import { canonicalJson, utf8Size } from '../snapshot/json.js';
import type { AppIdentityReader, AppSnapshotV2, JsonValue, SnapshotStore } from '../snapshot/types.js';
import { validateVersionedToolRefDeclarations } from '../tool/versioned-ref-declarations.js';
import { prepareSnapshotValueArguments } from '../tool/snapshot-value-arguments.js';
import { createObservationRegistry, DEFAULT_OBSERVATION_REGISTRY_LIMITS } from './observation-registry.js';
import type { ObservationJsonLimits, ScopeHandle } from './observation-types.js';
import { createInvocationLedger } from './invocation-ledger.js';
import { captureBoundedJson, exactFields, jsonObject, mapExecutionFact, unknownOutcome, type ExecutionMapping } from './invocation-outcome.js';
import type {
    ExecutionBinding, InteractionAuthority, InteractionLimits, InteractionLimitOverrides, InteractionStats,
    InvocationContext, InvocationReceipt, InvocationSource, Issue, ObserveResult,
    OperationProvider, ReceiptAccess, ReceiptMetadata, ScopeClient, ScopedInvocation, ScopePolicy, TrustedScopeInput,
} from './scoped-interaction-types.js';
export type * from './scoped-interaction-types.js';

const KiB = 1024, MiB = KiB * KiB, WORK = MiB;
const profile = (maxDepth: number, maxNodes: number, bytes: number): ObservationJsonLimits => Object.freeze({
    maxDepth, maxNodes, maxApproxBytes: bytes, maxCanonicalBytes: bytes,
});
export const DEFAULT_INTERACTION_LIMITS: InteractionLimits = Object.freeze({
    maxScopes: 16, maxReceiptsPerScope: 256, maxReceipts: 1024, maxInvocationsPerScope: 4, maxInvocations: 16,
    maxReadsPerScope: 8, maxReads: 32, maxQueriesPerScope: 2, maxQueries: 8, receiptTtlMs: 60000,
    request: profile(33, 10005, 136 * KiB), ordinaryInput: profile(32, 5000, 128 * KiB),
    metadata: profile(8, 256, 32 * KiB), fact: profile(52, 32032, 520 * KiB), receipt: profile(54, 33000, 560 * KiB),
    maxSourceBytes: 32 * MiB, maxFingerprintBytes: 8 * MiB, maxMetadataBytes: 8 * MiB,
    maxWorkBytes: 16 * MiB, maxResultBytes: 16 * MiB, maxTotalBytes: 64 * MiB,
});
const MESSAGE = 'The scoped interaction could not be completed';
class InteractionFailure { constructor(readonly code: string) {} }
function fail(code: string): never { throw new InteractionFailure(code); }
const problem = (error: unknown): Issue => Object.freeze({ code: error instanceof InteractionFailure ? error.code : 'OBSERVATION_INTERNAL_ERROR', message: MESSAGE });
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
interface Provider { readonly original: OperationProvider; readonly owns: OperationProvider['owns']; readonly query: OperationProvider['query'] }
interface Binding extends Omit<ExecutionBinding, 'operations'> { readonly operations?: Provider }
function binding(raw: unknown): Binding {
    if (raw === null) fail('TOOL_EXECUTION_UNAVAILABLE');
    try {
        const data = dataProperties(raw, ['identity', 'mode', 'validateInput', 'isLive', 'execute'], ['operations']);
        if (!data.identity || !['object', 'function'].includes(typeof data.identity) ||
            !['ordinary-v2', 'snapshot-value-v2'].includes(data.mode as string) ||
            ['validateInput', 'isLive', 'execute'].some(key => typeof data[key] !== 'function')) throw 0;
        let operations: Provider | undefined;
        if (data.operations !== undefined) {
            const p = dataProperties(data.operations, ['owns', 'query']);
            if (typeof p.owns !== 'function' || typeof p.query !== 'function') throw 0;
            operations = Object.freeze({ original: data.operations as OperationProvider,
                owns: p.owns as OperationProvider['owns'], query: p.query as OperationProvider['query'] });
        }
        return Object.freeze({ ...data, operations }) as unknown as Binding;
    } catch { return fail('EXECUTION_BINDING_FAILED'); }
}
function sameBinding(a: Binding, b: Binding): boolean {
    return a.identity === b.identity && a.mode === b.mode && a.validateInput === b.validateInput &&
        a.isLive === b.isLive && a.execute === b.execute && a.operations?.original === b.operations?.original &&
        a.operations?.owns === b.operations?.owns && a.operations?.query === b.operations?.query;
}
interface Metadata extends ReceiptMetadata { readonly operationId: string | null }
interface QueryWork {
    readonly pending: Promise<void>;
    readonly provider: Provider;
    readonly operationId: string;
    notify(): void;
    code?: string;
    reserved: boolean;
}
interface Entry {
    metadata: Metadata;
    metadataBytes: number;
    phase: InvocationReceipt['executionPhase'];
    pending?: Promise<void>;
    notify?: () => void;
    running: boolean;
    expired: boolean;
    unavailable: boolean;
    receipt?: InvocationReceipt;
    resultBytes: number;
    provider?: Provider;
    query?: QueryWork;
}
interface State {
    readonly id: string;
    readonly handle: ScopeHandle;
    readonly expiresAt: number | null;
    readonly appId: string;
    readonly instanceId: string;
    policy?: ScopePolicy;
    resolve?: (source: InvocationSource) => ExecutionBinding | null;
    readonly ledger: ReturnType<typeof createInvocationLedger<Entry>>;
    readonly operations: Map<string, string>;
    readonly controllers: Set<AbortController>;
    closing: boolean;
    invocations: number;
    reads: number;
    queries: number;
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
    const registry = createObservationRegistry(store, { namespace: config.namespace as string, now: clock,
        lifetime: config.lifetime as 'scope' | 'ttl' | undefined,
        limits: config.observationLimits as import('./observation-types.js').ObservationRegistryLimitOverrides | undefined });
    const sourceProfile = Object.freeze({ ...DEFAULT_OBSERVATION_REGISTRY_LIMITS.source,
        ...(config.observationLimits as import('./observation-types.js').ObservationRegistryLimitOverrides | undefined)?.source });
    const states = new Map<string, State>();
    const sources = new Map<string, { readonly source: AppSnapshotV2; readonly bytes: number; count: number }>();
    const fees: Fees = { source: 0, fingerprint: 0, metadata: 0, work: 0, result: 0 };
    let closed = false, activeInvocations = 0, activeReads = 0, activeQueries = 0, receiptEntries = 0;
    let completeClosed: (() => void) | undefined;
    const closedCompletion = new Promise<void>(resolve => { completeClosed = resolve; });
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
        fees.result -= entry.resultBytes; entry.resultBytes = 0; entry.receipt = undefined; entry.provider = undefined;
        if (expired) entry.expired = true;
    }
    function clean(state: State): void {
        if (states.get(state.id) !== state || !state.closing || state.invocations || state.reads || state.queries || state.projects) return;
        for (const entry of state.ledger.values()) { dropContent(entry); fees.metadata -= entry.metadataBytes; }
        receiptEntries -= state.ledger.size; fees.fingerprint -= state.fingerprintBytes;
        state.ledger.clear(); state.operations.clear(); state.policy = undefined; state.resolve = undefined;
        states.delete(state.id);
        settleClosed();
    }
    function revoke(state: State): void {
        if (state.closing) return;
        state.closing = true; registry.closeScope(state.handle);
        for (const entry of state.ledger.values()) if (!entry.running) dropContent(entry);
        for (const controller of state.controllers) controller.abort();
        clean(state);
    }
    function refresh(): number {
        const time = clock();
        for (const state of states.values()) {
            const checked = registry.checkScope(state.handle);
            if (checked.status === 'rejected') {
                if (checked.issue.code === 'OBSERVATION_INTERNAL_ERROR') fail(checked.issue.code);
                revoke(state);
            }
            for (const entry of state.ledger.values()) if (entry.receipt && time >= entry.receipt.expiresAt) dropContent(entry, true);
            clean(state);
        }
        return time;
    }
    function active(state: State): void {
        refresh(); if (state.closing || closed || !states.has(state.id)) fail('SCOPE_UNAVAILABLE');
    }
    function metadata(entry: Entry): ReceiptMetadata {
        const { operationId: _, ...value } = entry.metadata;
        return Object.freeze(value);
    }
    function setMetadata(entry: Entry, patch: Partial<Metadata>): void {
        const measured = capture<Metadata>({ ...entry.metadata, ...patch }, limits.metadata, 'INVOCATION_CAPACITY');
        entry.metadata = measured.value; // Actual metadata bytes replace the reservation only at settlement.
    }
    function providerOwns(provider: Provider, receiptMetadata: ReceiptMetadata, operationId: string): boolean {
        try {
            const current = dataProperties(provider.original, ['owns', 'query']);
            if (current.owns !== provider.owns || current.query !== provider.query) return false;
            return provider.owns.call(provider.original, receiptMetadata, operationId) === true;
        }
        catch { return false; }
    }
    function own(entry: Entry): boolean {
        return !!entry.provider && !!entry.metadata.operationId && providerOwns(entry.provider, metadata(entry), entry.metadata.operationId);
    }
    function hold(source: AppSnapshotV2, release: () => void): () => void {
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
        const result = registry.resolveBinding(state.handle, { observationId: request.observationId, bindingId: request.bindingId });
        if (result.status === 'rejected') fail(result.issue.code);
        return result;
    }
    async function run(state: State, entry: Entry, request: ScopedInvocation, controller: AbortController): Promise<void> {
        let release: (() => void) | undefined;
        let mapping: ExecutionMapping = { executionPhase: 'not-dispatched', outcome: unknownOutcome(), queryTerminal: false };
        try {
            const selected = sourceFor(state, request);
            const acquired = config.lifetime === 'ttl' ? store.acquire(selected.sourceRequest.snapshotId)
                : store.acquire(selected.sourceRequest.snapshotId, { lifetime: 'owner' });
            if (acquired.status === 'rejected') fail(acquired.issue.code);
            const snapshot = acquired.lease.snapshot;
            if (snapshot.schemaVersion !== 2) { acquired.lease.release(); fail('SNAPSHOT_INVALID'); }
            try { release = hold(snapshot, acquired.lease.release); } catch (error) { acquired.lease.release(); throw error; }
            setMetadata(entry, { source: { appId: snapshot.appId, instanceId: snapshot.instanceId, snapshotId: snapshot.id, revision: snapshot.revision } });
            const source: InvocationSource = Object.freeze({ appId: state.appId, instanceId: state.instanceId,
                snapshotId: snapshot.id, tool: selected.tool, target: selected.target });
            let declared: boolean;
            try { declared = validateVersionedToolRefDeclarations(source.tool.inputSchema, source.tool.isMutating); }
            catch { return fail('REF_CONTRACT_UNSUPPORTED'); }
            const initial = resolve(state, source);
            let rawInput = request.input, effectiveInput = request.input;
            let refSources: InvocationContext['refSources'] = Object.freeze([]), firstRefCanonical: string | undefined;
            if (initial.mode === 'snapshot-value-v2') {
                if (source.tool.isMutating || !declared) fail('REF_CONTRACT_UNSUPPORTED');
                const schema = source.tool.inputSchema;
                const slots = jsonObject(schema) && jsonObject(schema.properties) ? Object.entries(schema.properties)
                    .filter(([, field]) => jsonObject(field) && Object.hasOwn(field, 'x-aotui-ref')) : [];
                if (slots.length !== 1 || !jsonObject(schema) || !Array.isArray(schema.required) || !schema.required.includes(slots[0]![0])) fail('REF_CONTRACT_UNSUPPORTED');
                const refId = rawInput[slots[0]![0]];
                if (!nonEmpty(refId) || !selected.visibleRefIds.includes(refId)) fail('REF_NOT_VISIBLE');
                const prepared = prepareSnapshotValueArguments(store, state, { snapshotId: snapshot.id, toolId: source.tool.id, viewId: source.target.viewId, args: rawInput });
                if (prepared.status === 'rejected') fail(prepared.issue.code);
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
                if (initial.mode === 'snapshot-value-v2') {
                    if (!refSources.every(ref => current.visibleRefIds.includes(ref.refId))) fail('REF_NOT_VISIBLE');
                    const checked = prepareSnapshotValueArguments(store, state, { snapshotId: snapshot.id, toolId: source.tool.id, viewId: source.target.viewId, args: rawInput });
                    if (checked.status === 'rejected') fail(checked.issue.code);
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
            if (initial.mode === 'snapshot-value-v2') {
                if (canonicalJson(validation.value) !== canonicalJson(effectiveInput)) fail('REF_ARGUMENT_CHANGED');
            } else effectiveInput = capture<InvocationContext['effectiveInput']>(validation.value, limits.ordinaryInput, 'ACTION_INPUT_INVALID').value;
            const context: InvocationContext = Object.freeze({ scopeId: state.id, invocationId: request.invocationId,
                source, rawInput, effectiveInput, refSources, signal: controller.signal });
            let authorized: unknown;
            try { authorized = await state.policy!.authorize(context); } catch { return fail('TOOL_AUTHORIZATION_FAILED'); }
            recheck();
            if (authorized !== true) fail('TOOL_PERMISSION_DENIED');
            recheck();
            entry.phase = 'unknown'; // The business adapter may have entered from this point onward.
            try { mapping = mapExecutionFact(await initial.execute(context), limits.fact); }
            catch { mapping = { executionPhase: 'unknown', outcome: unknownOutcome(), queryTerminal: false }; }
            if (mapping.outcome.status === 'accepted') {
                const outcome = mapping.outcome;
                let qualified = false;
                try {
                    active(state);
                    if (initial.operations && nonEmpty(outcome.operationId) && utf8Size(outcome.operationId) <= 256 && entry.metadata.source &&
                        (!state.operations.has(outcome.operationId) || state.operations.get(outcome.operationId) === request.invocationId)) {
                        const candidate = capture<Metadata>({ ...entry.metadata, operationId: outcome.operationId }, limits.metadata, 'INVOCATION_CAPACITY').value;
                        const { operationId: _, ...receiptMetadata } = candidate;
                        if (providerOwns(initial.operations, Object.freeze(receiptMetadata), outcome.operationId)) {
                            entry.metadata = candidate; entry.provider = initial.operations;
                            state.operations.set(outcome.operationId, request.invocationId); qualified = true;
                        }
                    }
                } catch { /* Failed qualification cannot claim a pre-dispatch rejection. */ }
                if (!qualified) mapping = { executionPhase: 'entered-returned', queryTerminal: false, outcome: Object.freeze({ status: 'unknown',
                    code: 'TOOL_OUTCOME_UNKNOWN', message: MESSAGE, details: { kind: 'action-outcome' as const, phase: 'entered-returned' as const, outcome } }) };
            }
        } catch (error) {
            mapping = entry.phase === 'not-dispatched' ? { executionPhase: 'not-dispatched', queryTerminal: false,
                outcome: Object.freeze({ status: 'rejected', ...problem(error) }) }
                : { executionPhase: 'unknown', queryTerminal: false, outcome: unknownOutcome() };
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
            } catch { entry.unavailable = true; entry.provider = undefined; }
            fees.result -= limits.receipt.maxCanonicalBytes - entry.resultBytes;
            const actualMetadata = captureBoundedJson<Metadata>(entry.metadata, limits.metadata).bytes;
            fees.metadata -= limits.metadata.maxCanonicalBytes - actualMetadata; entry.metadataBytes = actualMetadata;
            release?.(); fees.work -= WORK; state.invocations--; activeInvocations--;
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
        try { allowed = await state.policy!.canReadReceipt(metadata(entry), controller.signal); }
        catch { hasContent(state, entry); return fail('RECEIPT_READ_FAILED'); }
        hasContent(state, entry);
        if (allowed !== true) fail('RECEIPT_PERMISSION_DENIED');
        if (entry.receipt!.outcome.status === 'accepted' && !own(entry)) fail('OPERATION_QUERY_UNAVAILABLE');
    }
    function query(state: State, entry: Entry): QueryWork {
        if (entry.query) return entry.query;
        if (state.queries >= limits.maxQueriesPerScope || activeQueries >= limits.maxQueries) fail('OPERATION_QUERY_CAPACITY');
        charge({ work: WORK, result: limits.receipt.maxCanonicalBytes }, 'OPERATION_QUERY_CAPACITY');
        const controller = new AbortController(); state.controllers.add(controller); state.queries++; activeQueries++;
        let notify!: () => void;
        const pending = new Promise<void>(resolve => { notify = resolve; });
        const provider = entry.provider!, operationId = entry.metadata.operationId!;
        const work: QueryWork = { pending, notify, reserved: true, provider, operationId }; entry.query = work;
        void Promise.resolve().then(async () => {
            try {
                hasContent(state, entry);
                if (!own(entry)) fail('OPERATION_QUERY_UNAVAILABLE');
                const result = captureBoundedJson<JsonValue>(await provider.query.call(provider.original, metadata(entry), operationId, controller.signal), limits.fact).value;
                hasContent(state, entry);
                if (!own(entry) || entry.receipt!.outcome.status !== 'accepted') fail('OPERATION_QUERY_UNAVAILABLE');
                if (!jsonObject(result) || typeof result.status !== 'string') fail('OPERATION_QUERY_UNAVAILABLE');
                if (result.status === 'pending' && exactFields(result, ['status'])) return;
                if (result.status !== 'settled' || !exactFields(result, ['status', 'fact'])) fail('OPERATION_QUERY_UNAVAILABLE');
                const mapped = mapExecutionFact(result.fact, limits.fact);
                if (!mapped.queryTerminal || mapped.executionPhase !== 'entered-returned') fail('OPERATION_QUERY_UNAVAILABLE');
                const updated = capture<InvocationReceipt>({ ...entry.receipt!, executionPhase: mapped.executionPhase, outcome: mapped.outcome }, limits.receipt, 'OPERATION_QUERY_UNAVAILABLE');
                fees.result += updated.bytes - entry.resultBytes - limits.receipt.maxCanonicalBytes; work.reserved = false;
                entry.receipt = updated.value; entry.resultBytes = updated.bytes; entry.phase = mapped.executionPhase; entry.provider = undefined;
            } catch (error) {
                try { hasContent(state, entry); } catch (current) { error = current; }
                work.code = state.closing || closed ? 'SCOPE_UNAVAILABLE' : error instanceof InteractionFailure &&
                    ['SCOPE_UNAVAILABLE', 'RESULT_EXPIRED', 'RESULT_UNAVAILABLE'].includes(error.code) ? error.code : 'OPERATION_QUERY_UNAVAILABLE';
            }
            finally {
                if (work.reserved) fees.result -= limits.receipt.maxCanonicalBytes;
                fees.work -= WORK; state.queries--; activeQueries--; state.controllers.delete(controller);
                entry.query = undefined; work.notify(); clean(state);
            }
        });
        return work;
    }
    function admitRead(state: State): AbortController {
        if (state.reads >= limits.maxReadsPerScope || activeReads >= limits.maxReads) fail('RECEIPT_READ_CAPACITY');
        charge({ work: limits.metadata.maxCanonicalBytes }, 'RECEIPT_READ_CAPACITY');
        const controller = new AbortController(); state.controllers.add(controller); state.reads++; activeReads++;
        return controller;
    }
    async function read(state: State, entry: Entry, controller: AbortController, explicit: boolean): Promise<ReceiptAccess> {
        try {
            if (entry.pending) await entry.pending;
            await permitted(state, entry, controller);
            if (explicit && entry.receipt!.outcome.status === 'accepted') {
                const work = query(state, entry); await work.pending;
                if (work.code) fail(work.code);
                await permitted(state, entry, controller);
                if (!providerOwns(work.provider, metadata(entry), work.operationId)) fail('OPERATION_QUERY_UNAVAILABLE');
            }
            hasContent(state, entry);
            if (entry.receipt!.outcome.status === 'accepted' && !own(entry)) fail('OPERATION_QUERY_UNAVAILABLE');
            return Object.freeze({ kind: 'receipt', receipt: entry.receipt! });
        } catch (error) { return unavailable(problem(error).code); }
        finally { fees.work -= limits.metadata.maxCanonicalBytes; state.reads--; activeReads--; state.controllers.delete(controller); clean(state); }
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
            const fingerprint = canonicalJson(request as unknown as JsonValue), found = state.ledger.lookup(request.invocationId, fingerprint);
            if (failedClock) {
                if (found.status === 'match' && found.value.unavailable) return Promise.resolve(unavailable('RESULT_UNAVAILABLE'));
                throw clockError;
            }
            if (found.status === 'conflict') fail('INVOCATION_ID_CONFLICT');
            if (found.status === 'match') {
                try { return read(state, found.value, admitRead(state), false); }
                catch (error) { return Promise.resolve(unavailable(problem(error).code)); }
            }
            if (state.ledger.size >= limits.maxReceiptsPerScope || receiptEntries >= limits.maxReceipts ||
                state.invocations >= limits.maxInvocationsPerScope || activeInvocations >= limits.maxInvocations) fail('INVOCATION_CAPACITY');
            if (state.reads >= limits.maxReadsPerScope || activeReads >= limits.maxReads) fail('RECEIPT_READ_CAPACITY');
            const initial = capture<Metadata>({ scopeId: state.id, invocationId: request.invocationId, observationId: request.observationId,
                bindingId: request.bindingId, source: null, operationId: null }, limits.metadata, 'INVOCATION_CAPACITY').value;
            charge({ fingerprint: captured.bytes, metadata: limits.metadata.maxCanonicalBytes, work: WORK + limits.metadata.maxCanonicalBytes,
                result: limits.receipt.maxCanonicalBytes });
            const controller = new AbortController(), readController = new AbortController();
            let notify!: () => void;
            const pending = new Promise<void>(resolve => { notify = resolve; });
            const entry: Entry = { metadata: initial, metadataBytes: limits.metadata.maxCanonicalBytes, phase: 'not-dispatched',
                pending, notify, running: true, expired: false, unavailable: false, resultBytes: 0 };
            state.ledger.claim(request.invocationId, fingerprint, entry); state.fingerprintBytes += captured.bytes; receiptEntries++;
            state.controllers.add(controller); state.controllers.add(readController); state.invocations++; activeInvocations++; state.reads++; activeReads++;
            void Promise.resolve().then(() => run(state, entry, request, controller));
            return read(state, entry, readController, false);
        } catch (error) { return Promise.resolve(Object.freeze({ kind: 'refused', ...problem(error) })); }
    }
    function client(id: string): ScopeClient {
        return Object.freeze({
            async observe(selection: unknown): Promise<ObserveResult> {
                const state = states.get(id); if (!state) return Object.freeze({ status: 'rejected', issue: problem(new InteractionFailure('SCOPE_UNAVAILABLE')) });
                let controller: AbortController | undefined, token: import('./observation-types.js').ReservationHandle | undefined;
                try {
                    active(state); const reserved = registry.begin(state.handle, selection);
                    if (reserved.status === 'rejected') return reserved;
                    token = reserved.reservation; controller = new AbortController(); state.controllers.add(controller); state.projects++;
                    const grant = await state.policy!.project(Object.freeze({ source: reserved.source, selection: reserved.selection, signal: controller.signal }));
                    return registry.complete(state.handle, token, grant);
                } catch (error) { return Object.freeze({ status: 'rejected', issue: problem(error) }); }
                finally {
                    if (token) registry.abandon(state.handle, token);
                    if (controller) {
                        try { refresh(); } catch { /* A failed clock must not prevent actual settlement. */ }
                        state.controllers.delete(controller); state.projects--;
                    }
                    clean(state);
                }
            },
            invoke(raw: unknown) { return invoke(id, raw); },
            readReceipt(raw: unknown): Promise<ReceiptAccess> {
                try {
                    let failedClock = false, clockError: unknown;
                    try { refresh(); } catch (error) { failedClock = true; clockError = error; }
                    const state = states.get(id); if (!state || state.closing || closed) fail('SCOPE_UNAVAILABLE');
                    if (!nonEmpty(raw) || raw.length > 256 || utf8Size(raw) > 256) fail('RECEIPT_INVALID');
                    const entry = state.ledger.get(raw); if (!entry) fail('RECEIPT_UNAVAILABLE');
                    if (failedClock) {
                        if (entry.unavailable) return Promise.resolve(unavailable('RESULT_UNAVAILABLE'));
                        throw clockError;
                    }
                    return read(state, entry, admitRead(state), true);
                } catch (error) { return Promise.resolve(unavailable(problem(error).code)); }
            },
            releaseObservation(observationId: string): void {
                try { refresh(); } catch { /* Explicit release remains possible with a failed clock. */ }
                const state = states.get(id); if (state) registry.releaseObservation(state.handle, observationId);
            },
            close(): void {
                try { refresh(); } catch { /* Explicit revocation must not depend on time recovery. */ }
                const state = states.get(id); if (state) revoke(state);
            },
        });
    }
    function stats(error?: unknown): InteractionStats {
        let closingScopes = 0, receiptContents = 0, acceptedOperations = 0;
        for (const state of states.values()) {
            if (state.closing) closingScopes++;
            acceptedOperations += state.operations.size;
            for (const entry of state.ledger.values()) if (entry.receipt) receiptContents++;
        }
        const observations = registry.inspect();
        return Object.freeze({ closed, scopes: states.size, closingScopes, activeInvocations, activeReads, activeQueries,
            receiptEntries, receiptContents, acceptedOperations, sourceBytes: fees.source, fingerprintBytes: fees.fingerprint,
            metadataBytes: fees.metadata, workBytes: fees.work, resultBytes: fees.result, invocationBytes: total(),
            combinedBytes: total() + observations.totalBytes, observations,
            ...(error === undefined ? observations.issue ? { issue: observations.issue } : {} : { issue: problem(error) }) });
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
                const opened = registry.openScope({ appId: data.appId, instanceId: data.instanceId });
                if (opened.status === 'rejected') return opened;
                const checked = registry.checkScope(opened.scope);
                if (checked.status === 'rejected') return checked;
                const state: State = { id: opened.scope.scopeId, handle: opened.scope, expiresAt: checked.expiresAt,
                    appId: data.appId as string, instanceId: data.instanceId as string, policy, resolve: resolver,
                    ledger: createInvocationLedger<Entry>(limits.maxReceiptsPerScope), operations: new Map(), controllers: new Set(),
                    closing: false, invocations: 0, reads: 0, queries: 0, projects: 0, fingerprintBytes: 0 };
                states.set(state.id, state); return Object.freeze({ status: 'opened' as const, client: client(state.id) });
            } catch (error) { return Object.freeze({ status: 'rejected' as const, issue: problem(error) }); }
        },
        inspect() { try { refresh(); return stats(); } catch (error) { return stats(error); } },
        sweepExpired() { try { refresh(); return stats(); } catch (error) { return stats(error); } },
        close() { closed = true; for (const state of states.values()) revoke(state); registry.close(); settleClosed(); return stats(); },
        whenClosed() { return closedCompletion; },
    });
}
