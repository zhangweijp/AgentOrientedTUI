import { captureAppMetadata, VIEW_TYPE_TOOL_PROTOCOL, APP_LIFECYCLE_PROTOCOL, STATE_SESSION_PROTOCOL } from '@aotui/runtime/spi';
import type { AppMetadata } from '@aotui/runtime/spi';
/**
 * AOTUI SDK - createTUIApp Factory
 * 
 * [RFC-027-C] Factory Injection Pattern
 * 
 * SDK通过工厂模式向Runtime暴露组件初始化能力,实现完全解耦。
 */

import type {
    AppContext,
    AppKernelConfig,
    AppReinitializeContext,
    SignalPolicy,
    RuntimeContext,
    ComponentRenderer,
    TUIAppFactory,
} from '@aotui/runtime/spi';

import { h, render, type ComponentType } from 'preact';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import { trackRenderCommits, whenRenderCommitted } from './render-commit.js';

// Failed initialization returns no renderer to the caller. Keep incomplete
// teardown reachable until the same DOM container or App Tool port is reused.
const pendingUnmounts = new WeakMap<HTMLElement | NonNullable<RuntimeContext['appTypeTools']>, () => void>();

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

/**
 * TUI App Configuration (Component Based)
 */
export interface TUIAppConfig extends Omit<AppMetadata, 'description'> {
    /** 根React组件 */
    component: ComponentType;

    /** App删除时的清理回调 (可选) */
    onDelete?: (context: AppContext) => Promise<void>;

    /** App 重新初始化时的清理回调 (可选) */
    onReinitialize?: (context: AppReinitializeContext) => Promise<void> | void;

    /** App启动配置 (可选,传递给组件) */
    launchConfig?: Record<string, any>;

    /** [RFC-012] 信号策略 */
    signalPolicy?: SignalPolicy;
}

// ═══════════════════════════════════════════════════════════════
//  createTUIApp Factory
// ═══════════════════════════════════════════════════════════════

/**
 * Create a TUI application using Factory Injection Pattern
 * 
 * @example
 * ```tsx
 * function TodoApp() {
 *     const [showDetail, setShowDetail] = useState(false);
 *     return (
 *         <>
 *             <TodoHomeComponent onOpenDetail={(id) => setShowDetail(true)} />
 *             {showDetail && <TodoDetailComponent onRequestClose={() => setShowDetail(false)} />}
 *         </>
 *     );
 * }
 * 
 * export default createTUIApp({
 *     app_name: 'todo_manager',
 *     component: TodoApp,
 * });
 * ```
 */
export function createTUIApp(config: TUIAppConfig): TUIAppFactory {
    const metadata = captureAppMetadata(config);

    // Render adapters such as act() restore the scheduler saved before initialization.
    // Install at factory creation too, so that saved scheduler already tracks commits.
    trackRenderCommits();

    // 保存根组件
    const RootComponent = config.component;

    // 转换为AppKernelConfig格式
    const kernelConfig: AppKernelConfig = {
        appName: metadata.app_name,
        name: metadata.app_name,
        ...(metadata.whatItIs === undefined ? {} : { whatItIs: metadata.whatItIs }),
        ...(metadata.whenToUse === undefined ? {} : { whenToUse: metadata.whenToUse }),
        // [重要] 传递Factory本身而非Component
        component: undefined as any, // 将在下面的返回对象中被覆盖
        ...(config.onDelete === undefined ? {} : { onDelete: config.onDelete }),
        ...(config.onReinitialize === undefined ? {} : { onReinitialize: config.onReinitialize }),
        ...(config.launchConfig === undefined ? {} : { launchConfig: config.launchConfig }),
        ...(config.signalPolicy === undefined ? {} : { signalPolicy: config.signalPolicy }),
    };

    const factory: TUIAppFactory = {
        displayName: metadata.app_name,
        kernelConfig,
        toolAuthoringProtocol: VIEW_TYPE_TOOL_PROTOCOL,
        persistenceSupport: STATE_SESSION_PROTOCOL,
        appLifecycleSupport: APP_LIFECYCLE_PROTOCOL,

        /**
         * [RFC-027-C] Factory Injection Pattern
         * 
         * SDK内部处理所有Preact渲染逻辑
         */
        async initializeComponent(container: HTMLElement, context: RuntimeContext): Promise<ComponentRenderer> {

            trackRenderCommits();

            const toolCleanup = new Set<() => void>();
            const toolOwners = { closed: false, active: new Set<() => void>() };
            // 构建AppRuntimeContext value
            const appContextValue = {
                toolCleanup,
                toolOwners,
                appId: context.appId,
                desktopId: context.desktopId,
                launchConfig: (context as { launchConfig?: Record<string, unknown> }).launchConfig,
                refExporter: context.refExporter,
                markDirty: context.markDirty,
                projection: context.projection,
                persistence: context.persistence,
                appLifecycle: context.appLifecycle,
                viewTools: context.viewTools,
                appTypeTools: context.appTypeTools,
            };

            if (context.appLifecycle?.protocol !== APP_LIFECYCLE_PROTOCOL)
                throw new Error('APP_LIFECYCLE_UNSUPPORTED');

            const cleanupKeys = context.appTypeTools ? [container, context.appTypeTools] : [container];
            for (const key of cleanupKeys) pendingUnmounts.get(key)?.();

            // 创建根VNode
            const rootVNode = h(
                AppRuntimeContext.Provider,
                { value: appContextValue },
                h(RootComponent, {})
            );

            // M3: bracket explicit SDK render commits. Preact's synchronous
            // layout effects register View/Ref/Tool bindings inside this boundary.
            // Internal component setState commits are tracked by registry mutations
            // and DOM invalidations; these explicit brackets are not their only gate.
            let attached = true;
            let unmounting = false;
            const renderCommitted = (node: typeof rootVNode | null) => {
                context.projection.beginCommit();
                try {
                    render(node, container);
                    if (node === null) attached = false;
                } finally {
                    context.projection.endCommit();
                }
            };

            const unmount = () => {
                if (unmounting) return;
                unmounting = true;
                toolOwners.closed = true;
                try {
                    let failure: { error: unknown } | undefined;
                    // Revoke before application cleanup can call a Tool or interrupt traversal.
                    for (const dispose of [...toolOwners.active]) {
                        try { dispose(); } catch (error) { failure ??= { error }; }
                    }
                    if (attached) {
                        try { renderCommitted(null); } catch (error) { failure ??= { error }; }
                    }
                    for (const key of cleanupKeys) {
                        if (attached || toolOwners.active.size > 0) pendingUnmounts.set(key, unmount);
                        else if (pendingUnmounts.get(key) === unmount) pendingUnmounts.delete(key);
                    }
                    if (failure) throw failure.error;
                } finally {
                    unmounting = false;
                }
            };

            try {
                renderCommitted(rootVNode);
            } catch (error) {
                try { unmount(); } catch { /* preserve initial error; failed cleanup remains retryable */ }
                throw error;
            }

            return {
                whenCommitted: signal => whenRenderCommitted(signal),
                render: () => {
                    if (toolOwners.closed) throw Object.assign(new Error('APP_RENDERER_CLOSED'), { code: 'APP_RENDERER_CLOSED' });
                    renderCommitted(rootVNode);
                },
                unmount,
            };
        },

    };

    // 将factory自己设置为component (Runtime会调用factory.initializeComponent)
    kernelConfig.component = factory as any;

    return factory;
}
