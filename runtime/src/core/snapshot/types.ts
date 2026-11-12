export const MARKDOWN_VIEW_FORMAT = 'markdown-v1' as const;
export const SEMANTIC_VIEW_FORMAT = 'semantic-v1' as const;
export const SNAPSHOT_SCHEMA_VERSION = 3 as const;
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
    | Readonly<{ format: typeof MARKDOWN_VIEW_FORMAT; value: string }>
    | Readonly<{ format: typeof SEMANTIC_VIEW_FORMAT; value: JsonValue }>;

export type RefTarget =
    | Readonly<{ kind: 'snapshot-value'; payload: JsonValue }>
    | Readonly<{
          kind: 'entity';
          entityType: string;
          entityId: string;
          entityVersion?: string;
      }>;

/**
 * Semantic snapshots present the currently active ViewType capabilities alongside
 * data References owned by real View instances. Normal View content changes do not replace
 * the Runtime-issued type-tool activation identity.
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
export type ToolExecutionV3 = Readonly<{ kind: 'view-type'; activationId: string }>;
export interface ToolDescriptorV3 {
    readonly id: string;
    readonly name: string;
    readonly viewType: string;
    readonly description: string;
    readonly inputSchema: JsonValue;
    readonly execution: ToolExecutionV3;
}
export type ObservedToolExecutionV3 = ToolExecutionV3;
export interface PreparedAppSnapshotDraftV3 {
    readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
    readonly appId: string;
    readonly instanceId: string;
    readonly producerSeq: number;
    readonly sourceEpoch: number;
    readonly capturedAt: number;
    readonly views: readonly ViewSnapshotV2[];
    readonly refs: Readonly<Record<string, RefDescriptorV2>>;
    readonly tools: Readonly<Record<string, ToolDescriptorV3>>;
}
export interface AppSnapshotV3 {
    readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
    readonly id: string;
    readonly appId: string;
    readonly instanceId: string;
    readonly revision: number;
    readonly createdAt: number;
    readonly views: readonly ViewSnapshotV2[];
    readonly refs: Readonly<Record<string, RefDescriptorV2>>;
    readonly tools: Readonly<Record<string, ToolDescriptorV3>>;
    readonly contentDigest: string;
}
export type SnapshotDraftEnvelope = Readonly<{
    appId: string;
    instanceId: string;
    producerSeq: number;
    sourceEpoch: number;
}>;

export type SnapshotHealth = 'unready' | 'ready' | 'degraded' | 'stopped';

export const SNAPSHOT_PREPARE_ISSUE_CODES = Object.freeze([
    'SNAPSHOT_INVALID', 'SNAPSHOT_SERIALIZATION_ERROR', 'TOOL_BINDING_INVALID',
    'TOOL_SCHEMA_INVALID', 'TOOL_SCHEMA_UNSUPPORTED', 'TOOL_SCHEMA_CAPACITY',
] as const);
type SnapshotPrepareIssueCode = typeof SNAPSHOT_PREPARE_ISSUE_CODES[number];

export type SnapshotIssueCode =
    | SnapshotPrepareIssueCode
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
    | 'TOOL_SOURCE_CONFLICT'
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

export type SnapshotPrepareIssue = Pick<SnapshotIssue, 'message' | 'path'> & { readonly code: SnapshotPrepareIssueCode };

export type CommitResult =
    | Readonly<{ status: 'published' | 'unchanged'; snapshot: AppSnapshotV3 }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type SnapshotRead =
    | Readonly<{ status: 'ready'; snapshot: AppSnapshotV3 }>
    | Readonly<{ status: 'unready' }>
    | Readonly<{ status: 'degraded'; lastGood?: AppSnapshotV3; issue: SnapshotIssue }>
    | Readonly<{ status: 'stopped' }>;

export type SnapshotLookup =
    | Readonly<{ status: 'found'; snapshot: AppSnapshotV3 }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export interface SnapshotLease {
    readonly snapshot: AppSnapshotV3;
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
    | Readonly<{ status: 'found'; tool: ToolDescriptorV3 }>
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

