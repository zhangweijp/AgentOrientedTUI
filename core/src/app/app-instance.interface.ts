import type { CancellationSignal } from '../invocation/app-interaction-types.js';
import type { ProjectionLimits } from '../invocation/observation-types.js';
import type { AppProjectionFrame, ProjectionCommitResult, ProjectionOptions } from '../projection/coordinator.js';
import type { AppViewTypeDefinition } from '../tool/view-owned-tools.js';
import type { AppID, DesktopID } from './identity.js';
import type { AppLifecyclePort } from './app-lifecycle.interface.js';
import type { AppLaunchConfig } from './app-config.interface.js';

export interface RuntimeContext {
    readonly appId: AppID;
    readonly desktopId: DesktopID;
    readonly launchConfig?: AppLaunchConfig;
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
    /** Read the routing ID of an owner mounted in the App's healthy accepted frame. */
    readViewId(owner: object): string | undefined;
}

export interface AppInstance {
    close(): void | Promise<void>;
}
