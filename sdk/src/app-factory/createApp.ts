import { MARKDOWN_VIEW_FORMAT, SnapshotDataError, type ViewRegion } from '@aotui/core';
import {
    createRefCapture, type AppFrameView, type AppLifecycleCallbacks, type AppProjectionFrame, type PreparedProjection, type RuntimeContext,
} from '@aotui/core';
import { captureViewBindings, captureViewPlacement, requireViewType, type ViewContextProps, type ViewNamingProps,
    type ViewRegionProps, type ViewType } from '../tools/view-type-tool.js';
import { createAppFactory, type AppConfig, type TUIAppFactory } from './app-factory.js';
import { publishedValue, capturePublication, type PublishedRef } from './refs.js';

declare const viewHandle: unique symbol;
export interface ViewHandle { readonly [viewHandle]: true }

type ViewFrame = { readonly views: readonly ViewHandle[] };

export interface AppAuthorContext extends
    Pick<RuntimeContext, 'appId' | 'desktopId' | 'launchConfig' | 'persistence' | 'projectionLimits' | 'signal'> {
    registerCleanup(callbacks: AppLifecycleCallbacks): void;
    /** Prepare a complete frame for a subsequent observation. */
    prepareProjection(frame: ViewFrame): PreparedProjection;
    /** Prepare a reversible opening that can leave the current frame intact on capacity rejection. */
    prepareOpeningProjection(frame: ViewFrame): PreparedProjection;
}

export type CreateAppConfig = AppConfig & {
    initialize(context: AppAuthorContext): void | Promise<void>;
};

interface ViewMetadata {
    readonly id?: string | undefined;
    readonly idPrefix?: string | undefined;
    readonly region?: ViewRegion | undefined;
    readonly name?: string | undefined;
    readonly onClose?: AppFrameView['onClose'];
}
type ViewRender = { readonly body: string; readonly refs?: readonly PublishedRef[] };
const handles = new WeakMap<object, {
    readonly type: ViewType;
    readonly metadata: ViewMetadata;
    readonly render: () => ViewRender & { readonly context?: unknown };
    app?: object;
}>();

/** Create a stable author handle. Its first publication binds it to the App. */
export function createView<const Definition extends ViewType>(
    type: Definition,
    options: ViewNamingProps<Definition> & ViewRegionProps<Definition> & { readonly name?: string; readonly onClose?: AppFrameView['onClose'];
        render: () => ViewRender & ViewContextProps<NoInfer<Definition>> },
): ViewHandle {
    const { render, ...metadata } = options;
    const handle = Object.freeze({}) as ViewHandle;
    handles.set(handle, { type, metadata, render });
    return handle;
}

function invalid(path: string, message: string): never {
    throw new SnapshotDataError('SNAPSHOT_INVALID', path, message);
}

/** Create a managed App without a renderer or a DOM dependency. */
export function createApp(config: CreateAppConfig): TUIAppFactory {
    const { initialize } = config;
    return createAppFactory(config, async (context, types) => {
        const { appId, desktopId, persistence, launchConfig, projectionLimits, signal, appLifecycle } = context;
        const app = {};
        const build = (frame: ViewFrame): AppProjectionFrame => {
            if (signal.aborted) throw Object.assign(new Error('App projection is closed'), { code: 'PROJECTION_CLOSED' });
            const capture = createRefCapture();
            const views: AppProjectionFrame['views'][number][] = [];
            for (const handle of frame.views) {
                const view = handles.get(handle);
                if (!view || view.app !== undefined && view.app !== app)
                    invalid('$.views', 'Expected a View handle belonging to this App instance');
                view.app = app;
                const { metadata, render } = view;
                const type = requireViewType(types, view.type);
                const label = metadata.id ?? metadata.idPrefix ?? type.name;
                const path = 'View ' + label;
                const { body, refs = [], context } = render();
                const placement = captureViewPlacement(type, metadata, context);
                if (typeof body !== 'string') invalid(path, 'Expected a Markdown body');

                const refIds = new Set<string>();
                const captured: AppProjectionFrame['views'][number]['refs'][number][] = [];
                for (const item of refs) {
                    const ref = publishedValue(label, capturePublication(capture, item));
                    if (refIds.has(ref.id)) invalid(path + '.refs', 'Ref IDs must be unique within this View');
                    refIds.add(ref.id);
                    captured.push(ref);
                }
                views.push({
                    ...placement, type: type.name, owner: handle, content: { format: MARKDOWN_VIEW_FORMAT, value: body }, refs: captured,
                    bindings: captureViewBindings(type, label, context),
                    ...(metadata.onClose === undefined ? {} : { onClose: metadata.onClose }),
                });
            }
            return { views };
        };
        const prepare = (frame: ViewFrame, options?: { readonly opening: true }): PreparedProjection => {
            const result = context.publishFrame(() => build(frame), options);
            if (result.status === 'prepared') return result;
            if (result.status === 'failed' && result.cause) throw result.cause.error;
            if ('issue' in result) {
                const { code, path, message } = result.issue;
                throw new SnapshotDataError(code, path ?? '$', message);
            }
            throw new SnapshotDataError('SNAPSHOT_INVALID', '$', 'Expected a prepared projection');
        };

        await initialize({
            appId, desktopId, signal, projectionLimits,
            ...(persistence === undefined ? {} : { persistence }),
            ...(launchConfig === undefined ? {} : { launchConfig }),
            registerCleanup: callbacks => { appLifecycle.register(callbacks); },
            prepareProjection: frame => prepare(frame),
            prepareOpeningProjection: frame => prepare(frame, { opening: true }),
        });
        return { close() {} };
    });
}
