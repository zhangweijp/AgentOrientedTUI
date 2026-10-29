import { Effect, Exit, Scope } from 'effect';
import type {
  Action, ActionContext, ActionResult, ActionSpec, Invocation, JsonObject, JsonValue,
  Observation, Session, SessionOptions, Target, TraceEvent, ViewSpec,
} from './contracts.js';

/** Copy data, never accessors or class instances; freezing a caller's object is insufficient. */
function copyJson(value: unknown, path = '$', ancestors = new Set<object>(), schemaMetadata = false): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value !== 'object' || value === null) throw new TypeError(`${path}: expected finite JSON data.`);
  if (ancestors.has(value)) throw new TypeError(`${path}: cyclic JSON data.`);
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${path}: expected a plain JSON object.`);
  }
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    // Schema libraries may attach non-enumerable metadata. Only schema exports
    // opt into ignoring it; business inputs and observations remain strict JSON.
    const keys = Reflect.ownKeys(descriptors).filter(key =>
      !schemaMetadata || Object.getOwnPropertyDescriptor(value, key)!.enumerable || (array && key === 'length'));
    if (keys.some(key => typeof key !== 'string')) throw new TypeError(`${path}: symbol keys are not JSON.`);
    if (array) {
      const length = (value as unknown[]).length;
      if (keys.length !== length + 1) throw new TypeError(`${path}: sparse arrays and extra array properties are not JSON.`);
      const result: JsonValue[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError(`${path}[${index}]: expected a JSON array element.`);
        }
        result.push(copyJson(descriptor.value, `${path}[${index}]`, ancestors, schemaMetadata));
      }
      return Object.freeze(result);
    }
    const result: Record<string, JsonValue> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError(`${path}.${key}: accessors and hidden properties are not JSON.`);
      Object.defineProperty(result, key, {
        enumerable: true, value: copyJson(descriptor.value, `${path}.${key}`, ancestors, schemaMetadata),
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function jsonObject(value: unknown, path: string): JsonObject {
  const result = copyJson(value, path);
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new TypeError(`${path}: expected a JSON object.`);
  return result as JsonObject;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key]!)}`).join(',')}}`;
}

const rejected = (code: string, message: string): ActionResult => Object.freeze({ status: 'rejected', code, message });
const unknown = (code: string, message: string): ActionResult => Object.freeze({ status: 'unknown', code, message });
const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'An operation threw an unspecified error.';

function copyResult(value: unknown): ActionResult {
  const result = jsonObject(value, 'action result');
  const errorFields = typeof result.code === 'string' && typeof result.message === 'string';
  const valid =
    (result.status === 'succeeded' && Object.hasOwn(result, 'value')) ||
    ((result.status === 'rejected' || result.status === 'unknown') && errorFields) ||
    (result.status === 'failed' && errorFields && (result.effects === 'none' || result.effects === 'partial')) ||
    (result.status === 'accepted' && typeof result.operationId === 'string');
  if (!valid) throw new TypeError('Executor returned an invalid ActionResult.');
  return result as unknown as ActionResult;
}

export function defineAction<I>(spec: ActionSpec<I>): Action {
  const { name, description, execute, input } = spec;
  if (!name.trim()) throw new TypeError('An action needs a non-empty name.');
  const standard = input['~standard'];
  let inputSchema: JsonObject;
  try {
    const path = `action ${name}.inputSchema`;
    const exported = copyJson(standard.jsonSchema.input({ target: 'draft-2020-12' }), path, new Set(), true);
    inputSchema = jsonObject(exported, path);
  } catch (error) {
    throw new TypeError(`Action ${name} cannot publish its input JSON Schema: ${messageOf(error)}`);
  }
  const validate = standard.validate.bind(standard);
  return Object.freeze({
    name, description, inputSchema,
    async validate(raw: unknown) {
      const result = await validate(raw);
      if (result.issues) return { valid: false as const, message: result.issues.map(issue => issue.message).join('; ') };
      return { valid: true as const, value: result.value };
    },
    async execute(context: ActionContext, validated: unknown) { return execute(context, validated as I); },
  });
}

interface ViewOwner {
  readonly spec: ViewSpec;
  readonly scope: Scope.Closeable;
  readonly token: symbol;
  readonly calls: Set<Call>;
  active: boolean;
  closing?: Promise<void>;
}
interface Binding { readonly owner: ViewOwner; readonly refId: string; readonly action: Action }
interface Published {
  readonly observation: Observation;
  readonly refs: Map<string, Target>;
  readonly bindings: Map<string, Binding>;
}
interface Receipt { readonly fingerprint: string; readonly promise: Promise<ActionResult> }
interface Call {
  readonly controller: AbortController;
  readonly promise: Promise<ActionResult>;
  readonly invocationId: string;
  owner?: ViewOwner;
  enteredExecutor: boolean;
  knownResult?: ActionResult;
}

export function createSession(options: SessionOptions = {}): Session {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30_000;
  const maxObservations = options.maxObservations ?? 64;
  const maxInvocations = options.maxInvocations ?? 1_024;
  const maxTraceEvents = options.maxTraceEvents ?? 512;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError('ttlMs must be finite and non-negative.');
  for (const [name, value, minimum] of [
    ['maxObservations', maxObservations, 1], ['maxInvocations', maxInvocations, 1], ['maxTraceEvents', maxTraceEvents, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}.`);
  }

  const id = `session_${globalThis.crypto.randomUUID()}`;
  const views = new Map<string, ViewOwner>();
  const observations = new Map<string, Published>();
  const receipts = new Map<string, Receipt>();
  const liveCalls = new Set<Call>();
  const closingViews = new Set<Promise<void>>();
  const events: TraceEvent[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  let activeCalls = 0;
  let observationSequence = 0;
  let traceSequence = 0;

  function trace(type: string, data: JsonObject): void {
    const event = Object.freeze({ sequence: ++traceSequence, type, data: jsonObject(data, 'trace') });
    if (maxTraceEvents === 0) return;
    events.push(event);
    if (events.length > maxTraceEvents) events.splice(0, events.length - maxTraceEvents);
  }

  function closeView(owner: ViewOwner): Promise<void> {
    if (owner.closing) return owner.closing;
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    owner.closing = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const completion = owner.closing;
    closingViews.add(completion);
    // Observe failures now and retain them for session.close's aggregate report.
    void completion.then(() => { closingViews.delete(completion); }, () => undefined);
    owner.active = false;
    if (views.get(owner.spec.id)?.token === owner.token) views.delete(owner.spec.id);
    const ownedCalls = [...owner.calls];
    const calls = ownedCalls.map(call => call.promise);
    for (const call of ownedCalls) call.controller.abort();
    trace('view.revoked', { viewId: owner.spec.id });
    void (async () => {
      const exit = await Effect.runPromiseExit(Scope.close(owner.scope, Exit.succeed(undefined)));
      await Promise.all(calls);
      if (!Exit.isSuccess(exit)) {
        trace('view.cleanup_failed', { viewId: owner.spec.id });
        throw new Error(`View ${owner.spec.id} subscription cleanup failed.`);
      }
      trace('view.closed', { viewId: owner.spec.id });
    })().then(finish, fail);
    return owner.closing;
  }

  function check(request: Invocation, signal: AbortSignal): ActionResult | { published: Published; binding: Binding; target: Target } {
    if (closed) return rejected('SESSION_CLOSED', 'This session is closed.');
    if (signal.aborted) return rejected('ABORTED', 'Cancelled before the executor started.');
    const published = observations.get(request.observationId);
    if (!published) return rejected('OBSERVATION_NOT_FOUND', 'Observation is unavailable; observe again.');
    if (now() >= published.observation.expiresAt) return rejected('OBSERVATION_EXPIRED', 'Observation expired; observe again.');
    const binding = published.bindings.get(request.actionBindingId);
    if (!binding) return rejected('BINDING_NOT_FOUND', 'This action was not available in that observation.');
    if (!binding.owner.active || views.get(binding.owner.spec.id)?.token !== binding.owner.token) {
      return rejected('BINDING_REVOKED', 'The owning view instance has closed; observe again.');
    }
    return { published, binding, target: published.refs.get(binding.refId)! };
  }

  async function perform(request: Invocation, call: Call, signal: AbortSignal): Promise<ActionResult> {
    const initial = check(request, signal);
    if ('status' in initial) return initial;
    call.owner = initial.binding.owner;
    call.owner.calls.add(call);
    let validation: Awaited<ReturnType<Action['validate']>>;
    try { validation = await initial.binding.action.validate(request.input); }
    catch (error) { return rejected('INVALID_INPUT', `Input validation failed: ${messageOf(error)}`); }
    // A validator can yield while TTL, owner, cancellation, or retained observations change.
    const current = check(request, signal);
    if ('status' in current) return current;
    if (!validation.valid) return rejected('INVALID_INPUT', validation.message);
    const context = Object.freeze({
      target: current.target, viewId: current.binding.owner.spec.id,
      invocationId: request.invocationId, signal,
    });
    call.enteredExecutor = true;
    trace('invocation.executor_started', { invocationId: request.invocationId, viewId: context.viewId });
    const value = await current.binding.action.execute(context, validation.value);
    if (signal.aborted) return unknown('ABORTED', 'Execution was interrupted; its external effects are not confirmed.');
    call.knownResult = copyResult(value);
    return call.knownResult;
  }

  async function run(request: Invocation, call: Call, signal: AbortSignal): Promise<ActionResult> {
    const work = Effect.scoped(Effect.flatMap(
      Effect.acquireRelease(
        Effect.sync(() => {
          activeCalls++;
          trace('invocation.acquired', { invocationId: request.invocationId });
        }),
        () => Effect.sync(() => {
          activeCalls--;
          call.owner?.calls.delete(call);
          liveCalls.delete(call);
          trace('invocation.released', { invocationId: request.invocationId });
        }),
      ),
      () => Effect.tryPromise({ try: innerSignal => perform(request, call, innerSignal), catch: error => error }),
    ));
    const exit = await Effect.runPromiseExit(work, { signal });
    // A pre-aborted call may never enter acquireRelease, but its receipt still settles.
    liveCalls.delete(call);
    const stoppedBeforeExecution = closed ? rejected('SESSION_CLOSED', 'This session is closed.')
      : call.owner && !call.owner.active ? rejected('BINDING_REVOKED', 'The owning view instance closed during validation.')
      : rejected(Exit.hasInterrupts(exit) ? 'ABORTED' : 'EXECUTION_REJECTED', 'Execution stopped before entering the executor.');
    // Preserve a confirmed business result even if a later runtime cleanup fails.
    const result = call.knownResult ?? (Exit.isSuccess(exit) ? exit.value : call.enteredExecutor
      ? unknown(Exit.hasInterrupts(exit) ? 'ABORTED' : 'EXECUTION_UNKNOWN', 'Executor did not provide a confirmed result; inspect its effects before retrying.')
      : stoppedBeforeExecution);
    trace('invocation.completed', { invocationId: request.invocationId, status: result.status });
    return result;
  }

  return {
    id,
    openView(spec) {
      if (closed) throw new Error('SESSION_CLOSED: cannot open a view.');
      if (!spec.id.trim() || views.has(spec.id)) throw new Error(`View id ${spec.id} must be non-empty and unique among open instances.`);
      const owner: ViewOwner = {
        spec: { ...spec }, scope: Effect.runSync(Scope.make()), token: Symbol(spec.id), calls: new Set(), active: true,
      };
      views.set(spec.id, owner);
      try {
        const dispose = spec.subscribe?.(() => {
          if (owner.active && !closed) trace('view.invalidated', { viewId: spec.id });
        });
        if (dispose) Effect.runSync(Scope.addFinalizer(owner.scope, Effect.sync(dispose)));
      } catch (error) {
        void closeView(owner).catch(() => undefined);
        throw error;
      }
      trace('view.opened', { viewId: spec.id });
      return () => closeView(owner);
    },
    observe() {
      if (closed) throw new Error('SESSION_CLOSED: cannot observe a closed session.');
      const observationId = `${id}/observation/${++observationSequence}`;
      const createdAt = now();
      if (!Number.isFinite(createdAt) || !Number.isFinite(createdAt + ttlMs)) throw new Error('The observation clock must return a finite timestamp.');
      const bindings = new Map<string, Binding>();
      let itemSequence = 0;
      let bindingSequence = 0;
      const projected = [...views.values()].map(owner => {
        const items = owner.spec.project().map(item => {
          if (typeof item.label !== 'string') throw new TypeError('A view item label must be a string.');
          if (!item.target || typeof item.target.kind !== 'string' || typeof item.target.id !== 'string' || typeof item.target.revision !== 'string') {
            throw new TypeError('A view target needs kind, id, and revision strings.');
          }
          const refId = `${observationId}/ref/${++itemSequence}`;
          const actions = item.actions.map(action => {
            const bindingId = `${observationId}/binding/${++bindingSequence}`;
            const prepared: Action = Object.freeze({
              name: action.name, description: action.description, inputSchema: action.inputSchema,
              validate: action.validate.bind(action), execute: action.execute.bind(action),
            });
            bindings.set(bindingId, { owner, refId, action: prepared });
            return { bindingId, name: prepared.name, description: prepared.description, inputSchema: prepared.inputSchema };
          });
          return { label: item.label, refId, target: item.target, actions };
        });
        if (closed || !owner.active || views.get(owner.spec.id)?.token !== owner.token) throw new Error('View instance changed during projection; observe again.');
        return { id: owner.spec.id, items };
      });
      const observation = copyJson({ id: observationId, sessionId: id, createdAt, expiresAt: createdAt + ttlMs, views: projected }) as unknown as Observation;
      const refs = new Map<string, Target>();
      for (const view of observation.views) for (const item of view.items) refs.set(item.refId, item.target);
      observations.set(observationId, { observation, refs, bindings });
      while (observations.size > maxObservations) observations.delete(observations.keys().next().value!);
      trace('observation.published', { observationId, views: observation.views.length, bindings: bindings.size });
      return observation;
    },
    execute(invocation, executionOptions = {}) {
      let request: Invocation;
      let fingerprint: string;
      try {
        for (const key of ['invocationId', 'observationId', 'actionBindingId'] as const) {
          if (typeof invocation[key] !== 'string' || !invocation[key].trim()) throw new TypeError(`${key} must be a non-empty string.`);
        }
        const input = copyJson(invocation.input, 'input');
        request = Object.freeze({ observationId: invocation.observationId, actionBindingId: invocation.actionBindingId, invocationId: invocation.invocationId, input });
        fingerprint = canonical({ observationId: request.observationId, actionBindingId: request.actionBindingId, input });
      } catch (error) { return Promise.resolve(rejected('INVALID_INPUT', messageOf(error))); }
      const previous = receipts.get(request.invocationId);
      if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.resolve(rejected('ID_CONFLICT', 'This invocationId was already used for a different request.'));
      if (closed) return Promise.resolve(rejected('SESSION_CLOSED', 'This session is closed.'));
      // Receipts are never evicted: dropping one could turn a retry into another write.
      if (receipts.size >= maxInvocations) return Promise.resolve(rejected('INVOCATION_CAPACITY', 'Invocation receipt capacity reached; open a new session.'));
      let resolve!: (result: ActionResult) => void;
      const promise = new Promise<ActionResult>(done => { resolve = done; });
      const call: Call = { controller: new AbortController(), promise, invocationId: request.invocationId, enteredExecutor: false };
      const signal = executionOptions.signal ? AbortSignal.any([call.controller.signal, executionOptions.signal]) : call.controller.signal;
      receipts.set(request.invocationId, { fingerprint, promise });
      liveCalls.add(call);
      // Reserve before invoking user code, including synchronously completing validators.
      void Promise.resolve().then(() => run(request, call, signal)).then(resolve, () => {
        liveCalls.delete(call);
        resolve(call.knownResult ?? (call.enteredExecutor ? unknown('EXECUTION_UNKNOWN', 'The runtime could not confirm the execution result.') : rejected('EXECUTION_REJECTED', 'The runtime stopped before execution.')));
      });
      return promise;
    },
    close() {
      if (closing) return closing;
      let finish!: () => void;
      let fail!: (error: unknown) => void;
      closing = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      closed = true;
      const ownedCalls = [...liveCalls];
      const pending = ownedCalls.map(call => call.promise);
      for (const call of ownedCalls) call.controller.abort();
      for (const owner of [...views.values()]) closeView(owner);
      const viewClosures = [...closingViews];
      observations.clear();
      void (async () => {
        const results = await Promise.allSettled([...viewClosures, ...pending]);
        closingViews.clear();
        trace('session.closed', { sessionId: id });
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Session closed with resource cleanup failures.');
      })().then(finish, fail);
      return closing;
    },
    inspect() {
      return Object.freeze({ activeCalls, views: views.size, observations: observations.size, invocations: receipts.size, events: Object.freeze([...events]) });
    },
  };
}
