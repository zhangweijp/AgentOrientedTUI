import type { OperationResult } from '../../spi/core/operations.js';
import { canonicalJson, copyJson } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';

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

type Handler = (args: Readonly<Record<string, unknown>>) => OperationResult | Promise<OperationResult>;
type ToolRegistration = {
    readonly spec: Readonly<ViewToolSpec>;
    readonly canonical: string;
    readonly handler: Handler;
    enabled: boolean;
    bindingVersion: number;
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
export function createViewOwnedTools(appId: string, appInstanceId: string) {
    nonEmpty(appId, 'appId');
    nonEmpty(appInstanceId, 'appInstanceId');

    const byViewId = new Map<string, string>();
    const byInstanceId = new Map<string, ViewInstance>();
    const bindings = new Map<string, Map<string, ToolRegistration>>();
    let mountSequence = 0;
    let bindingSequence = 0;

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

    return Object.freeze({
        validate,

        mount(viewId: string, viewType: string): ViewInstance {
            nonEmpty(viewId, 'viewId');
            nonEmpty(viewType, 'viewType');
            if (byViewId.has(viewId)) {
                throw new ViewToolContractError('VIEW_DUPLICATE', 'View ID already mounted: ' + viewId);
            }
            if (mountSequence >= Number.MAX_SAFE_INTEGER) {
                throw new ViewToolContractError('VIEW_CAPACITY', 'View mount sequence exhausted');
            }
            const instance: ViewInstance = Object.freeze({
                viewId,
                viewType,
                viewInstanceId: 'vi:v1:' + JSON.stringify([appInstanceId, ++mountSequence]),
            });
            byViewId.set(viewId, instance.viewInstanceId);
            byInstanceId.set(instance.viewInstanceId, instance);
            bindings.set(instance.viewInstanceId, new Map());
            return instance;
        },

        unmount(viewInstanceId: string): void {
            const view = byInstanceId.get(viewInstanceId);
            if (!view) return;
            byInstanceId.delete(viewInstanceId);
            if (byViewId.get(view.viewId) === viewInstanceId) byViewId.delete(view.viewId);
            bindings.delete(viewInstanceId);
        },

        registerTool(
            viewInstanceId: string,
            spec: ViewToolSpec,
            handler: Handler,
            enabled = true,
        ): () => void {
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
            const currentTools = bindings.get(viewInstanceId)!;
            if (currentTools.has(copied.name)) {
                throw new ViewToolContractError('TOOL_DUPLICATE', 'Tool already registered in this View instance');
            }
            const canonical = canonicalJson(copied as unknown as JsonValue);

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
            const registration: ToolRegistration = {
                spec: copied, canonical, handler, enabled,
                bindingVersion: issueBindingVersion(),
            };
            currentTools.set(copied.name, registration);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                if (bindings.get(viewInstanceId)?.get(copied.name) === registration) {
                    bindings.get(viewInstanceId)!.delete(copied.name);
                }
            };
        },

        setEnabled(viewInstanceId: string, name: string, enabled: boolean): void {
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
