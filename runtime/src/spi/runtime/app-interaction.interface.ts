import { VIEW_TYPE_PARAMETERS_MODE } from '../../core/tool/ordinary-parameter-contract.js';
import type { DesktopID } from '../core/types.js';
import type { InteractionAuthority, ScopePolicy } from '../../core/invocation/scoped-interaction-types.js';

export type InteractionMode = typeof VIEW_TYPE_PARAMETERS_MODE;

/** SDK interaction profiles supported by this Runtime. Selected by the trusted Host. */
export const SEMANTIC_INTERACTION_MODES: readonly InteractionMode[] = Object.freeze([
    VIEW_TYPE_PARAMETERS_MODE,
]);

export interface AppInteractionOptions {
    readonly interactionModes?: readonly InteractionMode[];
}
export type AppScopeResult = ReturnType<InteractionAuthority['createScope']>;
export interface RuntimeInteractionAccess {
    createAppScope(desktopId: DesktopID, appId: string, policy: ScopePolicy): AppScopeResult;
}
export interface DesktopInteractionAccess {
    createAppScope(appId: string, policy: ScopePolicy): AppScopeResult;
}
