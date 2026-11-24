import type { CancellationSignal } from '../invocation/app-interaction-types.js';
import type { ProjectionLimits } from '../invocation/observation-types.js';
import type { AppProjectionFrame, PreparedProjection, ProjectionCommitResult, ProjectionOptions } from '../projection/coordinator.js';
import type { AppViewTypeDefinition } from '../tool/view-owned-tools.js';
import type { AppID, DesktopID } from './identity.js';
import type { AppLifecyclePort } from './app-lifecycle.interface.js';
import type { AppStatePersistence } from './state-persistence.interface.js';
import type { AppLaunchConfig } from './app-config.interface.js';

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
    /** Suggest another look after a meaningful background change. */
    requestAttention(): void;
    /** Supply the static definitions once before publishing Views. */
    defineViewTypes(definitions: readonly AppViewTypeDefinition[]): void;
    /** Prepare one complete frame locally. A throwing build records a projection failure. */
    publishFrame(build: () => AppProjectionFrame, options?: ProjectionOptions): ProjectionCommitResult;
    /** Read the accepted frame's local version. Required by the Preact adapter. */
    readPreparedProjection?(): PreparedProjection;
    /** Look up a uniquely named View in the App's healthy accepted frame. */
    readPreparedViewId(viewType: string, name: string): string | undefined;
}

export interface AppInstance {
    close(): void | Promise<void>;
    /** Join already queued commits without waiting for unrelated business work. */
    whenCommitted?(signal: CancellationSignal): Promise<void>;
}
