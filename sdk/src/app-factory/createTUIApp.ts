import { APP_LIFECYCLE_PROTOCOL, type AppInstance, type RuntimeContext, type TUIAppFactory } from '@aotui/runtime/spi';
import { createDOMAppRoot, dispatchDOMAppEvent, readDOMAppViews } from '@aotui/runtime/adapters/dom';
import { h, render, type ComponentType } from 'preact';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import { createRenderCommit, trackRenderCommits, whenRenderCommitted } from './render-commit.js';
import { createAppFactory, type AppConfig } from './app-factory.js';

// Failed initialization returns no instance. Keep incomplete teardown reachable
// until the same container or App Tool port is reused.
const pendingUnmounts = new WeakMap<HTMLElement | NonNullable<RuntimeContext['appTypeTools']>, () => void>();

export interface TUIAppConfig extends AppConfig {
    component: ComponentType;
}

export function createTUIApp(config: TUIAppConfig): TUIAppFactory {
    const RootComponent = config.component;
    const factory = createAppFactory(config, async context => {
        const root = createDOMAppRoot(context.appId);
        try {
            const instance = await mountPreactApp(RootComponent, root, context);
            return {
                ...instance,
                close() {
                    try { return instance.close(); }
                    finally { root.remove(); }
                },
            };
        } catch (error) {
            root.remove();
            throw error;
        }
    });
    // act() can restore the scheduler it saved before initialization.
    trackRenderCommits();
    return factory;
}

/** Preact renderer and its owner cleanup, also used by the adapter's unit tests. */
export async function mountPreactApp(RootComponent: ComponentType, container: HTMLElement, context: RuntimeContext): Promise<AppInstance> {
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
    const rootVNode = () => h(
        AppRuntimeContext.Provider,
        { value: appContextValue },
        h(RootComponent, {})
    );

    const commitRender = createRenderCommit(context.projection, appContextValue);
    let attached = true;
    let unmounting = false;
    const renderCommitted = (node: ReturnType<typeof rootVNode> | null) => commitRender(() => {
        render(node, container);
        if (node === null) attached = false;
    });

    const close = () => {
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
                if (attached || toolOwners.active.size > 0) pendingUnmounts.set(key, close);
                else if (pendingUnmounts.get(key) === close) pendingUnmounts.delete(key);
            }
            if (failure) throw failure.error;
        } finally {
            unmounting = false;
        }
    };

    context.setViewReader?.(mounted => readDOMAppViews(container, mounted));
    try {
        renderCommitted(rootVNode());
    } catch (error) {
        try { close(); } catch { /* preserve initial error; failed cleanup remains retryable */ }
        throw error;
    }

    return {
        whenCommitted: whenRenderCommitted,
        onExternalEvent: event => dispatchDOMAppEvent(container, 'aotui:external-event', event),
        onLLMOutput: event => dispatchDOMAppEvent(container, 'aotui:llm-text', { ...event, id: `llm_${event.timestamp}` }),
        close,
    };
}
