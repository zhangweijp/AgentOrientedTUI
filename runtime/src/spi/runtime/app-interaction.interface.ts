import type { DesktopID } from '../core/types.js';
import type { InteractionAuthority, ScopePolicy } from '../../core/invocation/scoped-interaction.js';

export type InteractionModeV1 = 'ordinary-v1' | 'snapshot-value-v1' | 'create-if-absent-v1';
export type InteractionMode = InteractionModeV1 | 'ordinary-v2' | 'snapshot-value-v2';

/** SDK interaction profiles supported by this Runtime. Selected by the trusted Host. */
export const SEMANTIC_INTERACTION_MODES: readonly InteractionMode[] = Object.freeze([
    'ordinary-v1', 'ordinary-v2', 'snapshot-value-v1', 'snapshot-value-v2', 'create-if-absent-v1',
]);

export interface AppInteractionOptions {
    readonly experimentalInteractionModes?: readonly InteractionMode[];
}
export type AppScopeResult = ReturnType<InteractionAuthority['createScope']>;
export interface RuntimeInteractionAccess {
    experimentalCreateAppScope(desktopId: DesktopID, appId: string, policy: ScopePolicy): AppScopeResult;
}
export interface DesktopInteractionAccess {
    experimentalCreateAppScope(appId: string, policy: ScopePolicy): AppScopeResult;
}
