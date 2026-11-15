import type { AppInstance, RuntimeContext, TUIAppFactory } from '@aotui/runtime/spi';
import { createDOMAppRoot, dispatchDOMAppEvent, readDOMAppViews } from '@aotui/runtime/adapters/dom';
import { h, render, type ComponentType } from 'preact';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import { createRenderCommit, trackRenderCommits, whenRenderCommitted } from './render-commit.js';
import { createAppFactory, type AppConfig } from './app-factory.js';
import type { ViewType } from '../tools/view-type-tool.js';

// Retain interrupted DOM cleanup until the same container is reused.
const pendingUnmounts = new WeakMap<HTMLElement, () => void>();

export interface TUIAppConfig extends AppConfig {
    component: ComponentType;
}

export function createTUIApp(config: TUIAppConfig): TUIAppFactory {
    const RootComponent = config.component;
    const factory = createAppFactory(config, async (context, types) => {
        const root = createDOMAppRoot(context.appId);
        try {
            const instance = await mountPreactApp(RootComponent, root, context, types);
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
export async function mountPreactApp(
    RootComponent: ComponentType, container: HTMLElement, context: RuntimeContext, viewTypes: ReadonlyMap<string, ViewType>,
): Promise<AppInstance> {
    trackRenderCommits();
    pendingUnmounts.get(container)?.();
    type ViewInventory = NonNullable<import('preact').ContextType<typeof AppRuntimeContext>>['views'];
    const views: ViewInventory = new WeakMap();
    const appContextValue = {
        appId: context.appId,
        desktopId: context.desktopId,
        launchConfig: context.launchConfig,
        refExporter: context.refExporter,
        persistence: context.persistence,
        appLifecycle: context.appLifecycle,
        viewTypes,
        views,
        mountView: context.mountView,
    };
    const root = h(AppRuntimeContext.Provider, { value: appContextValue }, h(RootComponent, {}));
    const commitRender = createRenderCommit(context.projection, appContextValue);
    let attached = true;
    let unmounting = false;
    const close = () => {
        if (!attached || unmounting) return;
        unmounting = true;
        try {
            commitRender(() => render(null, container));
            attached = false;
            pendingUnmounts.delete(container);
        } catch (error) {
            pendingUnmounts.set(container, close);
            throw error;
        } finally {
            unmounting = false;
        }
    };

    context.setViewReader(() => readDOMAppViews(container, node => views.get(node)));
    try {
        commitRender(() => render(root, container));
    } catch (error) {
        try { close(); } catch { /* Preserve initial failure while cleanup can still be retried. */ }
        throw error;
    }

    return {
        whenCommitted: whenRenderCommitted,
        onLLMUsage: event => dispatchDOMAppEvent(container, 'aotui:llm-usage', event),
        close,
    };
}
