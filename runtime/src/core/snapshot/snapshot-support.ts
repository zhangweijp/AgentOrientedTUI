import { SNAPSHOT_PREPARE_ISSUE_CODES, type SnapshotLimits, type SnapshotPrepareIssue } from './types.js';

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

const KiB = 1024;
export const OBSERVATION_METADATA_BYTES = 64 * KiB;
// The default grant repeats View identities for visibility and content decisions.
export const VIEW_METADATA_BYTES = OBSERVATION_METADATA_BYTES / 4;

const jsonProfile = (maxDepth: number, maxNodes: number, bytes: number) => Object.freeze({
    maxDepth, maxNodes, maxApproxBytes: bytes, maxCanonicalBytes: bytes,
});
export const REF_VALUE_LIMITS = jsonProfile(DEFAULT_SNAPSHOT_LIMITS.maxDepth - 4, 10_000, DEFAULT_SNAPSHOT_LIMITS.maxRefPayloadBytes);
export const RAW_TOOL_ARGUMENT_LIMITS = jsonProfile(24, 10_000, 128 * KiB);
export const RESOLVED_TOOL_ARGUMENT_LIMITS = jsonProfile(REF_VALUE_LIMITS.maxDepth + 2,
    REF_VALUE_LIMITS.maxNodes + 2_000,
    REF_VALUE_LIMITS.maxCanonicalBytes + RAW_TOOL_ARGUMENT_LIMITS.maxCanonicalBytes);
export const RESOLVED_TOOL_ENVELOPE_LIMITS = jsonProfile(RESOLVED_TOOL_ARGUMENT_LIMITS.maxDepth + 1,
    RESOLVED_TOOL_ARGUMENT_LIMITS.maxNodes + 2_000, RESOLVED_TOOL_ARGUMENT_LIMITS.maxCanonicalBytes + 64 * KiB);
export const TOOL_REQUEST_LIMITS = jsonProfile(RESOLVED_TOOL_ENVELOPE_LIMITS.maxDepth + 1,
    RESOLVED_TOOL_ENVELOPE_LIMITS.maxNodes + RAW_TOOL_ARGUMENT_LIMITS.maxNodes + 5_100,
    RESOLVED_TOOL_ENVELOPE_LIMITS.maxCanonicalBytes + RAW_TOOL_ARGUMENT_LIMITS.maxCanonicalBytes + DEFAULT_SNAPSHOT_LIMITS.maxToolSchemaBytes + 32 * KiB);

export function isSnapshotPrepareIssueCode(code: unknown): code is SnapshotPrepareIssue['code'] {
    return SNAPSHOT_PREPARE_ISSUE_CODES.some(allowed => allowed === code);
}

export function captureSnapshotPrepareIssue(input: { code?: unknown; message?: unknown; path?: unknown } | null | undefined): SnapshotPrepareIssue {
    const { code, message, path } = input ?? {};
    return {
        code: isSnapshotPrepareIssueCode(code) ? code : 'SNAPSHOT_INVALID',
        message: typeof message === 'string' ? message.slice(0, 160) : 'Semantic producer failed',
        ...(typeof path === 'string' ? { path: path.slice(0, 512) } : {}),
    };
}

/** Structured key for one Ref owned by one mounted View instance. */
export function refKey(viewId: string, viewInstanceId: string, refId: string): string {
    return JSON.stringify([viewId, viewInstanceId, refId]);
}
