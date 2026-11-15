import type { CancellationSignal } from '../../core/invocation/app-interaction-types.js';
import type { ViewSnapshotV4 } from '../../core/snapshot/types.js';
import type { AppID, DesktopID } from '../core/types.js';
import type { LLMUsageEvent } from '../core/llm-usage.js';
import type { IProjectionPort } from '../runtime/projection.interface.js';
import type { MountedView } from '../runtime/view-owned-tools.interface.js';
import type { AppFrameBinding, AppTypeToolDefinition } from '../runtime/app-type-tools.interface.js';
import type { AppLifecyclePort } from '../runtime/app-lifecycle.interface.js';
import type { AppStatePersistence } from '../runtime/state-persistence.interface.js';
import type { AppLaunchConfig } from './app-config.interface.js';
import type { IRefExporter } from './ref-exporter.interface.js';
export type { AppStatePersistence, StateValue, StateIssue, StateBinding, StateBindingStatus, StateFlushReport } from '../runtime/state-persistence.interface.js';

export interface AppFrameRef {
    readonly id: string;
    readonly token: object;
    readonly refType?: string | undefined;
}

/** Completed author data. Runtime supplies the mounted identities and Tool activations. */
export interface AppFrameView extends Omit<ViewSnapshotV4, 'viewInstanceId' | 'toolBindings'> {
    readonly owner: object;
    readonly bindings: readonly AppFrameBinding[];
}
export interface AppProjectionFrame {
    readonly views: readonly (AppFrameView & { readonly refs: readonly AppFrameRef[] })[];
}
export type PreparedProjection = Readonly<{ status: 'prepared'; sourceEpoch: number }>;

export interface RuntimeContext {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly launchConfig?: AppLaunchConfig;
    readonly persistence?: AppStatePersistence;
    readonly appLifecycle?: AppLifecyclePort;
    readonly refExporter: IRefExporter;
    readonly projection: IProjectionPort;
    /** Aborted when the instance stops admitting new work. */
    readonly signal: CancellationSignal;
    /** Supply the static definitions once before publishing Views. */
    defineTools(definitions: readonly AppTypeToolDefinition[]): void;
    /** Obtain a renderer-owned Ref attachment. It becomes executable only after commit. */
    mountView(id: string, type: string): MountedView;
    /** Install the renderer's full-frame reader before its first commit. */
    setViewReader(read: () => readonly AppFrameView[]): void;
    /** Prepare one complete frame locally. Host acceptance happens separately. */
    publishFrame(build: () => AppProjectionFrame): PreparedProjection;
}

export interface AppInstance {
    close(): void | Promise<void>;
    /** Join already queued commits without waiting for unrelated business work. */
    whenCommitted?(signal: CancellationSignal): Promise<void>;
    onLLMUsage?(event: LLMUsageEvent): void;
}
