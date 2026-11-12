import { MARKDOWN_VIEW_FORMAT, SnapshotDataError } from '@aotui/runtime/core';
import {
    APP_LIFECYCLE_PROTOCOL,
    type AppLifecycleCallbacks, type AppProjectionFrame, type RuntimeContext, type TUIAppFactory,
} from '@aotui/runtime/spi';
import { createAppFrameTools, type ExactBindings, type ToolBindings, type ToolMap, type ToolSet } from '../tools/view-type-tool.js';
import { createAppFactory, VIEW_ID_PATTERN, type AppConfig } from './app-factory.js';
import { captureRefEntries, type PublishedRef } from './refs.js';

export interface PublishedView {
    readonly id: string;
    readonly type: string;
    readonly kind: 'instruction' | 'state';
    readonly name?: string;
    readonly body: string;
    readonly refs?: readonly PublishedRef[];
}

type EmptyTools = Record<never, never>;

type AppFrame<Tools extends ToolMap, Bindings extends ToolBindings<Tools>> = {
    readonly views: readonly PublishedView[];
} & (keyof Tools extends never ? { readonly bindings?: never } : {
    readonly bindings: Bindings & ExactBindings<Bindings, Tools>;
});

export interface AppAuthorContext<Tools extends ToolMap = EmptyTools> extends
    Pick<RuntimeContext, 'appId' | 'desktopId' | 'launchConfig' | 'persistence' | 'signal'> {
    /** Register the instance's application-owned stop and close callbacks. */
    registerCleanup(callbacks: AppLifecycleCallbacks): void;
    /** Commit the entire App. Omitted Views and Refs leave the current projection. */
    publish<const Bindings extends ToolBindings<Tools>>(frame: AppFrame<Tools, Bindings>): void;
}

export type CreateAppConfig<Tools extends ToolMap = EmptyTools> = AppConfig & {
    readonly tools?: ToolSet<Tools>;
    initialize(context: AppAuthorContext<NoInfer<Tools>>): void | Promise<void>;
} & (keyof Tools extends never ? unknown : { readonly tools: ToolSet<Tools> });

function invalid(path: string, message: string): never {
    throw new SnapshotDataError('SNAPSHOT_INVALID', path, message);
}

/** Create a managed App without a renderer or a DOM dependency. */
export function createApp<const Tools extends ToolMap = EmptyTools>(config: CreateAppConfig<Tools>): TUIAppFactory {
    const { initialize, tools } = config;
    return createAppFactory(config, async context => {
        const { appId, desktopId, persistence, launchConfig, signal, appLifecycle, refExporter } = context;
        if (appLifecycle?.protocol !== APP_LIFECYCLE_PROTOCOL) throw new Error('Managed App lifecycle unavailable');
        const toolBindings = tools && createAppFrameTools(tools);
        const capture = refExporter.captureRef.bind(refExporter);

        const publish = <const Bindings extends ToolBindings<Tools>>(frame: AppFrame<Tools, Bindings>): void => {
            if (signal.aborted) throw Object.assign(new Error('App projection is closed'), { code: 'PROJECTION_CLOSED' });
            let pendingTools: ReturnType<ReturnType<typeof createAppFrameTools>['prepare']> | undefined;
            context.publishFrame(() => {
                if (!toolBindings && frame.bindings !== undefined) invalid('$.bindings', 'Declare a ToolSet before publishing bindings');
                pendingTools = toolBindings?.prepare(frame.bindings);
                const viewIds = new Set<string>();
                const views: AppProjectionFrame['views'][number][] = [];
                for (const { id, type, kind, name = id, body, refs = [] } of frame.views) {
                    if (typeof id !== 'string' || !VIEW_ID_PATTERN.test(id) || viewIds.has(id)) {
                        invalid('$.views', 'View IDs must be unique and use 2–15 letters, digits or underscores');
                    }
                    viewIds.add(id);
                    const path = `View ${id}`;
                    if (typeof type !== 'string' || !type.trim() || kind !== 'instruction' && kind !== 'state' ||
                        typeof name !== 'string' || !name.trim() || typeof body !== 'string') {
                        invalid(path, 'Expected View type, kind, name and Markdown body');
                    }
                    const refIds = new Set<string>();
                    const captured: AppProjectionFrame['views'][number]['refs'][number][] = [];
                    for (const item of refs) {
                        for (const [refId, token] of captureRefEntries(capture, item)) {
                            if (typeof refId !== 'string' || !refId.trim() || refId.includes('.') || refIds.has(refId)) {
                                invalid(`${path}.refs`, 'Ref IDs must be unique, non-empty and contain no dot');
                            }
                            refIds.add(refId);
                            captured.push({ id: refId, token, refType: item.refType });
                        }
                    }
                    views.push({ id, type, name, kind, content: { format: MARKDOWN_VIEW_FORMAT, value: body }, refs: captured });
                }
                return { views, tools: pendingTools?.tools ?? [] };
            });
            pendingTools?.accept();
        };

        try {
            await initialize({
                appId, desktopId, signal,
                ...(persistence === undefined ? {} : { persistence }),
                ...(launchConfig === undefined ? {} : { launchConfig }),
                registerCleanup: callbacks => { appLifecycle.register(callbacks); },
                publish,
            });
        } catch (error) {
            toolBindings?.close();
            throw error;
        }
        return { close() { toolBindings?.close(); } };
    });
}
