/**
 * Runtime Core Semantic Snapshot V1.
 *
 * No DOM, Worker, UI framework, Node builtins, business state, or model SDK.
 * Internal M1 contract: NOT yet part of the @aotui/runtime public exports.
 */
export type JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | Readonly<{ [key: string]: JsonValue }>;

export type ViewContent =
    | Readonly<{ format: 'markdown-v1'; value: string }>
    | Readonly<{ format: 'semantic-v1'; value: JsonValue }>;

export interface ViewSnapshot {
    readonly id: string;
    readonly generation: string;
    readonly type: string;
    readonly name: string;
    readonly kind: 'instruction' | 'state';
    readonly content: ViewContent;
}

export type RefTarget =
    | Readonly<{ kind: 'snapshot-value'; payload: JsonValue }>
    | Readonly<{
          kind: 'entity';
          entityType: string;
          entityId: string;
          entityVersion?: string;
      }>;

export interface RefDescriptor {
    readonly id: string;
    readonly ownerViewId: string;
    readonly ownerViewGeneration: string;
    readonly refType: string;
    readonly target: RefTarget;
}

export interface ToolDescriptor {
    readonly id: string;
    readonly name: string;
    readonly viewType: string;
    readonly declaredByViewId?: string;
    readonly declaredByViewGeneration?: string;
    readonly description: string;
    readonly inputSchema: JsonValue;
    readonly visible: boolean;
    readonly isMutating: boolean;
}

/** Input comes from a producer; it must never be trusted just because TS types match. */
export interface PreparedAppSnapshotDraft {
    readonly schemaVersion: 1;
    readonly appId: string;
    readonly instanceId: string;
    readonly producerSeq: number;
    readonly sourceEpoch: number;
    readonly capturedAt: number;
    readonly views: readonly ViewSnapshot[];
    readonly refs: Readonly<Record<string, RefDescriptor>>;
    readonly tools: Readonly<Record<string, ToolDescriptor>>;
}

/** The committed snapshot is a detached, deeply frozen, JSON-compatible value. */
export interface AppSnapshotV1 {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly appId: string;
    readonly instanceId: string;
    readonly revision: number;
    readonly createdAt: number;
    readonly views: readonly ViewSnapshot[];
    readonly refs: Readonly<Record<string, RefDescriptor>>;
    readonly tools: Readonly<Record<string, ToolDescriptor>>;
    /** Diagnostic checksum only, never authority for snapshot identity or equality. */
    readonly contentDigest: string;
}

/**
 * M4 Stage 2: versioned source-bound observation.
 * V1 remains byte-for-byte compatible; no new fields are silently accepted in V1.
 * ViewInstanceId replaces the legacy generation identity ONLY in V2.
 */
export interface ViewSnapshotV2 {
    readonly id: string;
    readonly viewInstanceId: string;
    readonly type: string;
    readonly name: string;
    readonly kind: 'instruction' | 'state';
    readonly content: ViewContent;
}
export interface RefDescriptorV2 {
    readonly id: string;
    readonly ownerViewId: string;
    readonly ownerViewInstanceId: string;
    readonly refType: string;
    readonly target: RefTarget;
}
export interface ToolTargetV2 {
    readonly viewId: string;
    readonly viewInstanceId: string;
    readonly bindingVersion: number;
}
export interface ToolDescriptorV2 {
    readonly id: string;
    readonly name: string;
    readonly viewType: string;
    readonly description: string;
    readonly inputSchema: JsonValue;
    readonly isMutating: boolean;
    readonly targets: readonly ToolTargetV2[];
}
export interface PreparedAppSnapshotDraftV2 {
    readonly schemaVersion: 2;
    readonly appId: string;
    readonly instanceId: string;
    readonly producerSeq: number;
    readonly sourceEpoch: number;
    readonly capturedAt: number;
    readonly views: readonly ViewSnapshotV2[];
    readonly refs: Readonly<Record<string, RefDescriptorV2>>;
    readonly tools: Readonly<Record<string, ToolDescriptorV2>>;
}
export interface AppSnapshotV2 {
    readonly schemaVersion: 2;
    readonly id: string;
    readonly appId: string;
    readonly instanceId: string;
    readonly revision: number;
    readonly createdAt: number;
    readonly views: readonly ViewSnapshotV2[];
    readonly refs: Readonly<Record<string, RefDescriptorV2>>;
    readonly tools: Readonly<Record<string, ToolDescriptorV2>>;
    readonly contentDigest: string;
}
export type AppSnapshot = AppSnapshotV1 | AppSnapshotV2;
export type AnyPreparedAppSnapshotDraft = PreparedAppSnapshotDraft | PreparedAppSnapshotDraftV2;

export type SnapshotHealth = 'unready' | 'ready' | 'degraded' | 'stopped';

export type SnapshotIssueCode =
    | 'SNAPSHOT_INVALID'
    | 'SNAPSHOT_SERIALIZATION_ERROR'
    | 'SNAPSHOT_CAPACITY'
    | 'SNAPSHOT_EXPIRED'
    | 'SNAPSHOT_UNREADY'
    | 'SNAPSHOT_SOURCE_CONFLICT'
    | 'SNAPSHOT_SEQUENCE_STALE'
    | 'SNAPSHOT_SOURCE_EPOCH_CONFLICT'
    | 'APP_INSTANCE_MISMATCH'
    | 'APP_NOT_REGISTERED'
    | 'APP_STOPPED'
    | 'REF_NOT_FOUND'
    | 'VIEW_INSTANCE_REVOKED'
    | 'TOOL_UNAVAILABLE'
    | 'TOOL_SOURCE_STALE'
    | 'RESOURCE_VERSION_REQUIRED'
    | 'RESOURCE_VERSION_STALE';

