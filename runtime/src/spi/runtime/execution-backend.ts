import type {
    AppID, AppLaunchConfig, DesktopID, JsonValue, LocalRefUse, ProjectionLimits, RefScope, SnapshotIssue,
    ViewMultiplicity, ViewRegion, ViewToolInvocationTerminal, ViewToolReceiver,
} from '@aotui/core';
import type { AppCleanupReport } from './app-lifecycle.interface.js';

/** A complete frame produced by one App execution. View and activation identities are local to it. */
export interface AppExecutionProjection {
    /** Advance on a new committed frame. Re-reading the same frame keeps its revision. */
    readonly revision: number;
    readonly views: readonly Readonly<{
        id: string; type: string; name: string; region: ViewRegion; body: string;
        viewInstanceId: string; canClose?: true;
        tools: readonly Readonly<{ name: string; activationId: string }>[];
    }>[];
    readonly refs: readonly Readonly<{
        viewId: string; viewInstanceId: string; id: string; scope: RefScope;
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
    /** Check a proposed complete frame against this installation's fixed limits. */
    checkProjection(frame: AppExecutionProjection): SnapshotIssue | undefined;
}

export type AppExecutionRequest = Readonly<{ id: string }> & (
    | Readonly<{ kind: 'initialize' | 'open' | 'observe' | 'stop' | 'close' }>
    | Readonly<{
        kind: 'invoke'; tool: Readonly<{ viewType: string; name: string }>; receiver: ViewToolReceiver;
        input: Readonly<Record<string, JsonValue>>; localRefs: readonly LocalRefUse[];
    }>
    | Readonly<{ kind: 'closeView'; viewId: string; viewInstanceId: string }>
);

export type AppExecutionIssue = Readonly<{ code: string; message: string; path?: string }>;
type AppExecutionCleanup = Pick<AppCleanupReport, 'issues'> & Readonly<{ state: 'stopped' | 'completed' | 'failed' }>;
export type AppExecutionEvent =
    | (Readonly<{ kind: 'reply'; id: string }> & (
        | Readonly<{ status: 'ready' }>
        | Readonly<{ status: 'done'; cleanup?: AppExecutionCleanup }>
        | Readonly<{ status: 'failed'; issue: AppExecutionIssue }>
        | Readonly<{ status: 'tool'; terminal: ViewToolInvocationTerminal | Readonly<{ phase: 'finished-unknown' }> }>
    ))
    | Readonly<{ kind: 'projection'; id?: string; frame: AppExecutionProjection }>
    | Readonly<{ kind: 'projectionFailed'; id?: string; revision: number; issue: SnapshotIssue }>
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
