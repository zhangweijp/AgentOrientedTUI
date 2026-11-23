import type { JsonValue, RefDescriptor, SnapshotIssueCode, ToolDescriptor, ViewSnapshot } from '../snapshot/types.js';
import type { RefPath } from '../tool/ref-parameters.js';

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
export type ProjectionLimits = Pick<ObservationRegistryLimits, 'maxViews' | 'maxRefs' | 'maxTools' | 'observation' | 'metadata'>;
export type ProjectionLimitOverrides = Pick<ObservationRegistryLimitOverrides, keyof ProjectionLimits>;
export interface ObservationRegistryOptions {
    readonly namespace: string;
    readonly limits?: ObservationRegistryLimitOverrides;
}
export interface ReservationHandle { readonly reservation: true }
export interface ViewIdentity { readonly viewId: string; readonly viewInstanceId: string }
export interface ObservationWindowSelection {
    readonly receiverViews: readonly ViewIdentity[];
    readonly refViews: readonly ViewIdentity[];
}
export type ViewWindowAccess = (view: ViewIdentity) => Readonly<{ epoch: number; expanded: boolean }>;
export interface RefIdentity extends ViewIdentity { readonly refId: string }
export interface RefConsumer extends ViewIdentity { readonly appId: string; readonly instanceId: string }
export interface RefPathGrant {
    readonly path: RefPath;
    readonly consumer?: RefConsumer | 'console';
}
export interface RefGrant extends RefIdentity { readonly paths?: readonly RefPathGrant[] }
export interface ObservedRefPath extends Omit<RefPathGrant, 'consumer'> {
    readonly consumer?: RefConsumer;
    /** Type stated by the selected schema, when it can be determined without exposing the enclosing schema. */
    readonly valueType?: string;
    /** Nominal source type of a whole Ref or declared ArrayRef element. */
    readonly refType?: string;
    readonly array?: true;
}
export interface ProgramRefPath {
    readonly path: RefPath;
    readonly schema?: JsonValue;
}
type RefPresentation = RefIdentity & Pick<RefDescriptor, 'scope'> & {
    readonly kind: RefDescriptor['target']['kind'];
    readonly programPaths?: readonly ProgramRefPath[];
};
export type ObservedRef = Readonly<RefPresentation & (
    Pick<RefDescriptor, 'refType' | 'array' | 'valueSchema'> & { paths?: never } |
    { paths: readonly ObservedRefPath[]; refType?: never; array?: never; valueSchema?: never }
)>;
export interface ObservationSource {
    readonly appId: string;
    readonly instanceId: string;
    readonly snapshotId: string;
    readonly revision: number;
}
export interface ObservationSelection { readonly all: true; readonly programTools?: true }
export type ObservedView = Readonly<Omit<ViewSnapshot, 'toolBindings'>>;
export interface ProgramToolInput {
    readonly schema: Readonly<Record<string, JsonValue>>;
    readonly refOnly: readonly Readonly<{ parameter: string; arrayElement: boolean; refType: string }>[];
}
export interface ObservedTool extends Omit<ToolDescriptor, 'inputSchema'> {
    readonly inputSchema: Readonly<Record<string, JsonValue>>;
    readonly programInput?: ProgramToolInput;
    /** Omitted when every observed View of this type can receive the Tool. */
    readonly eligibleViewIds?: readonly string[];
}
export interface Observation {
    readonly observationId: string;
    readonly source: ObservationSource;
    /** null means this observation remains owned until release or instance closure. */
    readonly expiresAt: number | null;
    readonly views: readonly ObservedView[];
    readonly refs: readonly ObservedRef[];
    readonly tools: readonly ObservedTool[];
}
export interface ObservationGrant {
    readonly refs: readonly RefGrant[];
    readonly toolIds: readonly string[];
}
export type ObservationIssueCode = SnapshotIssueCode | 'APP_INTERACTION_UNAVAILABLE' |
    'RESERVATION_UNAVAILABLE' | 'OBSERVATION_INVALID' | 'OBSERVATION_PROJECTION_INVALID' |
    'OBSERVATION_UNAVAILABLE' | 'OBSERVATION_NOT_ADOPTED' | 'OBSERVATION_INTERNAL_ERROR' | 'OBSERVATION_WINDOW_CHANGED' | 'TOOL_INVALID_ARGS';
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
