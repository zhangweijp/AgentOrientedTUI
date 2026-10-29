/**
 * Internal M1 Semantic Snapshot Core.
 * Do not re-export from the runtime package root before M2/M3 producer guarantees.
 */
export { createSnapshotCore } from './store.js';
export { refKey, validatePreparedDraft, DEFAULT_SNAPSHOT_LIMITS } from './validator.js';
export { validatePreparedV2Draft } from './v2-validator.js';
export { canonicalJson, copyJson, diagnosticDigest, SnapshotDataError, utf8Size } from './json.js';
export type {
    AppSnapshot, AppSnapshotV1, AppSnapshotV2, AnyPreparedAppSnapshotDraft,
    CommitResult, JsonValue, LeaseResult, PreparedAppSnapshotDraft, PreparedAppSnapshotDraftV2,
    PreparedSnapshotFailure,
    RefDescriptor, RefLookup, RefSelector, RefTarget, SnapshotCommitter, SnapshotCore,
    SnapshotHealth, SnapshotIssue, SnapshotIssueCode, SnapshotLease, SnapshotLimits,
    SnapshotLifecycle, SnapshotLookup, SnapshotRead, SnapshotStore, SnapshotStoreOptions,
    SnapshotStoreStats, ToolDescriptor, ToolDescriptorV2, ToolTargetV2,
    RefDescriptorV2, ToolLookup, ToolSelector, ViewContent, ViewSnapshot, ViewSnapshotV2,
} from './types.js';
export type { ValidatedDraft, ValidationResult } from './validator.js';
