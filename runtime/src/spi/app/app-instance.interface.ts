import type { CancellationSignal } from '../../core/invocation/app-interaction-types.js';
import type { ViewInstance } from '../../core/tool/view-owned-tools.js';
import type { ViewSnapshotV2 } from '../../core/snapshot/types.js';
import type { AppID, DesktopID } from '../core/types.js';
import type { LLMOutputEvent } from '../core/llm-output.js';
import type { IProjectionPort } from '../runtime/projection.interface.js';
import type { IViewOwnedToolPort } from '../runtime/view-owned-tools.interface.js';
import type { AppFrameTool, IAppTypeToolPort } from '../runtime/app-type-tools.interface.js';
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
export interface AppProjectionFrame {
    readonly views: readonly (Omit<ViewSnapshotV2, 'viewInstanceId'> & { readonly refs: readonly AppFrameRef[] })[];
    readonly tools: readonly AppFrameTool[];
}

export interface RuntimeContext {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly launchConfig?: AppLaunchConfig;
    readonly persistence?: AppStatePersistence;
    readonly appLifecycle?: AppLifecyclePort;
    readonly refExporter: IRefExporter;
    readonly projection: IProjectionPort;
    readonly viewTools?: IViewOwnedToolPort;
    readonly appTypeTools?: IAppTypeToolPort;
    /** Aborted when the instance stops admitting new work. */
    readonly signal: CancellationSignal;
    /** Install the adapter's reader before its first commit. Called only at commit, never on observe. */
    setViewReader(read: (mounted: readonly ViewInstance[]) => readonly ViewSnapshotV2[]): void;
    /** Build and accept one complete frame within the synchronous capture boundary. */
    publishFrame(build: () => AppProjectionFrame): void;
}

export interface ExternalAppEvent {
    readonly viewId: string;
    readonly type: string;
    readonly data: Readonly<Record<string, unknown>>;
    readonly timestamp: number;
}

export interface AppInstance {
    close(): void | Promise<void>;
    /** Join already queued commits without waiting for unrelated business work. */
    whenCommitted?(signal: CancellationSignal): Promise<void>;
    onExternalEvent?(event: ExternalAppEvent): void;
    onLLMOutput?(event: LLMOutputEvent): void;
}
