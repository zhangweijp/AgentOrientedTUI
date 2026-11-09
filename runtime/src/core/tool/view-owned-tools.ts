import { ORDINARY_INVOCATION_MODE } from './invocation-terminal.js';
import { VIEW_TYPE_TOOL_PROTOCOL } from '../../spi/runtime/app-type-tools.interface.js';
import { compileOrdinarySchema, VIEW_TYPE_PARAMETERS_MODE, type OrdinaryParameterContract } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';
import type { ToolResultData } from '../../spi/core/tool-result.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { JsonValue, ObservedToolExecutionV3, ToolDescriptorV3 } from '../snapshot/types.js';
import type { SafeOrdinaryInvoker, ViewToolInvocationTerminal } from './invocation-terminal.js';
import type { AppTypeToolDefinition, AppTypeToolRegistrationOptions } from '../../spi/runtime/app-type-tools.interface.js';

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

type TypeToolRegistration = {
    readonly token: object;
    readonly definition: Readonly<Omit<AppTypeToolDefinition, 'inputSchema'> & { inputSchema: JsonValue }>;
    readonly bytes: number;
    readonly invoke: SafeOrdinaryInvoker;
    readonly contract: OrdinaryParameterContract;
    activationId?: string;
    activationBytes: number;
};

export class ViewToolContractError extends Error {
    constructor(readonly code: string, message: string, readonly path?: string) {
        super(code + ': ' + message);
        this.name = 'ViewToolContractError';
    }
}

function nonEmpty(value: string, label: string): void {
    if (typeof value !== 'string' || !value.trim()) {
        throw new ViewToolContractError('TOOL_INVALID', label + ' must be non-empty');
    }
}

function failure(code: string, message: string): ToolResultData {
    return { success: false, error: { code, message } };
}

function captureOptions(value: unknown, fields: readonly string[], label: string): Readonly<Record<string, unknown>> {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw 0;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Reflect.ownKeys(descriptors).length !== fields.length || Reflect.ownKeys(descriptors).some(key =>
            typeof key !== 'string' || !fields.includes(key) || !descriptors[key]!.enumerable || !('value' in descriptors[key]!))) throw 0;
        return Object.freeze(Object.fromEntries(fields.map(field => [field, descriptors[field]!.value])));
    } catch {
        throw new ViewToolContractError('TOOL_INVALID', 'Invalid ' + label + ' options');
    }
}

