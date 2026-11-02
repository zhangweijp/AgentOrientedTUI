import type { ExecutionResolver, ScopePolicy } from '../core/invocation/scoped-interaction-types.js';
import type { ObservationGrant } from '../core/invocation/observation-types.js';
import { DEFAULT_OBSERVATION_REGISTRY_LIMITS } from '../core/invocation/observation-registry.js';
import { captureBoundedJson } from '../core/invocation/invocation-outcome.js';
import { canonicalJson } from '../core/snapshot/json.js';

function fields(value: unknown, names: readonly string[]): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    return keys.length === names.length && names.every(name => Object.hasOwn(descriptors, name)) &&
        keys.every(name => typeof name === 'string' && names.includes(name) && descriptors[name]!.enumerable && 'value' in descriptors[name]!);
}

/** Host capability is an upper bound on a trusted policy's observable targets. */
export function withExecutableTools(policy: ScopePolicy, execution: ExecutionResolver): ScopePolicy {
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
            if (!fields(grant, ['views', 'refs', 'targets', 'content']) ||
                ![grant.views, grant.refs, grant.targets, grant.content].every(Array.isArray) ||
                grant.targets.length > DEFAULT_OBSERVATION_REGISTRY_LIMITS.maxBindings) return raw;
            // Invalid or duplicate grants must be rejected by Core, not made
            // valid by silently deleting their unsupported targets.
            const seen = new Set<string>();
            for (const entry of grant.targets) {
                if (!fields(entry, ['toolId', 'target']) || !fields(entry.target, ['viewId', 'viewInstanceId', 'bindingVersion', ...(entry.target && Object.hasOwn(entry.target, 'selector') ? ['selector'] : [])])) return raw;
                const target = entry.target;
                if (typeof entry.toolId !== 'string' || typeof target.viewId !== 'string' || typeof target.viewInstanceId !== 'string' ||
                    !Number.isSafeInteger(target.bindingVersion) || !Object.hasOwn(context.source.tools, entry.toolId)) return raw;
                const tool = context.source.tools[entry.toolId];
                const identity = JSON.stringify([entry.toolId, target.viewId, target.viewInstanceId, target.bindingVersion]);
                if (!tool || seen.has(identity) || !grant.views.some(view => view.viewId === target.viewId && view.viewInstanceId === target.viewInstanceId) ||
                    !tool.targets.some(candidate => candidate.viewId === target.viewId && candidate.viewInstanceId === target.viewInstanceId && candidate.bindingVersion === target.bindingVersion &&
                        canonicalJson(candidate.selector ? { ...candidate.selector } : null) === canonicalJson(target.selector ? { ...target.selector } : null))) return raw;
                seen.add(identity);
            }
            return { ...grant, targets: grant.targets.filter(entry => execution.resolve({
                appId: context.source.appId, instanceId: context.source.instanceId, snapshotId: context.source.id,
                tool: context.source.tools[entry.toolId]!, target: entry.target,
            }) !== null) };
        },
    };
}
