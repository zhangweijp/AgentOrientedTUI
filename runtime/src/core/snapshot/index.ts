/** Snapshot implementation barrel; supported package exports live in `core/index.ts`. */
export { createSnapshotCore } from './store.js';
export { refKey, DEFAULT_SNAPSHOT_LIMITS } from './snapshot-support.js';
export { validatePreparedV2Draft } from './v2-validator.js';
export { canonicalJson, copyJson, diagnosticDigest, SnapshotDataError, utf8Size } from './json.js';
export type {
    AppSnapshot, AppSnapshotV2,
    CommitResult, JsonValue, LeaseResult, PreparedAppSnapshotDraftV2,
    PreparedSnapshotFailure,
    RefLookup, RefSelector, RefTarget, SnapshotCommitter, SnapshotCore,
    SnapshotHealth, SnapshotIssue, SnapshotIssueCode, SnapshotLease, SnapshotLimits,
    SnapshotLifecycle, SnapshotLookup, SnapshotRead, SnapshotStore, SnapshotStoreOptions,
    SnapshotStoreStats, ToolDescriptorV2, ToolTargetV2,
    RefDescriptorV2, ToolLookup, ToolSelector, ViewContent, ViewSnapshotV2,
    SnapshotDraftEnvelope,
} from './types.js';
