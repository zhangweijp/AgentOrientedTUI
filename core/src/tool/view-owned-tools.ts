import type { ToolResult, ToolResultData } from './tool-result.js';
import { canonicalJson, checkJsonLimits, copyJson, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import { DEFAULT_SNAPSHOT_LIMITS, MAX_VIEW_TOOL_BINDINGS, VIEW_METADATA_BYTES } from '../snapshot/snapshot-support.js';
import type { JsonValue, ToolDescriptor, ToolRoute, ViewToolBinding, ViewToolReceiver } from '../snapshot/types.js';
import { isInstanceName, isViewTypeName, type ViewMultiplicity } from '../snapshot/types.js';
import { compileToolParameters, type ToolParameterContract } from './tool-parameters.js';
import type { ViewToolInvocationTerminal } from './invocation-terminal.js';

/** One shared business contract for an operation on a ViewType. */
interface AppTypeToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface AppViewTypeDefinition {
    readonly name: string;
    readonly multiplicity: ViewMultiplicity;
    readonly tools: readonly AppTypeToolDefinition[];
}

/** One candidate handler on one View. Functions stay in the App execution environment. */
export interface AppFrameBinding {
    readonly name: string;
    readonly enabled: boolean;
    readonly execute: (args: Readonly<Record<string, unknown>>) => ToolResult | Promise<ToolResult>;
}

export interface ViewInstance {
    readonly viewId: string;
    readonly viewType: string;
    readonly viewInstanceId: string;
}

export interface ViewOwnedToolLimits {
    readonly maxViews: number;
    readonly maxBindings: number;
    readonly maxRetainedBytes: number;
}
export interface ViewOwnedToolsStats {
    readonly state: 'active' | 'disposed';
    readonly views: number;
    readonly bindings: number;
    readonly retainedBytes: number;
}

type Tool = { readonly descriptor: ToolDescriptor; readonly contract: ToolParameterContract };
type Binding = ViewToolBinding & Pick<AppFrameBinding, 'execute'>;
type Mounted = {
    readonly owner: object;
    readonly view: ViewInstance;
    readonly bindings: ReadonlyMap<string, Binding>;
    readonly naming: string;
    readonly bindingKey?: string | number;
    readonly closeActivationId?: string;
    readonly onClose?: ViewCandidate['onClose'];
};
type ViewCandidate = {
    readonly id?: string;
    readonly idPrefix?: string;
    readonly type: string;
    readonly owner: object;
    readonly bindings: readonly AppFrameBinding[];
    readonly bindingKey?: string | number;
    readonly onClose?: () => ToolResult | Promise<ToolResult>;
};

export class ViewToolContractError extends Error {
    constructor(readonly code: string, message: string, readonly path?: string) {
        super(code + ': ' + message);
        this.name = 'ViewToolContractError';
    }
}

function fail(code: string, message: string): never {
    throw new ViewToolContractError(code, message);
}

function rejected(code: string, message: string): ToolResultData {
    return { success: false, error: { code, message } };
}

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** Owns the committed View identities and their enabled operations for one App instance. */
export function createViewOwnedTools(appId: string, appInstanceId: string, limits: Partial<ViewOwnedToolLimits> = {}) {
    const ceilings: ViewOwnedToolLimits = {
        maxViews: DEFAULT_SNAPSHOT_LIMITS.maxViews, maxBindings: MAX_VIEW_TOOL_BINDINGS, maxRetainedBytes: 32 * 1024 * 1024,
    };
    for (const key of Reflect.ownKeys(limits)) {
        if (typeof key !== 'string' || !Object.hasOwn(ceilings, key)) throw new RangeError('Unknown View-owned limit');
    }
    const { maxViews = ceilings.maxViews, maxBindings = ceilings.maxBindings, maxRetainedBytes = ceilings.maxRetainedBytes } = limits;
    for (const [key, value] of Object.entries({ maxViews, maxBindings, maxRetainedBytes })) {
        if (!Number.isSafeInteger(value) || value < 0 || value > ceilings[key as keyof ViewOwnedToolLimits])
            throw new RangeError(key + ' must be a safe integer within its hard limit');
    }
    if (!nonEmpty(appId) || !nonEmpty(appInstanceId)) fail('VIEW_INVALID', 'App and instance IDs are required');
    if (appId.length + appInstanceId.length > maxRetainedBytes) fail('VIEW_CAPACITY', 'App identity exceeds retention limit');
    let staticBytes = utf8Size(canonicalJson({ appId, appInstanceId }));
    if (staticBytes > maxRetainedBytes) fail('VIEW_CAPACITY', 'App identity exceeds retention limit');

    let disposed = false;
    let defined = false;
    let mounted = new Map<string, Mounted>();
    let declared = new Map<string, { multiplicity: ViewMultiplicity; tools: ReadonlyMap<string, Tool> }>();
    let sequences = new Map<string, number>();
    let mountSequence = 0;
    let activationSequence = 0;
    let bindingCount = 0;
    let liveBytes = 0;

    function assertActive(): void {
        if (disposed) fail('VIEW_REGISTRY_CLOSED', 'View registry is closed');
    }

    function identity(id: string, type: string, sequence: number): ViewInstance {
        if (!isInstanceName(id)) fail('VIEW_INVALID', 'Expected a View ID using ASCII letters, digits or underscores, with at least one nondigit');
        if (id.length + type.length > maxRetainedBytes) fail('VIEW_CAPACITY', 'View identity exceeds retention limit');
        if (!Number.isSafeInteger(sequence)) fail('VIEW_CAPACITY', 'View mount sequence exhausted');
        return Object.freeze({ viewId: id, viewType: type, viewInstanceId: 'm:' + sequence });
    }

    function current(tool: ToolRoute, receiver: ViewToolReceiver) {
        const view = mounted.get(receiver.viewId);
        if (view?.view.viewInstanceId !== receiver.viewInstanceId || view.view.viewType !== tool.viewType)
            return { error: rejected('VIEW_INSTANCE_REVOKED', 'The receiving View was closed or replaced. Observe the current Views.') };
        const binding = view.bindings.get(tool.id);
        if (!binding || binding.activationId !== receiver.activationId)
            return { error: rejected('TOOL_SOURCE_STALE', 'The receiving View no longer has this Tool activation. Observe the current Tools.') };
        const declaration = declared.get(tool.viewType)?.tools.get(tool.name);
        if (!declaration || declaration.descriptor.id !== tool.id)
            return { error: rejected('TOOL_SOURCE_CONFLICT', 'Tool definition does not match the current ViewType') };
        return { binding, contract: declaration.contract };
    }

    return Object.freeze({
        defineViewTypes(definitions: readonly AppViewTypeDefinition[]): void {
            assertActive();
            if (defined) fail('TOOL_DUPLICATE', 'App Tool definitions were already supplied');
            if (!Array.isArray(definitions) || definitions.length > DEFAULT_SNAPSHOT_LIMITS.maxViews)
                fail('VIEW_CAPACITY', 'App ViewType definition limit exceeded');
            const types = new Map<string, { multiplicity: ViewMultiplicity; tools: Map<string, Tool> }>();
            let bytes = staticBytes;
            let toolCount = 0;
            for (const input of definitions) {
                const definition = copyJson(input, { maxDepth: 48, maxNodes: 120_000, maxApproxBytes: maxRetainedBytes }) as unknown as AppViewTypeDefinition;
                if (!definition || typeof definition !== 'object' || Array.isArray(definition) ||
                    Object.keys(definition).length !== 3 || !isViewTypeName(definition.name) ||
                    (definition.multiplicity !== 'single' && definition.multiplicity !== 'multiple') || !Array.isArray(definition.tools))
                    fail('VIEW_INVALID', 'Expected a ViewType name, multiplicity and Tool list');
                const { name: viewType, multiplicity } = definition;
                if (types.has(viewType)) fail('VIEW_DUPLICATE', 'Duplicate ViewType ' + viewType);
                bytes += utf8Size(canonicalJson({ viewType, multiplicity }));
                const tools = new Map<string, Tool>();
                for (const tool of definition.tools) {
                    if (++toolCount > DEFAULT_SNAPSHOT_LIMITS.maxTools) fail('TOOL_CAPACITY', 'App Tool definition limit exceeded');
                    if (!tool || typeof tool !== 'object' || Array.isArray(tool) || Object.keys(tool).length !== 3 ||
                        !nonEmpty(tool.name) || !nonEmpty(tool.description) || !Object.hasOwn(tool, 'inputSchema'))
                        fail('TOOL_INVALID', 'Expected a Tool name, description and input schema');
                    checkJsonLimits(tool as unknown as JsonValue, { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 });
                    const { name, description } = tool;
                    if (tools.has(name)) fail('TOOL_DUPLICATE', 'Duplicate Tool ' + viewType + '.' + name);
                    const compiled = compileToolParameters(tool.inputSchema);
                    if (!compiled.ok) {
                        const { code, message, path } = compiled.issue;
                        throw new ViewToolContractError(code === 'PARAMETER_DECLARATION_CAPACITY' ? 'TOOL_SCHEMA_CAPACITY' : code, message, path);
                    }
                    const inputSchema = compiled.contract.schema;
                    const descriptor = { id: JSON.stringify([appId, viewType, name]), viewType, multiplicity, name, description, inputSchema };
                    bytes += utf8Size(canonicalJson(descriptor));
                    if (bytes > maxRetainedBytes) fail('TOOL_CAPACITY', 'App Tool definitions exceed retention limit');
                    tools.set(name, { descriptor, contract: compiled.contract });
                }
                if (bytes > maxRetainedBytes) fail('TOOL_CAPACITY', 'App Tool definitions exceed retention limit');
                types.set(viewType, { multiplicity, tools });
            }
            assertActive();
            if (defined || mounted.size) fail('TOOL_DUPLICATE', 'App Tool definitions must precede View publication');
            for (const type of types.values()) for (const { descriptor } of type.tools.values()) Object.freeze(descriptor);
            declared = types;
            staticBytes = bytes;
            defined = true;
        },

        /** Build the entire next inventory without changing any currently executable handler. */
        prepareFrame(views: readonly ViewCandidate[], resetActivations = false) {
            assertActive();
            if (!Array.isArray(views) || views.length > maxViews) fail('VIEW_CAPACITY', 'App frame exceeds the View limit');
            const previous = mounted;
            const next = new Map<string, Mounted>();
            const previousByOwner = new Map([...previous.values()].map(entry => [entry.owner, entry]));
            const occupied = new Set(views.flatMap(({ owner }) => {
                const prior = previousByOwner.get(owner);
                return prior ? [prior.view.viewId] : [];
            }));
            const nextSequences = new Map(sequences);
            let nextMountSequence = mountSequence;
            let nextActivationSequence = activationSequence;
            const owners = new Set<object>();
            const singles = new Set<string>();
            const tools = new Map<string, ToolDescriptor>();
            let bytes = 0;
            let count = 0;
            let entries = 0;

            // Pass 1: validate every candidate and reserve fixed single-instance IDs
            // before allocating any multi-instance sequences, so frame order never collides.
            const staged = views.map(({ id: override, idPrefix, type, owner, bindings, onClose, bindingKey }, index) => {
                if (owners.has(owner)) fail('VIEW_DUPLICATE', 'Duplicate View owner for ' + type);
                if (!owner || typeof owner !== 'object') fail('VIEW_INVALID', 'View requires a stable owner');
                owners.add(owner);
                if (bindingKey !== undefined) {
                    const path = '$.views[' + index + '].bindingKey';
                    if (!(typeof bindingKey === 'string' || typeof bindingKey === 'number' && Number.isSafeInteger(bindingKey) && !Object.is(bindingKey, -0)))
                        throw new SnapshotDataError('TOOL_BINDING_INVALID', path, 'Expected a string or safe integer other than negative zero');
                    if (utf8Size(canonicalJson(bindingKey)) > VIEW_METADATA_BYTES)
                        throw new SnapshotDataError('TOOL_BINDING_INVALID', path, 'Binding key exceeds View metadata budget');
                    bytes += utf8Size(canonicalJson(bindingKey));
                }
                const definition = declared.get(type);
                if (!definition) fail('VIEW_INVALID', 'Register ViewType ' + type + ' before mounting it');
                const single = definition.multiplicity === 'single';
                if (single && idPrefix !== undefined || !single && override !== undefined)
                    fail('VIEW_INVALID', 'ViewType ' + type + ' requires naming options matching its multiplicity');
                if (single && singles.has(type)) fail('VIEW_DUPLICATE', 'Single ViewType ' + type + ' already has a mount');
                if (single) singles.add(type);
                const naming = (single ? override : idPrefix) ?? type;
                if (!isInstanceName(naming)) fail('VIEW_INVALID', 'Invalid ID or prefix for ViewType ' + type);
                const continuous = previousByOwner.get(owner);
                if (continuous && (continuous.view.viewType !== type || continuous.naming !== naming))
                    fail('VIEW_INVALID', 'Remount ViewType ' + type + ' to change its ID or prefix');
                if (!continuous && single) {
                    if (occupied.has(naming)) {
                        throw new SnapshotDataError('SNAPSHOT_INVALID', 'ViewType ' + type + '.id', 'View ID already occupied: ' + naming);
                    }
                    occupied.add(naming);
                }
                return { definition, single, naming, continuous, type, owner, bindings, onClose, bindingKey };
            });

            // Pass 2: assign sequential IDs for newly opened multi-instance Views and bind Tools.
            const instances = staged.map(({ definition, single, naming, continuous, type, owner, bindings, onClose, bindingKey }) => {
                let id = continuous?.view.viewId ?? naming;
                if (!continuous && !single) {
                    let sequence = nextSequences.get(naming) ?? 0;
                    do {
                        sequence++;
                        if (!Number.isSafeInteger(sequence)) fail('VIEW_CAPACITY', 'View sequence exhausted for ' + naming);
                        id = naming + '_' + sequence;
                    } while (occupied.has(id));
                    nextSequences.set(naming, sequence);
                    occupied.add(id);
                }
                const view = continuous?.view ?? identity(id, type, ++nextMountSequence);
                if (onClose !== undefined && typeof onClose !== 'function')
                    throw new SnapshotDataError('SNAPSHOT_INVALID', `View ${id}.onClose`, 'Expected a close callback');
                const definitions = definition.tools;
                if (!Array.isArray(bindings) || bindings.length !== (definitions?.size ?? 0))
                    throw new SnapshotDataError('TOOL_BINDING_INVALID', `View ${id}`, 'Expected one binding for each ViewType operation');
                entries += bindings.length;
                if (entries > maxBindings) fail('TOOL_CAPACITY', 'App frame exceeds the View Tool binding limit');
                bytes += utf8Size(canonicalJson(view as unknown as JsonValue));
                const reset = resetActivations || !Object.is(continuous?.bindingKey, bindingKey);
                const active = new Map<string, Binding>();
                const seen = new Set<string>();
                const toolBindings: ViewToolBinding[] = [];
                for (const { name, execute, enabled } of bindings) {
                    const tool = definitions?.get(name);
                    if (!tool || seen.has(name) || typeof execute !== 'function' || typeof enabled !== 'boolean')
                        throw new SnapshotDataError('TOOL_BINDING_INVALID', `View ${id}`, 'Invalid or duplicate View Tool binding');
                    seen.add(name);
                    if (!enabled) continue;
                    const toolId = tool.descriptor.id;
                    // A recovered frame needs a newly adopted tool binding even on an unchanged mount.
                    const old = reset ? undefined : continuous?.bindings.get(toolId);
                    if (!old && nextActivationSequence >= Number.MAX_SAFE_INTEGER) fail('TOOL_CAPACITY', 'Tool activation sequence exhausted');
                    const activationId = old?.activationId ?? 'a:' + ++nextActivationSequence;
                    const reference = Object.freeze({ toolId, activationId });
                    bytes += utf8Size(canonicalJson(reference));
                    count++;
                    active.set(toolId, { ...reference, execute });
                    tools.set(toolId, tool.descriptor);
                    toolBindings.push(reference);
                }
                let closeActivationId: string | undefined;
                if (onClose) {
                    if (!reset && continuous?.closeActivationId) closeActivationId = continuous.closeActivationId;
                    else {
                        if (nextActivationSequence >= Number.MAX_SAFE_INTEGER) fail('TOOL_CAPACITY', 'Close activation sequence exhausted');
                        closeActivationId = 'a:' + ++nextActivationSequence;
                    }
                    bytes += utf8Size(closeActivationId);
                    if (++entries > maxBindings) fail('TOOL_CAPACITY', 'App frame exceeds the View binding limit');
                    count++;
                }
                if (bytes + staticBytes > maxRetainedBytes) fail('TOOL_CAPACITY', 'View Tool retention limit exceeded');
                next.set(id, { owner, view, naming, bindings: active, ...(bindingKey === undefined ? {} : { bindingKey }),
                    ...(onClose ? { onClose, closeActivationId: closeActivationId! } : {}) });
                return { ...view, toolBindings: Object.freeze(toolBindings), ...(closeActivationId ? { closeActivationId } : {}) };
            });
            // Prefix counters survive unmounts. Charge every retained pair, including
            // counter digit growth, before the inventory and its accounting are installed.
            for (const entry of nextSequences) {
                bytes += utf8Size(canonicalJson(entry));
                if (bytes + staticBytes > maxRetainedBytes) fail('TOOL_CAPACITY', 'View Tool retention limit exceeded');
            }
            return {
                instances,
                tools: [...tools.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
                accept() {
                    assertActive();
                    if (mounted !== previous) fail('VIEW_INVALID', 'Prepared View inventory was superseded');
                    mounted = next;
                    sequences = nextSequences;
                    mountSequence = nextMountSequence;
                    activationSequence = nextActivationSequence;
                    liveBytes = bytes;
                    bindingCount = count;
                },
            };
        },

        viewTypes() {
            return Object.freeze([...declared].map(([name, { multiplicity }]) => Object.freeze({ name, multiplicity })));
        },
        getView(id: string): ViewInstance | undefined { return mounted.get(id)?.view; },
        readViewId(owner: object): string | undefined {
            for (const entry of mounted.values()) if (entry.owner === owner) return entry.view.viewId;
        },
        async closeView(viewId: string, viewInstanceId: string, closeActivationId: string): Promise<ViewToolInvocationTerminal> {
            const selected = mounted.get(viewId);
            if (selected?.view.viewInstanceId !== viewInstanceId)
                return { phase: 'not-entered', result: rejected('VIEW_INSTANCE_REVOKED', 'The selected View closed or was replaced.') };
            const close = selected.onClose;
            if (!close || selected.closeActivationId !== closeActivationId) return { phase: 'not-entered', result: rejected('VIEW_CLOSE_SOURCE_STALE', 'The original close activation is no longer current.') };
            return { phase: 'entered-returned', result: await close() };
        },
        inspect(): ViewOwnedToolsStats {
            return { state: disposed ? 'disposed' : 'active', views: mounted.size, bindings: bindingCount, retainedBytes: staticBytes + liveBytes };
        },
        validateTypeToolBinding(tool: ToolRoute, receiver: ViewToolReceiver): ToolResultData {
            return current(tool, receiver).error ?? { success: true };
        },
        async invokeTypeTool(tool: ToolRoute, receiver: ViewToolReceiver,
            args: Readonly<Record<string, unknown>>): Promise<ViewToolInvocationTerminal> {
            const initial = current(tool, receiver);
            if (initial.error) return { phase: 'not-entered', result: initial.error };
            const validated = initial.contract!.validateResolvedInput(args);
            if (!validated.ok || Object.hasOwn(validated.value, 'view_id'))
                return { phase: 'not-entered', result: rejected('E_INVALID_ARGS', 'Expected only valid business arguments') };
            const selected = current(tool, receiver);
            if (selected.error) return { phase: 'not-entered', result: selected.error };
            // Call synchronously after checking the current instance and activation.
            const execute = selected.binding!.execute;
            const result = await execute(validated.value);
            return { phase: 'entered-returned', result };
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            mounted = new Map();
            declared.clear();
            sequences.clear();
            staticBytes = liveBytes = bindingCount = 0;
            appId = appInstanceId = '';
        },
    });
}
