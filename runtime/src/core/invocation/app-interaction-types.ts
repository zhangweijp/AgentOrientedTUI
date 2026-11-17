/** Core owns these contracts. The Runtime root also exposes the Host-facing types. */
import type { AppSnapshot, JsonValue, ViewToolReceiver, ToolDescriptor } from '../snapshot/types.js';
import type { Observation, ObservedView, ObservationGrant, ObservationSource, ObservationRegistryStats, ObservationJsonLimits, ObservationSelection } from './observation-types.js';
import type { SnapshotValueRefSource } from '../tool/snapshot-value-arguments.js';
export type { AppIdentityRead, AppIdentityReader } from '../snapshot/types.js';
type JsonObject = Readonly<Record<string, JsonValue>>;
export interface Issue { readonly code: string; readonly message: string; readonly path?: string }
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: Readonly<{once?: boolean}>): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
import type { ToolResultData } from '../tool/tool-result.js';
export type ExecutionPhase = 'not-entered' | 'entered-returned';
export type BusinessDetails = Readonly<{kind:'tool-result'; phase:ExecutionPhase; result:ToolResultData}>;
export type InvocationOutcome =
  | Readonly<{status:'succeeded'; value:JsonValue}>
  | Readonly<{status:'rejected'; code:string; message:string; path?:string; details?:BusinessDetails}>
  | Readonly<{status:'failed'; code:string; message:string; details?:BusinessDetails}>
  | Readonly<{status:'unknown'; code:string; message:string; details?:BusinessDetails}>;
export type ExecutionFact =
  | Readonly<{kind:'tool-result'; phase:ExecutionPhase; result:ToolResultData}>
  | Readonly<{kind:'unknown'}>;
export interface AppInvocation {
  readonly invocationId:string;
  readonly observationId:string;
  readonly toolId:string;
  /** Model-facing arguments, including the receiving View's XML id. */
  readonly input:JsonObject & { readonly view_id: string };
}
export interface ReceiptQuery {
  readonly observationId: string;
  readonly invocationId: string;
}
export interface InvocationSource {
  readonly appId:string;
  readonly instanceId:string;
  readonly snapshotId:string;
  readonly tool:ToolDescriptor;
  readonly receiver:ViewToolReceiver;
}
export interface ReceiptMetadata {
  readonly appId:string;
  readonly instanceId:string;
  readonly invocationId:string;
  readonly observationId:string;
  readonly toolId:string;
  readonly source:ObservationSource|null;
}
export interface InvocationReceipt {
  readonly invocationId:string;
  readonly observationId:string;
  readonly toolId:string;
  readonly source:ObservationSource|null;
  /** When the invocation reached its terminal outcome. */
  readonly completedAt:number;
  readonly expiresAt:number;
  readonly executionPhase:'not-dispatched'|ExecutionPhase|'unknown';
  readonly outcome:InvocationOutcome;
}
export type ReceiptAccess =
  | Readonly<{kind:'receipt'; receipt:InvocationReceipt}>
  | Readonly<{kind:'unavailable'; code:string; message:string}>;
export type InvokeResult = ReceiptAccess | Readonly<{kind:'refused'; code:string; message:string}>;
export type ObserveResult = Readonly<{status:'observed'; observation:Observation}> | Readonly<{status:'rejected'; issue:Issue}>;
export type AppPreviewResult = Readonly<{status:'previewed'; source:ObservationSource; views:readonly ObservedView[]}> |
  Readonly<{status:'rejected'; issue:Issue}>;
export interface InvocationContext {
  readonly invocationId:string;
  readonly source:InvocationSource;
  readonly rawInput:JsonObject;
  readonly effectiveInput:JsonObject;
  readonly refSources:readonly SnapshotValueRefSource[];
  readonly signal:CancellationSignal;
}
export type LiveCheck = Readonly<{ok:true}> | Readonly<{ok:false}>;
export interface ExecutionBinding {
  readonly identity:object;
  isLive(source:InvocationSource):LiveCheck;
  execute(context:InvocationContext):ExecutionFact|Promise<ExecutionFact>;
}
export interface ExecutionResolver {
  /** Stable identity/function references for one live registered callable. */
  resolve(source:InvocationSource):ExecutionBinding|null;
}
export interface AppInteractionPolicy {
  project(context:Readonly<{source:AppSnapshot; signal:CancellationSignal}>):ObservationGrant|Promise<ObservationGrant>;
  authorize(context:InvocationContext):boolean|Promise<boolean>;
  canReadReceipt(metadata:ReceiptMetadata, signal:CancellationSignal):boolean|Promise<boolean>;
}
export interface AppInteraction {
  observe(selection:ObservationSelection):Promise<ObserveResult>;
  preview():Promise<AppPreviewResult>;
  /** Adopt the prepared observation and release the previous observation. */
  adoptObservation(observationId:string):Readonly<{status:'adopted'}>|Readonly<{status:'rejected';issue:Issue}>;
  /** A deadline bounds this wait and the initial invocation's admission. Dispatched work continues to settlement. */
  invoke(request:AppInvocation, timeoutMs?:number):Promise<InvokeResult>;
  /** Authorize and read the original invocation's terminal receipt. The deadline only bounds this read. */
  readReceipt(query: ReceiptQuery, timeoutMs?:number):Promise<ReceiptAccess>;
  releaseObservation(observationId:string):void;
}
export interface AppInteractionSource {
  readonly appId:string;
  readonly instanceId:string;
  readonly policy:AppInteractionPolicy;
  readonly execution:ExecutionResolver;
}
export interface InteractionLimits {
  readonly maxReceiptsPerObservation:number;
  readonly maxReceipts:number;
  readonly maxReads:number;
  readonly receiptTtlMs:number;
  readonly request:ObservationJsonLimits;
  readonly rawInput:ObservationJsonLimits;
  readonly metadata:ObservationJsonLimits;
  readonly fact:ObservationJsonLimits;
  readonly receipt:ObservationJsonLimits;
  readonly maxSourceBytes:number;
  readonly maxFingerprintBytes:number;
  readonly maxMetadataBytes:number;
  readonly maxWorkBytes:number;
  readonly maxResultBytes:number;
  readonly maxTotalBytes:number;
}
export type InteractionLimitOverrides = {
  readonly [K in keyof InteractionLimits]?: InteractionLimits[K] extends ObservationJsonLimits ? Partial<InteractionLimits[K]> : number;
};
export interface InteractionStats {
  readonly closed:boolean;
  readonly activeInvocations:number;
  readonly activeReads:number;
  readonly receiptEntries:number;
  readonly receiptContents:number;
  readonly sourceBytes:number;
  readonly fingerprintBytes:number;
  readonly metadataBytes:number;
  readonly workBytes:number;
  readonly resultBytes:number;
  readonly invocationBytes:number;
  readonly combinedBytes:number;
  readonly observations:ObservationRegistryStats;
  readonly issue?:Issue;
}
export interface InstanceInteraction extends AppInteraction {
  /** Pure Core accepts input from transport and validates it before use. */
  observe(selection:unknown):Promise<ObserveResult>;
  invoke(request:unknown, timeoutMs?:number):Promise<InvokeResult>;
  inspect():InteractionStats;
  close():InteractionStats;
  whenClosed():Promise<void>;
}
