import type { AppInteractionPolicy } from '../core/invocation/app-interaction-types.js';
import type { ObservationGrant } from '../core/invocation/observation-types.js';
import { DEFAULT_OBSERVATION_REGISTRY_LIMITS } from '../core/invocation/observation-registry.js';
import { captureBoundedJson } from '../core/invocation/invocation-outcome.js';

function fields(value: unknown, names: readonly string[]): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    return keys.length === names.length && names.every(name => Object.hasOwn(descriptors, name)) &&
        keys.every(name => typeof name === 'string' && descriptors[name]!.enumerable && 'value' in descriptors[name]!);
}

/** At most the Tools executable by this Worker can be granted. */
export function withExecutableTools(policy: AppInteractionPolicy, enabled: () => boolean): AppInteractionPolicy {
    if (!fields(policy, ['project', 'authorize', 'canReadReceipt'])) return policy;
    const { project, authorize, canReadReceipt } = policy;
    if ([project, authorize, canReadReceipt].some(value => typeof value !== 'function')) return policy;
    return {
        authorize,
        canReadReceipt,
        project: async context => {
            const raw = await project.call(policy, context);
            if (enabled()) return raw;
            let grant: ObservationGrant;
            try { grant = captureBoundedJson<ObservationGrant>(raw, DEFAULT_OBSERVATION_REGISTRY_LIMITS.metadata).value; }
            catch { return raw; }
            // Preserve malformed grants for Core validation, even when execution is disabled.
            if (!fields(grant, ['refs', 'toolIds']) || !Array.isArray(grant.toolIds) ||
                grant.toolIds.length > DEFAULT_OBSERVATION_REGISTRY_LIMITS.maxTools ||
                new Set(grant.toolIds).size !== grant.toolIds.length ||
                grant.toolIds.some(id => typeof id !== 'string' || !Object.hasOwn(context.source.tools, id))) return raw;
            return { ...grant, toolIds: [] };
        },
    };
}
