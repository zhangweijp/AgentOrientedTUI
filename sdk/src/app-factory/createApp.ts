import {
    APP_LIFECYCLE_PROTOCOL, MARKDOWN_VIEW_FORMAT, SnapshotDataError, VIEW_TYPE_TOOL_PROTOCOL, captureAppMetadata, createRefCapture,
    DEFAULT_SNAPSHOT_LIMITS, type AppFrameView, type AppLaunchConfig, type AppLifecycleCallbacks, type AppMetadata, type AppProjectionFrame,
    type PublishResult, type ProjectionOptions, type RuntimeContext, type TUIAppFactory as CoreAppFactory,
} from '@aotui/core';
import { captureViewBindings, captureViewClose, captureViewPlacement, captureViewTypes, readViewType, requireViewType, viewTypeDefinitions, type ViewContextProps, type ViewNamingProps,
    type ViewRegionProps, type ViewType } from '../tools/view-type-tool.js';
import { capturePublication, type PublishedRef } from './refs.js';

declare const viewHandle: unique symbol;
declare const frameBrand: unique symbol;
export interface ViewFrame { readonly [frameBrand]: true }
type FrameData = {
    readonly body: string;
    readonly name?: string | undefined;
    readonly refs?: readonly PublishedRef[] | undefined;
    readonly bindingKey?: string | number | undefined;
};
type FrameOptions<D extends ViewType> = FrameData & ViewContextProps<D>;
type CreateViewOptions<D extends ViewType> = ViewNamingProps<D> & ViewRegionProps<D>;
export interface ViewHandleIdentity { readonly [viewHandle]: true }
export type ViewHandle<D extends ViewType = ViewType> = ViewType extends D ? ViewHandleIdentity :
    ViewHandleIdentity & { readonly frame: (options: FrameOptions<D>) => ViewFrame };
type Handles<D extends ViewType> = D extends unknown ? ViewHandle<D> : never;

export interface AppAuthorContext extends
    Pick<RuntimeContext, 'appId' | 'desktopId' | 'launchConfig' | 'projectionLimits' | 'signal' | 'requestAttention'> {
    registerLifecycle(callbacks: AppLifecycleCallbacks): void;
    /** Synchronous local commit, not a Receiver acceptance or Observation. */
    publish(build: () => readonly ViewFrame[], options?: ProjectionOptions): PublishResult;
    /** Return the ID of this handle in the healthy accepted frame. */
    readViewId(handle: ViewHandle): string | undefined;
}

/** Lets author declaration emit name the factory through the SDK entry. */
export interface TUIAppFactory extends CoreAppFactory {}

type ViewTypes = readonly ViewType[];
type LaunchConfig = Readonly<AppLaunchConfig> | undefined;
export type CreateAppConfig<T extends ViewTypes = ViewTypes> = Pick<AppMetadata, 'app_name'> & {
    readonly viewTypes: T | ((config: LaunchConfig) => T);
    readonly initialize: (context: AppAuthorContext, viewTypes: Readonly<NoInfer<T>>) => void | Promise<void>;
};

type Placement = Pick<AppFrameView, 'id' | 'idPrefix' | 'region'>;
const frames = new WeakMap<object, { handle: ViewHandle; type: ViewType; placement: Placement; output: FrameData & { context?: unknown } }>();

function invalid(path: string, message: string): never {
    throw new SnapshotDataError('SNAPSHOT_INVALID', path, message);
}

function fields(input: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
    if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
        invalid(path, 'Expected a plain data object');
    const output: Record<string, unknown> = Object.create(null);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
        const field = Reflect.get(descriptors, key) as PropertyDescriptor;
        if (typeof key !== 'string' || !allowed.includes(key) || !field.enumerable || !('value' in field))
            invalid(path, 'Unexpected field or accessor');
        output[key] = field.value;
    }
    return output;
}
function dense(input: unknown, limit: number, path: string): readonly unknown[] {
    if (input instanceof Promise) { void Promise.prototype.then.call(input, undefined, () => {}); }
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > limit)
        invalid(path, 'Expected a bounded dense synchronous array');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== input.length + 1) invalid(path, 'Expected only array elements');
    return Array.from({length: input.length}, (_, i) => {
        const field = descriptors[String(i)];
        if (!field || !field.enumerable || !('value' in field)) invalid(path + '[' + i + ']', 'Expected data element');
        return field.value;
    });
}

/** Create a reusable static descriptor. Frames, not Handles, carry business context. */
export function createView<const D extends ViewType>(
    type: D, ...args: {} extends CreateViewOptions<NoInfer<D>>
        ? [options?: CreateViewOptions<NoInfer<D>>] : [options: CreateViewOptions<NoInfer<D>>]
): Handles<D>;
export function createView(type: ViewType, options?: unknown): unknown {
    const canonical = readViewType(type);
    const placement = Object.freeze(captureViewPlacement(canonical, fields(options === undefined ? {} : options, ['id', 'idPrefix', 'region'], '$.options')));
    const handle = Object.freeze({ frame(input: unknown): ViewFrame {
        const captured = fields(input, ['body', 'name', 'refs', 'context', 'bindingKey'], '$.frame');
        const output = Object.freeze({ ...captured, ...(captured.refs === undefined ? {} : {
            refs: Object.freeze(dense(captured.refs, DEFAULT_SNAPSHOT_LIMITS.maxRefs, '$.frame.refs')),
        }) }) as FrameData & { context?: unknown };
        const frame = Object.freeze({}) as ViewFrame;
        frames.set(frame, { handle: handle as unknown as ViewHandle, type: canonical, placement, output });
        return frame;
    } });
    return handle;
}

