/** Core owns these contracts. The Runtime root also exposes the Host-facing types. */
import type { AppSnapshot, JsonValue, ViewToolReceiver, ToolDescriptor } from '../snapshot/types.js';
import type { Observation, ObservedView, ObservationGrant, ObservationSource, ObservationRegistryStats, ObservationJsonLimits, ObservationWindowSelection } from './observation-types.js';
import type { RefPath } from '../tool/ref-path.js';
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
  /** Only multiple ViewTypes require the receiving View's XML ID. */
  readonly viewId?: string;
  /** Business argument slots. Ref addresses are resolved before application code runs. */
  readonly input:JsonObject;
}
export interface ConsoleInputPath {
  readonly appId: string;
  readonly viewId: string;
  readonly refId: string;
  readonly path: RefPath;
}
export type ConsoleInputs = Readonly<{ status: 'ready'; refs: JsonObject; paths: readonly ConsoleInputPath[] }> |
  Readonly<{ status: 'rejected'; issue: Issue }>;
export interface ObservationCandidate {
  readonly observation: Observation;
  /** Discard a prepared candidate. Once adopted, its turn owns the source. */
  discard(): readonly Issue[];
}
export type PrepareObservationResult = Readonly<{ status: 'prepared'; candidate: ObservationCandidate }> |
  Readonly<{ status: 'rejected'; issue: Issue }>;
export interface TurnSelection {
  readonly apps: readonly Readonly<{ candidate: ObservationCandidate; windows?: ObservationWindowSelection }>[];
}
export type InspectRefMode = 'schema' | 'value';
export type InspectRefResult = Readonly<{ status: 'ready'; schema: JsonValue }> |
  Readonly<{ status: 'ready'; value: JsonValue }> |
  Readonly<{ status: 'rejected'; issue: Issue }>;
export interface ActiveTurn {
  readonly isCurrent: boolean;
  invoke(appId: string, request: AppInvocation, timeoutMs?: number, signal?: CancellationSignal): Promise<InvokeResult>;
  readConsoleInputs(imports?: readonly string[]): Promise<ConsoleInputs>;
  inspectRef(address: string, mode: InspectRefMode): Promise<InspectRefResult>;
  release(): readonly Issue[];
}
export type AdoptTurnResult = Readonly<{ status: 'adopted'; turn: ActiveTurn; cleanupIssues: readonly Issue[] }> |
  Readonly<{ status: 'rejected'; issue: Issue }>;
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
export type InvokeResult = ReceiptAccess | Readonly<{kind:'refused'} & Issue>;
export type ObserveResult = Readonly<{status:'observed'; observation:Observation}> | Readonly<{status:'rejected'; issue:Issue}>;
export type AppPreviewResult = Readonly<{status:'previewed'; source:ObservationSource; views:readonly ObservedView[]}> |
  Readonly<{status:'rejected'; issue:Issue}>;
export interface InvocationContext {
  readonly invocationId:string;
  readonly observationId:string;
  readonly source:InvocationSource;
  readonly rawInput:JsonObject;
  readonly effectiveInput:JsonObject;
  readonly refSources:readonly SnapshotValueRefSource[];
  readonly signal:CancellationSignal;
}
export interface ExecutionBinding {
  readonly identity:object;
  isLive(source:InvocationSource):boolean;
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
  observe():Promise<ObserveResult>;
  preview():Promise<AppPreviewResult>;
  /** Adopt the prepared observation and release the previous observation. */
  adoptObservation(observationId:string, windows?: import('./observation-types.js').ObservationWindowSelection):Readonly<{status:'adopted'}>|Readonly<{status:'rejected';issue:Issue}>;
  /** A deadline bounds this wait and the initial invocation's admission. Dispatched work continues to settlement. */
  invoke(request:AppInvocation, timeoutMs?:number, turn?:ActiveTurn, signal?:CancellationSignal):Promise<InvokeResult>;
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
export type InvocationJsonLimits = Omit<ObservationJsonLimits, 'maxApproxBytes'>;
export interface InteractionLimits {
  readonly maxReceiptsPerObservation:number;
  readonly maxReceipts:number;
  readonly maxReads:number;
  readonly receiptTtlMs:number;
  readonly request:InvocationJsonLimits;
  readonly rawInput:InvocationJsonLimits;
  readonly metadata:InvocationJsonLimits;
  readonly fact:InvocationJsonLimits;
  readonly receipt:InvocationJsonLimits;
}
export type InteractionLimitOverrides = {
  readonly [K in keyof InteractionLimits]?: InteractionLimits[K] extends InvocationJsonLimits ? Partial<InteractionLimits[K]> : number;
};
export interface InteractionStats {
  readonly closed:boolean;
  readonly activeInvocations:number;
  readonly activeReads:number;
  readonly receiptEntries:number;
  readonly receiptContents:number;
  readonly borrowedSnapshots:number;
  readonly observations:ObservationRegistryStats;
  readonly closingInvocation?: Readonly<Pick<InvocationReceipt, 'observationId' | 'invocationId' | 'executionPhase'> & {
      status: InvocationOutcome['status'];
  }>;
  readonly issue?:Issue;
}
export interface InstanceInteraction extends AppInteraction {
  /** Pure Core accepts input from transport and validates it before use. */
  invoke(request:unknown, timeoutMs?:number, turn?:ActiveTurn, signal?:CancellationSignal):Promise<InvokeResult>;
  inspect():InteractionStats;
  close():InteractionStats;
  whenClosed():Promise<void>;
}