export interface SnapshotIssue {
    readonly code: SnapshotIssueCode;
    readonly message: string;
    readonly path?: string;
    readonly appId?: string;
    readonly instanceId?: string;
    readonly snapshotId?: string;
}

export type CommitResult =
    | Readonly<{ status: 'published' | 'unchanged'; snapshot: AppSnapshot }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type SnapshotRead =
    | Readonly<{ status: 'ready'; snapshot: AppSnapshot }>
    | Readonly<{ status: 'unready' }>
    | Readonly<{ status: 'degraded'; lastGood?: AppSnapshot; issue: SnapshotIssue }>
    | Readonly<{ status: 'stopped' }>;

export type SnapshotLookup =
    | Readonly<{ status: 'found'; snapshot: AppSnapshot }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export interface SnapshotLease {
    readonly snapshot: AppSnapshot;
    readonly expiresAt: number;
    release(): void;
}

export type LeaseResult =
    | Readonly<{ status: 'acquired'; lease: SnapshotLease }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type RefLookup =
    | Readonly<{ status: 'resolved'; ref: RefDescriptor | RefDescriptorV2; target: RefTarget }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type ToolLookup =
    | Readonly<{ status: 'found'; tool: ToolDescriptor | ToolDescriptorV2 }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type RefSelector = Readonly<{
    snapshotId: string;
    appId: string;
    instanceId: string;
    viewId: string;
    refId: string;
}> & (
    | Readonly<{ viewGeneration: string; viewInstanceId?: never }>
    | Readonly<{ viewInstanceId: string; viewGeneration?: never }>
);

export interface ToolSelector {
    readonly snapshotId: string;
    readonly appId: string;
    readonly instanceId: string;
    readonly toolId: string;
}

export interface SnapshotLimits {
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxSnapshotBytes: number;
    readonly maxViews: number;
    readonly maxRefs: number;
    readonly maxTools: number;
    readonly maxViewContentBytes: number;
    readonly maxRefPayloadBytes: number;
    readonly maxToolSchemaBytes: number;
}

export interface SnapshotStoreOptions {
    readonly now?: () => number;
    readonly limits?: Partial<SnapshotLimits>;
    readonly maxHistoryEntries?: number;
    readonly maxHistoryBytes?: number;
    readonly historyTtlMs?: number;
    readonly leaseTtlMs?: number;
    readonly maxActiveLeases?: number;
}

export interface SnapshotStoreStats {
    readonly activeApps: number;
    readonly currentSnapshots: number;
    readonly historicalSnapshots: number;
    readonly historicalBytes: number;
    readonly activeLeases: number;
}

export interface SnapshotStore {
    readLatest(appId: string): SnapshotRead;
    getById(snapshotId: string): SnapshotLookup;
    acquire(snapshotId: string, requestedTtlMs?: number): LeaseResult;
    resolveRef(selector: RefSelector): RefLookup;
    getTool(selector: ToolSelector): ToolLookup;
    inspect(): SnapshotStoreStats;
}

export interface PreparedSnapshotFailure {
    readonly appId: string;
    readonly instanceId: string;
    readonly producerSeq: number;
    readonly sourceEpoch: number;
    readonly issue: SnapshotIssue;
}

export interface SnapshotCommitter {
    accept(input: unknown): CommitResult;
    /** Trusted transport reports a Producer failure before a Draft could be created. */
    reportPrepareFailure(failure: PreparedSnapshotFailure): CommitResult;
}

export interface SnapshotLifecycle {
    /** Must be called by the trusted Runtime owner, never from producer payload. */
    startApp(appId: string, instanceId: string): void;
    stopApp(appId: string, instanceId: string): void;
}

export interface SnapshotCore {
    readonly store: SnapshotStore;
    readonly committer: SnapshotCommitter;
    readonly lifecycle: SnapshotLifecycle;
}

/**
 * No cross-App transaction is implied: this is a read vector of committed App snapshots.
 * Unready/stopped members cannot fabricate a snapshotId or revision.
 */
export type WorkspaceComponent =
    | Readonly<{
          appId: string;
          instanceId: string;
          health: 'ready';
          appSnapshotId: string;
          revision: number;
      }>
    | Readonly<{
          appId: string;
          instanceId: string;
          health: 'degraded';
          issueCode: string;
          lastGoodSnapshotId?: string;
          lastGoodRevision?: number;
      }>
    | Readonly<{
          appId: string;
          instanceId: string;
          health: 'unready' | 'stopped';
      }>;

export interface WorkspaceSnapshot {
    readonly id: string;
    readonly workspaceId: string;
    readonly createdAt: number;
    readonly membershipRevision: number;
    readonly metadataRevision: number;
    readonly components: readonly WorkspaceComponent[];
}

export interface WorkspaceMember {
    readonly appId: string;
    readonly instanceId: string;
}

export interface WorkspaceComposer {
    compose(
        workspaceId: string,
        members: readonly WorkspaceMember[],
        membershipRevision: number,
        metadataRevision: number,
    ): WorkspaceSnapshot;
}
