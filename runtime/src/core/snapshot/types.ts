/**
 * Runtime Core semantic snapshot types.
 *
 * No DOM, Worker, UI framework, Node builtins, business state, or model SDK.
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

export type RefTarget =
    | Readonly<{ kind: 'snapshot-value'; payload: JsonValue }>
    | Readonly<{
          kind: 'entity';
          entityType: string;
          entityId: string;
          entityVersion?: string;
      }>;

/**
 * M4 Stage 2: versioned source-bound observation.
 * Snapshot schema version 2 is the sole supported publication contract.
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
    /** App-declared, existing input parameter selecting this observed target. */
    readonly selector?: ToolTargetSelector;
}
export interface ToolTargetSelector { readonly param: string; readonly value: string }
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
export type SnapshotDraftEnvelope = Readonly<{
    appId: string;
    instanceId: string;
    producerSeq: number;
    sourceEpoch: number;
}>;

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
    | 'REF_DECLARATION_INVALID'
    | 'REF_CONTRACT_UNSUPPORTED';

export interface SnapshotIssue {
    readonly code: SnapshotIssueCode;
    readonly message: string;
    readonly path?: string;
    readonly appId?: string;
    readonly instanceId?: string;
    readonly snapshotId?: string;
}

export type CommitResult =
    | Readonly<{ status: 'published' | 'unchanged'; snapshot: AppSnapshotV2 }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type SnapshotRead =
    | Readonly<{ status: 'ready'; snapshot: AppSnapshotV2 }>
    | Readonly<{ status: 'unready' }>
    | Readonly<{ status: 'degraded'; lastGood?: AppSnapshotV2; issue: SnapshotIssue }>
    | Readonly<{ status: 'stopped' }>;

export type SnapshotLookup =
    | Readonly<{ status: 'found'; snapshot: AppSnapshotV2 }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export interface SnapshotLease {
    readonly snapshot: AppSnapshotV2;
    /** null means retained by an explicit owner until release/dispose. */
    readonly expiresAt: number | null;
    release(): void;
}

export type LeaseResult =
    | Readonly<{ status: 'acquired'; lease: SnapshotLease }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type RefLookup =
    | Readonly<{ status: 'resolved'; ref: RefDescriptorV2; target: RefTarget }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type ToolLookup =
    | Readonly<{ status: 'found'; tool: ToolDescriptorV2 }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export interface RefSelector {
    snapshotId: string;
    appId: string;
    instanceId: string;
    viewId: string;
    refId: string;
    viewInstanceId: string;
}

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
    readonly maxAppRecords?: number;
    readonly maxInstanceIds?: number;
    readonly maxIdentityBytes?: number;
    readonly maxCurrentBytes?: number;
}

export interface SnapshotStoreStats {
    readonly state: 'active' | 'disposed';
    readonly appRecords: number;
    readonly issuedInstanceIds: number;
    readonly identityBytes: number;
    readonly currentBytes: number;
    readonly diagnosticBytes: number;
    readonly activeApps: number;
    readonly currentSnapshots: number;
    readonly historicalSnapshots: number;
    readonly historicalBytes: number;
    readonly activeLeases: number;
}

export interface SnapshotStore {
    readLatest(appId: string): SnapshotRead;
    getById(snapshotId: string): SnapshotLookup;
    acquire(snapshotId: string, requestedTtlMs?: number | Readonly<{ lifetime: 'owner' }>): LeaseResult;
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
    dispose(): void;
    /** Must be called by the trusted Runtime owner, never from producer payload. */
    startApp(appId: string, instanceId: string): void;
    stopApp(appId: string, instanceId: string): void;
}

export interface SnapshotCore {
    readonly store: SnapshotStore & AppIdentityReader;
    readonly committer: SnapshotCommitter;
    readonly lifecycle: SnapshotLifecycle;
}

/** Lifecycle identity is independent from projection readiness. */
export type AppIdentityRead =
    | Readonly<{ status: 'absent' }>
    | Readonly<{ status: 'active'; instanceId: string }>
    | Readonly<{ status: 'stopped'; instanceId: string }>;

export interface AppIdentityReader {
    readAppIdentity(appId: string): AppIdentityRead;
}

