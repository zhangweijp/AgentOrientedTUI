import { VIEW_TYPE_PARAMETERS_MODE } from '../../core/tool/ordinary-parameter-contract.js';
import type { AppInteraction, Issue } from '../../core/invocation/app-interaction-types.js';

export type InteractionMode = typeof VIEW_TYPE_PARAMETERS_MODE;

/** SDK interaction profiles supported by this Runtime. Selected by the trusted Host. */
export const SEMANTIC_INTERACTION_MODES: readonly InteractionMode[] = Object.freeze([
    VIEW_TYPE_PARAMETERS_MODE,
]);

export interface AppInteractionOptions {
    readonly interactionModes?: readonly InteractionMode[];
}
export type AppInteractionResult = Readonly<{ status: 'ready'; interaction: AppInteraction }> |
    Readonly<{ status: 'rejected'; issue: Issue }>;
export function appInteractionUnavailable(code = 'APP_INTERACTION_UNAVAILABLE'): Extract<AppInteractionResult, { status: 'rejected' }> {
    return Object.freeze({ status: 'rejected', issue: Object.freeze({ code, message: code === 'APP_INSTANCE_MISMATCH'
        ? 'The expected App instance has changed. Discover the current instance.' : 'App interaction is unavailable.' }) });
}
