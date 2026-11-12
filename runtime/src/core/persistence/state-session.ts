import { canonicalJson, utf8Size } from '../snapshot/json.js';
import {
    captureStateAddress, captureStateMutationResult, captureStateReadResult, captureStateReleaseResult,
    captureStateValue, decodeStateRecord, encodeStateRecord, failedMutation, failedRead,
    rejectState, requireStateLimits, stateFields, stateIssue, unknownMutation, validStateOwner,
} from './state-storage.js';
import type {
    CapturedStateValue, Rejected, StateAddress, StateIssue, StateIssueCode,
    StateMutationResult, StateReadResult, StateReleaseResult, StateStorage, StateValue, StateValueLimits,
} from './state-storage.js';

export interface StateSessionLimits extends StateValueLimits {
    readonly maxKeys: number;
    /** Address tuples, owned canonical values and live encoded records; not heap/RSS. */
    readonly maxRetainedBytes: number;
    /** Includes queued and executing adapter calls. Initialization acknowledgments are counted separately. */
    readonly maxPendingRequests: number;
    readonly maxConcurrentRequests: number;
    /** Logical revision and binding-generation ceilings, never clocks or wrapping counters. */
    readonly maxRevision: number;
}
export type StateRecovery = Readonly<{
    instanceId: string; address: StateAddress; generation: number;
} & ({ status: 'missing' } | { status: 'found'; source: 'v1' | 'session'; value: StateValue } | { status: 'blocked'; issue: StateIssue })>;
export type InitializationConfirmation = Readonly<{ status: 'ready'; value?: StateValue }> | Readonly<{ status: 'failed' }>;
export type StateChangeResult = Readonly<{ status: 'accepted'; revision: number }> | Rejected;
export interface StateFlushEntry {
    readonly address: StateAddress;
    readonly revision: number;
    readonly status: 'saved' | 'unchanged' | 'blocked' | 'failed' | 'unknown';
    readonly issue?: StateIssue;
}
export interface StateFlushReport { readonly status: 'completed' | 'disposed'; readonly ok: boolean; readonly entries: readonly StateFlushEntry[] }
export interface StateDisposeReport {
    readonly status: 'disposed';
    readonly unsaved: readonly StateFlushEntry[];
    readonly release: StateReleaseResult;
}
export type StateBindingStatus = Readonly<{
    phase: 'open' | 'sealed'; initialized: boolean; revision: number; dirty: boolean; issue?: StateIssue;
}> | Readonly<{ phase: 'released'; issue: StateIssue }>;
export interface StateBinding {
    readonly generation: number;
    readonly recovery: Promise<StateRecovery>;
    inspect(): StateBindingStatus;
    confirmInitialization(recovery: StateRecovery, confirmation: InitializationConfirmation): StateChangeResult;
    update(value: StateValue): StateChangeResult;
    /** SDK serializers may fail before producing JSON. No serializer, cause or component closure is retained. */
    reportUpdateFailure(): StateChangeResult;
    clear(): Promise<StateMutationResult>;
    release(): boolean;
}
const limitNames = ['maxDepth', 'maxNodes', 'maxValueBytes', 'maxRecordBytes', 'maxAddressBytes', 'maxKeys', 'maxRetainedBytes', 'maxPendingRequests', 'maxConcurrentRequests', 'maxRevision'] as const;
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};
type Value = { snapshot: CapturedStateValue; holders: number };
type Entry = {
    identity: string; address: StateAddress; addressBytes: number; generation: number; active: boolean;
    revision: number; savedRevision: number; latestRevision: number; latest?: Value; action: 'value' | 'clear';
    hasSessionValue: boolean; initialized: boolean; block?: StateIssue; attemptIssue?: StateIssue;
    unknown: boolean; clearedThrough: number; initialization?: Initialization;
    clear?: { revision: number; promise: Promise<StateMutationResult>; result?: StateMutationResult };
    jobs: number; activeIO: boolean; batches: number;
};
type Initialization = {
    entry: Entry; generation: number; revision: number; hydrate: boolean; suppressed: boolean; sessionClean: boolean; sessionRevision: number;
    initial?: Value; session?: Value; restored?: Value; issued?: StateRecovery; readIssue?: StateIssue;
    recovery: ReturnType<typeof deferred<StateRecovery>>; done: ReturnType<typeof deferred<void>>;
    waiter?: BatchItem; completed: boolean;
};
type BatchItem = {
    entry: Entry; revision: number; value?: Value; initialization?: Initialization;
    wait?: Promise<void>; result?: StateFlushEntry; clear?: Entry['clear'];
};
type Job = {
    entry: Entry; kind: 'read' | 'mutation';
    invoke: () => Promise<unknown>;
    settle: (result: StateReadResult | StateMutationResult) => void;
};

