import { isCreateIfAbsentSchema, matchesCreateIfAbsentInput, type CreateIfAbsentTerminal } from './create-if-absent-contract.js';
import { compileOrdinaryProfile, ORDINARY_PARAMETER_MARKER } from './ordinary-parameter-profile.js';
import { compileSnapshotValueProfile } from './snapshot-value-parameter-contract.js';
import { validateVersionedToolRefDeclarations } from './versioned-ref-declarations.js';
import type { OperationResult } from '../../spi/core/operations.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { validateToolRefDeclarations } from './ref-declarations.js';
import type { SafeRefInvoker, SafeCreateIfAbsentInvoker, RefV1Terminal } from './invocation-terminal.js';

export function isClosedEmptyOrdinarySchema(value: unknown): boolean {
    try { return canonicalJson(copyJson(value, {maxDepth:2,maxNodes:5,maxApproxBytes:256})) ===
        '{"additionalProperties":false,"properties":{},"required":[],"type":"object"}'; } catch { return false; }
}

export interface ViewInstance {
    readonly viewId: string;
    readonly viewType: string;
    readonly viewInstanceId: string;
}

export interface ViewToolSpec {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonValue;
    readonly isMutating: boolean;
}

export interface ToolTarget {
    readonly viewId: string;
    readonly viewInstanceId: string;
    /** Changes when this View's Tool is re-registered or its availability changes. */
    readonly bindingVersion: number;
}

