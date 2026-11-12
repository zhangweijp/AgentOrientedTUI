import { VIEW_TYPE_PARAMETERS_MODE } from '../tool/ordinary-parameter-contract.js';
import { ORDINARY_INVOCATION_MODE } from '../tool/invocation-terminal.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/types.js';
import { canonicalJson, utf8Size } from '../snapshot/json.js';
import { RESOLVED_TOOL_ENVELOPE_LIMITS } from '../snapshot/snapshot-support.js';
import type { AppIdentityReader, AppSnapshotV3, JsonValue, SnapshotStore } from '../snapshot/types.js';
import { validateVersionedToolRefDeclarations } from '../tool/versioned-ref-declarations.js';
import { checkRefViews, prepareViewTypeParameters } from '../tool/snapshot-value-arguments.js';
import { createObservationOperations, previewCommittedApp, type ObservationState } from './observation-registry.js';
import type { ObservationJsonLimits } from './observation-types.js';
import { captureBoundedJson, exactFields, jsonObject, mapExecutionFact, unknownOutcome, type ExecutionMapping } from './invocation-outcome.js';
import type {
    AppInteractionSource, AppInvocation, ExecutionBinding, InstanceInteraction, InteractionLimits, InteractionLimitOverrides, InteractionStats,
    InvocationContext, InvocationReceipt, InvocationSource, Issue, ObserveResult,
    ReceiptAccess, ReceiptMetadata, AppInteractionPolicy,
} from './app-interaction-types.js';

const KiB = 1024, MiB = KiB * KiB, WORK = MiB;
const profile = (maxDepth: number, maxNodes: number, bytes: number): ObservationJsonLimits => Object.freeze({
    maxDepth, maxNodes, maxApproxBytes: bytes, maxCanonicalBytes: bytes,
});
export const DEFAULT_INTERACTION_LIMITS: InteractionLimits = Object.freeze({
    maxReceiptsPerObservation: 256, maxReceipts: 1024, maxReads: 8, receiptTtlMs: 60_000,
    request: profile(33, 10005, 136 * KiB), ordinaryInput: profile(32, 5000, 128 * KiB),
    metadata: profile(8, 256, 32 * KiB), fact: profile(52, 32032, 520 * KiB), receipt: profile(54, 33000, 560 * KiB),
    maxSourceBytes: 32 * MiB, maxFingerprintBytes: 8 * MiB, maxMetadataBytes: 8 * MiB,
    maxWorkBytes: 16 * MiB, maxResultBytes: 16 * MiB, maxTotalBytes: 64 * MiB,
});
const MESSAGE = 'The App interaction could not be completed';
class InteractionFailure {
    constructor(readonly code: string, readonly message: string = MESSAGE, readonly path?: string) {}
}
function fail(code: string, message?: string, path?: string): never { throw new InteractionFailure(code, message, path); }
const problem = (error: unknown): Issue => error instanceof InteractionFailure
    ? Object.freeze({ code: error.code, message: error.message, ...(error.path === undefined ? {} : { path: error.path }) })
    : Object.freeze({ code: 'OBSERVATION_INTERNAL_ERROR', message: MESSAGE });
