import type {
    AppID, AppLaunchConfig, DesktopID, JsonValue, LocalRefUse, ProjectionLimits, RefScope, RefContinuity, SnapshotIssue,
    ViewMultiplicity, ViewRegion, ViewToolInvocationTerminal, ViewToolReceiver,
} from '@aotui/core';
import type { SnapshotDraftEnvelope } from "@aotui/core/host";
import type { AppCleanupReport } from './app-lifecycle.interface.js';

/** A complete frame produced by one App execution. View and activation identities are local to it. */
export interface AppExecutionProjection {
    readonly sourceEpoch: number;
    readonly producerSeq: number;
    readonly healthySince: number;
    /** Required on the first accepted frame only, including empty declarations. */
    readonly viewTypes?: readonly Readonly<{ name: string; multiplicity: ViewMultiplicity }>[];
    readonly views: readonly Readonly<{
        id: string; type: string; name: string; region: ViewRegion; body: string;
        viewInstanceId: string; closeActivationId?: string;
        tools: readonly Readonly<{ name: string; activationId: string }>[];
    }>[];
    readonly refs: readonly Readonly<{
        viewId: string; viewInstanceId: string; id: string; scope: RefScope; continuity: RefContinuity;
        refType?: string; array?: true; valueSchema: JsonValue; value: JsonValue;
    }>[];
    readonly tools: readonly Readonly<{
        viewType: string; name: string; multiplicity: ViewMultiplicity; description: string; inputSchema: JsonValue;
    }>[];
}

export interface AppExecutionLaunch {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly instanceId: string;
    readonly installationId: string;
    readonly name: string;
    readonly command?: readonly string[];
    readonly modulePath?: string;
    readonly config?: AppLaunchConfig;
    readonly projectionLimits: ProjectionLimits;
    readonly toolsEnabled: boolean;
    readonly timeoutMs: number;
    /** The single Receiver actually accepts/rejects; no preflight success implies publication. */
    acceptProjection(frame: AppExecutionProjection, mode: "authoritative" | "candidate", requestId?: string): AppExecutionAcceptance;
}

export type AppExecutionAcceptance =
    | Readonly<{ status: 'accepted'; publication: SnapshotDraftEnvelope }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>;

export type AppExecutionRequest = Readonly<{ id: string }> & (
    | Readonly<{ kind: 'initialize' | 'open' | 'stop' | 'close' }>
    | Readonly<{ kind: 'observe'; known?: SnapshotDraftEnvelope }>
    | Readonly<{
        kind: 'invoke'; tool: Readonly<{ viewType: string; name: string }>; receiver: ViewToolReceiver;
        input: Readonly<Record<string, JsonValue>>; localRefs: readonly LocalRefUse[];
    }>
    | Readonly<{ kind: 'closeView'; viewId: string; viewInstanceId: string; closeActivationId: string }>
);

export type AppExecutionIssue = Readonly<{ code: string; message: string; path?: string }>;
type AppExecutionCleanup = Pick<AppCleanupReport, 'issues'> & Readonly<{ state: AppCleanupReport['state'] }>;
export type AppExecutionEvent =
    | (Readonly<{ kind: 'reply'; id: string }> & (
        | Readonly<{ status: 'ready' }>
        | Readonly<{ status: 'done'; cleanup?: AppExecutionCleanup; publication?: SnapshotDraftEnvelope }>
        | Readonly<{ status: 'failed'; issue: AppExecutionIssue; cleanup?: AppExecutionCleanup }>
        | Readonly<{ status: 'tool'; terminal: ViewToolInvocationTerminal | Readonly<{ phase: 'finished-unknown' }> }>
    ))
    | Readonly<{ kind: 'projectionCurrent'; id: string; publication: SnapshotDraftEnvelope }>
    | Readonly<{ kind: 'projection'; id?: string; frame: AppExecutionProjection }>
    | Readonly<{ kind: 'projectionFailed'; id?: string; producerSeq: number; sourceEpoch: number; issue: SnapshotIssue }>
    | Readonly<{ kind: 'update'; reason: 'view_updated' | 'projection_recovered' | 'attention_requested' }>
    /** All complete receipts precede channelEnded. An execution may remain live after this event. */
    | Readonly<{ kind: 'channelEnded'; issue?: AppExecutionIssue }>
    /** The execution has exited and its receipt channel has drained. */
    | Readonly<{ kind: 'exited'; issue?: AppExecutionIssue }>;

export interface AppExecutionHandle {
    /** Report a definitely unentered operation with a terminal reply. A thrown send alone leaves its outcome unknown. */
    send(request: AppExecutionRequest): void;
    /** Request termination. Report confirmed exit separately, even after an earlier failure. */
    terminate(): void | Promise<void>;
}

export interface AppExecutionBackend {
    /** Return one fresh handle synchronously. Throw only when no execution needs to be released. */
    start(launch: AppExecutionLaunch, emit: (event: AppExecutionEvent) => void): AppExecutionHandle;
}
