import type { ObservedToolExecutionV3, SnapshotIssueCode, ToolDescriptorV3, ViewSnapshotV2 } from '../snapshot/types.js';

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
    readonly execution: ObservedToolExecutionV3;
}
export type ObservedView = Readonly<Omit<ViewSnapshotV2, 'content'> & { readonly content?: ViewSnapshotV2['content'] }>;
export interface Observation {
    readonly observationId: string;
    readonly source: ObservationSource;
    /** null means this observation remains owned until release or Scope revocation. */
    readonly expiresAt: number | null;
    readonly views: readonly ObservedView[];
    readonly refs: readonly Readonly<RefIdentity & { refType: string; kind: 'snapshot-value' | 'entity' }>[];
    readonly tools: readonly ToolDescriptorV3[];
    readonly bindings: readonly ObservationBinding[];
}
export interface ToolObservationGrant {
    readonly toolId: string;
    readonly execution: ObservedToolExecutionV3;
}
export interface ObservationGrant {
    readonly views: readonly ViewIdentity[];
    readonly refs: readonly RefIdentity[];
    readonly toolBindings: readonly ToolObservationGrant[];
    readonly content: readonly Readonly<{ view: ViewIdentity; decision: 'retain' | 'hide' }>[];
}
export type ObservationIssueCode = SnapshotIssueCode | 'SCOPE_INVALID' | 'SCOPE_UNAVAILABLE' |
    'RESERVATION_UNAVAILABLE' | 'OBSERVATION_INVALID' | 'OBSERVATION_PROJECTION_INVALID' |
    'OBSERVATION_UNAVAILABLE' | 'OBSERVATION_NOT_ADOPTED' | 'BINDING_UNAVAILABLE' | 'OBSERVATION_CAPACITY' | 'OBSERVATION_INTERNAL_ERROR';
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
