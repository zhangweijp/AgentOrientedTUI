import type { ExecutionResolver, AppInteractionPolicy } from '../core/invocation/app-interaction-types.js';
import type { ObservationGrant } from '../core/invocation/observation-types.js';
import { DEFAULT_OBSERVATION_REGISTRY_LIMITS } from '../core/invocation/observation-registry.js';
import { captureBoundedJson } from '../core/invocation/invocation-outcome.js';
import { canonicalJson } from '../core/snapshot/json.js';
import type { AppSnapshotV3, JsonValue, ObservedToolExecutionV3, ToolDescriptorV3 } from '../core/snapshot/types.js';

function fields(value: unknown, names: readonly string[]): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    return keys.length === names.length && names.every(name => Object.hasOwn(descriptors, name)) &&
        keys.every(name => typeof name === 'string' && names.includes(name) && descriptors[name]!.enumerable && 'value' in descriptors[name]!);
}

function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

function executableBinding(value: unknown, tool: ToolDescriptorV3, grant: ObservationGrant,
    source: AppSnapshotV3): value is ObservedToolExecutionV3 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const execution = value as Record<string, unknown>;
    if (execution.kind === 'view-type') {
        if (!fields(execution, ['kind', 'activationId']) || !text(execution.activationId) || tool.execution.kind !== 'view-type' ||
            tool.execution.activationId !== execution.activationId) return false;
        return grant.views.some(identity => {
            const view = source.views.find(candidate => candidate.id === identity.viewId && candidate.viewInstanceId === identity.viewInstanceId);
            return view?.type === tool.viewType;
        });
    }
    return false;
}

/** Host capability is an upper bound on a trusted policy's observable targets. */
export function withExecutableTools(policy: AppInteractionPolicy, execution: ExecutionResolver): AppInteractionPolicy {
    // Do not turn an invalid policy into a valid wrapper. Core remains the
    // authority for policy validation and its diagnostic contract.
    if (!fields(policy, ['project', 'authorize', 'canReadReceipt'])) return policy;
    const { project, authorize, canReadReceipt } = policy;
    if ([project, authorize, canReadReceipt].some(value => typeof value !== 'function')) return policy;
    return {
        authorize,
        canReadReceipt,
        project: async context => {
            const raw = await project.call(policy, context);
            let grant: ObservationGrant;
            try { grant = captureBoundedJson<ObservationGrant>(raw, DEFAULT_OBSERVATION_REGISTRY_LIMITS.metadata).value; }
            catch { return raw; }
            if (!fields(grant, ['views', 'refs', 'toolBindings', 'content']) ||
                ![grant.views, grant.refs, grant.toolBindings, grant.content].every(Array.isArray) ||
                grant.toolBindings.length > DEFAULT_OBSERVATION_REGISTRY_LIMITS.maxBindings) return raw;
            // Invalid or duplicate grants must be rejected by Core, not made
            // valid by silently deleting their unsupported execution bindings.
            const seen = new Set<string>();
            for (const view of grant.views) if (!fields(view, ['viewId', 'viewInstanceId']) || !text(view.viewId) || !text(view.viewInstanceId)) return raw;
            for (const entry of grant.toolBindings) {
                if (!fields(entry, ['toolId', 'execution']) || !text(entry.toolId) || !Object.hasOwn(context.source.tools, entry.toolId)) return raw;
                const tool = context.source.tools[entry.toolId];
                if (!tool || !executableBinding(entry.execution, tool, grant, context.source)) return raw;
                const identity = canonicalJson({ toolId: entry.toolId, execution: entry.execution as unknown as JsonValue });
                if (seen.has(identity)) return raw;
                seen.add(identity);
            }
            return { ...grant, toolBindings: grant.toolBindings.filter(entry => execution.resolve({
                appId: context.source.appId, instanceId: context.source.instanceId, snapshotId: context.source.id,
                tool: context.source.tools[entry.toolId]!, execution: entry.execution as ObservedToolExecutionV3,
            }) !== null) };
        },
    };
}