/**
 * One App instance, its live View identities and Tool bindings.
 *
 * No DOM/Worker/model imports. Does not publish snapshots or authorize external
 * calls. Invocation adapters must obtain observed identity from a validated,
 * pinned Runtime-owned V3 snapshot before invoking this registry.
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
    let encodedAppInstanceId: string | undefined = JSON.stringify(appInstanceId);
    let encodedAppInstanceIdBytes = utf8Size(encodedAppInstanceId);
    let disposed = false;
    let bindingCount = 0;

    const byViewId = new Map<string, string>();
    const byInstanceId = new Map<string, ViewInstance>();
    const typeTools = new Map<string, Map<string, TypeToolRegistration>>();
    let mountSequence = 0;
    let activationSequence = 0;

    function assertActive(): void {
        if (disposed) throw new ViewToolContractError('VIEW_REGISTRY_CLOSED', 'View-owned Registry is closed');
    }
    function viewBytes(view: ViewInstance): number {
        return utf8Size(canonicalJson(view as unknown as JsonValue));
    }
    function matchingViewCount(viewType: string): number {
        let count = 0;
        for (const view of byInstanceId.values()) if (view.viewType === viewType) count++;
        return count;
    }

    function activationIdFor(sequence: number): string {
        if (encodedAppInstanceId === undefined) throw new ViewToolContractError('VIEW_REGISTRY_CLOSED', 'View-owned Registry is closed');
        return 'ta:v1:[' + encodedAppInstanceId + ',' + sequence + ']';
    }

    function activationBytesFor(sequence: number): number {
        // `ta:v1:[` + JSON string + comma + decimal sequence + `]`.
        if (encodedAppInstanceId === undefined) throw new ViewToolContractError('VIEW_REGISTRY_CLOSED', 'View-owned Registry is closed');
        return 8 + encodedAppInstanceIdBytes + String(sequence).length + 1;
    }

    function nextActivation(): Readonly<{ id: string; bytes: number }> {
        if (activationSequence >= Number.MAX_SAFE_INTEGER) {
            throw new ViewToolContractError('TOOL_CAPACITY', 'Tool activation sequence exhausted');
        }
        const sequence = ++activationSequence;
        return Object.freeze({ id: activationIdFor(sequence), bytes: activationBytesFor(sequence) });
    }

    function expireTypeActivations(viewType: string): void {
        for (const registration of typeTools.get(viewType)?.values() ?? []) {
            if (registration.activationId) retainedBytes -= registration.activationBytes;
            registration.activationId = undefined;
            registration.activationBytes = 0;
        }
    }

    function planTypeActivation(viewType: string, reserveBytes = 0): Readonly<{
        lastSequence: number;
        bytes: number;
        entries: readonly Readonly<{ registration: TypeToolRegistration; id: string; bytes: number }>[];
    }> {
        const registrations = typeTools.get(viewType);
        const count = registrations?.size ?? 0;
        if (count > Number.MAX_SAFE_INTEGER - activationSequence) {
            throw new ViewToolContractError('TOOL_CAPACITY', 'Tool activation sequence exhausted');
        }
        const pending = [...(registrations?.values() ?? [])];
        const lastSequence = activationSequence + pending.length;
        let bytes = 0;
        for (let index = 0; index < pending.length; index++) bytes += activationBytesFor(activationSequence + index + 1);
        if (bytes > captured.maxRetainedBytes - retainedBytes - reserveBytes) {
            throw new ViewToolContractError('TOOL_CAPACITY', 'Tool activation retention limit reached');
        }
        const entries = pending.map((registration, index) => {
            const sequence = activationSequence + index + 1;
            const activationBytes = activationBytesFor(sequence);
            return Object.freeze({ registration, id: activationIdFor(sequence), bytes: activationBytes });
        });
        return Object.freeze({ lastSequence, bytes, entries: Object.freeze(entries) });
    }

    function activateTypeTools(plan: ReturnType<typeof planTypeActivation>): void {
        for (const entry of plan.entries) {
            entry.registration.activationId = entry.id;
            entry.registration.activationBytes = entry.bytes;
        }
        activationSequence = plan.lastSequence;
        retainedBytes += plan.bytes;
    }

    function toolId(viewType: string, name: string): string {
        // Structured ID is unambiguous. The Agent-facing tool name is adapter-owned.
        return JSON.stringify([appId, viewType, name]);
    }

    function validateTypeToolBinding(tool: ToolDescriptorV3, execution: ObservedToolExecutionV3): ToolResultData {
        if (disposed) return failure('VIEW_INSTANCE_REVOKED', 'View-owned Registry is closed');
        if (execution.kind !== 'view-type' || tool.execution.kind !== 'view-type' ||
            tool.execution.activationId !== execution.activationId || tool.id !== toolId(tool.viewType, tool.name)) {
            return failure('TOOL_SOURCE_CONFLICT', 'Observed execution identity does not match the Tool');
        }
        const registration = typeTools.get(tool.viewType)?.get(tool.name);
        if (!registration) return failure('TOOL_UNAVAILABLE', 'ViewType Tool is no longer registered');
        if (!registration.activationId || registration.activationId !== execution.activationId || matchingViewCount(tool.viewType) === 0) {
            return failure('TOOL_UNAVAILABLE', 'ViewType Tool is not active');
        }
        const expected = {
            id: toolId(tool.viewType, tool.name), name: registration.definition.name, viewType: registration.definition.viewType,
            description: registration.definition.description, inputSchema: registration.definition.inputSchema,
            execution: { kind: 'view-type', activationId: registration.activationId },
        };
        if (canonicalJson(tool as unknown as JsonValue) !== canonicalJson(expected as unknown as JsonValue)) {
            return failure('TOOL_SOURCE_STALE', 'Tool contract changed since the source observation');
        }
        if (typeof registration.invoke !== 'function') return failure('TOOL_EXECUTION_UNAVAILABLE', 'Current Tool has no trusted callable');
        return { success: true };
    }

    return Object.freeze({
        protocol: VIEW_TYPE_TOOL_PROTOCOL,
        dispose(): void {
            if (disposed) return;
            disposed = true;
            byViewId.clear();
            byInstanceId.clear();
            typeTools.clear();
            retainedBytes = 0;
            bindingCount = 0;
            appId = '';
            appInstanceId = '';
            encodedAppInstanceId = undefined;
            encodedAppInstanceIdBytes = 0;
        },
        inspect(): Readonly<ViewOwnedToolsStats> {
            return Object.freeze({ state: disposed ? 'disposed' : 'active', views: byInstanceId.size,
                bindings: bindingCount, retainedBytes });
        },
        validateTypeToolBinding,
        /** Internal Worker access after full binding qualification; never grants execution. */
        getTypeToolContract(tool: ToolDescriptorV3, execution: ObservedToolExecutionV3): OrdinaryParameterContract | undefined {
            if (disposed || execution.kind !== 'view-type') return undefined;
            const registration = typeTools.get(tool.viewType)?.get(tool.name);
            return registration?.activationId !== undefined && registration.activationId === execution.activationId
                ? registration.contract : undefined;
        },
        invokeTypeTool(tool: ToolDescriptorV3, execution: ObservedToolExecutionV3, args: Readonly<Record<string, unknown>>): ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal> {
            const live = validateTypeToolBinding(tool, execution);
            if (!live.success) return { phase: 'not-entered', result: live };
            const registration = typeTools.get(tool.viewType)!.get(tool.name)!;
            // The complete parameter object belongs to the App; Runtime does not route on business fields.
            // No yield occurs between the final activation check and trusted invoker entry.
            return registration.invoke(args);
        },
        registerTypeTool(definition: AppTypeToolDefinition, options: AppTypeToolRegistrationOptions): () => void {
            assertActive();
            const copied = copyJson(definition, { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 }) as unknown as AppTypeToolDefinition;
            if (!copied || typeof copied !== 'object' || Array.isArray(copied) ||
                Object.keys(copied).length !== 4 || typeof copied.viewType !== 'string' || !copied.viewType.trim() ||
                typeof copied.name !== 'string' || !copied.name.trim() || typeof copied.description !== 'string' || !copied.description.trim() ||
                !copied.inputSchema || typeof copied.inputSchema !== 'object' || Array.isArray(copied.inputSchema)) {
                throw new ViewToolContractError('TOOL_INVALID', 'Invalid ViewType Tool definition');
            }
            const optionFields = captureOptions(options, ['safeOrdinaryParametersInvocationMode', 'createSafeOrdinaryParametersInvoker'], 'ViewType Tool registration');
            if (optionFields.safeOrdinaryParametersInvocationMode !== ORDINARY_INVOCATION_MODE ||
                typeof optionFields.createSafeOrdinaryParametersInvoker !== 'function')
                throw new ViewToolContractError('TOOL_INVALID', 'Invalid trusted ViewType Tool registration options');
            const compiled = compileOrdinarySchema(copied.inputSchema, VIEW_TYPE_PARAMETERS_MODE);
            if (!compiled.ok) throw new ViewToolContractError(compiled.issue.code, compiled.issue.message, compiled.issue.path);
            const inputSchema = ordinaryParameterProfile(compiled.contract);
            const publicDefinition = Object.freeze({ viewType: copied.viewType, name: copied.name, description: copied.description,
                inputSchema });
            const declarationBytes = utf8Size(canonicalJson(publicDefinition as unknown as JsonValue));
            const nextActivationBytes = (): number => {
                if (matchingViewCount(copied.viewType) === 0) return 0;
                if (activationSequence >= Number.MAX_SAFE_INTEGER) {
                    throw new ViewToolContractError('TOOL_CAPACITY', 'Tool activation sequence exhausted');
                }
                return activationBytesFor(activationSequence + 1);
            };
            const ensureAvailable = (): void => {
                assertActive();
                if (typeTools.get(copied.viewType)?.has(copied.name)) {
                    throw new ViewToolContractError('TOOL_DUPLICATE', 'ViewType Tool already registered: ' + copied.viewType + '.' + copied.name);
                }
                const activationBytes = nextActivationBytes();
                if (bindingCount >= captured.maxBindings || declarationBytes + activationBytes > captured.maxRetainedBytes - retainedBytes) {
                    throw new ViewToolContractError('TOOL_CAPACITY', 'Tool retention limit reached');
                }
            };
            ensureAvailable();
            const invoke = (optionFields.createSafeOrdinaryParametersInvoker as AppTypeToolRegistrationOptions['createSafeOrdinaryParametersInvoker'])(compiled.contract);
            if (typeof invoke !== 'function') throw new ViewToolContractError('TOOL_INVALID', 'Trusted ViewType Tool factory did not return a callable');
            // The invoker factory is App code and may synchronously reenter Runtime APIs.
            // Recheck close, duplicate ownership and quotas before changing Registry state.
            ensureAvailable();
            const activeViewType = matchingViewCount(copied.viewType) > 0;
            const activation = activeViewType ? nextActivation() : undefined;
            const registration: TypeToolRegistration = {
                token: {}, definition: publicDefinition, bytes: declarationBytes,
                invoke: invoke as SafeOrdinaryInvoker, contract: compiled.contract,
                activationBytes: activation?.bytes ?? 0,
                ...(activation ? { activationId: activation.id } : {}),
            };
            const currentTypeTools = typeTools.get(copied.viewType) ?? new Map<string, TypeToolRegistration>();
            currentTypeTools.set(copied.name, registration);
            typeTools.set(copied.viewType, currentTypeTools);
            bindingCount++;
            retainedBytes += declarationBytes + (activation?.bytes ?? 0);
            const registeredViewType = copied.viewType;
            const registeredName = copied.name;
            const registrationToken = registration.token;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                const current = typeTools.get(registeredViewType);
                const currentRegistration = current?.get(registeredName);
                if (currentRegistration?.token !== registrationToken) return;
                current!.delete(registeredName);
                if (current!.size === 0) typeTools.delete(registeredViewType);
                retainedBytes -= currentRegistration.bytes + currentRegistration.activationBytes;
                bindingCount--;
            };
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
            const wasFirstOfType = matchingViewCount(viewType) === 0;
            const registrations = typeTools.get(viewType);
            const activationPlan = wasFirstOfType && registrations?.size ? planTypeActivation(viewType, bytes) : undefined;
            mountSequence++;
            retainedBytes += bytes;
            byViewId.set(viewId, instance.viewInstanceId);
            byInstanceId.set(instance.viewInstanceId, instance);
            if (activationPlan) activateTypeTools(activationPlan);
            return instance;
        },

        unmount(viewInstanceId: string): void {
            const view = byInstanceId.get(viewInstanceId);
            if (!view) return;
            retainedBytes -= viewBytes(view);
            byInstanceId.delete(viewInstanceId);
            if (byViewId.get(view.viewId) === viewInstanceId) byViewId.delete(view.viewId);
            if (matchingViewCount(view.viewType) === 0) expireTypeActivations(view.viewType);
        },

        /** Internal producer inventory; no private callable or live View object escapes. */
        listViews(): readonly ViewInstance[] {
            return Object.freeze([...byInstanceId.values()]
                .sort((a, b) => a.viewId < b.viewId ? -1 : a.viewId > b.viewId ? 1 : 0));
        },

        /** All outputs are detached V3 metadata; neither private callable escapes. */
        listTools(): readonly ToolDescriptorV3[] {
            const typeToolDescriptors: ToolDescriptorV3[] = [];
            for (const [viewType, registrations] of typeTools) {
                if (matchingViewCount(viewType) === 0) continue;
                for (const registration of registrations.values()) {
                    if (!registration.activationId) continue;
                    typeToolDescriptors.push(Object.freeze({
                        id: toolId(viewType, registration.definition.name),
                        name: registration.definition.name,
                        viewType,
                        description: registration.definition.description,
                        inputSchema: registration.definition.inputSchema,
                        execution: Object.freeze({ kind: 'view-type' as const, activationId: registration.activationId }),
                    }));
                }
            }
            return Object.freeze(typeToolDescriptors.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        },

    });
}
