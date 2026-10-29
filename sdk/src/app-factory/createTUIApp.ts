/**
 * AOTUI SDK - createTUIApp Factory
 * 
 * [RFC-027-C] Factory Injection Pattern
 * 
 * SDK通过工厂模式向Runtime暴露组件初始化能力,实现完全解耦。
 */

import type {
    AppContext,
    IAOTUIApp,
    AppKernelConfig,
    AppReinitializeContext,
    AppOperationHandler,
    SignalPolicy,
    RuntimeContext,
    ComponentRenderer,
} from '@aotui/runtime/spi';

import { TUI_FACTORY, type Factory } from '../factory/index.js';
import type { ComponentType } from 'preact';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import { AppConfigContext } from '../contexts/index.js';

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

/**
 * TUI App Configuration (Component Based)
 */
export interface TUIAppConfig {
    experimentalAppLifecycle?: boolean;
    /**
     * App 唯一名称（用于展示、Tool 前缀、配置键、持久化命名空间）
     *
     * 约束: [a-z0-9_]
     */
    app_name: string;

    /** App 描述 (兼容旧字段) */
    description?: string;

    /** App 是什么 */
    whatItIs?: string;

    /** 什么时候用 */
    whenToUse?: string;

    /** 根React组件 */
    component: ComponentType;

    /** App级别的Operation处理器 (可选) */
    onOperation?: AppOperationHandler;

    /** App删除时的清理回调 (可选) */
    onDelete?: (context: AppContext) => Promise<void>;

    /** App 重新初始化时的清理回调 (可选) */
    onReinitialize?: (context: AppReinitializeContext) => Promise<void> | void;

    /** App启动配置 (可选,传递给组件) */
    launchConfig?: Record<string, any>;

    /** [RFC-012] 信号策略 */
    signalPolicy?: SignalPolicy;
}

/**
 * TUI Component App Factory
 * 
 * 实现ComponentFactory接口,提供initializeComponent方法
 */
export interface TUIComponentAppFactory extends Factory<IAOTUIApp> {
    readonly [TUI_FACTORY]: 'app';

    /** App显示名称 */
    displayName: string;

    /** 传递给Runtime的Kernel配置 */
    kernelConfig: AppKernelConfig;
    readonly persistenceSupport: 'state-session-v1';
    readonly appLifecycleSupport?: 'app-lifecycle-v2';

    /** @deprecated Legacy app-instance creation is unsupported in component mode. */
    create: () => IAOTUIApp;

    // ComponentFactory核心方法 (手动实现)
    initializeComponent(container: HTMLElement, context: RuntimeContext): Promise<ComponentRenderer>;
    onOperation?: AppOperationHandler;
    onDelete?: () => Promise<void>;
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
 *             {showDetail && <TodoDetailComponent onClose={() => setShowDetail(false)} />}
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
export function createTUIApp(config: TUIAppConfig): TUIComponentAppFactory {
    if (typeof config.app_name !== 'string') {
        throw new Error('[AOTUI SDK] app_name must be a string matching /^[a-z0-9_]+$/; name is not a substitute.');
    }
    if (!/^[a-z0-9_]+$/.test(config.app_name)) {
        throw new Error(
            `[AOTUI SDK] Invalid app_name "${config.app_name}". ` +
            `app_name must match /^[a-z0-9_]+$/`
        );
    }

    // 保存根组件
    const RootComponent = config.component;

    // 转换为AppKernelConfig格式
    const kernelConfig: AppKernelConfig = {
        appName: config.app_name,
        name: config.app_name,
        description: config.description,
        whatItIs: config.whatItIs,
        whenToUse: config.whenToUse,
        // [重要] 传递Factory本身而非Component
        component: undefined as any, // 将在下面的返回对象中被覆盖
        onOperation: config.onOperation,
        onDelete: config.onDelete,
        onReinitialize: config.onReinitialize,
        launchConfig: config.launchConfig,
        signalPolicy: config.signalPolicy,
    };

    const factory: TUIComponentAppFactory = {
        [TUI_FACTORY]: 'app',
        displayName: config.app_name,
        kernelConfig,
        persistenceSupport: 'state-session-v1',
        ...(config.experimentalAppLifecycle ? { appLifecycleSupport: 'app-lifecycle-v2' as const } : {}),

        /**
         * [RFC-027-C] Factory Injection Pattern
         * 
         * SDK内部处理所有Preact渲染逻辑
         */
        async initializeComponent(container: HTMLElement, context: RuntimeContext): Promise<ComponentRenderer> {

            // [长期主义] 使用标准ESM动态导入，不依赖CommonJS require
            const { render, h } = await import('preact');

            console.log('[createTUIApp] initializeComponent', {
                appId: context.appId,
                desktopId: context.desktopId
            });

            // 构建AppRuntimeContext value
            const appContextValue = {
                appId: context.appId,
                desktopId: context.desktopId,
                launchConfig: (context as { launchConfig?: Record<string, unknown> }).launchConfig,
                allocateViewId: context.allocateViewId,
                registerView: context.registerView,
                unregisterView: context.unregisterView,
                refExporter: context.refExporter,
                typeTools: (context as { typeTools: any }).typeTools, // [RFC-020] Pass Type Tool Registry
                markDirty: context.markDirty,
                projection: context.projection,
                persistence: context.persistence,
                appLifecycle: context.appLifecycle,
                viewTools: context.viewTools,
            };

            if (config.experimentalAppLifecycle && context.appLifecycle?.protocol !== 'app-lifecycle-v2')
                throw new Error('APP_LIFECYCLE_UNSUPPORTED');

            // 创建根VNode
            const rootVNode = h(
                AppRuntimeContext.Provider,
                { value: appContextValue },
                h(
                    AppConfigContext.Provider,
                    { value: (appContextValue.launchConfig ?? {}) as any },
                    h(RootComponent, {})
                )
            );

            // M3: bracket explicit SDK render commits. Preact's synchronous
            // layout effects register View/Ref/ViewTypeTool inside this boundary.
            // Internal component setState commits are tracked by registry mutations
            // and DOM invalidations; these explicit brackets are not their only gate.
            const renderCommitted = (node: typeof rootVNode | null) => {
                context.projection?.beginCommit();
                try {
                    render(node, container);
                } finally {
                    context.projection?.endCommit();
                }
            };

            // A failed initial commit must not leave earlier View/Tool effects
            // registered. Unmount the partial tree before propagating the error.
            try {
                renderCommitted(rootVNode);
            } catch (error) {
                try { renderCommitted(null); } catch { /* preserve initial error */ }
                throw error;
            }

            // 返回Renderer控制接口
            return {
                render: () => renderCommitted(rootVNode),
                unmount: () => renderCommitted(null),
            };
        },

        onOperation: config.onOperation,
        onDelete: config.onDelete as any,

        create: () => {
            throw new Error(
                '[SDK] createTUIApp().create() is deprecated. ' +
                'Runtime should call initializeComponent() instead.'
            );
        },
    };

    // 将factory自己设置为component (Runtime会调用factory.initializeComponent)
    kernelConfig.component = factory as any;

    return factory;
}
