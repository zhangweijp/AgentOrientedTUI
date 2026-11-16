import { MARKDOWN_VIEW_FORMAT, SnapshotDataError } from '@aotui/runtime/core';
import {
    type AppLifecycleCallbacks, type AppProjectionFrame, type PreparedProjection, type RuntimeContext, type TUIAppFactory,
} from '@aotui/runtime/spi';
import { captureViewBindings, requireViewType, type ViewBindingProps, type ViewType } from '../tools/view-type-tool.js';
import { createAppFactory, VIEW_ID_PATTERN, type AppConfig } from './app-factory.js';
import { captureRefEntries, type PublishedRef } from './refs.js';

declare const viewHandle: unique symbol;
export interface ViewHandle { readonly [viewHandle]: true }

export interface AppAuthorContext extends
    Pick<RuntimeContext, 'appId' | 'desktopId' | 'launchConfig' | 'persistence' | 'signal'> {
    registerCleanup(callbacks: AppLifecycleCallbacks): void;
    /** Prepare this complete App projection synchronously. Errors are thrown locally. */
    publish(frame: { readonly views: readonly ViewHandle[] }): PreparedProjection;
}

export type CreateAppConfig = AppConfig & {
    initialize(context: AppAuthorContext): void | Promise<void>;
};

interface ViewMetadata {
    readonly id: string;
    readonly kind: 'instruction' | 'state';
    readonly name?: string;
}
type ViewRender = { readonly body: string; readonly refs?: readonly PublishedRef[] };
const handles = new WeakMap<object, {
    readonly type: ViewType;
    readonly metadata: ViewMetadata;
    readonly render: () => ViewRender & { readonly bindings?: unknown; readonly context?: unknown };
    app?: object;
}>();

/** Create a stable author handle. Its first publication binds it to the App. */
export function createView<const Definition extends ViewType>(
    type: Definition,
    options: ViewMetadata & { render: () => ViewRender & ViewBindingProps<NoInfer<Definition>> },
): ViewHandle {
    const { id, name, kind, render } = options;
    const handle = Object.freeze({}) as ViewHandle;
    handles.set(handle, { type, metadata: { id, kind, ...(name === undefined ? {} : { name }) }, render });
    return handle;
}

function invalid(path: string, message: string): never {
    throw new SnapshotDataError('SNAPSHOT_INVALID', path, message);
}

/** Create a managed App without a renderer or a DOM dependency. */
export function createApp(config: CreateAppConfig): TUIAppFactory {
    const { initialize } = config;
    return createAppFactory(config, async (context, types) => {
        const { appId, desktopId, persistence, launchConfig, signal, appLifecycle, refExporter } = context;
        const capture = refExporter.captureRef.bind(refExporter);
        const app = {};
        const publish: AppAuthorContext['publish'] = frame => context.publishFrame(() => {
            if (signal.aborted) throw Object.assign(new Error('App projection is closed'), { code: 'PROJECTION_CLOSED' });
            const views: AppProjectionFrame['views'][number][] = [];
            const viewIds = new Set<string>();
            for (const handle of frame.views) {
                const view = handles.get(handle);
                if (!view || view.app !== undefined && view.app !== app)
                    invalid('$.views', 'Expected a View handle belonging to this App instance');
                view.app = app;
                const { metadata: { id, kind, name = id }, render } = view;
                const type = requireViewType(types, view.type);
                if (typeof id !== 'string' || !VIEW_ID_PATTERN.test(id) || viewIds.has(id))
                    invalid('$.views', 'View IDs must be unique and use only ASCII letters, digits or underscores');
                viewIds.add(id);
                const path = 'View ' + id;
                const { body, refs = [], bindings, context } = render();
                if (kind !== 'instruction' && kind !== 'state' || typeof name !== 'string' || !name.trim() || typeof body !== 'string')
                    invalid(path, 'Expected View kind, name and Markdown body');

                const refIds = new Set<string>();
                const captured: AppProjectionFrame['views'][number]['refs'][number][] = [];
                for (const item of refs) {
                    for (const [refId, token] of captureRefEntries(capture, item)) {
                        if (typeof refId !== 'string' || !refId.trim() || refId.includes('.') || refIds.has(refId))
                            invalid(path + '.refs', 'Ref IDs must be unique, non-empty and contain no dot');
                        refIds.add(refId);
                        captured.push({ id: refId, token, refType: item.refType });
                    }
                }
                views.push({
                    id, type: type.name, name, kind, owner: handle, content: { format: MARKDOWN_VIEW_FORMAT, value: body }, refs: captured,
                    bindings: captureViewBindings(type, bindings, id, context),
                });
            }
            return { views };
        });

        await initialize({
            appId, desktopId, signal,
            ...(persistence === undefined ? {} : { persistence }),
            ...(launchConfig === undefined ? {} : { launchConfig }),
            registerCleanup: callbacks => { appLifecycle!.register(callbacks); },
            publish,
        });
        return { close() {} };
    });
}
