import { createJsonCopier, SnapshotDataError } from './json.js';
import { DEFAULT_SNAPSHOT_LIMITS } from './snapshot-support.js';
import type { JsonValue, SnapshotIssue } from './types.js';

export type RefValueCheck = (value: JsonValue) => Readonly<{ path: string; message: string }> | void;
export type RefCapture = { readonly value: JsonValue } | { readonly issue: SnapshotIssue };
const limits = { ...DEFAULT_SNAPSHOT_LIMITS, maxApproxBytes: DEFAULT_SNAPSHOT_LIMITS.maxSnapshotBytes * 2 };

/** A producer creates one bounded capture function per render or frame. */
export function createRefCapture() {
    const copy = createJsonCopier(limits);
    return (data: unknown, check?: RefValueCheck): RefCapture => {
        try {
            const value = copy(data);
            const failure = check?.(value);
            return failure ? { issue: { code: 'SNAPSHOT_INVALID', ...failure } } : { value };
        } catch (error) {
            if (error instanceof SnapshotDataError) return { issue: { code: error.code, path: error.path, message: error.message } };
            return { issue: { code: 'SNAPSHOT_INVALID', message: 'Semantic projection commit failed' } };
        }
    };
}
