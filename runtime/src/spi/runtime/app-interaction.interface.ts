import type { AppInteraction, Issue } from '../../core/invocation/app-interaction-types.js';
import type { ProjectionLimitOverrides } from '../../core/invocation/observation-types.js';

export interface AppInteractionOptions {
    /** Trusted Host option. Defaults to true. False allows View observation without Tool execution. */
    readonly toolsEnabled?: boolean;
    /** Fixed per-installation limits on the complete App projection. Overrides may only lower defaults. */
    readonly projectionLimits?: ProjectionLimitOverrides;
}
export type AppInteractionResult = Readonly<{ status: 'ready'; interaction: AppInteraction }> |
    Readonly<{ status: 'rejected'; issue: Issue }>;
export function appInteractionUnavailable(code = 'APP_INTERACTION_UNAVAILABLE'): Extract<AppInteractionResult, { status: 'rejected' }> {
    return Object.freeze({ status: 'rejected', issue: Object.freeze({ code, message: code === 'APP_INSTANCE_MISMATCH'
        ? 'The expected App instance has changed. Discover the current instance.' : 'App interaction is unavailable.' }) });
}
