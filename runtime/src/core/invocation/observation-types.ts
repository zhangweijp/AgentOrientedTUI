import type { ToolSourceRequest } from '../tool/source-binding.js';
import type { AppSnapshotV2, SnapshotIssueCode, ToolDescriptorV2, ToolTargetV2, ViewSnapshotV2 } from '../snapshot/types.js';

export interface ObservationJsonLimits {
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxApproxBytes: number;
    readonly maxCanonicalBytes: number;
}
export interface ObservationRegistryLimits {
    readonly maxScopes: number;
    readonly maxObservationsPerScope: number;
    readonly maxObservations: number;
    readonly maxReservationsPerScope: number;
    readonly maxReservations: number;
    readonly maxViews: number;
    readonly maxRefs: number;
    readonly maxTools: number;
    readonly maxBindings: number;
    /** Applied only when lifetime is explicitly 'ttl'. */
    readonly scopeTtlMs: number;
    /** Applied only when lifetime is explicitly 'ttl'. */
    readonly observationTtlMs: number;
    readonly capture: ObservationJsonLimits;
    readonly metadata: ObservationJsonLimits;
    readonly observation: ObservationJsonLimits;
    readonly source: ObservationJsonLimits;
    readonly maxSourceBytes: number;
    readonly maxObservationBytes: number;
    readonly maxMetadataBytes: number;
    readonly maxTotalBytes: number;
}
export type ObservationRegistryLimitOverrides = {
    readonly [K in keyof ObservationRegistryLimits]?: ObservationRegistryLimits[K] extends ObservationJsonLimits
        ? Partial<ObservationJsonLimits> : number;
};
export interface ObservationRegistryOptions {
    readonly namespace: string;
    readonly now: () => number;
    /** Default scope ownership uses explicit release/close; TTL is opt-in. */
    readonly lifetime?: 'scope' | 'ttl';
    readonly limits?: ObservationRegistryLimitOverrides;
}
export interface ScopeHandle { readonly scopeId: string }
export interface ReservationHandle { readonly reservation: true }
export interface ViewIdentity { readonly viewId: string; readonly viewInstanceId: string }
export interface RefIdentity extends ViewIdentity { readonly refId: string }
export interface ObservationSource {
    readonly appId: string;
    readonly instanceId: string;
    readonly snapshotId: string;
    readonly revision: number;
}
export interface ObservationSelection { readonly viewIds: readonly string[] }
export interface ObservationBinding {
    readonly bindingId: string;
    readonly toolId: string;
    readonly target: ToolTargetV2;
}
export type ObservedView = Readonly<Omit<ViewSnapshotV2, 'content'> & { readonly content?: ViewSnapshotV2['content'] }>;
export interface Observation {
    readonly observationId: string;
    readonly source: ObservationSource;
    /** null means this observation remains owned until release or Scope revocation. */
    readonly expiresAt: number | null;
    readonly views: readonly ObservedView[];
    readonly refs: readonly Readonly<RefIdentity & { refType: string; kind: 'snapshot-value' | 'entity' }>[];
    readonly tools: readonly ToolDescriptorV2[];
    readonly bindings: readonly ObservationBinding[];
}
export interface ObservationGrant {
    readonly views: readonly ViewIdentity[];
    readonly refs: readonly RefIdentity[];
    readonly targets: readonly Readonly<{ toolId: string; target: ToolTargetV2 }>[];
    readonly content: readonly Readonly<{ view: ViewIdentity; decision: 'retain' | 'hide' }>[];
}
export type ObservationIssueCode = SnapshotIssueCode | 'SCOPE_INVALID' | 'SCOPE_UNAVAILABLE' |
    'RESERVATION_UNAVAILABLE' | 'OBSERVATION_INVALID' | 'OBSERVATION_PROJECTION_INVALID' |
    'OBSERVATION_UNAVAILABLE' | 'BINDING_UNAVAILABLE' | 'OBSERVATION_CAPACITY' | 'OBSERVATION_INTERNAL_ERROR';
export interface ObservationIssue { readonly code: ObservationIssueCode; readonly message: string }
export interface ObservationRejected { readonly status: 'rejected'; readonly issue: ObservationIssue }
export interface ObservationRegistryStats {
    readonly closed: boolean;
    readonly scopes: number;
    readonly observations: number;
    readonly reservations: number;
    readonly cancelledReservations: number;
    readonly observationSlots: number;
    readonly sources: number;
    readonly sourceBytes: number;
    readonly observationBytes: number;
    readonly metadataBytes: number;
    readonly totalBytes: number;
    readonly issue?: ObservationIssue;
}
export interface ObservationCleanup extends ObservationRegistryStats {
    readonly releasedObservations: number;
    readonly releasedSources: number;
    readonly removedScopes: number;
}
export interface ObservationRegistry {
    openScope(input: unknown): Readonly<{ status: 'opened'; scope: ScopeHandle }> | ObservationRejected;
    checkScope(scope: ScopeHandle): Readonly<{ status: 'active'; expiresAt: number | null }> | ObservationRejected;
    begin(scope: ScopeHandle, selection: unknown): Readonly<{
        status: 'reserved'; reservation: ReservationHandle; source: AppSnapshotV2;
        selection: ObservationSelection; expiresAt: number | null;
    }> | ObservationRejected;
    complete(scope: ScopeHandle, reservation: ReservationHandle, grant: unknown): Readonly<{
        status: 'observed'; observation: Observation;
    }> | ObservationRejected;
    abandon(scope: ScopeHandle, reservation: ReservationHandle): void;
    resolveBinding(scope: ScopeHandle, input: unknown): Readonly<{
        status: 'found'; sourceRequest: ToolSourceRequest; tool: ToolDescriptorV2;
        target: ToolTargetV2; visibleRefIds: readonly string[];
    }> | ObservationRejected;
    releaseObservation(scope: ScopeHandle, observationId: string): void;
    closeScope(scope: ScopeHandle): ObservationCleanup;
    sweepExpired(): ObservationCleanup;
    close(): ObservationCleanup;
    inspect(): ObservationRegistryStats;
}