/** An observation for a future AppSnapshot producer, NOT an execution permit. */
export interface AggregatedViewTool extends ViewToolSpec {
    readonly id: string;
    readonly appId: string;
    readonly appInstanceId: string;
    readonly viewType: string;
    readonly targets: readonly ToolTarget[];
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

type Handler = (args: Readonly<Record<string, unknown>>) => OperationResult | Promise<OperationResult>;
type ToolRegistration = {
    readonly token: object;
    readonly spec: Readonly<ViewToolSpec>;
    readonly canonical: string;
    readonly handler: Handler;
    enabled: boolean;
    bindingVersion: number;
    readonly safeCreate?:Readonly<{handler:Handler;invoke:SafeCreateIfAbsentInvoker;viewInstanceId:string;bindingVersion:number}>;
    readonly safeInvocation?: Readonly<{ mode: 'snapshot-value-v1' | 'snapshot-value-v2' | 'ordinary-v1' | 'ordinary-v2'; handler: Handler;
        invoke: SafeRefInvoker; viewInstanceId: string; bindingVersion: number }>;
};

export class ViewToolContractError extends Error {
    constructor(readonly code: string, message: string) {
        super(code + ': ' + message);
        this.name = 'ViewToolContractError';
    }
}

function nonEmpty(value: string, label: string): void {
    if (typeof value !== 'string' || !value.trim()) {
        throw new ViewToolContractError('TOOL_INVALID', label + ' must be non-empty');
    }
}

function failure(code: string, message: string): OperationResult {
    return { success: false, error: { code, message } };
}

/**
 * Internal M4-preflight: one App instance, its live View identities and Tool bindings.
 *
 * No DOM/Worker/model imports. Does not publish snapshots or authorize external
 * calls. A future M4 adapter must obtain the observed target from a validated,
 * pinned Runtime-owned AppSnapshot before invoking this registry.
 */
export function createViewOwnedTools(appId: string, appInstanceId: string, limits: Partial<ViewOwnedToolLimits> = {}) {
    const ceilings: ViewOwnedToolLimits = { maxViews: 1000, maxBindings: 10000, maxRetainedBytes: 32 * 1024 * 1024 };
    for (const key of Reflect.ownKeys(limits)) {
        if (typeof key !== 'string' || !Object.hasOwn(ceilings, key)) throw new RangeError('Unknown View-owned limit');
    }
    const captured = {
        maxViews: limits.maxViews === undefined ? ceilings.maxViews : limits.maxViews,
        maxBindings: limits.maxBindings === undefined ? ceilings.maxBindings : limits.maxBindings,
        maxRetainedBytes: limits.maxRetainedBytes === undefined ? ceilings.maxRetainedBytes : limits.maxRetainedBytes,
    };
    for (const key of Object.keys(ceilings) as Array<keyof ViewOwnedToolLimits>) {
        const value = captured[key];
        if (!Number.isSafeInteger(value) || value < 0 || value > ceilings[key]) throw new RangeError(key + ' must be a safe integer within its hard limit');
    }
    if (typeof appId === 'string' && typeof appInstanceId === 'string' && appId.length + appInstanceId.length > captured.maxRetainedBytes) {
        throw new ViewToolContractError('VIEW_CAPACITY', 'App identity exceeds maxRetainedBytes');
    }
    nonEmpty(appId, 'appId');
    nonEmpty(appInstanceId, 'appInstanceId');
    let retainedBytes = utf8Size(canonicalJson({ appId, appInstanceId }));
    if (retainedBytes > captured.maxRetainedBytes) throw new ViewToolContractError('VIEW_CAPACITY', 'App identity exceeds maxRetainedBytes');
    let disposed = false;
    let bindingCount = 0;

    const byViewId = new Map<string, string>();
    const byInstanceId = new Map<string, ViewInstance>();
    const bindings = new Map<string, Map<string, ToolRegistration>>();
    let mountSequence = 0;
    let bindingSequence = 0;

    function assertActive(): void {
        if (disposed) throw new ViewToolContractError('VIEW_REGISTRY_CLOSED', 'View-owned Registry is closed');
    }
    function viewBytes(view: ViewInstance): number {
        return utf8Size(canonicalJson(view as unknown as JsonValue));
    }
    function cleanup(viewInstanceId: string, name: string, token: object): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const tools = bindings.get(viewInstanceId), registration = tools?.get(name);
            if (registration?.token !== token) return;
            retainedBytes -= utf8Size(registration.canonical);
            bindingCount--;
            tools!.delete(name);
        };
    }

    function issueBindingVersion(): number {
        if (bindingSequence >= Number.MAX_SAFE_INTEGER) {
            throw new ViewToolContractError('TOOL_CAPACITY', 'Tool binding sequence exhausted');
        }
        return ++bindingSequence;
    }

    function current(instanceId: string): ViewInstance {
        const view = byInstanceId.get(instanceId);
        if (!view) {
            throw new ViewToolContractError('VIEW_INSTANCE_REVOKED', 'View instance no longer exists');
        }
        return view;
    }

    function toolId(viewType: string, name: string): string {
        // Structured ID is unambiguous. The Agent-facing tool name is adapter-owned.
        return JSON.stringify([appId, viewType, name]);
    }

    function validate(
        observedTool: AggregatedViewTool,
        observedTarget: ToolTarget,
    ): OperationResult {
        if (disposed) return failure('VIEW_INSTANCE_REVOKED', 'View-owned Registry is closed');
        if (observedTool.appId !== appId || observedTool.appInstanceId !== appInstanceId) {
            return failure('APP_INSTANCE_MISMATCH', 'Tool source is from another App instance');
        }
        if (observedTool.id !== toolId(observedTool.viewType, observedTool.name) ||
            !observedTool.targets.some(target =>
                target.viewId === observedTarget.viewId &&
                target.viewInstanceId === observedTarget.viewInstanceId &&
                target.bindingVersion === observedTarget.bindingVersion)) {
            return failure('TOOL_SOURCE_CONFLICT', 'Target is not part of the source Tool observation');
        }
        const view = byInstanceId.get(observedTarget.viewInstanceId);
        if (!view || view.viewId !== observedTarget.viewId ||
            view.viewType !== observedTool.viewType) {
            return failure('VIEW_INSTANCE_REVOKED', 'Original target View instance is no longer mounted');
        }
        const registered = bindings.get(view.viewInstanceId)?.get(observedTool.name);
        if (!registered || !registered.enabled) {
            return failure('TOOL_UNAVAILABLE', 'Tool is no longer enabled in the target View');
        }
        if (registered.bindingVersion !== observedTarget.bindingVersion ||
            registered.canonical !== canonicalJson({
                name: observedTool.name, description: observedTool.description,
                inputSchema: observedTool.inputSchema, isMutating: observedTool.isMutating,
            } as JsonValue)) {
            return failure('TOOL_SOURCE_STALE', 'Tool binding changed since the source observation');
        }
        return { success: true };
    }

    function validateRefBinding(observedTool: AggregatedViewTool, observedTarget: ToolTarget): OperationResult {
        const live = validate(observedTool, observedTarget);
        if (!live.success) return live;
        const registered = bindings.get(observedTarget.viewInstanceId)!.get(observedTool.name)!;
        const safe = registered.safeInvocation;
        return !Object.hasOwn(observedTool.inputSchema as object, ORDINARY_PARAMETER_MARKER) && safe?.mode === 'snapshot-value-v1' && typeof safe.invoke === 'function' && safe.handler === registered.handler &&
            safe.viewInstanceId === observedTarget.viewInstanceId && safe.bindingVersion === registered.bindingVersion
            ? { success: true }
            : failure('REF_EXECUTION_UNAVAILABLE', 'Current Tool binding has no safe Ref wrapper');
    }

    function validateOrdinaryBinding(tool: AggregatedViewTool, target: ToolTarget): OperationResult {
        const live = validate(tool,target);
        if (!live.success) return live;
        const registered = bindings.get(target.viewInstanceId)!.get(tool.name)!;
        const safe = registered.safeInvocation;
        return !tool.isMutating && isClosedEmptyOrdinarySchema(tool.inputSchema) && safe?.mode === 'ordinary-v1' &&
            typeof safe.invoke === 'function' && safe.handler === registered.handler && safe.viewInstanceId === target.viewInstanceId &&
            safe.bindingVersion === registered.bindingVersion ? {success:true} : failure('TOOL_EXECUTION_UNAVAILABLE','Current Tool has no safe ordinary wrapper');
    }

    function validateCreateIfAbsentBinding(tool:AggregatedViewTool,target:ToolTarget):OperationResult {
        const live=validate(tool,target);if(!live.success)return live;
        const registered=bindings.get(target.viewInstanceId)!.get(tool.name)!,safe=registered.safeCreate;
        return tool.isMutating && isCreateIfAbsentSchema(tool.inputSchema) && safe && typeof safe.invoke==='function' &&
            safe.handler===registered.handler && safe.viewInstanceId===target.viewInstanceId && safe.bindingVersion===registered.bindingVersion
            ? {success:true} : failure('TOOL_EXECUTION_UNAVAILABLE','Current Tool has no safe creation callable');
    }

    function validateOrdinaryParametersBinding(tool: AggregatedViewTool, target: ToolTarget): OperationResult {
        const live = validate(tool, target);
        if (!live.success) return live;
        const registered = bindings.get(target.viewInstanceId)!.get(tool.name)!, safe = registered.safeInvocation;
        return safe?.mode === 'ordinary-v2' && typeof safe.invoke === 'function' &&
            safe.handler === registered.handler && safe.viewInstanceId === target.viewInstanceId &&
            safe.bindingVersion === registered.bindingVersion ? { success: true }
            : failure('TOOL_EXECUTION_UNAVAILABLE', 'Current Tool has no safe ordinary-v2 callable');
    }

    function validateSnapshotValueParametersBinding(tool: AggregatedViewTool, target: ToolTarget): OperationResult {
        const live = validate(tool, target);
        if (!live.success) return live;
        const registered = bindings.get(target.viewInstanceId)!.get(tool.name)!, safe = registered.safeInvocation;
        return !tool.isMutating && safe?.mode === 'snapshot-value-v2' && typeof safe.invoke === 'function' &&
            safe.handler === registered.handler && safe.viewInstanceId === target.viewInstanceId &&
            safe.bindingVersion === registered.bindingVersion ? { success: true }
            : failure('REF_EXECUTION_UNAVAILABLE', 'Current Tool has no safe Ref V2 callable');
    }

    return Object.freeze({
        dispose(): void {
            if (disposed) return;
            disposed = true;
            byViewId.clear();
            byInstanceId.clear();
            bindings.clear();
            retainedBytes = 0;
            bindingCount = 0;
            appId = '';
            appInstanceId = '';
        },
        inspect(): Readonly<ViewOwnedToolsStats> {
            return Object.freeze({ state: disposed ? 'disposed' : 'active', views: byInstanceId.size,
                bindings: bindingCount, retainedBytes });
        },
        validate,
        validateRefBinding,
        validateOrdinaryBinding,
        validateOrdinaryParametersBinding,
        validateSnapshotValueParametersBinding,
        invokeSnapshotValueParameters(tool: AggregatedViewTool, target: ToolTarget, args: Readonly<Record<string, unknown>>): RefV1Terminal | Promise<RefV1Terminal> {
            const live = validateSnapshotValueParametersBinding(tool, target);
            if (!live.success) return { phase: 'not-entered', result: live };
            return bindings.get(target.viewInstanceId)!.get(tool.name)!.safeInvocation!.invoke(args);
        },
        invokeOrdinaryParameters(tool: AggregatedViewTool, target: ToolTarget, args: Readonly<Record<string, unknown>>): RefV1Terminal | Promise<RefV1Terminal> {
            const live = validateOrdinaryParametersBinding(tool, target);
            if (!live.success) return { phase: 'not-entered', result: live };
            // No yield between the final identity check and the private SDK helper entry.
            return bindings.get(target.viewInstanceId)!.get(tool.name)!.safeInvocation!.invoke(args);
        },
        validateCreateIfAbsentBinding,
        invokeCreateIfAbsent(tool:AggregatedViewTool,target:ToolTarget,args:Readonly<Record<string,unknown>>):CreateIfAbsentTerminal|Promise<CreateIfAbsentTerminal> {
            const live=validateCreateIfAbsentBinding(tool,target);
            if(!live.success)return {phase:'not-entered',outcome:{status:'rejected',code:live.error!.code,message:live.error!.message}};
            if(!matchesCreateIfAbsentInput(tool.inputSchema,args))return {phase:'not-entered',outcome:{status:'rejected',code:'E_INVALID_ARGS',message:'Expected exact required string arguments'}};
            return bindings.get(target.viewInstanceId)!.get(tool.name)!.safeCreate!.invoke(args);
        },
        invokeOrdinary(tool: AggregatedViewTool, target: ToolTarget, args: Readonly<Record<string, unknown>>): RefV1Terminal | Promise<RefV1Terminal> {
            const live = validateOrdinaryBinding(tool,target);
            if (!live.success) return {phase:'not-entered',result:live};
            try {
                const captured=copyJson(args,{maxDepth:1,maxNodes:1,maxApproxBytes:16});
                if (!captured || typeof captured!=='object' || Array.isArray(captured) || Reflect.ownKeys(captured).length) throw new Error();
            } catch { return {phase:'not-entered',result:failure('E_INVALID_ARGS','Expected empty Tool arguments')}; }
            return bindings.get(target.viewInstanceId)!.get(tool.name)!.safeInvocation!.invoke(args);
        },

        invokeRef(observedTool: AggregatedViewTool, observedTarget: ToolTarget,
            args: Readonly<Record<string, unknown>>): RefV1Terminal | Promise<RefV1Terminal> {
            const live = validateRefBinding(observedTool, observedTarget);
            if (!live.success) return { phase: 'not-entered', result: live };
            if (observedTool.isMutating) return { phase: 'not-entered',
                result: failure('TOOL_PERMISSION_DENIED', 'Ref protocol only supports read-only Tools') };
            // No yield between live validation, binding lookup and actual safe invocation.
            return bindings.get(observedTarget.viewInstanceId)!.get(observedTool.name)!.safeInvocation!.invoke(args);
        },

        mount(viewId: string, viewType: string): ViewInstance {
            assertActive();
            nonEmpty(viewId, 'viewId');
            nonEmpty(viewType, 'viewType');
            if (byViewId.has(viewId)) {
                throw new ViewToolContractError('VIEW_DUPLICATE', 'View ID already mounted: ' + viewId);
            }
            if (byInstanceId.size >= captured.maxViews || viewId.length + viewType.length > captured.maxRetainedBytes - retainedBytes) {
                throw new ViewToolContractError('VIEW_CAPACITY', 'View retention limit reached');
            }
            if (mountSequence >= Number.MAX_SAFE_INTEGER) {
                throw new ViewToolContractError('VIEW_CAPACITY', 'View mount sequence exhausted');
            }
            const instance: ViewInstance = Object.freeze({
                viewId,
                viewType,
                viewInstanceId: 'vi:v1:' + JSON.stringify([appInstanceId, mountSequence + 1]),
            });
            const bytes = viewBytes(instance);
            if (bytes > captured.maxRetainedBytes - retainedBytes) throw new ViewToolContractError('VIEW_CAPACITY', 'View exceeds maxRetainedBytes');
            mountSequence++;
            retainedBytes += bytes;
            byViewId.set(viewId, instance.viewInstanceId);
            byInstanceId.set(instance.viewInstanceId, instance);
            bindings.set(instance.viewInstanceId, new Map());
            return instance;
        },

        unmount(viewInstanceId: string): void {
            const view = byInstanceId.get(viewInstanceId);
            if (!view) return;
            retainedBytes -= viewBytes(view);
            for (const registration of bindings.get(viewInstanceId)!.values()) {
                retainedBytes -= utf8Size(registration.canonical);
                bindingCount--;
            }
            byInstanceId.delete(viewInstanceId);
            if (byViewId.get(view.viewId) === viewInstanceId) byViewId.delete(view.viewId);
            bindings.delete(viewInstanceId);
        },

        registerTool(
            viewInstanceId: string,
            spec: ViewToolSpec,
            handler: Handler,
            enabled = true,
            options?: Readonly<{ safeRefInvocationMode: 'snapshot-value-v1' } | { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' } | { safeOrdinaryInvocationMode: 'ordinary-v1' } | { safeOrdinaryParametersInvocationMode: 'ordinary-v2' } | {safeCreateIfAbsentInvocationMode:'create-if-absent-v1'}>,
            safeInvoker?: SafeRefInvoker | SafeCreateIfAbsentInvoker,
        ): () => void {
            assertActive();
            const view = current(viewInstanceId);
            // Inspect descriptors before reading fields; copying developer-owned
            // data must not execute getters or keep mutable aliases.
            const copied = copyJson(spec, {
                maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024,
            }) as unknown as Readonly<ViewToolSpec>;
            nonEmpty(copied.name, 'tool name');
            nonEmpty(copied.description, 'tool description');
            if (typeof handler !== 'function' || typeof enabled !== 'boolean' ||
                typeof copied.isMutating !== 'boolean' ||
                !copied.inputSchema || typeof copied.inputSchema !== 'object' ||
                Array.isArray(copied.inputSchema) ||
                (copied.inputSchema as Record<string, JsonValue>).type !== 'object' ||
                Object.keys(copied).length !== 4) {
                throw new ViewToolContractError('TOOL_INVALID', 'Invalid Tool definition');
            }
            validateVersionedToolRefDeclarations(copied.inputSchema, copied.isMutating);
            const currentTools = bindings.get(viewInstanceId)!;
            if (currentTools.has(copied.name)) {
                throw new ViewToolContractError('TOOL_DUPLICATE', 'Tool already registered in this View instance');
            }
            const canonical = canonicalJson(copied as unknown as JsonValue);
            if (options !== undefined) {
                const metadata = copyJson(options, { maxDepth: 1, maxNodes: 2, maxApproxBytes: 128 });
                if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object' ||
                    Object.keys(metadata).length !== 1 || !((metadata as Readonly<Record<string, JsonValue>>).safeRefInvocationMode === 'snapshot-value-v1' || (metadata as Readonly<Record<string, JsonValue>>).safeSnapshotValueParametersInvocationMode === 'snapshot-value-v2' || (metadata as Readonly<Record<string, JsonValue>>).safeOrdinaryInvocationMode === 'ordinary-v1' || (metadata as Readonly<Record<string, JsonValue>>).safeOrdinaryParametersInvocationMode === 'ordinary-v2' || (metadata as Readonly<Record<string, JsonValue>>).safeCreateIfAbsentInvocationMode === 'create-if-absent-v1')) {
                    throw new ViewToolContractError('TOOL_INVALID', 'Invalid Ref registration metadata');
                }
            }
            if (safeInvoker !== undefined && (options === undefined || typeof safeInvoker !== 'function')) {
                throw new ViewToolContractError('TOOL_INVALID', 'Invalid safe Ref callable');
            }

            const creation=options!==undefined && 'safeCreateIfAbsentInvocationMode' in options;
            const parameters = options !== undefined && 'safeOrdinaryParametersInvocationMode' in options;
            const snapshotParameters = options !== undefined && 'safeSnapshotValueParametersInvocationMode' in options;
            const snapshotProfile = compileSnapshotValueProfile(copied.inputSchema);
            if (options !== undefined && (snapshotProfile.ok !== snapshotParameters ||
                snapshotParameters && (typeof safeInvoker !== 'function' || copied.isMutating)))
                throw new ViewToolContractError('TOOL_INVALID', 'Ref V2 requires an exact profile, mode and safe callable');
            if (parameters && (typeof safeInvoker !== 'function' || !compileOrdinaryProfile(copied.inputSchema)))
                throw new ViewToolContractError('TOOL_INVALID', 'ordinary-v2 requires a safe callable and normalized ordinary profile');
            if(creation && (typeof safeInvoker!=='function' || !copied.isMutating || !isCreateIfAbsentSchema(copied.inputSchema))) {
                throw new ViewToolContractError('TOOL_INVALID','Creation requires a safe callable and closed string parameters');
            }

            // All same-type declarations must expose one identical public contract.
            // Do not pick the first registered handler or silently suffix Tool names.
            for (const [otherId, otherTools] of bindings) {
                if (otherId === viewInstanceId ||
                    byInstanceId.get(otherId)?.viewType !== view.viewType) continue;
                const other = otherTools.get(copied.name);
                if (other && other.canonical !== canonical) {
                    throw new ViewToolContractError(
                        'TOOL_SCHEMA_CONFLICT',
                        'Different public Tool contract for ' + view.viewType + '.' + copied.name,
                    );
                }
            }
            const bytes = utf8Size(canonical);
            if (bindingCount >= captured.maxBindings || bytes > captured.maxRetainedBytes - retainedBytes) {
                throw new ViewToolContractError('TOOL_CAPACITY', 'Tool retention limit reached');
            }
            const bindingVersion = issueBindingVersion();
            const registration: ToolRegistration = {
                token: {}, spec: copied, canonical, handler, enabled,
                bindingVersion,
                ...(creation ? {safeCreate:Object.freeze({handler,invoke:safeInvoker as SafeCreateIfAbsentInvoker,viewInstanceId,bindingVersion})} : {}),
                ...(options === undefined || safeInvoker === undefined || creation ? {} : { safeInvocation: Object.freeze({ mode: snapshotParameters ? 'snapshot-value-v2' as const : parameters ? 'ordinary-v2' as const : 'safeOrdinaryInvocationMode' in options ? 'ordinary-v1' as const : 'snapshot-value-v1' as const,
                    handler, invoke: safeInvoker as SafeRefInvoker, viewInstanceId, bindingVersion }) }),
            };
            currentTools.set(copied.name, registration);
            bindingCount++;
            retainedBytes += bytes;
            return cleanup(viewInstanceId, copied.name, registration.token);
        },

        setEnabled(viewInstanceId: string, name: string, enabled: boolean): void {
            assertActive();
            const viewTools = bindings.get(current(viewInstanceId).viewInstanceId)!;
            const registration = viewTools.get(name);
            if (!registration) throw new ViewToolContractError('TOOL_NOT_FOUND', 'Tool not registered');
            if (typeof enabled !== 'boolean') throw new ViewToolContractError('TOOL_INVALID', 'enabled must be boolean');
            if (registration.enabled === enabled) return;
            registration.bindingVersion = issueBindingVersion();
            registration.enabled = enabled;
        },

        /** Internal V2 Producer inventory; no Handler or live view object escapes. */
        listViews(): readonly ViewInstance[] {
            return Object.freeze([...byInstanceId.values()]
                .sort((a, b) => a.viewId < b.viewId ? -1 : a.viewId > b.viewId ? 1 : 0));
        },

        /** All outputs are detached metadata; no Handler reference ever escapes. */
        listTools(): readonly AggregatedViewTool[] {
            const grouped = new Map<string, {
                readonly viewType: string;
                readonly spec: Readonly<ViewToolSpec>;
                targets: ToolTarget[];
            }>();
            for (const [instanceId, view] of byInstanceId) {
                for (const registration of bindings.get(instanceId)!.values()) {
                    if (!registration.enabled) continue;
                    const id = toolId(view.viewType, registration.spec.name);
                    let group = grouped.get(id);
                    if (!group) {
                        group = { viewType: view.viewType, spec: registration.spec, targets: [] };
                        grouped.set(id, group);
                    }
                    group.targets.push(Object.freeze({
                        viewId: view.viewId,
                        viewInstanceId: instanceId,
                        bindingVersion: registration.bindingVersion,
                    }));
                }
            }
            return Object.freeze([...grouped].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, group]) =>
                Object.freeze({
                    id,
                    appId,
                    appInstanceId,
                    viewType: group.viewType,
                    ...group.spec,
                    targets: Object.freeze(group.targets.sort((a, b) => a.viewId < b.viewId ? -1 : a.viewId > b.viewId ? 1 : 0)),
                }),
            ));
        },

        /**
         * Expects a source Tool and target supplied by the future trusted M4 adapter.
         * Never re-resolves the public viewId to "whatever is mounted now".
         * Snapshot validation, user permissions and business CAS remain M4 duties.
         */
        async invoke(
            observedTool: AggregatedViewTool,
            observedTarget: ToolTarget,
            args: Readonly<Record<string, unknown>>,
        ): Promise<OperationResult> {
            const verified = validate(observedTool, observedTarget);
            if (!verified.success) return verified;
            const registered = bindings.get(observedTarget.viewInstanceId)!.get(observedTool.name)!;
            if (Object.hasOwn(registered.spec.inputSchema as object, ORDINARY_PARAMETER_MARKER))
                return failure('TOOL_EXECUTION_UNAVAILABLE', 'ordinary-v2 requires its negotiated safe channel');
            if (validateToolRefDeclarations(registered.spec.inputSchema, registered.spec.isMutating)) {
                return failure('REF_CONTRACT_UNSUPPORTED', 'Snapshot-value Ref execution is not implemented');
            }
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
                return failure('TOOL_INVALID_ARGS', 'Tool arguments must be an object');
            }
            try {
                const result = await registered.handler(args);
                if (!result || typeof result.success !== 'boolean') {
                    return failure('TOOL_RESULT_INVALID', 'Tool handler returned an invalid result');
                }
                return result; // Do not turn a business { success:false } into success.
            } catch (error) {
                return failure('TOOL_HANDLER_EXCEPTION',
                    error instanceof Error ? error.message : 'Tool execution failed');
            }
        },
    });
}
