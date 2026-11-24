import type { AppInstance, RuntimeContext } from '@aotui/core';
import { createDOMAppRoot, readDOMAppViews } from '../preact/dom-app.js';
import { h, render, type ComponentType } from 'preact';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import { createRenderCommit, createViewRefs, prepareRenderProjection, trackRenderCommits, whenRenderCommitted } from './render-commit.js';
import { createAppFactory, type AppConfig, type TUIAppFactory } from './app-factory.js';
import { requireViewType, type ViewType } from '../tools/view-type-tool.js';

export interface TUIAppConfig extends AppConfig {
    component: ComponentType;
}

export function createTUIApp(config: TUIAppConfig): TUIAppFactory {
    const RootComponent = config.component;
    const factory = createAppFactory(config, async (context, types) => {
        const root = createDOMAppRoot();
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

/** Mount the Preact tree and register its cleanup with the App owner. */
async function mountPreactApp(
    RootComponent: ComponentType, container: HTMLElement, context: RuntimeContext, viewTypes: ReadonlyMap<string, ViewType>,
): Promise<AppInstance> {
    trackRenderCommits();
    type RenderContext = NonNullable<import('preact').ContextType<typeof AppRuntimeContext>>;
    const views: RenderContext['views'] = new Map();
    const appContextValue: RenderContext = {
        appId: context.appId,
        desktopId: context.desktopId,
        launchConfig: context.launchConfig,
        projectionLimits: context.projectionLimits,
        ...(context.persistence === undefined ? {} : { persistence: context.persistence }),
        appLifecycle: context.appLifecycle,
        resolveViewType: definition => requireViewType(viewTypes, definition),
        createViewRefs: label => createViewRefs(appContextValue, label),
        views,
        prepareProjection: update => prepareRenderProjection(appContextValue, context.signal, update),
        prepareOpeningProjection: (update, revert) => prepareRenderProjection(appContextValue, context.signal, update, { revert }),
        readPreparedViewId: (type, name) => context.readPreparedViewId(type, name),
        requestAttention: () => context.requestAttention(),
    };
    const root = h(AppRuntimeContext.Provider, { value: appContextValue }, h(RootComponent, {}));
    const commitRender = createRenderCommit(context, appContextValue, refs => ({
        views: readDOMAppViews(container, node => {
            const attached = views.get(node);
            return attached && { ...attached, refs: attached.readRefs(refs) };
        }, views.size),
    }));
    let attached = true;
    let unmounting = false;
    const close = () => {
        if (!attached || unmounting) return;
        unmounting = true;
        try {
            commitRender(() => render(null, container));
            attached = false;
        } finally {
            unmounting = false;
        }
    };

    try {
        commitRender(() => render(root, container));
    } catch (error) {
        try { close(); } catch { /* Preserve the mount failure. */ }
        throw error;
    }

    return {
        whenCommitted: signal => whenRenderCommitted(signal, appContextValue),
        close,
    };
}
