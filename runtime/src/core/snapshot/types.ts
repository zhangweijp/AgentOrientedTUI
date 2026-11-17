export const MARKDOWN_VIEW_FORMAT = 'markdown-v1' as const;
export const SNAPSHOT_SCHEMA_VERSION = 6 as const;
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

export type ViewContent = Readonly<{ format: typeof MARKDOWN_VIEW_FORMAT; value: string }>;

export type RefTarget = Readonly<{ kind: 'snapshot-value'; payload: JsonValue }>;

/**
 * Semantic snapshots present the currently active ViewType capabilities alongside
 * data References owned by real View instances. Each View carries only the
 * identity of its enabled bindings. Definitions are shared in the Tool table.
 */
export interface ViewSnapshot {
    readonly id: string;
    readonly viewInstanceId: string;
    readonly type: string;
    readonly name: string;
    readonly kind: 'instruction' | 'state';
    readonly content: ViewContent;
    readonly toolBindings: readonly ViewToolBinding[];
}
export type ViewToolBinding = Readonly<{ toolId: string; activationId: string }>;
export type ViewToolReceiver = Readonly<{ viewId: string; viewInstanceId: string; activationId: string }>;
export interface RefDescriptor {
    readonly id: string;
    readonly ownerViewId: string;
    readonly ownerViewInstanceId: string;
    readonly refType: string;
    readonly target: RefTarget;
}
export interface ToolDescriptor {
    readonly id: string;
    readonly name: string;
    readonly viewType: string;
    /** Another registered ViewType in this App declares the same tool name. */
    readonly nameSharedAcrossViewTypes: boolean;
    readonly description: string;
    readonly inputSchema: JsonValue;
}
export type ToolInvocationDescriptor = Omit<ToolDescriptor, 'nameSharedAcrossViewTypes'>;
export interface PreparedAppSnapshotDraft {
    readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
    readonly appId: string;
    readonly instanceId: string;
    readonly producerSeq: number;
    readonly sourceEpoch: number;
    readonly capturedAt: number;
    readonly views: readonly ViewSnapshot[];
    readonly refs: Readonly<Record<string, RefDescriptor>>;
    readonly tools: Readonly<Record<string, ToolDescriptor>>;
}
export interface AppSnapshot {
    readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
    readonly id: string;
    readonly appId: string;
    readonly instanceId: string;
    readonly revision: number;
    readonly createdAt: number;
    readonly views: readonly ViewSnapshot[];
    readonly refs: Readonly<Record<string, RefDescriptor>>;
    readonly tools: Readonly<Record<string, ToolDescriptor>>;
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
    'TOOL_SCHEMA_INVALID', 'TOOL_SCHEMA_UNSUPPORTED', 'TOOL_SCHEMA_CAPACITY', 'OBSERVATION_CAPACITY',
] as const);
type SnapshotPrepareIssueCode = typeof SNAPSHOT_PREPARE_ISSUE_CODES[number];

export type SnapshotIssueCode =
    | SnapshotPrepareIssueCode
    | 'SNAPSHOT_CAPACITY'
    | 'SNAPSHOT_UNAVAILABLE'
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

export interface SnapshotHold {
    readonly snapshot: AppSnapshot;
    /** Idempotently relinquishes this hold. */
    release(): void;
}

export type HoldResult =
    | Readonly<{ status: 'acquired'; hold: SnapshotHold }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type RefLookup =
    | Readonly<{ status: 'resolved'; ref: RefDescriptor; target: RefTarget }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type ToolLookup =
    | Readonly<{ status: 'found'; tool: ToolDescriptor }>
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
    readonly appId: string;
    readonly instanceId: string;
    readonly now?: () => number;
    /** Captured at Core creation. Omitted or undefined fields use their defaults.
     * Overrides are safe integers from zero to their default, inclusive.
     * Invalid property shapes throw TypeError; invalid values throw RangeError. */
    readonly limits?: Partial<{ [Field in keyof SnapshotLimits]: SnapshotLimits[Field] | undefined }> | undefined;
    readonly maxHeldSnapshots?: number;
    readonly maxHeldSnapshotBytes?: number;
    readonly maxActiveHolds?: number;
    readonly maxIdentityBytes?: number;
    readonly maxCurrentBytes?: number;
}

export interface SnapshotStoreStats {
    readonly state: 'active' | 'disposed';
    readonly currentBytes: number;
    readonly diagnosticBytes: number;
    readonly currentSnapshots: number;
    readonly heldSnapshots: number;
    readonly heldSnapshotBytes: number;
    readonly activeHolds: number;
}

export interface SnapshotStore {
    readLatest(appId: string): SnapshotRead;
    getById(snapshotId: string): SnapshotLookup;
    acquire(snapshotId: string): HoldResult;
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
    stop(): void;
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

