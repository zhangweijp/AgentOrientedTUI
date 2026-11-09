import { VIEW_TYPE_PARAMETERS_MODE } from '../tool/ordinary-parameter-contract.js';
import { ORDINARY_INVOCATION_MODE } from '../tool/invocation-terminal.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/types.js';
import { canonicalJson, utf8Size } from '../snapshot/json.js';
import type { AppIdentityReader, AppSnapshotV3, JsonValue, SnapshotStore } from '../snapshot/types.js';
import { validateVersionedToolRefDeclarations } from '../tool/versioned-ref-declarations.js';
import { prepareViewTypeParameters } from '../tool/snapshot-value-arguments.js';
import { createObservationOperations, DEFAULT_OBSERVATION_REGISTRY_LIMITS, type ObservationState } from './observation-registry.js';
import type { ObservationJsonLimits } from './observation-types.js';
import { captureBoundedJson, exactFields, jsonObject, mapExecutionFact, unknownOutcome, type ExecutionMapping } from './invocation-outcome.js';
import type {
    ExecutionBinding, InteractionAuthority, InteractionLimits, InteractionLimitOverrides, InteractionStats,
    InvocationContext, InvocationReceipt, InvocationSource, Issue, ObserveResult,
    ReceiptAccess, ReceiptMetadata, ScopeClient, ScopedInvocation, ScopePolicy, TrustedScopeInput,
} from './scoped-interaction-types.js';

const KiB = 1024, MiB = KiB * KiB, WORK = MiB;
const profile = (maxDepth: number, maxNodes: number, bytes: number): ObservationJsonLimits => Object.freeze({
    maxDepth, maxNodes, maxApproxBytes: bytes, maxCanonicalBytes: bytes,
});
export const DEFAULT_INTERACTION_LIMITS: InteractionLimits = Object.freeze({
    maxScopes: 16, maxReceiptsPerScope: 256, maxReceipts: 1024, maxInvocationsPerScope: 4, maxInvocations: 16,
    maxReadsPerScope: 8, maxReads: 32, receiptTtlMs: 60000,
    request: profile(33, 10005, 136 * KiB), ordinaryInput: profile(32, 5000, 128 * KiB),
    metadata: profile(8, 256, 32 * KiB), fact: profile(52, 32032, 520 * KiB), receipt: profile(54, 33000, 560 * KiB),
    maxSourceBytes: 32 * MiB, maxFingerprintBytes: 8 * MiB, maxMetadataBytes: 8 * MiB,
    maxWorkBytes: 16 * MiB, maxResultBytes: 16 * MiB, maxTotalBytes: 64 * MiB,
});
const MESSAGE = 'The scoped interaction could not be completed';
class InteractionFailure { constructor(readonly code: string, readonly message: string = MESSAGE) {} }
function fail(code: string, message?: string): never { throw new InteractionFailure(code, message); }
const problem = (error: unknown): Issue => Object.freeze({ code: error instanceof InteractionFailure ? error.code : 'OBSERVATION_INTERNAL_ERROR', message: error instanceof InteractionFailure ? error.message : MESSAGE });
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
    metadata: ReceiptMetadata;
    metadataBytes: number;
    phase: InvocationReceipt['executionPhase'];
    pending?: Promise<void>;
    notify?: () => void;
    running: boolean;
    expired: boolean;
    unavailable: boolean;
    receipt?: InvocationReceipt;
    resultBytes: number;
}
interface State extends ObservationState {
    policy?: ScopePolicy;
    resolve?: (source: InvocationSource) => ExecutionBinding | null;
    readonly entries: Map<string, Entry>;
    readonly controllers: Set<AbortController>;
    closing: boolean;
    invocations: number;
    reads: number;
    projects: number;
    fingerprintBytes: number;
}
type Fees = { source: number; fingerprint: number; metadata: number; work: number; result: number };

