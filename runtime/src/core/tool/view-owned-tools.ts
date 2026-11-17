import type { AppFrameBinding, AppTypeToolDefinition } from '../../spi/runtime/app-type-tools.interface.js';
import type { ToolResultData } from '../../spi/core/tool-result.js';
import { canonicalJson, copyJson, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import { DEFAULT_SNAPSHOT_LIMITS, MAX_VIEW_TOOL_BINDINGS } from '../snapshot/snapshot-support.js';
import type { JsonValue, ToolDescriptorV5, ToolInvocationDescriptor, ViewToolBinding, ViewToolReceiver } from '../snapshot/types.js';
import { compileOrdinarySchema, modelToolSchema, type OrdinaryParameterContract } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';
import type { ViewToolInvocationTerminal } from './invocation-terminal.js';
import { sameToolDefinition } from './source-binding.js';

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

type Tool = { readonly descriptor: ToolDescriptorV5; readonly contract: OrdinaryParameterContract };
type Binding = ViewToolBinding & Pick<AppFrameBinding, 'execute'>;
type Mounted = {
    readonly owner: object;
    readonly view: ViewInstance;
    readonly bindings: ReadonlyMap<string, Binding>;
};
type ViewCandidate = {
    readonly id: string;
    readonly type: string;
    readonly owner: object;
    readonly bindings: readonly AppFrameBinding[];
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
    let declared = new Map<string, ReadonlyMap<string, Tool>>();
    let mountSequence = 0;
    let activationSequence = 0;
    let bindingCount = 0;
    let liveBytes = 0;

    function assertActive(): void {
        if (disposed) fail('VIEW_REGISTRY_CLOSED', 'View registry is closed');
    }

    function identity(id: string, type: string): ViewInstance {
        if (!nonEmpty(id) || id.includes('.') || !nonEmpty(type)) fail('VIEW_INVALID', 'Expected a View type and an ID without a dot');
        if (id.length + type.length > maxRetainedBytes) fail('VIEW_CAPACITY', 'View identity exceeds retention limit');
        if (mountSequence >= Number.MAX_SAFE_INTEGER) fail('VIEW_CAPACITY', 'View mount sequence exhausted');
        return Object.freeze({ viewId: id, viewType: type, viewInstanceId: 'vi:v1:' + JSON.stringify([appInstanceId, ++mountSequence]) });
    }

    function current(tool: ToolInvocationDescriptor, receiver: ViewToolReceiver) {
        const view = mounted.get(receiver.viewId);
        if (view?.view.viewInstanceId !== receiver.viewInstanceId || view.view.viewType !== tool.viewType)
            return { error: rejected('VIEW_INSTANCE_REVOKED', 'The receiving View was closed or replaced. Observe the current Views.') };
        const binding = view.bindings.get(tool.id);
        if (!binding || binding.activationId !== receiver.activationId)
            return { error: rejected('TOOL_SOURCE_STALE', 'The receiving View no longer has this Tool activation. Observe the current Tools.') };
        const declaration = declared.get(tool.viewType)?.get(tool.name);
        if (!declaration || !sameToolDefinition(declaration.descriptor, tool))
            return { error: rejected('TOOL_SOURCE_CONFLICT', 'Tool definition does not match the current ViewType') };
        return { binding, contract: declaration.contract };
    }

    return Object.freeze({
        defineTools(definitions: readonly AppTypeToolDefinition[]): void {
            assertActive();
            if (defined) fail('TOOL_DUPLICATE', 'App Tool definitions were already supplied');
            if (!Array.isArray(definitions) || definitions.length > DEFAULT_SNAPSHOT_LIMITS.maxTools)
                fail('TOOL_CAPACITY', 'App Tool definition limit exceeded');
            const types = new Map<string, Map<string, Tool>>();
            const firstByName = new Map<string, { nameSharedAcrossViewTypes: boolean }>();
            let bytes = staticBytes;
            for (const input of definitions) {
                const definition = copyJson(input, { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 }) as unknown as AppTypeToolDefinition;
                if (!definition || typeof definition !== 'object' || Array.isArray(definition) ||
                    Object.keys(definition).length !== 4 || !nonEmpty(definition.viewType) ||
                    !nonEmpty(definition.name) || !nonEmpty(definition.description) || !Object.hasOwn(definition, 'inputSchema'))
                    fail('TOOL_INVALID', 'Expected four fields in a ViewType Tool definition');
                const { viewType, name, description } = definition;
                const type = types.get(viewType) ?? new Map<string, Tool>();
                if (type.has(name)) fail('TOOL_DUPLICATE', 'Duplicate Tool ' + viewType + '.' + name);
                const compiled = compileOrdinarySchema(definition.inputSchema);
                if (!compiled.ok) {
                    const { code, message, path } = compiled.issue;
                    throw new ViewToolContractError(code === 'PARAMETER_DECLARATION_CAPACITY' ? 'TOOL_SCHEMA_CAPACITY' : code, message, path);
                }
                const inputSchema = ordinaryParameterProfile(compiled.contract);
                modelToolSchema(inputSchema, viewType);
                const first = firstByName.get(name);
                const descriptor = { id: JSON.stringify([appId, viewType, name]), viewType, name, description, inputSchema,
                    nameSharedAcrossViewTypes: first !== undefined };
                if (!first) firstByName.set(name, descriptor);
                else if (!first.nameSharedAcrossViewTypes) {
                    first.nameSharedAcrossViewTypes = true;
                    bytes -= 1; // JSON true is one byte shorter than false.
                }
                bytes += utf8Size(canonicalJson(descriptor));
                if (bytes > maxRetainedBytes) fail('TOOL_CAPACITY', 'App Tool definitions exceed retention limit');
                type.set(name, { descriptor, contract: compiled.contract });
                types.set(viewType, type);
            }
            assertActive();
            if (defined || mounted.size) fail('TOOL_DUPLICATE', 'App Tool definitions must precede View publication');
            for (const type of types.values()) for (const { descriptor } of type.values()) Object.freeze(descriptor);
            declared = types;
            staticBytes = bytes;
            defined = true;
        },

        /** Build the entire next inventory without changing any currently executable handler. */
        prepareFrame(views: readonly ViewCandidate[]) {
            assertActive();
            if (!Array.isArray(views) || views.length > maxViews) fail('VIEW_CAPACITY', 'App frame exceeds the View limit');
            const previous = mounted;
            const next = new Map<string, Mounted>();
            const owners = new Set<object>();
            const tools = new Map<string, ToolDescriptorV5>();
            let bytes = 0;
            let count = 0;
            let entries = 0;
            const instances = views.map(({ id, type, owner, bindings }) => {
                if (next.has(id) || owners.has(owner)) fail('VIEW_DUPLICATE', 'Duplicate View in App frame: ' + id);
                if (!owner || typeof owner !== 'object') fail('VIEW_INVALID', 'View requires a stable owner');
                owners.add(owner);
                const prior = previous.get(id);
                const continuous = prior && prior.owner === owner && prior.view.viewType === type ? prior : undefined;
                const view = continuous?.view ?? identity(id, type);
                const definitions = declared.get(type);
                if (!Array.isArray(bindings) || bindings.length !== (definitions?.size ?? 0))
                    throw new SnapshotDataError('TOOL_BINDING_INVALID', `View ${id}`, 'Expected one binding for each ViewType operation');
                entries += bindings.length;
                if (entries > maxBindings) fail('TOOL_CAPACITY', 'App frame exceeds the View Tool binding limit');
                bytes += utf8Size(canonicalJson(view as unknown as JsonValue));
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
                    const old = continuous?.bindings.get(toolId);
                    if (!old && activationSequence >= Number.MAX_SAFE_INTEGER) fail('TOOL_CAPACITY', 'Tool activation sequence exhausted');
                    const activationId = old?.activationId ?? 'ta:v2:' + ++activationSequence;
                    const reference = Object.freeze({ toolId, activationId });
                    bytes += utf8Size(canonicalJson(reference));
                    count++;
                    active.set(toolId, { ...reference, execute });
                    tools.set(toolId, tool.descriptor);
                    toolBindings.push(reference);
                }
                if (bytes + staticBytes > maxRetainedBytes) fail('TOOL_CAPACITY', 'View Tool retention limit exceeded');
                next.set(id, { owner, view, bindings: active });
                return { ...view, toolBindings: Object.freeze(toolBindings) };
            });
            return {
                instances,
                tools: [...tools.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
                accept() {
                    assertActive();
                    if (mounted !== previous) fail('VIEW_INVALID', 'Prepared View inventory was superseded');
                    mounted = next;
                    liveBytes = bytes;
                    bindingCount = count;
                },
            };
        },

        getView(id: string): ViewInstance | undefined { return mounted.get(id)?.view; },
        listViews(): readonly ViewInstance[] { return [...mounted.values()].map(item => item.view); },
        inspect(): ViewOwnedToolsStats {
            return { state: disposed ? 'disposed' : 'active', views: mounted.size, bindings: bindingCount, retainedBytes: staticBytes + liveBytes };
        },
        validateTypeToolBinding(tool: ToolInvocationDescriptor, receiver: ViewToolReceiver): ToolResultData {
            return current(tool, receiver).error ?? { success: true };
        },
        getTypeToolContract(tool: ToolInvocationDescriptor, receiver: ViewToolReceiver): OrdinaryParameterContract | undefined {
            return current(tool, receiver).contract;
        },
        async invokeTypeTool(tool: ToolInvocationDescriptor, receiver: ViewToolReceiver,
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
            staticBytes = liveBytes = bindingCount = 0;
            appId = appInstanceId = '';
        },
    });
}
