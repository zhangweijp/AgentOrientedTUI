/** Internal Core contracts; no root package export. */
import type { AppSnapshotV2, JsonValue, ToolDescriptorV2, ToolTargetV2 } from '../snapshot/types.js';
import type { Observation, ObservationSelection, ObservationGrant, ObservationSource, ObservationRegistryStats, ObservationJsonLimits } from './observation-types.js';
import type { SnapshotValueRefSource } from '../tool/snapshot-value-arguments.js';
export type { AppIdentityRead, AppIdentityReader } from '../snapshot/types.js';
type JsonObject = Readonly<Record<string, JsonValue>>;
export interface Issue { readonly code: string; readonly message: string }
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: Readonly<{once?: boolean}>): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
import type { ActionOutcome } from './invocation-outcome.js';
export type { ActionOutcome } from './invocation-outcome.js';
export interface OperationResultData {
  readonly success: boolean;
  readonly data?: JsonObject;
  readonly error?: Readonly<{code:string; message:string; context?:JsonObject}>;
}
export type ExecutionPhase = 'not-entered' | 'entered-returned';
export type BusinessDetails =
  | Readonly<{kind:'operation-result'; phase:ExecutionPhase; result:OperationResultData}>
  | Readonly<{kind:'action-outcome'; phase:ExecutionPhase; outcome:ActionOutcome}>;
export type InvocationOutcome =
  | Readonly<{status:'succeeded'; value:JsonValue}>
  | Readonly<{status:'rejected'; code:string; message:string; details?:BusinessDetails}>
  | Readonly<{status:'failed'; code:string; message:string; effects:'none'|'partial'; details?:BusinessDetails}>
  | Readonly<{status:'accepted'; operationId:string}>
  | Readonly<{status:'unknown'; code:string; message:string; details?:BusinessDetails}>;
export type ExecutionFact =
  | Readonly<{kind:'action'; phase:ExecutionPhase; outcome:ActionOutcome}>
  | Readonly<{kind:'operation-result'; phase:ExecutionPhase; result:OperationResultData; failureEffects?:'none'|'partial'}>
  | Readonly<{kind:'unknown'}>;
export interface ScopedInvocation {
  readonly invocationId:string;
  readonly observationId:string;
  readonly bindingId:string;
  readonly input:JsonObject;
}
export interface InvocationSource {
  readonly appId:string;
  readonly instanceId:string;
  readonly snapshotId:string;
  readonly tool:ToolDescriptorV2;
  readonly target:ToolTargetV2;
}
export interface ReceiptMetadata {
  readonly scopeId:string;
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
export interface InvocationContext {
  readonly scopeId:string;
  readonly invocationId:string;
  readonly source:InvocationSource;
  readonly rawInput:JsonObject;
  readonly effectiveInput:JsonObject;
  readonly refSources:readonly SnapshotValueRefSource[];
  readonly signal:CancellationSignal;
}
export type InputValidation = Readonly<{ok:true; value:JsonObject}> | Readonly<{ok:false}>;
export type LiveCheck = Readonly<{ok:true}> | Readonly<{ok:false}>;
export type OperationQuery = Readonly<{status:'pending'}> |
  Readonly<{status:'settled'; fact:ExecutionFact}> | Readonly<{status:'unavailable'}>;
export interface OperationProvider {
  /** Synchronous ownership proof for this exact scope + invocation + operation. */
  owns(metadata:ReceiptMetadata, operationId:string):boolean;
  query(metadata:ReceiptMetadata, operationId:string, signal:CancellationSignal):OperationQuery|Promise<OperationQuery>;
}
export interface ExecutionBindingBase {
  readonly identity:object;
  validateInput(source:InvocationSource, input:JsonObject, signal:CancellationSignal):InputValidation|Promise<InputValidation>;
  isLive(source:InvocationSource):LiveCheck;
  execute(context:InvocationContext):ExecutionFact|Promise<ExecutionFact>;
}
export type ExecutionBinding = ExecutionBindingBase & Readonly<{mode:'ordinary-v2'|'snapshot-value-v2';operations?:OperationProvider}>;
export interface ExecutionResolver {
  /** Stable identity/function references for one live registered callable. */
  resolve(source:InvocationSource):ExecutionBinding|null;
}
export interface ScopePolicy {
  project(context:Readonly<{source:AppSnapshotV2; selection:ObservationSelection; signal:CancellationSignal}>):ObservationGrant|Promise<ObservationGrant>;
  authorize(context:InvocationContext):boolean|Promise<boolean>;
  canReadReceipt(metadata:ReceiptMetadata, signal:CancellationSignal):boolean|Promise<boolean>;
}
export interface ScopeClient {
  observe(selection:unknown):Promise<ObserveResult>;
  invoke(request:unknown):Promise<InvokeResult>;
  readReceipt(invocationId:unknown):Promise<ReceiptAccess>;
  releaseObservation(observationId:string):void;
  close():void;
}
export interface TrustedScopeInput {
  readonly appId:string;
  readonly instanceId:string;
  readonly policy:ScopePolicy;
  readonly execution:ExecutionResolver;
}
export interface InteractionLimits {
  readonly maxScopes:number;
  readonly maxReceiptsPerScope:number;
  readonly maxReceipts:number;
  readonly maxInvocationsPerScope:number;
  readonly maxInvocations:number;
  readonly maxReadsPerScope:number;
  readonly maxReads:number;
  readonly maxQueriesPerScope:number;
  readonly maxQueries:number;
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
  readonly scopes:number;
  readonly closingScopes:number;
  readonly activeInvocations:number;
  readonly activeReads:number;
  readonly activeQueries:number;
  readonly receiptEntries:number;
  readonly receiptContents:number;
  readonly acceptedOperations:number;
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
export interface InteractionAuthority {
  createScope(input:TrustedScopeInput):Readonly<{status:'opened';client:ScopeClient}>|Readonly<{status:'rejected';issue:Issue}>;
  sweepExpired():InteractionStats;
  inspect():InteractionStats;
  close():InteractionStats;
  whenClosed():Promise<void>;
}