export function createScopedInteraction(store: SnapshotStore & AppIdentityReader, options: Readonly<{
    namespace: string; now: () => number;
    lifetime?: 'scope' | 'ttl';
    observationLimits?: import('./observation-types.js').ObservationRegistryLimitOverrides;
    limits?: InteractionLimitOverrides;
}>): InteractionAuthority {
    let config: Record<string, unknown>, limits: InteractionLimits;
    try {
        config = dataProperties(options, ['namespace', 'now'], ['observationLimits', 'limits', 'lifetime']);
        if (!nonEmpty(config.namespace) || config.namespace.length > 128 || utf8Size(config.namespace) > 128 || typeof config.now !== 'function') throw 0;
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
    } catch { throw new TypeError('Invalid scoped interaction configuration'); }
    let lastNow = -1;
    function clock(): number {
        let value: number;
        try { value = (config.now as () => number)(); } catch { return fail('OBSERVATION_INTERNAL_ERROR'); }
        if (!Number.isSafeInteger(value) || value < 0 || value < lastNow) fail('OBSERVATION_INTERNAL_ERROR');
        lastNow = value; return value;
    }
    const sourceProfile = Object.freeze({ ...DEFAULT_OBSERVATION_REGISTRY_LIMITS.source,
        ...(config.observationLimits as import('./observation-types.js').ObservationRegistryLimitOverrides | undefined)?.source });
    const states = new Map<string, State>();
    const sources = new Map<string, { readonly source: AppSnapshotV3; readonly bytes: number; count: number }>();
    const fees: Fees = { source: 0, fingerprint: 0, metadata: 0, work: 0, result: 0 };
    let closed = false;
    const observations = createObservationOperations(store, { namespace: config.namespace as string, now: clock,
        lifetime: config.lifetime as 'scope' | 'ttl' | undefined,
        limits: config.observationLimits as import('./observation-types.js').ObservationRegistryLimitOverrides | undefined },
        states, refresh, () => closed);
    try { clock(); } catch { throw new RangeError('Invalid observation registry clock'); }
    let completeClosed: (() => void) | undefined;
    const closedCompletion = new Promise<void>(resolve => { completeClosed = resolve; });
    function stateCounts() {
        let activeInvocations = 0, activeReads = 0, receiptEntries = 0;
        for (const state of states.values()) {
            activeInvocations += state.invocations;
            activeReads += state.reads;
            receiptEntries += state.entries.size;
        }
        return { activeInvocations, activeReads, receiptEntries };
    }
    function settleClosed(): void {
        if (closed && states.size === 0) { completeClosed?.(); completeClosed = undefined; }
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
    function clean(state: State): void {
        if (states.get(state.id) !== state || !state.closing || state.invocations || state.reads || state.projects) return;
        for (const entry of state.entries.values()) { dropContent(entry); fees.metadata -= entry.metadataBytes; }
        fees.fingerprint -= state.fingerprintBytes;
        state.entries.clear(); state.policy = undefined; state.resolve = undefined;
        states.delete(state.id);
        settleClosed();
    }
    function revoke(state: State): void {
        if (state.closing) return;
        state.closing = true; observations.releaseScope(state);
        for (const entry of state.entries.values()) if (!entry.running) dropContent(entry);
        for (const controller of state.controllers) controller.abort();
        clean(state);
    }
    function refresh(): number {
        const time = clock();
        for (const state of states.values()) {
            if (!observations.refreshScope(state, time)) revoke(state);
            for (const entry of state.entries.values()) if (entry.receipt && time >= entry.receipt.expiresAt) dropContent(entry, true);
            clean(state);
        }
        return time;
    }
    function active(state: State): void {
        refresh(); if (state.closing || closed || !states.has(state.id)) fail('SCOPE_UNAVAILABLE');
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
    function sourceFor(state: State, request: ScopedInvocation) {
        active(state);
        const result = observations.resolveBinding(state, { observationId: request.observationId, bindingId: request.bindingId });
        if (result.status === 'rejected') fail(result.issue.code);
        return result;
    }
    async function run(state: State, entry: Entry, request: ScopedInvocation, controller: AbortController): Promise<void> {
        let release: (() => void) | undefined;
        let mapping: ExecutionMapping = { executionPhase: 'not-dispatched', outcome: unknownOutcome() };
        try {
            const selected = sourceFor(state, request);
            const acquired = config.lifetime === 'ttl' ? store.acquire(selected.sourceRequest.snapshotId)
                : store.acquire(selected.sourceRequest.snapshotId, { lifetime: 'owner' });
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
                if (prepared.status === 'rejected') fail(prepared.issue.code, prepared.issue.code === 'REF_TYPE_MISMATCH' ? prepared.issue.message : undefined);
                try { rawInput = prepared.rawArgs; effectiveInput = prepared.effectiveArgs; refSources = prepared.refSources;
                    firstRefCanonical = canonicalJson({ effectiveInput, refSources } as unknown as JsonValue); }
                finally { prepared.release(); }
            } else {
                if (declared) fail('REF_CONTRACT_UNSUPPORTED');
                rawInput = capture<InvocationContext['rawInput']>(request.input, limits.ordinaryInput, 'ACTION_INPUT_INVALID').value;
                effectiveInput = rawInput;
            }
            function recheck(): void {
                const current = sourceFor(state, request);
                if (initial.mode === VIEW_TYPE_PARAMETERS_MODE) {
                    const checked = prepareViewTypeParameters(store, state, { snapshotId: snapshot.id, toolId: source.tool.id,
                        execution: source.execution, args: rawInput }, current.visibleRefs);
                    if (checked.status === 'rejected') fail(checked.issue.code, checked.issue.code === 'REF_TYPE_MISMATCH' ? checked.issue.message : undefined);
                    try { if (canonicalJson({ effectiveInput: checked.effectiveArgs, refSources: checked.refSources } as unknown as JsonValue) !== firstRefCanonical) fail('REF_ARGUMENT_CHANGED'); }
                    finally { checked.release(); }
                }
                const latest = resolve(state, source);
                if (!sameBinding(initial, latest)) fail('TOOL_SOURCE_STALE');
                live(latest, source);
            }
            recheck();
            let validation: JsonValue;
            try { validation = captureBoundedJson<JsonValue>(await initial.validateInput(source, effectiveInput, controller.signal), limits.fact).value; }
            catch { return fail('INPUT_VALIDATOR_FAILED'); }
            recheck();
            if (!jsonObject(validation) || typeof validation.ok !== 'boolean' || !exactFields(validation, validation.ok ? ['ok', 'value'] : ['ok'])) fail('INPUT_VALIDATOR_FAILED');
            if (!validation.ok) fail('ACTION_INPUT_INVALID');
            if (!jsonObject(validation.value)) fail('INPUT_VALIDATOR_FAILED');
            if (initial.mode === VIEW_TYPE_PARAMETERS_MODE) {
                if (canonicalJson(validation.value) !== canonicalJson(effectiveInput)) fail('REF_ARGUMENT_CHANGED');
            } else effectiveInput = capture<InvocationContext['effectiveInput']>(validation.value, limits.ordinaryInput, 'ACTION_INPUT_INVALID').value;
            const context: InvocationContext = Object.freeze({ scopeId: state.id, invocationId: request.invocationId,
                source, rawInput, effectiveInput, refSources, signal: controller.signal });
            let authorized: unknown;
            try { authorized = await state.policy!.authorize(context); } catch { return fail('TOOL_AUTHORIZATION_FAILED'); }
            recheck();
            if (authorized !== true) fail('TOOL_PERMISSION_DENIED');
            entry.phase = 'unknown'; // The business adapter may have entered from this point onward.
            try { mapping = mapExecutionFact(await initial.execute(context), limits.fact); }
            catch { mapping = { executionPhase: 'unknown', outcome: unknownOutcome() }; }
        } catch (error) {
            mapping = entry.phase === 'not-dispatched' ? { executionPhase: 'not-dispatched',
                outcome: Object.freeze({ status: 'rejected', ...problem(error) }) }
                : { executionPhase: 'unknown', outcome: unknownOutcome() };
        } finally {
            entry.phase = mapping.executionPhase;
            try {
                const completedAt = clock();
                active(state);
                const expiresAt = completedAt + (state.expiresAt === null ? limits.receiptTtlMs
                    : Math.min(limits.receiptTtlMs, state.expiresAt - completedAt));
                const result = capture<InvocationReceipt>({ invocationId: entry.metadata.invocationId, observationId: entry.metadata.observationId,
                    bindingId: entry.metadata.bindingId, source: entry.metadata.source, completedAt, expiresAt,
                    executionPhase: mapping.executionPhase, outcome: mapping.outcome }, limits.receipt, 'RESULT_UNAVAILABLE');
                entry.receipt = result.value; entry.resultBytes = result.bytes;
            } catch { entry.unavailable = true; }
            fees.result -= limits.receipt.maxCanonicalBytes - entry.resultBytes;
            const actualMetadata = captureBoundedJson<ReceiptMetadata>(entry.metadata, limits.metadata).bytes;
            fees.metadata -= limits.metadata.maxCanonicalBytes - actualMetadata; entry.metadataBytes = actualMetadata;
            release?.(); fees.work -= WORK; state.invocations--;
            state.controllers.delete(controller); entry.running = false;
            const notify = entry.notify; entry.pending = undefined; entry.notify = undefined; notify?.();
            clean(state);
        }
    }

    function hasContent(state: State, entry: Entry): void {
        if (state.closing || closed || !states.has(state.id)) fail('SCOPE_UNAVAILABLE');
        if (entry.unavailable) fail('RESULT_UNAVAILABLE');
        active(state);
        if (entry.expired) fail('RESULT_EXPIRED');
        if (!entry.receipt) fail('RESULT_UNAVAILABLE');
    }
    async function permitted(state: State, entry: Entry, controller: AbortController): Promise<void> {
        hasContent(state, entry);
        let allowed: unknown;
        try { allowed = await state.policy!.canReadReceipt(entry.metadata, controller.signal); }
        catch { hasContent(state, entry); return fail('RECEIPT_READ_FAILED'); }
        hasContent(state, entry);
        if (allowed !== true) fail('RECEIPT_PERMISSION_DENIED');
    }
    function admitRead(state: State): AbortController {
        if (state.reads >= limits.maxReadsPerScope || stateCounts().activeReads >= limits.maxReads) fail('RECEIPT_READ_CAPACITY');
        charge({ work: limits.metadata.maxCanonicalBytes }, 'RECEIPT_READ_CAPACITY');
        const controller = new AbortController(); state.controllers.add(controller); state.reads++;
        return controller;
    }
    async function read(state: State, entry: Entry, controller: AbortController): Promise<ReceiptAccess> {
        try {
            if (entry.pending) await entry.pending;
            await permitted(state, entry, controller);
            hasContent(state, entry);
            return Object.freeze({ kind: 'receipt', receipt: entry.receipt! });
        } catch (error) { return unavailable(problem(error).code); }
        finally { fees.work -= limits.metadata.maxCanonicalBytes; state.reads--; state.controllers.delete(controller); clean(state); }
    }
    function invoke(id: string, raw: unknown): Promise<import('./scoped-interaction-types.js').InvokeResult> {
        try {
            let failedClock = false, clockError: unknown;
            try { refresh(); } catch (error) { failedClock = true; clockError = error; }
            const state = states.get(id); if (!state || state.closing || closed) fail('SCOPE_UNAVAILABLE');
            const captured = capture<ScopedInvocation>(raw, limits.request, 'INVOCATION_INVALID'), request = captured.value;
            if (!jsonObject(request) || !exactFields(request, ['invocationId', 'observationId', 'bindingId', 'input']) ||
                [request.invocationId, request.observationId, request.bindingId].some(value => !nonEmpty(value) || utf8Size(value) > 256) ||
                !jsonObject(request.input)) fail('INVOCATION_INVALID');
            const fingerprint = canonicalJson(request as unknown as JsonValue), found = state.entries.get(request.invocationId);
            if (failedClock) {
                if (found?.fingerprint === fingerprint && found.unavailable) return Promise.resolve(unavailable('RESULT_UNAVAILABLE'));
                throw clockError;
            }
            if (found && found.fingerprint !== fingerprint) fail('INVOCATION_ID_CONFLICT');
            if (found) {
                try { return read(state, found, admitRead(state)); }
                catch (error) { return Promise.resolve(unavailable(problem(error).code)); }
            }
            const counts = stateCounts();
            if (state.entries.size >= limits.maxReceiptsPerScope || counts.receiptEntries >= limits.maxReceipts ||
                state.invocations >= limits.maxInvocationsPerScope || counts.activeInvocations >= limits.maxInvocations) fail('INVOCATION_CAPACITY');
            if (state.reads >= limits.maxReadsPerScope || counts.activeReads >= limits.maxReads) fail('RECEIPT_READ_CAPACITY');
            const initial = capture<ReceiptMetadata>({ scopeId: state.id, invocationId: request.invocationId, observationId: request.observationId,
                bindingId: request.bindingId, source: null }, limits.metadata, 'INVOCATION_CAPACITY').value;
            charge({ fingerprint: captured.bytes, metadata: limits.metadata.maxCanonicalBytes, work: WORK + limits.metadata.maxCanonicalBytes,
                result: limits.receipt.maxCanonicalBytes });
            const controller = new AbortController(), readController = new AbortController();
            let notify!: () => void;
            const pending = new Promise<void>(resolve => { notify = resolve; });
            const entry: Entry = { fingerprint, metadata: initial, metadataBytes: limits.metadata.maxCanonicalBytes, phase: 'not-dispatched',
                pending, notify, running: true, expired: false, unavailable: false, resultBytes: 0 };
            state.entries.set(request.invocationId, entry); state.fingerprintBytes += captured.bytes;
            state.controllers.add(controller); state.controllers.add(readController); state.invocations++; state.reads++;
            void Promise.resolve().then(() => run(state, entry, request, controller));
            return read(state, entry, readController);
        } catch (error) { return Promise.resolve(Object.freeze({ kind: 'refused', ...problem(error) })); }
    }
    function client(id: string): ScopeClient {
        return Object.freeze({
            async observe(selection: unknown): Promise<ObserveResult> {
                const state = states.get(id); if (!state) return Object.freeze({ status: 'rejected', issue: problem(new InteractionFailure('SCOPE_UNAVAILABLE')) });
                let controller: AbortController | undefined, token: import('./observation-types.js').ReservationHandle | undefined;
                try {
                    active(state); const reserved = observations.begin(state, selection);
                    if (reserved.status === 'rejected') return reserved;
                    token = reserved.reservation; controller = new AbortController(); state.controllers.add(controller); state.projects++;
                    const grant = await state.policy!.project(Object.freeze({ source: reserved.source, selection: reserved.selection, signal: controller.signal }));
                    return observations.complete(state, token, grant);
                } catch (error) { return Object.freeze({ status: 'rejected', issue: problem(error) }); }
                finally {
                    if (token) observations.abandon(state, token);
                    if (controller) {
                        try { refresh(); } catch { /* A failed clock must not prevent actual settlement. */ }
                        state.controllers.delete(controller); state.projects--;
                    }
                    clean(state);
                }
            },
            invoke(raw: unknown) { return invoke(id, raw); },
            adoptObservation(observationId: string) {
                const state = states.get(id);
                if (!state) return Object.freeze({ status: 'rejected' as const, issue: problem(new InteractionFailure('SCOPE_UNAVAILABLE')) });
                return observations.adoptObservation(state, observationId);
            },
            releaseObservation(observationId: string): void {
                try { refresh(); } catch { /* Explicit release remains possible with a failed clock. */ }
                const state = states.get(id); if (state) observations.releaseObservation(state, observationId);
            },
            close(): void {
                try { refresh(); } catch { /* Explicit revocation must not depend on time recovery. */ }
                const state = states.get(id); if (state) revoke(state);
            },
        });
    }
    function stats(error?: unknown): InteractionStats {
        let closingScopes = 0, receiptContents = 0;
        const counts = stateCounts();
        for (const state of states.values()) {
            if (state.closing) closingScopes++;
            for (const entry of state.entries.values()) if (entry.receipt) receiptContents++;
        }
        const observationStats = observations.stats(error);
        return Object.freeze({ closed, scopes: states.size, closingScopes, ...counts,
            receiptContents, sourceBytes: fees.source, fingerprintBytes: fees.fingerprint,
            metadataBytes: fees.metadata, workBytes: fees.work, resultBytes: fees.result, invocationBytes: total(),
            combinedBytes: total() + observationStats.totalBytes, observations: observationStats,
            ...(error === undefined ? observationStats.issue ? { issue: observationStats.issue } : {} : { issue: problem(error) }) });
    }
    return Object.freeze({
        createScope(input: TrustedScopeInput) {
            try {
                refresh(); if (closed) fail('SCOPE_UNAVAILABLE');
                let data: Record<string, unknown>, policy: ScopePolicy, resolver: State['resolve'];
                try {
                    data = dataProperties(input, ['appId', 'instanceId', 'policy', 'execution']);
                    const p = dataProperties(data.policy, ['project', 'authorize', 'canReadReceipt']);
                    const e = dataProperties(data.execution, ['resolve']);
                    if (Object.values(p).some(value => typeof value !== 'function') || typeof e.resolve !== 'function') throw 0;
                    policy = Object.freeze(p) as unknown as ScopePolicy; resolver = e.resolve as State['resolve'];
                } catch { return fail('SCOPE_INVALID'); }
                if (states.size >= limits.maxScopes) fail('INVOCATION_CAPACITY');
                const prepared = observations.prepareScope({ appId: data.appId, instanceId: data.instanceId });
                if (prepared.status === 'rejected') return prepared;
                const state: State = { id: prepared.id, expiresAt: prepared.expiresAt,
                    appId: prepared.appId, instanceId: prepared.instanceId, policy, resolve: resolver,
                    observations: new Map(), reservations: new Map(), entries: new Map(), controllers: new Set(),
                    closing: false, invocations: 0, reads: 0, projects: 0, fingerprintBytes: 0 };
                if (!observations.refreshScope(state, clock())) return Object.freeze({ status: 'rejected' as const,
                    issue: Object.freeze({ code: 'SCOPE_UNAVAILABLE', message: 'Observation registry request could not be completed' }) });
                states.set(state.id, state); return Object.freeze({ status: 'opened' as const, client: client(state.id) });
            } catch (error) { return Object.freeze({ status: 'rejected' as const, issue: problem(error) }); }
        },
        inspect() { try { refresh(); return stats(); } catch (error) { return stats(error); } },
        sweepExpired() { try { refresh(); return stats(); } catch (error) { return stats(error); } },
        close() {
            closed = true; for (const state of states.values()) revoke(state); settleClosed();
            try { refresh(); return stats(); } catch (error) { return stats(error); }
        },
        whenClosed() { return closedCompletion; },
    });
}
