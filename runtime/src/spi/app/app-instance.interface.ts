import type { CancellationSignal } from '../../core/invocation/app-interaction-types.js';
import type { ProjectionLimits } from '../../core/invocation/observation-types.js';
import type { AppProjectionFrame, ProjectionCommitResult, ProjectionOptions } from '../../core/projection/coordinator.js';
import type { AppTypeToolDefinition } from '../../core/tool/view-owned-tools.js';
import type { AppID, DesktopID } from '../core/types.js';
import type { LLMUsageEvent } from '../core/llm-usage.js';
import type { AppLifecyclePort } from '../runtime/app-lifecycle.interface.js';
import type { AppStatePersistence } from '../runtime/state-persistence.interface.js';
import type { AppLaunchConfig } from './app-config.interface.js';
export type { AppStatePersistence, StateValue, StateIssue, StateBinding, StateBindingStatus, StateFlushReport } from '../runtime/state-persistence.interface.js';

export interface RuntimeContext {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly launchConfig?: AppLaunchConfig;
    readonly persistence?: AppStatePersistence;
    readonly appLifecycle: AppLifecyclePort;
    /** Effective fixed limits on this App's complete projection. */
    readonly projectionLimits: ProjectionLimits;
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
