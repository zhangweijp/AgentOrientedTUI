import type { CancellationSignal } from '../../core/invocation/app-interaction-types.js';
import type { JsonValue, SnapshotIssue, ViewSnapshotV4 } from '../../core/snapshot/types.js';
import type { AppID, DesktopID } from '../core/types.js';
import type { LLMUsageEvent } from '../core/llm-usage.js';
import type { AppFrameBinding, AppTypeToolDefinition } from '../runtime/app-type-tools.interface.js';
import type { AppLifecyclePort } from '../runtime/app-lifecycle.interface.js';
import type { AppStatePersistence } from '../runtime/state-persistence.interface.js';
import type { AppLaunchConfig } from './app-config.interface.js';
export type { AppStatePersistence, StateValue, StateIssue, StateBinding, StateBindingStatus, StateFlushReport } from '../runtime/state-persistence.interface.js';

export interface AppFrameRef {
    readonly id: string;
    readonly value: JsonValue;
    readonly refType?: string | undefined;
}

/** Completed author data. Runtime supplies the mounted identities and Tool activations. */
export interface AppFrameView extends Omit<ViewSnapshotV4, 'viewInstanceId' | 'toolBindings'> {
    readonly owner: object;
    readonly bindings: readonly AppFrameBinding[];
    readonly refs: readonly AppFrameRef[];
}
export interface AppProjectionFrame {
    readonly views: readonly AppFrameView[];
}
export type PreparedProjection = Readonly<{ status: 'prepared'; sourceEpoch: number }>;
export type ProjectionOptions =
    | Readonly<{ opening: true; retainViews?: true }>
    | Readonly<{ restore: true }>;
export type ProjectionCommitResult = PreparedProjection
    | Readonly<{ status: 'restored'; sourceEpoch: number }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>
    | Readonly<{ status: 'failed'; issue: SnapshotIssue; cause?: { readonly error: unknown } }>;

export interface RuntimeContext {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly launchConfig?: AppLaunchConfig;
    readonly persistence?: AppStatePersistence;
    readonly appLifecycle?: AppLifecyclePort;
    /** Aborted when the instance stops admitting new work. */
    readonly signal: CancellationSignal;
    /** Supply the static definitions once before publishing Views. */
    defineTools(definitions: readonly AppTypeToolDefinition[]): void;
    /** Prepare one complete frame locally. A throwing build records a projection failure. */
    publishFrame(build: () => AppProjectionFrame, options?: ProjectionOptions): ProjectionCommitResult;
}

export interface AppInstance {
    close(): void | Promise<void>;
    /** Join already queued commits without waiting for unrelated business work. */
    whenCommitted?(signal: CancellationSignal): Promise<void>;
    onLLMUsage?(event: LLMUsageEvent): void;
}