/** Create a managed App without a renderer or a DOM dependency. */
export function createApp<const T extends ViewTypes>(config: CreateAppConfig<T>): TUIAppFactory {
    const { app_name } = captureAppMetadata({ app_name: Object.getOwnPropertyDescriptor(config, 'app_name')?.value });
    const readField = <K extends 'viewTypes' | 'initialize'>(key: K): CreateAppConfig<T>[K] => {
        const field = Object.getOwnPropertyDescriptor(config, key);
        if (!field || !field.enumerable || !('value' in field))
            throw Object.assign(new TypeError('App requires a data property ' + key), { code: 'APP_INVALID_EXPORT', path: key });
        return field.value;
    };
    const declaration = readField('viewTypes');
    const initializeAuthor = readField('initialize');
    if (typeof initializeAuthor !== 'function')
        throw Object.assign(new TypeError('App requires initialize'), { code: 'APP_INVALID_EXPORT', path: 'initialize' });
    const invalidFactory = () => Object.assign(new TypeError('viewTypes must return a synchronous declaration array'),
        { code: 'VIEW_TYPE_INVALID', path: 'viewTypes' });
    if (typeof declaration === 'function' && Object.getPrototypeOf(declaration) === Object.getPrototypeOf(async () => {}))
        throw invalidFactory();
    const seal = (input: unknown) => {
        const types = captureViewTypes(input);
        // captureViewTypes preserves order and canonicalizes every element without altering its declaration type.
        const canonical = Object.freeze([...types.values()]) as unknown as Readonly<NoInfer<T>>;
        return { types, canonical, definitions: viewTypeDefinitions(types) };
    };
    const staticDeclarations = typeof declaration === 'function' ? undefined : seal(declaration);
    const dynamicDeclarations = typeof declaration === 'function' ? declaration : undefined;
    return { app_name, toolAuthoringProtocol: VIEW_TYPE_TOOL_PROTOCOL, appLifecycleSupport: APP_LIFECYCLE_PROTOCOL, initialize };

    async function initialize(context: RuntimeContext) {
        const { appId, desktopId, launchConfig, projectionLimits, signal, appLifecycle } = context;
        if (appLifecycle?.protocol !== APP_LIFECYCLE_PROTOCOL || typeof appLifecycle.register !== 'function')
            throw new Error('APP_LIFECYCLE_UNSUPPORTED');
        const checkSignal = () => {
            if (signal.aborted) throw Object.assign(new Error('App projection is closed'), { code: 'PROJECTION_CLOSED' });
        };
        checkSignal();
        const sealed = staticDeclarations ?? (() => {
            const result = dynamicDeclarations!(launchConfig);
            // Do not assimilate an arbitrary thenable or wait for asynchronous declarations.
            if (result instanceof Promise) {
                try { void Promise.prototype.then.call(result, undefined, () => {}); } catch { /* Best-effort observation only. */ }
                throw invalidFactory();
            }
            return seal(result);
        })();
        checkSignal();
        const { types, canonical, definitions } = sealed;
        context.defineViewTypes(definitions);
        checkSignal();
        const build = (builder: () => readonly ViewFrame[]): AppProjectionFrame => {
            if (typeof builder !== 'function' || Object.getPrototypeOf(builder) === Object.getPrototypeOf(async () => {}))
                invalid('$.build', 'Projection builder must be synchronous');
            const capture = createRefCapture();
            const views: AppProjectionFrame['views'][number][] = [];
            for (const frame of dense(builder(), DEFAULT_SNAPSHOT_LIMITS.maxViews, '$.views')) {
                const entry = frames.get(frame as object);
                if (!entry) invalid('$.views', 'Expected a ViewFrame created by a View handle');
                const { handle, placement, output } = entry;
                const type = requireViewType(types, entry.type);
                const label = placement.id ?? placement.idPrefix ?? type.name;
                const path = 'View ' + label;
                const { body, name, refs = [], context, bindingKey } = output;
                if (typeof body !== 'string') invalid(path, 'Expected a Markdown body');

                const refIds = new Set<string>();
                const captured: AppProjectionFrame['views'][number]['refs'][number][] = [];
                for (const item of refs) {
                    const ref = capturePublication(label, capture, item);
                    if (refIds.has(ref.id)) invalid(path + '.refs', 'Ref IDs must be unique within this View');
                    refIds.add(ref.id);
                    captured.push(ref);
                }
                const onClose = captureViewClose(type, label, context);
                views.push({
                    ...placement, ...(name === undefined ? {} : { name }), ...(bindingKey === undefined ? {} : { bindingKey }), type: type.name, owner: handle, content: { format: MARKDOWN_VIEW_FORMAT, value: body }, refs: captured,
                    bindings: captureViewBindings(type, label, context),
                    ...(onClose === undefined ? {} : { onClose }),
                });
            }
            return { views };
        };
        const result = await initializeAuthor({
            appId, desktopId, signal, projectionLimits,
            ...(launchConfig === undefined ? {} : { launchConfig }),
            registerLifecycle: callbacks => { appLifecycle.register(callbacks); },
            publish(builder, options) {
                return context.publishFrame(() => build(builder), options);
            },
            readViewId: handle => context.readViewId(handle),
            requestAttention: () => context.requestAttention(),
        }, canonical);
        if (result !== undefined) throw Object.assign(new Error('App initialize must return void; use registerLifecycle'),
            { code: 'APP_INVALID_INSTANCE', path: 'initialize' });
    }
}
