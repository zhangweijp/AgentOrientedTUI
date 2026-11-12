import { ORDINARY_INVOCATION_MODE } from '../tool/invocation-terminal.js';
import { VIEW_TYPE_PARAMETERS_MODE } from '../tool/ordinary-parameter-contract.js';
/** Internal Core contracts; no root package export. */
import type { AppSnapshotV3, JsonValue, ObservedToolExecutionV3, ToolDescriptorV3 } from '../snapshot/types.js';
import type { Observation, ObservedView, ObservationSelection, ObservationGrant, ObservationSource, ObservationRegistryStats, ObservationJsonLimits } from './observation-types.js';
import type { SnapshotValueRefSource } from '../tool/snapshot-value-arguments.js';
export type { AppIdentityRead, AppIdentityReader } from '../snapshot/types.js';
type JsonObject = Readonly<Record<string, JsonValue>>;
export interface Issue { readonly code: string; readonly message: string; readonly path?: string }
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: Readonly<{once?: boolean}>): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
import type { ToolResultData } from '../../spi/core/tool-result.js';
export type { ToolResultData } from '../../spi/core/tool-result.js';
export type ExecutionPhase = 'not-entered' | 'entered-returned';
export type BusinessDetails = Readonly<{kind:'tool-result'; phase:ExecutionPhase; result:ToolResultData}>;
export type InvocationOutcome =
  | Readonly<{status:'succeeded'; value:JsonValue}>
  | Readonly<{status:'rejected'; code:string; message:string; path?:string; details?:BusinessDetails}>
  | Readonly<{status:'failed'; code:string; message:string; effects:'none'|'partial'; details?:BusinessDetails}>
  | Readonly<{status:'unknown'; code:string; message:string; details?:BusinessDetails}>;
export type ExecutionFact =
  | Readonly<{kind:'tool-result'; phase:ExecutionPhase; result:ToolResultData; failureEffects?:'none'|'partial'}>
  | Readonly<{kind:'unknown'}>;
export interface AppInvocation {
  readonly invocationId:string;
  readonly observationId:string;
  readonly bindingId:string;
  readonly input:JsonObject;
}
export interface InvocationSource {
  readonly appId:string;
  readonly instanceId:string;
  readonly snapshotId:string;
  readonly tool:ToolDescriptorV3;
  readonly execution:ObservedToolExecutionV3;
}
export interface ReceiptMetadata {
  readonly appId:string;
  readonly instanceId:string;
  readonly invocationId:string;
  readonly observationId:string;
  readonly bindingId:string;
  readonly source:ObservationSource|null;
}
export interface InvocationReceipt {
  readonly invocationId:string;
  readonly observationId:string;
  readonly bindingId:string;
  readonly source:ObservationSource|null;
  /** When this receipt was produced. A deadline receipt can precede execution completion. */
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
export type InputValidation = Readonly<{ok:true; value:JsonObject}> | Readonly<{ok:false}>;
export type LiveCheck = Readonly<{ok:true}> | Readonly<{ok:false}>;
export interface ExecutionBindingBase {
  readonly identity:object;
  validateInput(source:InvocationSource, input:JsonObject, signal:CancellationSignal):InputValidation|Promise<InputValidation>;
  isLive(source:InvocationSource):LiveCheck;
  execute(context:InvocationContext):ExecutionFact|Promise<ExecutionFact>;
}
export type ExecutionBinding = ExecutionBindingBase & Readonly<{mode:typeof ORDINARY_INVOCATION_MODE|typeof VIEW_TYPE_PARAMETERS_MODE}>;
export interface ExecutionResolver {
  /** Stable identity/function references for one live registered callable. */
  resolve(source:InvocationSource):ExecutionBinding|null;
}
export interface AppInteractionPolicy {
  project(context:Readonly<{source:AppSnapshotV3; selection:ObservationSelection; signal:CancellationSignal}>):ObservationGrant|Promise<ObservationGrant>;
  authorize(context:InvocationContext):boolean|Promise<boolean>;
  canReadReceipt(metadata:ReceiptMetadata, signal:CancellationSignal):boolean|Promise<boolean>;
}
export interface AppInteraction {
  observe(selection:unknown):Promise<ObserveResult>;
  preview():Promise<AppPreviewResult>;
  /** Adopt the prepared observation and release the previous observation. */
  adoptObservation(observationId:string):Readonly<{status:'adopted'}>|Readonly<{status:'rejected';issue:Issue}>;
  /** A waiting deadline bounds this invocation's wait without ending dispatched work. */
  invoke(request:unknown, timeoutMs?:number):Promise<InvokeResult>;
  /** Authorize and read a matching original invocation, without admitting execution. */
  readReceipt(request:unknown, timeoutMs?:number):Promise<ReceiptAccess>;
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
  readonly ordinaryInput:ObservationJsonLimits;
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
  sweepExpired():InteractionStats;
  inspect():InteractionStats;
  close():InteractionStats;
  whenClosed():Promise<void>;
}
