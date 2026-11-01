import type { SnapshotLimits } from './types.js';

export const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
    maxDepth: 48,
    maxNodes: 100_000,
    maxSnapshotBytes: 4 * 1024 * 1024,
    maxViews: 1_000,
    maxRefs: 10_000,
    maxTools: 1_000,
    maxViewContentBytes: 512 * 1024,
    maxRefPayloadBytes: 512 * 1024,
    maxToolSchemaBytes: 64 * 1024,
});

/** Structured key for one Ref owned by one mounted View instance. */
export function refKey(viewId: string, viewInstanceId: string, refId: string): string {
    return JSON.stringify([viewId, viewInstanceId, refId]);
}
