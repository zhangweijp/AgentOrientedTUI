import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }

export interface Target {
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
  readonly data: JsonObject;
}

export type ActionResult =
  | { readonly status: 'succeeded'; readonly value: JsonValue }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string }
  | { readonly status: 'failed'; readonly code: string; readonly message: string; readonly effects: 'none' | 'partial' }
  | { readonly status: 'accepted'; readonly operationId: string }
  | { readonly status: 'unknown'; readonly code: string; readonly message: string };

export interface ActionContext {
  readonly target: Target;
  readonly viewId: string;
  readonly invocationId: string;
  readonly signal: AbortSignal;
}

export type InputContract<I> = StandardSchemaV1<unknown, I> & StandardJSONSchemaV1<unknown, I>;

export interface ActionSpec<I> {
  readonly name: string;
  readonly description: string;
  readonly input: InputContract<I>;
  readonly execute: (context: ActionContext, input: I) => ActionResult | Promise<ActionResult>;
}

/** Prepared once; the validator and executor are never serialized to a model. */
export interface Action {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly validate: (input: unknown) => Promise<
    { readonly valid: true; readonly value: unknown } |
    { readonly valid: false; readonly message: string }
  >;
  readonly execute: (context: ActionContext, validated: unknown) => Promise<ActionResult>;
}

export interface ViewItem {
  readonly label: string;
  readonly target: Target;
  readonly actions: readonly Action[];
}

export interface ViewSpec {
  readonly id: string;
  /** Synchronous projection from an already-read, coherent local resource cut. */
  readonly project: () => readonly ViewItem[];
  readonly subscribe?: (invalidate: () => void) => () => void;
}

export interface PublishedAction {
  readonly bindingId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface PublishedItem {
  readonly label: string;
  readonly refId: string;
  readonly target: Target;
  readonly actions: readonly PublishedAction[];
}

export interface Observation {
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly views: readonly { readonly id: string; readonly items: readonly PublishedItem[] }[];
}

export interface Invocation {
  readonly observationId: string;
  readonly actionBindingId: string;
  readonly invocationId: string;
  readonly input: JsonValue;
}

export interface TraceEvent {
  readonly sequence: number;
  readonly type: string;
  readonly data: JsonObject;
}

export interface SessionOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxObservations?: number;
  readonly maxInvocations?: number;
  readonly maxTraceEvents?: number;
}

export interface Session {
  readonly id: string;
  openView(spec: ViewSpec): () => Promise<void>;
  observe(): Observation;
  execute(invocation: Invocation, options?: { readonly signal?: AbortSignal }): Promise<ActionResult>;
  /** Revoke views and close runtime scopes; arbitrary external Promises may outlive cancellation. */
  close(): Promise<void>;
  /** activeCalls counts owned runtime scopes, not all external work still running. */
  inspect(): { readonly activeCalls: number; readonly views: number; readonly observations: number; readonly invocations: number; readonly events: readonly TraceEvent[] };
}
