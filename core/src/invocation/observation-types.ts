import type { JsonValue, RefDescriptor, SnapshotIssueCode, ToolDescriptor, ViewSnapshot } from '../snapshot/types.js';

export interface ObservationJsonLimits {
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxApproxBytes: number;
    readonly maxCanonicalBytes: number;
}
export interface ProjectionLimits {
    readonly maxViews: number;
    readonly maxRefs: number;
    readonly maxTools: number;
    readonly metadata: ObservationJsonLimits;
    readonly observation: ObservationJsonLimits;
}
export type ProjectionLimitOverrides = {
    readonly [K in keyof ProjectionLimits]?: ProjectionLimits[K] extends ObservationJsonLimits
        ? Partial<ObservationJsonLimits> : number;
};
export interface ObservationRegistryOptions {
    readonly namespace: string;
    readonly limits?: ProjectionLimitOverrides;
}
export interface ReservationHandle { readonly reservation: true }
export interface ViewIdentity { readonly viewId: string; readonly viewInstanceId: string }
export interface ObservationWindowSelection {
    readonly activeViews: readonly ViewIdentity[];
    readonly closeViews?: readonly ViewIdentity[];
}
export interface RefIdentity extends ViewIdentity { readonly refId: string }
export interface RefConsumer extends ViewIdentity { readonly appId: string; readonly instanceId: string }
export interface RefGrant extends RefIdentity {
    /** Further restrict passing this Ref to these mounts. Omit to use its declared scope. */
    readonly consumers?: readonly RefConsumer[];
}
export type ObservedRef = Readonly<RefGrant & Pick<RefDescriptor, 'scope' | 'refType' | 'array' | 'valueSchema'>>;
export interface ObservationSource {
    readonly appId: string;
    readonly instanceId: string;
    readonly snapshotId: string;
    readonly revision: number;
}
export type ObservedView = Readonly<Omit<ViewSnapshot, 'toolBindings' | 'closeActivationId'> & { readonly canClose?: true }>;
export interface ObservedTool extends Omit<ToolDescriptor, 'inputSchema'> {
    readonly inputSchema: Readonly<Record<string, JsonValue>>;
    /** Omitted when every observed View of this type can receive the Tool. */
    readonly eligibleViewIds?: readonly string[];
}
export interface Observation {
    readonly observationId: string;
    readonly source: ObservationSource;
    readonly views: readonly ObservedView[];
    readonly refs: readonly ObservedRef[];
    readonly tools: readonly ObservedTool[];
}
export interface ObservationOptions {
    readonly excludeToolIds?: readonly string[];
}
export interface ObservationGrant {
    readonly refs: readonly RefGrant[];
    readonly toolIds: readonly string[];
    readonly closeViews?: readonly ViewIdentity[];
}
export type ObservationIssueCode = SnapshotIssueCode | 'APP_INTERACTION_UNAVAILABLE' |
    'RESERVATION_UNAVAILABLE' | 'OBSERVATION_INVALID' | 'OBSERVATION_PROJECTION_INVALID' |
    'OBSERVATION_UNAVAILABLE' | 'OBSERVATION_NOT_ADOPTED' | 'OBSERVATION_INTERNAL_ERROR' | 'OBSERVATION_WINDOW_CHANGED' | 'TOOL_INVALID_ARGS' | 'VIEW_CLOSE_NOT_GRANTED' | 'VIEW_CLOSE_SOURCE_STALE' | 'VIEW_CLOSE_UNAVAILABLE';
export interface ObservationIssue { readonly code: ObservationIssueCode; readonly message: string; readonly path?: string }
export interface ObservationRejected { readonly status: 'rejected'; readonly issue: ObservationIssue }
export interface ObservationRegistryStats {
    readonly closed: boolean;
    readonly observations: number;
    readonly reservations: number;
    readonly cancelledReservations: number;
    readonly observationSlots: number;
    readonly issue?: ObservationIssue;
}
