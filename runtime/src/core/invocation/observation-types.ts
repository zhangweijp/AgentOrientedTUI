import type { SnapshotIssueCode, ToolDescriptorV4, ViewSnapshotV4 } from '../snapshot/types.js';

export interface ObservationJsonLimits {
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxApproxBytes: number;
    readonly maxCanonicalBytes: number;
}
export interface ObservationRegistryLimits {
    readonly maxViews: number;
    readonly maxRefs: number;
    readonly maxTools: number;
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
export interface ObservationSelection { readonly all: true }
export type ObservedView = Readonly<Omit<ViewSnapshotV4, 'toolBindings'>>;
export interface ObservedTool extends ToolDescriptorV4 {
    /** Omitted when every observed View of this type can receive the Tool. */
    readonly eligibleViewIds?: readonly string[];
}
export interface Observation {
    readonly observationId: string;
    readonly source: ObservationSource;
    /** null means this observation remains owned until release or instance closure. */
    readonly expiresAt: number | null;
    readonly views: readonly ObservedView[];
    readonly refs: readonly Readonly<RefIdentity & { refType: string; kind: 'snapshot-value' | 'entity' }>[];
    readonly tools: readonly ObservedTool[];
}
export interface ObservationGrant {
    readonly refs: readonly RefIdentity[];
    readonly toolIds: readonly string[];
}
export type ObservationIssueCode = SnapshotIssueCode | 'APP_INTERACTION_UNAVAILABLE' |
    'RESERVATION_UNAVAILABLE' | 'OBSERVATION_INVALID' | 'OBSERVATION_PROJECTION_INVALID' |
    'OBSERVATION_UNAVAILABLE' | 'OBSERVATION_NOT_ADOPTED' | 'OBSERVATION_CAPACITY' | 'OBSERVATION_INTERNAL_ERROR';
export interface ObservationIssue { readonly code: ObservationIssueCode; readonly message: string; readonly path?: string }
export interface ObservationRejected { readonly status: 'rejected'; readonly issue: ObservationIssue }
export interface ObservationRegistryStats {
    readonly closed: boolean;
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
