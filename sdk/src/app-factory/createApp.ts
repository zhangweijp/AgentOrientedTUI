import {
    APP_LIFECYCLE_PROTOCOL, MARKDOWN_VIEW_FORMAT, SnapshotDataError, VIEW_TYPE_TOOL_PROTOCOL, captureAppMetadata, createRefCapture,
    type AppFrameView, type AppLifecycleCallbacks, type AppMetadata, type AppProjectionFrame, type OpeningProjectionResult,
    type PreparedProjection, type ProjectionCommitResult, type RuntimeContext, type TUIAppFactory as CoreAppFactory, type ViewRegion,
} from '@aotui/core';
import { captureViewBindings, captureViewPlacement, captureViewTypes, requireViewType, viewTypeDefinitions, type ViewContextProps, type ViewNamingProps,
    type ViewRegionProps, type ViewType } from '../tools/view-type-tool.js';
import { capturePublication, type PublishedRef } from './refs.js';

declare const viewHandle: unique symbol;
export interface ViewHandle { readonly [viewHandle]: true }

type ViewFrame = { readonly views: readonly ViewHandle[] };

export interface AppAuthorContext extends
    Pick<RuntimeContext, 'appId' | 'desktopId' | 'launchConfig' | 'projectionLimits' | 'signal' | 'requestAttention'> {
    registerCleanup(callbacks: AppLifecycleCallbacks): void;
    /** Prepare a complete frame for a subsequent observation. */
    prepareProjection(frame: ViewFrame): PreparedProjection;
    /** On App capacity rejection, keep the current healthy frame intact. */
    prepareOpeningProjection(frame: ViewFrame): OpeningProjectionResult;
    /** Return the ID of this handle in the healthy accepted frame. */
    readViewId(handle: ViewHandle): string | undefined;
}

/** Lets author declaration emit name the factory through the SDK entry. */
export interface TUIAppFactory extends CoreAppFactory {}

export type CreateAppConfig = Pick<AppMetadata, 'app_name'> & {
    readonly viewTypes: readonly ViewType[];
    initialize(context: AppAuthorContext): void | Promise<void>;
};

interface ViewMetadata {
    readonly id?: string | undefined;
    readonly idPrefix?: string | undefined;
    readonly region?: ViewRegion | undefined;
    readonly name?: string | undefined;
    readonly onClose?: AppFrameView['onClose'];
}
type ViewRender = { readonly body: string; readonly name?: string | undefined; readonly refs?: readonly PublishedRef[] };
const handles = new WeakMap<object, {
    readonly type: ViewType;
    readonly metadata: ViewMetadata;
    readonly render: () => ViewRender & { readonly context?: unknown };
    app?: object;
}>();

/** Create a stable handle. Its first preparation binds it to the App. */
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

function throwCommitIssue(result: Exclude<ProjectionCommitResult, PreparedProjection>): never {
    if (result.status === 'failed' && result.cause) throw result.cause.error;
    const { code, path, message } = result.issue;
    throw new SnapshotDataError(code, path ?? '$', message);
}

/** Create a managed App without a renderer or a DOM dependency. */
export function createApp(config: CreateAppConfig): TUIAppFactory {
    const { app_name } = captureAppMetadata({ app_name: Object.getOwnPropertyDescriptor(config, 'app_name')?.value });
    const types = captureViewTypes(config.viewTypes);
    const definitions = viewTypeDefinitions(types);
    const { initialize: initializeAuthor } = config;
    return { app_name, toolAuthoringProtocol: VIEW_TYPE_TOOL_PROTOCOL, appLifecycleSupport: APP_LIFECYCLE_PROTOCOL, initialize };

    async function initialize(context: RuntimeContext) {
        const { appId, desktopId, launchConfig, projectionLimits, signal, appLifecycle } = context;
        if (appLifecycle?.protocol !== APP_LIFECYCLE_PROTOCOL || typeof appLifecycle.register !== 'function')
            throw new Error('APP_LIFECYCLE_UNSUPPORTED');
        context.defineViewTypes(definitions);
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
                const output = render();
                if (typeof (output as Partial<PromiseLike<unknown>> | undefined)?.then === 'function') {
                    void Promise.resolve(output).catch(() => {});
                    invalid(path, 'Expected render() to return a Markdown body synchronously');
                }
                const { body, name = metadata.name, refs = [], context } = output;
                const placement = captureViewPlacement(type, { ...metadata, name });
                if (typeof body !== 'string') invalid(path, 'Expected a Markdown body');

                const refIds = new Set<string>();
                const captured: AppProjectionFrame['views'][number]['refs'][number][] = [];
                for (const item of refs) {
                    const ref = capturePublication(label, capture, item);
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
        await initializeAuthor({
            appId, desktopId, signal, projectionLimits,
            ...(launchConfig === undefined ? {} : { launchConfig }),
            registerCleanup: callbacks => { appLifecycle.register(callbacks); },
            prepareProjection(frame) {
                const result = context.publishFrame(() => build(frame));
                return result.status === 'prepared' ? result : throwCommitIssue(result);
            },
            prepareOpeningProjection(frame) {
                const result = context.publishFrame(() => build(frame), { opening: true });
                return result.status === 'failed' ? throwCommitIssue(result) : result;
            },
            readViewId: handle => context.readViewId(handle),
            requestAttention: () => context.requestAttention(),
        });
        return { close() {} };
    }
}