/** Internal deep module. The port is a plain object with own data methods, captured once before I/O. */
export function createStateSession(options: Readonly<{ instanceId: string; storage: StateStorage; limits: StateSessionLimits; now: () => number }>) {
    const fields = stateFields(options);
    if (!fields || Object.keys(fields).length !== 4 || !fields.limits) throw new Error('INVALID_INPUT: explicit state session options required');
    const limits = requireStateLimits(fields.limits.value as StateSessionLimits, limitNames);
    const candidateId: unknown = fields.instanceId?.value, port = stateFields(fields.storage?.value), clock: unknown = fields.now?.value;
    if (!validStateOwner(candidateId, limits.maxAddressBytes) || !port || port.owner?.value !== candidateId || typeof clock !== 'function' || ['read', 'replace', 'remove', 'release'].some(k => typeof port[k]?.value !== 'function')) {
        throw new Error('INVALID_INPUT: bounded instance, matching owner and explicit clock required');
    }
    const instanceId: string = candidateId;
    // Bind to the original port once; later caller mutations do not redirect this session.
    let storage: StateStorage | undefined = Object.freeze({ owner: instanceId,
        read: port.read!.value.bind(fields.storage!.value), replace: port.replace!.value.bind(fields.storage!.value),
        remove: port.remove!.value.bind(fields.storage!.value), release: port.release!.value.bind(fields.storage!.value),
    });
    let now: (() => number) | undefined = clock as () => number;
    let phase: 'open' | 'sealed' | 'disposed' = 'open', revision = 0, generation = 0;
    let retainedBytes = 0, activeIO = 0, pending = 0, releasePending = 0;
    const entries = new Map<string, Entry>(), queue: Job[] = [], idleWaiters: (() => void)[] = [];
    let flushPromise: Promise<StateFlushReport> | undefined, disposePromise: Promise<StateDisposeReport> | undefined;
    const result = (e: Entry, rev: number, status: StateFlushEntry['status'], issue?: StateIssue): StateFlushEntry => Object.freeze({ address: e.address, revision: rev, status, ...(issue ? { issue } : {}) });
    const keep = (value: Value | undefined) => { if (value) value.holders++;return value; };
    const drop = (value: Value | undefined) => { if (value && --value.holders === 0) retainedBytes -= value.snapshot.bytes; };
    function own(snapshot: CapturedStateValue): Value | undefined {
        if (retainedBytes + snapshot.bytes > limits.maxRetainedBytes) return undefined;
        retainedBytes += snapshot.bytes;return { snapshot, holders: 1 };
    }
    function nextRevision(): number | undefined { return revision >= limits.maxRevision ? undefined : ++revision; }
    const current = (id: string, gen: number) => { const e = entries.get(id);return e?.active && e.generation === gen ? e : undefined; };
    const lifecycleIssue = (): StateIssueCode | undefined => phase === 'disposed' ? 'DISPOSED' : phase === 'sealed' ? 'SEALED' : undefined;
    function evict(e: Entry) {
        if (e.active || e.initialization || e.jobs || e.batches || e.unknown || e.block || e.attemptIssue || e.action === 'clear' || e.savedRevision !== e.revision) return;
        if (entries.get(e.identity) === e) { entries.delete(e.identity);retainedBytes -= e.addressBytes;drop(e.latest);e.latest = undefined; }
    }
    function notifyIdle() { if (!pending) for (const resolve of idleWaiters.splice(0)) resolve(); }
    function pump() {
        if (phase === 'disposed') return;
        for (let index = 0; index < queue.length && activeIO < limits.maxConcurrentRequests;) {
            const job = queue[index]!;
            if (job.entry.activeIO) { index++;continue; }
            queue.splice(index, 1);
            if (job.kind === 'mutation' && job.entry.unknown) { finish(job, unknownMutation(), false);continue; }
            activeIO++;job.entry.activeIO = true;
            // pump itself is deferred until completion Promises are installed.
            // Selection and actual port entry are one synchronous step: dispose
            // cannot leave a selected-but-not-entered mutation behind.
            let requestPromise: Promise<unknown>;
            try { requestPromise = job.invoke(); }
            catch { finish(job, job.kind === 'read' ? failedRead('IO_FAILED') : unknownMutation(), true);continue; }
            Promise.resolve(requestPromise).then(
                raw => finish(job, job.kind === 'read' ? captureStateReadResult(raw, limits.maxRecordBytes) : captureStateMutationResult(raw), true),
                () => finish(job, job.kind === 'read' ? failedRead('IO_FAILED') : unknownMutation(), true),
            );
        }
    }
    function finish(job: Job, receipt: StateReadResult | StateMutationResult, started: boolean) {
        if (job.kind === 'mutation' && receipt.status === 'unknown') job.entry.unknown = true;
        // Apply the request result before starting the next request at this address.
        job.settle(receipt);
        pending--;job.entry.jobs--;
        if (started) { activeIO--;job.entry.activeIO = false; }
        evict(job.entry);notifyIdle();void Promise.resolve().then(pump);
    }
    function enqueue(e: Entry, kind: Job['kind'], invoke: Job['invoke'], settle: Job['settle']): boolean {
        if (phase === 'disposed' || pending >= limits.maxPendingRequests) return false;
        pending++;e.jobs++;queue.push({ entry: e, kind, invoke, settle });void Promise.resolve().then(pump);return true;
    }
    const blocker = (e: Entry, rev: number): StateFlushEntry | undefined => e.unknown ? result(e, rev, 'unknown', stateIssue('UNKNOWN_OUTCOME')) : e.block ? result(e, rev, 'blocked', e.block) : undefined;
    function discardInitialization(init: Initialization) {
        drop(init.initial);drop(init.session);drop(init.restored);init.initial = init.session = init.restored = undefined;init.issued = undefined;
        if (init.entry.initialization === init) init.entry.initialization = undefined;
        init.completed = true;init.done.resolve();
    }
    function cancelInitialization(init: Initialization, code: StateIssueCode) {
        const e = init.entry;
        if (init.waiter) init.waiter.result = result(e, init.waiter.revision, 'blocked', stateIssue(code));
        if (!init.issued) init.recovery.resolve(Object.freeze({ instanceId, address: e.address, generation: init.generation, status: 'blocked', issue: stateIssue(code) }));
        discardInitialization(init);
    }
    function issueRecovery(init: Initialization, receipt: StateReadResult | 'checked-session') {
        const e = init.entry;
        if (init.completed || e.initialization !== init || !current(e.identity, init.generation) || phase === 'disposed') return;
        let detail: { status: 'missing' } | { status: 'found'; source: 'v1' | 'session'; value: StateValue } | { status: 'blocked'; issue: StateIssue };
        if (receipt === 'checked-session' || receipt.status === 'missing') detail = { status: 'missing' };
        else if (receipt.status === 'failed') detail = { status: 'blocked', issue: receipt.issue };
        else {
            // The read text is owned while decoding; it is not retained by this session after recovery is issued.
            const textBytes = utf8Size(receipt.text);
            if (retainedBytes + textBytes > limits.maxRetainedBytes) detail = { status: 'blocked', issue: stateIssue('CAPACITY_EXCEEDED') };
            else {
                retainedBytes += textBytes;
                const decoded = decodeStateRecord(receipt.text, limits);
                if (decoded.status === 'rejected') detail = { status: 'blocked', issue: decoded.issue };
                else {
                    init.restored = own(decoded.snapshot);
                    detail = init.restored ? { status: 'found', source: 'v1', value: decoded.snapshot.value } : { status: 'blocked', issue: stateIssue('CAPACITY_EXCEEDED') };
                }
                retainedBytes -= textBytes;
            }
        }
        // An unconfirmed old generation must check storage again. A completed
        // check can be reused for its retained session baseline, including while
        // an already admitted old write is held. Valid recovery exposes that
        // baseline, not the older disk value that it superseded.
        if (init.session && e.clearedThrough >= init.sessionRevision) { drop(init.session);init.session = undefined; }
        if (e.action === 'clear') init.suppressed = e.clear?.result?.status !== 'failed';
        if (detail.status !== 'blocked' && init.session) {
            drop(init.restored);init.restored = keep(init.session);
            detail = { status: 'found', source: 'session', value: init.session.snapshot.value };
        }
        const existingBlock = blocker(e, init.revision);
        if (detail.status !== 'blocked' && existingBlock) {
            drop(init.restored);init.restored = undefined;detail = { status: 'blocked', issue: existingBlock.issue! };
        }
        if (detail.status === 'blocked') {
            init.readIssue = detail.issue;
            if (e.clearedThrough < init.revision) e.block = detail.issue;
        }
        const issued: StateRecovery = Object.freeze({ instanceId, address: e.address, generation: init.generation, ...detail });init.issued = issued;init.recovery.resolve(issued);
    }
    function confirm(id: string, gen: number, recovery: StateRecovery, confirmation: InitializationConfirmation): StateChangeResult {
        if (phase === 'disposed') return rejectState('DISPOSED');
        const e = current(id, gen), init = e?.initialization;
        if (!e || !init || !init.issued || init.issued !== recovery) return rejectState('STALE_BINDING');
        const f = stateFields(confirmation), status = f?.status?.value;
        if (!f || !['ready', 'failed'].includes(status) || Object.keys(f).some(k => k !== 'status' && k !== 'value') || status === 'failed' && Object.keys(f).length !== 1) return rejectState('INVALID_INPUT');
        const needsValue = recovery.status === 'found' && (init.hydrate || recovery.source === 'session');
        if (status === 'ready' && (needsValue ? !Object.hasOwn(f, 'value') : Object.hasOwn(f, 'value'))) return rejectState('INVALID_INPUT');
        let chosen = init.initial, clean = false, issue = init.readIssue;
        if (status === 'failed') issue = stateIssue('INITIALIZATION_FAILED');
        else if (!issue && needsValue) {
            const captured = captureStateValue(f.value!.value, limits);
            if (captured.status === 'rejected') issue = captured.issue;
            else if (init.restored && canonicalJson(captured.snapshot.value) === canonicalJson(init.restored.snapshot.value)) {
                chosen = init.restored;clean = recovery.status === 'found' && (recovery.source !== 'session' || init.sessionClean);
            } else { chosen = own(captured.snapshot);if (!chosen) issue = stateIssue('CAPACITY_EXCEEDED'); }
        }
        // Only an already registered initialization may complete after seal. No new revision is minted here.
        if (issue && e.clearedThrough < init.revision) e.block = issue;
        if (!issue && e.clearedThrough < init.revision && e.revision === init.revision && !init.suppressed && chosen) {
            drop(e.latest);e.latest = keep(chosen);e.latestRevision = init.revision;e.savedRevision = clean ? e.revision : 0;e.hasSessionValue = true;e.action = 'value';
        }
        e.initialized = true;
        if (init.waiter) {
            const item = init.waiter, blocked = blocker(e, item.revision);
            if (blocked) item.result = blocked;
            else if (item.revision === init.revision && !init.suppressed) {
                drop(item.value);item.value = keep(chosen);
                if (e.clearedThrough >= item.revision || clean) item.result = result(e, item.revision, 'unchanged');
            }
        }
        // A newly captured confirmation is temporarily owned in addition to initial/restored values.
        if (chosen && chosen !== init.initial && chosen !== init.restored) drop(chosen);
        const rev = init.revision;discardInitialization(init);evict(e);
        return issue ? Object.freeze({ status: 'rejected', issue }) : Object.freeze({ status: 'accepted', revision: rev });
    }
    function update(id: string, gen: number, input: StateValue | undefined, failed: boolean): StateChangeResult {
        const life = lifecycleIssue();if (life) return rejectState(life);
        const e = current(id, gen);if (!e) return rejectState('STALE_BINDING');
        const rev = nextRevision();
        if (!rev) { e.attemptIssue = stateIssue('REVISION_EXHAUSTED');return rejectState('REVISION_EXHAUSTED'); }
        const captured = failed ? rejectState('SERIALIZATION_FAILED') : captureStateValue(input, limits);
        const value = captured.status === 'captured' ? own(captured.snapshot) : undefined;
        e.revision = rev;e.action = 'value';
        if (!value) {
            e.attemptIssue = captured.status === 'rejected' ? captured.issue : stateIssue('CAPACITY_EXCEEDED');
            return Object.freeze({ status: 'rejected', issue: e.attemptIssue });
        }
        drop(e.latest);e.latest = value;e.latestRevision = rev;e.attemptIssue = undefined;e.hasSessionValue = true;
        return Object.freeze({ status: 'accepted', revision: rev });
    }
    function clear(id: string, gen: number): Promise<StateMutationResult> {
        const life = lifecycleIssue();if (life) return Promise.resolve(failedMutation(life));
        const e = current(id, gen);if (!e) return Promise.resolve(failedMutation('STALE_BINDING'));
        if (e.unknown) return Promise.resolve(unknownMutation());
        if (pending >= limits.maxPendingRequests) return Promise.resolve(failedMutation('CAPACITY_EXCEEDED'));
        const rev = nextRevision();if (!rev) return Promise.resolve(failedMutation('REVISION_EXHAUSTED'));
        const completion = deferred<StateMutationResult>();
        const record: NonNullable<Entry['clear']> = { revision: rev, promise: completion.promise };
        e.revision = rev;e.action = 'clear';e.clear = record;e.attemptIssue = undefined;
        enqueue(e, 'mutation', () => storage!.remove(e.address), raw => {
            const receipt = raw as StateMutationResult;record.result = receipt;
            if (receipt.status === 'applied') {
                e.clearedThrough = Math.max(e.clearedThrough, rev);e.block = undefined;
                if (e.latestRevision <= rev) { drop(e.latest);e.latest = undefined;e.latestRevision = 0;e.hasSessionValue = false; }
                if (e.revision === rev) e.savedRevision = rev;
            }
            completion.resolve(receipt);
        });
        return completion.promise;
    }
    function bind(input: StateAddress, initialValue: StateValue, bindingOptions: Readonly<{ hydrate: boolean }>): Readonly<{ status: 'bound'; binding: StateBinding }> | Rejected {
        const life = lifecycleIssue();if (life) return rejectState(life);
        const address = captureStateAddress(input, limits.maxAddressBytes), mode = stateFields(bindingOptions);
        if (address.status === 'rejected') return address;
        if (!mode || Object.keys(mode).length !== 1 || typeof mode.hydrate?.value !== 'boolean') return rejectState('INVALID_INPUT');
        let e = entries.get(address.identity);
        if (e?.active) return rejectState('OWNER_BUSY');
        if (generation >= limits.maxRevision || revision >= limits.maxRevision) return rejectState('REVISION_EXHAUSTED');
        const checkedSession = !!e?.initialized && (e.action === 'value' || e.clear?.result?.status === 'applied');
        if (!checkedSession && pending >= limits.maxPendingRequests || !e && entries.size >= limits.maxKeys) return rejectState('CAPACITY_EXCEEDED');
        const captured = captureStateValue(initialValue, limits);if (captured.status === 'rejected') return captured;
        if (retainedBytes + captured.snapshot.bytes + (e ? 0 : address.bytes) > limits.maxRetainedBytes) return rejectState('CAPACITY_EXCEEDED');
        if (!e) {
            retainedBytes += address.bytes;
            e = { identity: address.identity, address: address.address, addressBytes: address.bytes, generation: 0, active: false, revision: 0, savedRevision: 0, latestRevision: 0,
                action: 'value', hasSessionValue: false, initialized: false, unknown: false, clearedThrough: 0, jobs: 0, activeIO: false, batches: 0 };
            entries.set(e.identity, e);
        }
        const initial = own(captured.snapshot)!;
        const session = e.hasSessionValue ? keep(e.latest) : undefined, sessionRevision = e.latestRevision;
        const sessionClean = !!session && e.initialized && e.savedRevision === e.revision && !e.attemptIssue;
        // A fresh binding owns its own revision. Old writes can never mark its
        // later normalized confirmation clean by reusing an old revision number.
        e.revision = nextRevision()!;e.savedRevision = sessionClean ? e.revision : 0;e.initialized = false;
        if (!session && e.action !== 'clear') { drop(e.latest);e.latest = keep(initial);e.latestRevision = e.revision; }
        e.generation = ++generation;e.active = true;
        const init: Initialization = { entry: e, generation, revision: e.revision, hydrate: mode.hydrate!.value, suppressed: e.action === 'clear', sessionClean, sessionRevision, session, initial, recovery: deferred<StateRecovery>(), done: deferred<void>(), completed: false };
        e.initialization = init;
        const id = e.identity, gen = generation;
        const binding: StateBinding = Object.freeze({ generation: gen, recovery: init.recovery.promise,
            inspect: (): StateBindingStatus => {
                if (phase === 'disposed') return Object.freeze({ phase: 'released', issue: stateIssue('DISPOSED') });
                const owned = current(id, gen);
                if (!owned) return Object.freeze({ phase: 'released', issue: stateIssue('STALE_BINDING') });
                const issue = owned.unknown ? stateIssue('UNKNOWN_OUTCOME') : owned.block ?? owned.attemptIssue ??
                    (owned.action === 'clear' && owned.clear?.result?.status !== 'applied' ? owned.clear?.result?.issue : undefined);
                const dirty = owned.action === 'clear' ? owned.clear?.result?.status !== 'applied' :
                    !owned.initialized || owned.savedRevision !== owned.revision || !!owned.attemptIssue || !!owned.block;
                return Object.freeze({ phase, initialized: owned.initialized, revision: owned.revision, dirty, ...(issue ? { issue } : {}) });
            },
            confirmInitialization: (receipt: StateRecovery, confirmation: InitializationConfirmation) => confirm(id, gen, receipt, confirmation),
            update: (value: StateValue) => update(id, gen, value, false), reportUpdateFailure: () => update(id, gen, undefined, true),
            clear: () => clear(id, gen),
            release: () => {
                const owned = current(id, gen);if (!owned || phase === 'disposed') return false;
                owned.active = false;if (owned.initialization) cancelInitialization(owned.initialization, 'STALE_BINDING');evict(owned);return true;
            },
        });
        if (checkedSession) issueRecovery(init, 'checked-session');
        else enqueue(e, 'read', () => storage!.read(e!.address), raw => issueRecovery(init, raw as StateReadResult));
        return Object.freeze({ status: 'bound', binding });
    }
    async function flushItem(item: BatchItem): Promise<StateFlushEntry> {
        const e = item.entry;
        if (item.wait) await item.wait;
        if (item.result) return item.result;
        if (phase === 'disposed') return result(e, item.revision, 'blocked', stateIssue('DISPOSED'));
        if (item.clear) {
            const receipt = item.clear.result ?? await item.clear.promise;
            return receipt.status === 'applied' ? result(e, item.revision, 'unchanged') : result(e, item.revision, receipt.status === 'unknown' ? 'unknown' : 'failed', receipt.issue);
        }
        const blocked = blocker(e, item.revision);if (blocked) return blocked;
        if (e.clear && e.clear.revision > item.revision) {
            const removed = e.clear.result ?? await e.clear.promise;
            return removed.status === 'applied' ? result(e, item.revision, 'unchanged') : result(e, item.revision, removed.status === 'unknown' ? 'unknown' : 'failed', removed.issue);
        }
        if (e.clearedThrough >= item.revision) return result(e, item.revision, 'unchanged');
        if (!item.value) return result(e, item.revision, 'failed', stateIssue('SERIALIZATION_FAILED'));
        let time: number;try { time = now!(); } catch { return result(e, item.revision, 'failed', stateIssue('CLOCK_INVALID')); }
        const encoded = encodeStateRecord(item.value.snapshot, time, limits);
        if (encoded.status === 'rejected') return result(e, item.revision, 'failed', encoded.issue);
        if (retainedBytes + encoded.bytes > limits.maxRetainedBytes || pending >= limits.maxPendingRequests) return result(e, item.revision, 'failed', stateIssue('CAPACITY_EXCEEDED'));
        retainedBytes += encoded.bytes;
        const completion = deferred<StateMutationResult>();
        const accepted = enqueue(e, 'mutation', () => storage!.replace(e.address, encoded.text), raw => {
            const receipt = raw as StateMutationResult;
            if (receipt.status === 'applied' && e.revision === item.revision && e.action === 'value' && !e.attemptIssue && !e.block) e.savedRevision = item.revision;
            completion.resolve(receipt);
        });
        if (!accepted) { retainedBytes -= encoded.bytes;return result(e, item.revision, 'failed', stateIssue(lifecycleIssue() === 'DISPOSED' ? 'DISPOSED' : 'CAPACITY_EXCEEDED')); }
        try {
            const receipt = await completion.promise;
            return receipt.status === 'applied' ? result(e, item.revision, 'saved') : result(e, item.revision, receipt.status === 'unknown' ? 'unknown' : 'failed', receipt.issue);
        } finally { retainedBytes -= encoded.bytes; }
    }
    function flush(): Promise<StateFlushReport> {
        if (flushPromise) return flushPromise;
        if (phase === 'disposed') return Promise.resolve(Object.freeze({ status: 'disposed', ok: false, entries: Object.freeze([]) }));
        const completion = deferred<StateFlushReport>();flushPromise = completion.promise;
        const batch: BatchItem[] = [];
        for (const e of entries.values()) {
            e.batches++;
            const item: BatchItem = { entry: e, revision: e.revision, value: keep(e.latest) };
            if (e.initialization) { item.initialization = e.initialization;item.wait = e.initialization.done.promise;e.initialization.waiter = item; }
            // release may cancel the acknowledgment wait, but cannot confer write
            // eligibility. Capture that fact now: a future binding cannot grant it
            // retroactively to this batch. A clear still reports its explicit delete.
            if (!e.initialized && !e.initialization && e.action !== 'clear') item.result = blocker(e, e.revision) ?? result(e, e.revision, 'blocked', stateIssue('INITIALIZATION_FAILED'));
            else if (e.attemptIssue) item.result = result(e, e.revision, 'failed', e.attemptIssue);
            else if (e.action === 'clear') item.clear = e.clear;
            else if (!e.initialization && !blocker(e, e.revision) && e.savedRevision === e.revision) item.result = result(e, e.revision, 'unchanged');
            batch.push(item);
        }
        Promise.resolve().then(async () => {
            const outcomes = await Promise.all(batch.map(flushItem));
            return Object.freeze({ status: 'completed' as const, ok: outcomes.every(item => item.status === 'saved' || item.status === 'unchanged'), entries: Object.freeze(outcomes) });
        }).then(report => {
            for (const item of batch) { drop(item.value);item.entry.batches--;if (item.initialization) item.initialization.waiter = undefined;evict(item.entry); }
            flushPromise = undefined;completion.resolve(report);
        });
        return completion.promise;
    }
    function dispose(): Promise<StateDisposeReport> {
        if (disposePromise) return disposePromise;
        const completion = deferred<StateDisposeReport>();
        disposePromise = completion.promise;
        if (phase !== 'disposed') {
            phase = 'disposed';
            for (const e of entries.values()) { e.active = false;if (e.initialization) cancelInitialization(e.initialization, 'DISPOSED'); }
            for (const job of queue.splice(0)) finish(job, job.kind === 'read' ? failedRead('DISPOSED') : failedMutation('DISPOSED'), false);
        }
        const oldFlush = flushPromise;
        Promise.resolve().then(async () => {
            if (oldFlush) await oldFlush;
            if (pending) await new Promise<void>(resolve => idleWaiters.push(resolve));
            const unsaved: StateFlushEntry[] = [];
            for (const e of entries.values()) {
                const blocked = blocker(e, e.revision);
                if (blocked) unsaved.push(blocked);
                else if (e.attemptIssue) unsaved.push(result(e, e.revision, 'failed', e.attemptIssue));
                else if (e.action === 'clear' && e.clear?.result?.status !== 'applied') unsaved.push(result(e, e.revision, 'failed', stateIssue('DISPOSED')));
                else if (e.action === 'value' && (e.savedRevision !== e.revision || !e.initialized)) unsaved.push(result(e, e.revision, 'failed', stateIssue('DISPOSED')));
            }
            releasePending = 1;
            let release: StateReleaseResult;
            try { release = captureStateReleaseResult(await storage!.release()); }
            catch { release = Object.freeze({ status: 'unknown', issue: stateIssue('UNKNOWN_OUTCOME') }); }
            releasePending = 0;
            if (release.status === 'released') {
                for (const e of entries.values()) { drop(e.latest);e.latest = undefined;retainedBytes -= e.addressBytes; }
                entries.clear();storage = undefined;now = undefined;
            } else disposePromise = undefined;
            return Object.freeze({ status: 'disposed' as const, unsaved: Object.freeze(unsaved), release });
        }).then(completion.resolve);
        return completion.promise;
    }
    return Object.freeze({ bind, flush, seal: () => { if (phase === 'open') phase = 'sealed';return phase; }, dispose,
        getStats: () => Object.freeze({ phase, activeBindings: [...entries.values()].filter(e => e.active).length, retainedKeys: entries.size, retainedBytes,
            queuedRequests: queue.length, activeIO, pendingRequests: pending, pendingInitializations: [...entries.values()].filter(e => e.initialization).length,
            unknownAddresses: [...entries.values()].filter(e => e.unknown).length, dirtyKeys: [...entries.values()].filter(e => e.action === 'clear' ? e.clear?.result?.status !== 'applied' : !e.initialized || e.savedRevision !== e.revision || !!e.attemptIssue || !!e.block).length,
            releasePending, ownerRetained: storage !== undefined }),
    });
}