const unavailable = (code: string): ReceiptAccess => Object.freeze({ kind: 'unavailable', code, message: MESSAGE });
function dataProperties(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw 0;
    const descriptors = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(descriptors);
    if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key => typeof key !== 'string' ||
        ![...required, ...optional].includes(key) || !descriptors[key]!.enumerable || !('value' in descriptors[key]!))) throw 0;
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function capture<T>(raw: unknown, limits: ObservationJsonLimits, code: string): { value: T; bytes: number } {
    try { return captureBoundedJson<T>(raw, limits); } catch { return fail(code); }
}
type Binding = ExecutionBinding;
function binding(raw: unknown): Binding {
    if (raw === null) fail('TOOL_EXECUTION_UNAVAILABLE');
    try {
        const data = dataProperties(raw, ['identity', 'mode', 'validateInput', 'isLive', 'execute']);
        if (!data.identity || !['object', 'function'].includes(typeof data.identity) ||
            (data.mode !== ORDINARY_INVOCATION_MODE && data.mode !== VIEW_TYPE_PARAMETERS_MODE) ||
            ['validateInput', 'isLive', 'execute'].some(key => typeof data[key] !== 'function')) throw 0;
        return Object.freeze(data) as unknown as Binding;
    } catch { return fail('EXECUTION_BINDING_FAILED'); }
}
function sameBinding(a: Binding, b: Binding): boolean {
    return a.identity === b.identity && a.mode === b.mode && a.validateInput === b.validateInput &&
        a.isLive === b.isLive && a.execute === b.execute;
}
interface Entry {
    readonly fingerprint: string;
    readonly fingerprintBytes: number;
    expiresAt?: number;
    metadata: ReceiptMetadata;
    metadataBytes: number;
    phase: InvocationReceipt['executionPhase'];
    readonly waiters: Set<() => void>;
    readonly deadline?: number;
    admissionExpired?: true;
    running: boolean;
    expired: boolean;
    unavailable: boolean;
    receipt?: InvocationReceipt;
    resultBytes: number;
}
interface State extends ObservationState {
    policy?: AppInteractionPolicy;
    resolve?: (source: InvocationSource) => ExecutionBinding | null;
    readonly entries: Map<string, Entry>;
    readonly controllers: Set<AbortController>;
    closing: boolean;
    invocations: number;
    reads: number;
    projects: number;
}
type Fees = { source: number; fingerprint: number; metadata: number; work: number; result: number };

