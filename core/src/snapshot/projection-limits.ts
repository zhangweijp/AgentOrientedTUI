import { DEFAULT_SNAPSHOT_LIMITS, OBSERVATION_METADATA_BYTES } from './snapshot-support.js';
import type { ObservationJsonLimits, ProjectionLimits } from '../invocation/observation-types.js';

const profile = (maxDepth: number, maxNodes: number, bytes: number): ObservationJsonLimits =>
    Object.freeze({ maxDepth, maxNodes, maxApproxBytes: bytes, maxCanonicalBytes: bytes });

export const DEFAULT_PROJECTION_LIMITS: ProjectionLimits = Object.freeze({
    maxViews: 256, maxRefs: 512, maxTools: 256,
    metadata: profile(12, 8192, OBSERVATION_METADATA_BYTES),
    observation: profile(DEFAULT_SNAPSHOT_LIMITS.maxDepth + 2, DEFAULT_SNAPSHOT_LIMITS.maxNodes + 4_000,
        DEFAULT_SNAPSHOT_LIMITS.maxViewContentBytes + DEFAULT_SNAPSHOT_LIMITS.maxToolSchemaBytes + 2 * OBSERVATION_METADATA_BYTES),
});

function invalidLimit(path: string, message: string): never {
    throw Object.assign(new TypeError(message), { path });
}

export function plainConfigObject(input: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalidLimit(path, 'Expected a plain object');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
        const field = `${path}.${String(key)}`;
        if (typeof key !== 'string' || !allowed.includes(key)) invalidLimit(field, 'Unknown field');
        if (!descriptors[key]!.enumerable || !('value' in descriptors[key]!)) invalidLimit(field, 'Expected an enumerable data property');
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value]));
}

/** Host options are partial; a Worker message must carry every effective field. */
export function normalizeProjectionLimits(input: unknown, path: string, complete = false): ProjectionLimits {
    if (input === undefined && !complete) return DEFAULT_PROJECTION_LIMITS;
    const overrides = plainConfigObject(input, Object.keys(DEFAULT_PROJECTION_LIMITS), path);
    const effectiveNumber = (value: unknown, hard: number, field: string): number => {
        if (value === undefined && !complete) return hard;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > hard) {
            invalidLimit(field, `Expected a positive safe integer up to ${hard}`);
        }
        return value;
    };
    const result: Record<string, number | ObservationJsonLimits> = {};
    for (const [key, hard] of Object.entries(DEFAULT_PROJECTION_LIMITS) as [string, number | ObservationJsonLimits][]) {
        const field = `${path}.${key}`;
        const override = overrides[key];
        if (typeof hard === 'number') result[key] = effectiveNumber(override, hard, field);
        else if (override === undefined && !complete) result[key] = hard;
        else {
            const lower = plainConfigObject(override, Object.keys(hard), field);
            const effective = { ...hard };
            for (const limit of Object.keys(hard) as (keyof ObservationJsonLimits)[]) {
                effective[limit] = effectiveNumber(lower[limit], hard[limit], `${field}.${limit}`);
            }
            result[key] = Object.freeze(effective);
        }
    }
    return Object.freeze(result) as unknown as ProjectionLimits;
}