export function createAppInteraction(store: SnapshotStore & AppIdentityReader, options: Readonly<AppInteractionSource & {
    namespace: string; now: () => number;
    observationLimits?: import('./observation-types.js').ObservationRegistryLimitOverrides;
    limits?: InteractionLimitOverrides;
}>): InstanceInteraction {
    let config: Record<string, unknown>, limits: InteractionLimits, policy: AppInteractionPolicy, resolver: State['resolve'];
    try {
        config = dataProperties(options, ['namespace', 'now', 'appId', 'instanceId', 'policy', 'execution'], ['observationLimits', 'limits']);
        if (!nonEmpty(config.namespace) || utf8Size(config.namespace) > 128 || typeof config.now !== 'function' ||
            !nonEmpty(config.appId) || !nonEmpty(config.instanceId)) throw 0;
        const p = dataProperties(config.policy, ['project', 'authorize', 'canReadReceipt']);
        const e = dataProperties(config.execution, ['resolve']);
        if (Object.values(p).some(value => typeof value !== 'function') || typeof e.resolve !== 'function') throw 0;
        policy = Object.freeze(p) as unknown as AppInteractionPolicy;
        resolver = e.resolve as State['resolve'];
        const overrides = config.limits === undefined ? {} : dataProperties(config.limits, [], Object.keys(DEFAULT_INTERACTION_LIMITS));
        const effective: Record<string, number | ObservationJsonLimits> = {};
        for (const [key, hard] of Object.entries(DEFAULT_INTERACTION_LIMITS)) {
            if (typeof hard === 'number') {
                const value = overrides[key] === undefined ? hard : overrides[key];
                if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > hard) throw 0;
                effective[key] = value as number;
            } else {
                const lower = overrides[key] === undefined ? {} : dataProperties(overrides[key], [], Object.keys(hard));
                const p = { ...hard };
                for (const field of Object.keys(hard) as (keyof ObservationJsonLimits)[]) {
                    const value = lower[field] === undefined ? hard[field] : lower[field];
                    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > hard[field]) throw 0;
                    Object.assign(p, { [field]: value });
                }
                effective[key] = Object.freeze(p);
            }
        }
        limits = Object.freeze(effective) as unknown as InteractionLimits;
    } catch { throw new TypeError('Invalid App interaction configuration'); }
    const now = config.now as () => number;
    let lastNow = -1;
    function clock(): number {
        let value: number;
        try { value = now(); } catch { return fail('OBSERVATION_INTERNAL_ERROR'); }
        if (!Number.isSafeInteger(value) || value < 0 || value < lastNow) fail('OBSERVATION_INTERNAL_ERROR');
        lastNow = value; return value;
    }
    const state: State = { appId: config.appId as string, instanceId: config.instanceId as string,
        policy, resolve: resolver, observations: new Map(), reservations: new Map(),
        entries: new Map(), controllers: new Set(), closing: false, invocations: 0, reads: 0, projects: 0 };
    const sources = new Map<string, { readonly source: AppSnapshotV3; readonly bytes: number; count: number }>();
    const fees: Fees = { source: 0, fingerprint: 0, metadata: 0, work: 0, result: 0 };
    let closed = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let scheduledExpiry: number | undefined;
    const observations = createObservationOperations(store, { namespace: config.namespace as string,
        limits: config.observationLimits as import('./observation-types.js').ObservationRegistryLimitOverrides | undefined },
        state, refresh);
    const sourceProfile = observations.limits.source;
    try { clock(); } catch { throw new RangeError('Invalid observation registry clock'); }
    let completeClosed: (() => void) | undefined;
    const closedCompletion = new Promise<void>(resolve => { completeClosed = resolve; });
    function settleClosed(): void {
        if (closed && state.closing && !state.invocations && !state.reads && !state.projects) {
            completeClosed?.(); completeClosed = undefined;
        }
    }
    const total = () => fees.source + fees.fingerprint + fees.metadata + fees.work + fees.result;
    function charge(delta: Partial<Fees>, code = 'INVOCATION_CAPACITY'): void {
        const next = { ...fees };
        for (const key of Object.keys(delta) as (keyof Fees)[]) next[key] += delta[key]!;
        if (next.source > limits.maxSourceBytes || next.fingerprint > limits.maxFingerprintBytes || next.metadata > limits.maxMetadataBytes ||
            next.work > limits.maxWorkBytes || next.result > limits.maxResultBytes ||
            Object.values(next).reduce((a, b) => a + b, 0) > limits.maxTotalBytes) fail(code);
        Object.assign(fees, next);
    }
    function dropContent(entry: Entry, expired = false): void {
        fees.result -= entry.resultBytes; entry.resultBytes = 0; entry.receipt = undefined;
        if (expired) entry.expired = true;
    }
    function forget(state: State, entry: Entry): void {
        dropContent(entry);
        fees.metadata -= entry.metadataBytes;
        fees.fingerprint -= entry.fingerprintBytes;
        state.entries.delete(entry.metadata.invocationId);
    }
    function clean(state: State): void {
        if (!state.closing || state.invocations || state.reads || state.projects) return;
        for (const entry of state.entries.values()) forget(state, entry);
        state.policy = undefined; state.resolve = undefined;
        settleClosed();
    }
    function revoke(state: State): void {
        if (state.closing) return;
        clearTimeout(expiry);
        expiry = undefined;
        scheduledExpiry = undefined;
        state.closing = true; observations.releaseAll(state);
        for (const entry of state.entries.values()) if (!entry.running) dropContent(entry);
        for (const controller of state.controllers) controller.abort();
        clean(state);
    }
    function expireReceipts(time: number): void {
        if (state.closing) return;
        let next: number | undefined;
        for (const entry of state.entries.values()) {
            if (entry.running || entry.expiresAt === undefined) continue;
            if (time >= entry.expiresAt) {
                if (entry.metadata.observationId === state.adoptedObservationId) dropContent(entry, true);
                else forget(state, entry);
            } else next = Math.min(next ?? Infinity, entry.expiresAt);
        }
        if (next === scheduledExpiry) return;
        clearTimeout(expiry);
        scheduledExpiry = next;
        expiry = next === undefined ? undefined : setTimeout(() => {
            scheduledExpiry = undefined;
            expiry = undefined;
            try { expireReceipts(clock()); } catch { /* The next valid operation can prune expired receipts. */ }
        }, Math.max(0, next - time));
        if (expiry && typeof expiry === 'object') expiry.unref();
    }
    function refresh(): number {
        if (!state.closing && !observations.isCurrent(state)) revoke(state);
        if (state.closing) return lastNow;
        const time = clock();
        expireReceipts(time);
        return time;
    }
    function active(state: State): void {
        refresh(); if (state.closing || closed) fail('APP_INTERACTION_UNAVAILABLE');
    }
    function setMetadata(entry: Entry, patch: Partial<ReceiptMetadata>): void {
        const measured = capture<ReceiptMetadata>({ ...entry.metadata, ...patch }, limits.metadata, 'INVOCATION_CAPACITY');
        entry.metadata = measured.value; // Actual metadata bytes replace the reservation only at settlement.
    }
    function hold(source: AppSnapshotV3, release: () => void): () => void {
        const existing = sources.get(source.id);
        const bytes = existing?.bytes ?? capture<unknown>(source, sourceProfile, 'INVOCATION_CAPACITY').bytes;
        charge({ source: existing ? 0 : bytes });
        if (existing) existing.count++;
        else sources.set(source.id, { source, bytes, count: 1 });
        let released = false;
        return () => {
            if (released) return; released = true;
            try { release(); } finally {
                const item = sources.get(source.id)!;
                if (--item.count === 0) { sources.delete(source.id); fees.source -= item.bytes; }
            }
        };
    }
    function resolve(state: State, source: InvocationSource): Binding {
        let value: unknown;
        try { value = state.resolve!(source); } catch { return fail('EXECUTION_BINDING_FAILED'); }
        return binding(value);
    }
    function live(current: Binding, source: InvocationSource): void {
        let value: JsonValue;
        try { value = captureBoundedJson<JsonValue>(current.isLive(source), limits.metadata).value; }
        catch { return fail('LIVE_BINDING_CHECK_FAILED'); }
        if (!jsonObject(value) || !exactFields(value, ['ok']) || typeof value.ok !== 'boolean') fail('LIVE_BINDING_CHECK_FAILED');
        if (value.ok !== true) fail('TOOL_SOURCE_STALE');
    }
    function sourceFor(state: State, request: AppInvocation) {
        active(state);
        const result = observations.resolveBinding(state, { observationId: request.observationId, bindingId: request.bindingId });
        if (result.status === 'rejected') fail(result.issue.code);
        return result;
    }
    const deadlineIssue = { code: 'INVOCATION_DEADLINE_EXCEEDED', message: 'Invocation deadline elapsed before dispatch' };
    function expireAdmission(entry: Entry, controller: AbortController): void {
        if (!entry.running || entry.phase !== 'not-dispatched' || entry.admissionExpired) return;
        entry.admissionExpired = true;
        controller.abort();
    }
    function checkAdmission(entry: Entry, controller: AbortController): void {
        if (entry.deadline !== undefined && clock() >= entry.deadline) expireAdmission(entry, controller);
        if (entry.admissionExpired) fail(deadlineIssue.code, deadlineIssue.message);
    }
    function makeReceipt(entry: Entry, mapping: ExecutionMapping, completedAt: number) {
        const expiresAt = completedAt + limits.receiptTtlMs;
        if (!Number.isSafeInteger(expiresAt)) fail('RESULT_UNAVAILABLE');
        const { invocationId, observationId, bindingId, source } = entry.metadata;
        return capture<InvocationReceipt>({ invocationId, observationId, bindingId, source, completedAt, expiresAt,
            executionPhase: mapping.executionPhase, outcome: mapping.outcome }, limits.receipt, 'RESULT_UNAVAILABLE');
    }
    async function run(state: State, entry: Entry, request: AppInvocation, controller: AbortController): Promise<void> {
        let release: (() => void) | undefined;
        let mapping: ExecutionMapping = { executionPhase: 'not-dispatched', outcome: unknownOutcome() };
        try {
            checkAdmission(entry, controller);
            const selected = sourceFor(state, request);
            const acquired = store.acquire(selected.sourceRequest.snapshotId, { lifetime: 'owner' });
            if (acquired.status === 'rejected') fail(acquired.issue.code);
            const snapshot = acquired.lease.snapshot;
            if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) { acquired.lease.release(); fail('SNAPSHOT_INVALID'); }
            try { release = hold(snapshot, acquired.lease.release); } catch (error) { acquired.lease.release(); throw error; }
            setMetadata(entry, { source: { appId: snapshot.appId, instanceId: snapshot.instanceId, snapshotId: snapshot.id, revision: snapshot.revision } });
            const source: InvocationSource = Object.freeze({ appId: state.appId, instanceId: state.instanceId,
                snapshotId: snapshot.id, tool: selected.tool, execution: selected.execution });
            let declared: boolean;
            try { declared = validateVersionedToolRefDeclarations(source.tool.inputSchema); }
            catch { return fail('REF_CONTRACT_UNSUPPORTED'); }
            const initial = resolve(state, source);
            let rawInput = request.input, effectiveInput = request.input;
            let refSources: InvocationContext['refSources'] = Object.freeze([]), firstRefCanonical: string | undefined;
            if (initial.mode === VIEW_TYPE_PARAMETERS_MODE) {
                if (source.execution.kind !== 'view-type') fail('REF_CONTRACT_UNSUPPORTED');
                if (!declared) rawInput = capture<InvocationContext['rawInput']>(request.input, limits.ordinaryInput, 'ACTION_INPUT_INVALID').value;
                const prepared = prepareViewTypeParameters(store, state, { snapshotId: snapshot.id, toolId: source.tool.id,
                    execution: source.execution, args: rawInput }, selected.visibleRefs);
                if (prepared.status === 'rejected') fail(prepared.issue.code, prepared.issue.message, prepared.issue.path);
                try { rawInput = prepared.rawArgs; effectiveInput = prepared.effectiveArgs; refSources = prepared.refSources;
                    firstRefCanonical = canonicalJson({ effectiveInput, refSources } as unknown as JsonValue); }
                finally { prepared.release(); }
            } else {
                if (declared) fail('REF_CONTRACT_UNSUPPORTED');
                rawInput = capture<InvocationContext['rawInput']>(request.input, limits.ordinaryInput, 'ACTION_INPUT_INVALID').value;
                effectiveInput = rawInput;
            }
            function recheck(): void {
                checkAdmission(entry, controller);
                const current = sourceFor(state, request);
                if (initial.mode === VIEW_TYPE_PARAMETERS_MODE) {
                    if (refSources.length) {
                        const latest = store.readLatest(state.appId);
                        const issue = checkRefViews(refSources, rawInput, (id, instanceId) => latest.status === 'ready' &&
                            latest.snapshot.views.some(view => view.id === id && view.viewInstanceId === instanceId));
                        if (issue) fail(issue.code, issue.message, issue.path);
                    }
                    const checked = prepareViewTypeParameters(store, state, { snapshotId: snapshot.id, toolId: source.tool.id,
                        execution: source.execution, args: rawInput }, current.visibleRefs);
                    if (checked.status === 'rejected') fail(checked.issue.code, checked.issue.message, checked.issue.path);
                    try { if (canonicalJson({ effectiveInput: checked.effectiveArgs, refSources: checked.refSources } as unknown as JsonValue) !== firstRefCanonical) fail('REF_ARGUMENT_CHANGED'); }
                    finally { checked.release(); }
                }
                const latest = resolve(state, source);
                if (!sameBinding(initial, latest)) fail('TOOL_SOURCE_STALE');
                live(latest, source);
            }
            recheck();
            let validation: JsonValue;
            try { validation = captureBoundedJson<JsonValue>(await initial.validateInput(source, effectiveInput, controller.signal), RESOLVED_TOOL_ENVELOPE_LIMITS).value; }
            catch { return fail('INPUT_VALIDATOR_FAILED'); }
            recheck();
            if (!jsonObject(validation) || typeof validation.ok !== 'boolean' || !exactFields(validation, validation.ok ? ['ok', 'value'] : ['ok'])) fail('INPUT_VALIDATOR_FAILED');
            if (!validation.ok) fail('ACTION_INPUT_INVALID');
            if (!jsonObject(validation.value)) fail('INPUT_VALIDATOR_FAILED');
            if (initial.mode === VIEW_TYPE_PARAMETERS_MODE) {
                if (canonicalJson(validation.value) !== canonicalJson(effectiveInput)) fail('REF_ARGUMENT_CHANGED');
            } else effectiveInput = capture<InvocationContext['effectiveInput']>(validation.value, limits.ordinaryInput, 'ACTION_INPUT_INVALID').value;
            const context: InvocationContext = Object.freeze({ invocationId: request.invocationId,
                source, rawInput, effectiveInput, refSources, signal: controller.signal });
            let authorized: unknown;
            try { authorized = await state.policy!.authorize(context); } catch { return fail('TOOL_AUTHORIZATION_FAILED'); }
            recheck();
            if (authorized !== true) fail('TOOL_PERMISSION_DENIED');
            checkAdmission(entry, controller);
            entry.phase = 'unknown'; // The business adapter may have entered from this point onward.
            try { mapping = mapExecutionFact(await initial.execute(context), limits.fact); }
            catch { mapping = { executionPhase: 'unknown', outcome: unknownOutcome() }; }
        } catch (error) {
            mapping = entry.phase === 'not-dispatched' ? { executionPhase: 'not-dispatched',
                outcome: Object.freeze({ status: 'rejected', ...(entry.admissionExpired ? deadlineIssue : problem(error)) }) }
                : { executionPhase: 'unknown', outcome: unknownOutcome() };
        } finally {
            entry.phase = mapping.executionPhase;
            try {
                const completedAt = clock();
                entry.expiresAt = completedAt + limits.receiptTtlMs;
                if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
                const result = makeReceipt(entry, mapping, completedAt);
                entry.receipt = result.value; entry.resultBytes = result.bytes;
            } catch {
                entry.unavailable = true;
                // Retain a current fingerprint even if the clock or result cannot settle a readable receipt.
                entry.expiresAt ??= lastNow + limits.receiptTtlMs;
            }
            fees.result -= limits.receipt.maxCanonicalBytes - entry.resultBytes;
            const actualMetadata = captureBoundedJson<ReceiptMetadata>(entry.metadata, limits.metadata).bytes;
            fees.metadata -= limits.metadata.maxCanonicalBytes - actualMetadata; entry.metadataBytes = actualMetadata;
            release?.(); fees.work -= WORK; state.invocations--;
            state.controllers.delete(controller); entry.running = false;
            expireReceipts(lastNow);
            for (const notify of entry.waiters) notify();
            clean(state);
        }
    }

    function hasContent(state: State, entry: Entry): void {
        if (state.closing || closed) fail('APP_INTERACTION_UNAVAILABLE');
        if (entry.unavailable) fail('RESULT_UNAVAILABLE');
        active(state);
        if (entry.expired) fail('RESULT_EXPIRED');
        if (!entry.receipt) fail('RESULT_UNAVAILABLE');
    }
    async function permitted(state: State, entry: Entry, controller: AbortController, check: () => void): Promise<void> {
        check();
        let allowed: unknown;
        try { allowed = await state.policy!.canReadReceipt(entry.metadata, controller.signal); }
        catch { check(); return fail('RECEIPT_READ_FAILED'); }
        check();
        if (allowed !== true) fail('RECEIPT_PERMISSION_DENIED');
    }
    function admitRead(state: State): AbortController {
        if (state.reads >= limits.maxReads) fail('RECEIPT_READ_CAPACITY');
        charge({ work: limits.metadata.maxCanonicalBytes }, 'RECEIPT_READ_CAPACITY');
        const controller = new AbortController(); state.controllers.add(controller); state.reads++;
        return controller;
    }
    function wait(entry: Entry, deadline?: number, admission?: AbortController): Promise<ExecutionMapping | undefined> {
        if (!entry.running) return Promise.resolve(undefined);
        const delay = deadline === undefined ? undefined : Math.max(0, deadline - clock());
        return new Promise(resolve => {
            const done = () => { clearTimeout(timer); entry.waiters.delete(done); resolve(undefined); };
            const timer = delay === undefined ? undefined : setTimeout(() => {
                entry.waiters.delete(done);
                if (admission) expireAdmission(entry, admission);
                resolve(entry.admissionExpired
                    ? { executionPhase: 'not-dispatched', outcome: { status: 'rejected', ...deadlineIssue } }
                    : { executionPhase: 'unknown', outcome: unknownOutcome() });
            }, delay);
            entry.waiters.add(done);
        });
    }
    async function read(state: State, entry: Entry, controller: AbortController, deadline?: number, admission?: AbortController): Promise<ReceiptAccess> {
        let permission: Promise<void> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = await wait(entry, deadline, admission);
            const check = timeout ? () => active(state) : () => hasContent(state, entry);
            const receipt = timeout ? makeReceipt(entry, timeout, clock()).value : undefined;
            const remaining = deadline === undefined ? undefined : Math.max(0, deadline - clock());
            permission = permitted(state, entry, controller, check);
            if (remaining === undefined) await permission;
            else await Promise.race([permission, new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    reject(new InteractionFailure(deadlineIssue.code));
                    controller.abort();
                }, remaining);
            })]);
            check();
            return Object.freeze({ kind: 'receipt', receipt: receipt ?? entry.receipt! });
        } catch (error) { return unavailable(problem(error).code); }
        finally {
            clearTimeout(timer);
            const release = () => {
                fees.work -= limits.metadata.maxCanonicalBytes;
                state.reads--;
                state.controllers.delete(controller);
                clean(state);
            };
            // Ending the observer's wait does not end its Host permission callback.
            if (permission) void permission.then(release, release);
            else release();
        }
    }
    function capturedRequest(raw: unknown) {
        const captured = capture<AppInvocation>(raw, limits.request, 'INVOCATION_INVALID');
        const request = captured.value;
        if (!jsonObject(request) || !exactFields(request, ['invocationId', 'observationId', 'bindingId', 'input']) ||
            [request.invocationId, request.observationId, request.bindingId].some(value => !nonEmpty(value) || utf8Size(value) > 256) ||
            !jsonObject(request.input)) fail('INVOCATION_INVALID');
        return { request, bytes: captured.bytes, fingerprint: canonicalJson(request as unknown as JsonValue) };
    }

    function deadline(timeoutMs: number | undefined, now: number): number | undefined {
        if (timeoutMs === undefined) return;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isSafeInteger(now + timeoutMs))
            fail('INVOCATION_INVALID');
        return now + timeoutMs;
    }

    function findEntry(request: AppInvocation, fingerprint: string): Entry | undefined {
        const entry = state.entries.get(request.invocationId);
        if (entry && entry.fingerprint !== fingerprint) fail('INVOCATION_ID_CONFLICT', 'This call ID is already bound to different input or an observation.');
        return entry;
    }

    function readReceipt(raw: unknown, timeoutMs?: number): Promise<ReceiptAccess> {
        try {
            const end = deadline(timeoutMs, refresh());
            if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
            const { request, fingerprint } = capturedRequest(raw);
            const entry = findEntry(request, fingerprint);
            if (!entry) fail('RESULT_UNAVAILABLE');
            return read(state, entry, admitRead(state), end);
        } catch (error) { return Promise.resolve(unavailable(problem(error).code)); }
    }

    function invoke(raw: unknown, timeoutMs?: number): Promise<import('./app-interaction-types.js').InvokeResult> {
        try {
            const { request, bytes, fingerprint } = capturedRequest(raw);
            let now: number;
            try { now = refresh(); } catch (error) {
                const entry = state.entries.get(request.invocationId);
                if (entry?.fingerprint === fingerprint && entry.unavailable) return Promise.resolve(unavailable('RESULT_UNAVAILABLE'));
                throw error;
            }
            if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
            const end = deadline(timeoutMs, now);
            const found = findEntry(request, fingerprint);
            if (found) {
                try { return read(state, found, admitRead(state), end); }
                catch (error) { return Promise.resolve(unavailable(problem(error).code)); }
            }
            if (state.invocations) fail('INVOCATION_CAPACITY', 'An App operation is still in progress. Read its receipt or wait for it to finish.');
            if (request.observationId !== state.adoptedObservationId) {
                fail(state.observations.has(request.observationId) ? 'OBSERVATION_NOT_ADOPTED' : 'OBSERVATION_UNAVAILABLE');
            }
            const currentCount = [...state.entries.values()].filter(entry => entry.metadata.observationId === request.observationId).length;
            if (currentCount >= limits.maxReceiptsPerObservation)
                fail('INVOCATION_CAPACITY', 'The current observation has reached its call limit. Prepare and adopt a new observation.');
            if (state.entries.size >= limits.maxReceipts)
                fail('INVOCATION_CAPACITY', 'Retained call history is full. Wait for earlier receipts to expire.');
            if (state.reads >= limits.maxReads) fail('RECEIPT_READ_CAPACITY');
            const initial = capture<ReceiptMetadata>({ appId: state.appId, instanceId: state.instanceId,
                invocationId: request.invocationId, observationId: request.observationId,
                bindingId: request.bindingId, source: null }, limits.metadata, 'INVOCATION_CAPACITY').value;
            charge({ fingerprint: bytes, metadata: limits.metadata.maxCanonicalBytes, work: WORK + limits.metadata.maxCanonicalBytes,
                result: limits.receipt.maxCanonicalBytes });
            const controller = new AbortController(), readController = new AbortController();
            const entry: Entry = { fingerprint, fingerprintBytes: bytes, metadata: initial, metadataBytes: limits.metadata.maxCanonicalBytes,
                phase: 'not-dispatched', waiters: new Set(), ...(end === undefined ? {} : { deadline: end }),
                running: true, expired: false, unavailable: false, resultBytes: 0 };
            state.entries.set(request.invocationId, entry);
            state.controllers.add(controller); state.controllers.add(readController); state.invocations++; state.reads++;
            void Promise.resolve().then(() => run(state, entry, request, controller));
            return read(state, entry, readController, end, controller);
        } catch (error) { return Promise.resolve(Object.freeze({ kind: 'refused', ...problem(error) })); }
    }

    async function observe(selection: unknown): Promise<ObserveResult> {
        let controller: AbortController | undefined, token: import('./observation-types.js').ReservationHandle | undefined;
        try {
            active(state);
            if (state.projects || state.observations.size > (state.adoptedObservationId ? 1 : 0))
                fail('OBSERVATION_CAPACITY', 'Release or adopt the prepared observation before preparing another.');
            const reserved = observations.begin(state, selection);
            if (reserved.status === 'rejected') return reserved;
            token = reserved.reservation; controller = new AbortController(); state.controllers.add(controller); state.projects++;
            const grant = await state.policy!.project(Object.freeze({ source: reserved.source, selection: reserved.selection, signal: controller.signal }));
            return observations.complete(state, token, grant);
        } catch (error) { return Object.freeze({ status: 'rejected', issue: problem(error) }); }
        finally {
            if (token) observations.abandon(state, token);
            if (controller) {
                state.controllers.delete(controller); state.projects--;
            }
            clean(state);
        }
    }
    function stats(error?: unknown): InteractionStats {
        const observationStats = observations.stats(error);
        return Object.freeze({ closed, activeInvocations: state.invocations, activeReads: state.reads, receiptEntries: state.entries.size,
            receiptContents: [...state.entries.values()].filter(entry => entry.receipt).length,
            sourceBytes: fees.source, fingerprintBytes: fees.fingerprint, metadataBytes: fees.metadata, workBytes: fees.work,
            resultBytes: fees.result, invocationBytes: total(), combinedBytes: total() + observationStats.totalBytes,
            observations: observationStats, ...(error === undefined ? {} : { issue: problem(error) }) });
    }
    function inspect() { try { refresh(); return stats(); } catch (error) { return stats(error); } }
    return Object.freeze({
        observe, invoke, readReceipt, inspect, sweepExpired: inspect,
        async preview() {
            try { active(state); return previewCommittedApp(store, state.appId, state.instanceId); }
            catch (error) { return Object.freeze({ status: 'rejected' as const, issue: problem(error) }); }
        },
        adoptObservation(observationId: string) {
            const result = observations.adoptObservation(state, observationId);
            if (result.status === 'adopted') expireReceipts(lastNow);
            return result;
        },
        releaseObservation(observationId: string): void {
            observations.releaseObservation(state, observationId);
            try { refresh(); } catch { /* Explicit release remains possible with a failed clock. */ }
        },
        close() {
            closed = true;
            revoke(state);
            settleClosed();
            return stats();
        },
        whenClosed() { return closedCompletion; },
    });
}
