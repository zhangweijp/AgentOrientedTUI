import { utf8Size } from '../snapshot/json.js';
import {
    captureStateAddress, captureStateMutationResult, captureStateReadResult, captureStateReleaseResult,
    captureStateValue, decodeStateRecord, encodeStateRecord, failedMutation, failedRead,
    requireStateLimits, stateError, stateFields, stateIssue, unknownMutation, validStateOwner,
} from './state-storage.js';
import type { StateAddress, StateIssue, StateReleaseResult, StateStorage, StateValue, StateValueLimits } from './state-storage.js';

export interface StateSessionLimits extends StateValueLimits {
    readonly maxKeys: number;
    /** Address tuples and live encoded records, measured in UTF-8. */
    readonly maxRetainedBytes: number;
    readonly maxPendingRequests: number;
    readonly maxConcurrentRequests: number;
    readonly maxRevision: number;
}
export interface StateFlushEntry {
    readonly address: StateAddress;
    readonly revision: number;
    readonly status: 'saved' | 'removed' | 'failed' | 'unknown';
    readonly issue?: StateIssue;
}
export interface StateFlushReport {
    readonly status: 'completed' | 'disposed';
    readonly ok: boolean;
    readonly entries: readonly StateFlushEntry[];
}
export interface StateDisposeReport {
    readonly status: 'disposed';
    readonly unsaved: readonly StateFlushEntry[];
    readonly release: StateReleaseResult;
}
const limitNames = ['maxDepth', 'maxNodes', 'maxValueBytes', 'maxRecordBytes', 'maxAddressBytes', 'maxKeys', 'maxRetainedBytes', 'maxPendingRequests', 'maxConcurrentRequests', 'maxRevision'] as const;
type Key = { address: StateAddress; bytes: number; pending: number; active: boolean;
    latest?: StateFlushEntry; failure?: StateFlushEntry; unknown?: StateFlushEntry };
type Job = { key: Key; bytes: number } & (
    | { kind: 'load'; resolve: (value: StateValue | undefined) => void; reject: (error: Error) => void }
    | { kind: 'save' | 'remove'; revision: number; text?: string; resolve: (value: StateFlushEntry) => void }
);
const successful = (entry: StateFlushEntry) => entry.status === 'saved' || entry.status === 'removed';

/** Owns accepted operations for one instance, using its original storage port. */
export function createStateSession(options: Readonly<{ instanceId: string; storage: StateStorage; limits: StateSessionLimits; now: () => number }>) {
    const fields = stateFields(options);
    if (!fields || Object.keys(fields).length !== 4 || !fields.limits) throw stateError(stateIssue('INVALID_INPUT'));
    const limits = requireStateLimits(fields.limits.value as StateSessionLimits, limitNames);
    const instanceId: unknown = fields.instanceId?.value, port = stateFields(fields.storage?.value), clock: unknown = fields.now?.value;
    if (!validStateOwner(instanceId, limits.maxAddressBytes) || !port || port.owner?.value !== instanceId ||
        typeof clock !== 'function' || ['read', 'replace', 'remove', 'release'].some(key => typeof port[key]?.value !== 'function'))
        throw stateError(stateIssue('INVALID_INPUT'));
    let storage: StateStorage | undefined = Object.freeze({ owner: instanceId,
        read: port.read!.value.bind(fields.storage!.value), replace: port.replace!.value.bind(fields.storage!.value),
        remove: port.remove!.value.bind(fields.storage!.value), release: port.release!.value.bind(fields.storage!.value) });
    let now: (() => number) | undefined = clock as () => number;
    let phase: 'open' | 'sealed' | 'disposed' = 'open';
    let revision = 0, pending = 0, activeIO = 0, retainedBytes = 0, releasePending = 0;
    const keys = new Map<string, Key>(), queue: Job[] = [], idleWaiters: (() => void)[] = [];
    const mutations = new Map<number, Promise<StateFlushEntry>>();
    let disposal: Promise<StateDisposeReport> | undefined;

    function admit() {
        if (phase !== 'open') throw stateError(stateIssue(phase === 'sealed' ? 'SEALED' : 'DISPOSED'));
        if (pending >= limits.maxPendingRequests) throw stateError(stateIssue('CAPACITY_EXCEEDED'));
    }
    function keyFor(input: StateAddress, bytes: number): Key {
        const capture = captureStateAddress(input, limits.maxAddressBytes);
        if (capture.status === 'rejected') throw stateError(capture.issue);
        const current = keys.get(capture.identity);
        const cost = bytes + (current ? 0 : capture.bytes);
        const reclaim: string[] = [];
        let count = keys.size + (current ? 0 : 1), total = retainedBytes + cost;
        for (const [id, candidate] of keys) {
            if (count <= limits.maxKeys && total <= limits.maxRetainedBytes) break;
            // Completed successful metadata is bounded. Keep active jobs and failure evidence.
            if (candidate === current || candidate.pending || candidate.failure || candidate.unknown) continue;
            reclaim.push(id);
            count--;
            total -= candidate.bytes;
        }
        if (count > limits.maxKeys || total > limits.maxRetainedBytes) throw stateError(stateIssue('CAPACITY_EXCEEDED'));
        for (const id of reclaim) keys.delete(id);
        retainedBytes = total;
        const key = current ?? { address: capture.address, bytes: capture.bytes, pending: 0, active: false };
        keys.set(capture.identity, key);
        return key;
    }
    function enqueue(job: Job) {
        pending++;
        job.key.pending++;
        queue.push(job);
        queueMicrotask(pump);
    }
    function pump() {
        if (phase === 'disposed') return;
        for (let index = 0; index < queue.length && activeIO < limits.maxConcurrentRequests;) {
            const job = queue[index]!;
            const { key } = job;
            if (key.active) { index++; continue; }
            queue.splice(index, 1);
            if (key.unknown) {
                finish(job, job.kind === 'load' ? failedRead('UNKNOWN_OUTCOME') : failedMutation('UNKNOWN_OUTCOME'), false);
                continue;
            }
            key.active = true;
            activeIO++;
            // Adapter entry is synchronous with selecting the job. Disposal cannot overtake it.
            const failed = () => job.kind === 'load' ? failedRead('IO_FAILED') : unknownMutation();
            try {
                const request = job.kind === 'load' ? storage!.read(key.address) :
                    job.kind === 'save' ? storage!.replace(key.address, job.text!) : storage!.remove(key.address);
                void Promise.resolve(request).then(raw => finish(job, raw, true), () => finish(job, failed(), true));
            } catch { finish(job, failed(), true); }
        }
    }
    function finish(job: Job, raw: unknown, entered: boolean) {
        const { key } = job;
        retainedBytes -= job.bytes;
        pending--;
        key.pending--;
        if (entered) { key.active = false; activeIO--; }
        if (job.kind === 'load') {
            const result = captureStateReadResult(raw, limits.maxRecordBytes);
            if (result.status === 'missing') job.resolve(undefined);
            else if (result.status === 'failed') job.reject(stateError(result.issue));
            else {
                const decoded = decodeStateRecord(result.text, limits);
                if (decoded.status === 'rejected') job.reject(stateError(decoded.issue));
                else if (retainedBytes + utf8Size(result.text) + decoded.snapshot.bytes > limits.maxRetainedBytes)
                    job.reject(stateError(stateIssue('CAPACITY_EXCEEDED')));
                else job.resolve(decoded.snapshot.value);
            }
            if (!key.pending && !key.latest) {
                keys.delete(JSON.stringify([key.address.namespace, key.address.key]));
                retainedBytes -= key.bytes;
            }
        } else {
            const result = captureStateMutationResult(raw);
            const entry: StateFlushEntry = Object.freeze({ address: key.address, revision: job.revision,
                ...(result.status === 'applied' ? { status: job.kind === 'save' ? 'saved' : 'removed' } :
                    { status: result.status, issue: result.issue }) });
            if (!key.latest || key.latest.revision < entry.revision) key.latest = entry;
            if (entry.status === 'unknown') key.unknown ??= entry;
            if (entry.status === 'failed') key.failure ??= entry;
            mutations.delete(job.revision);
            job.resolve(entry);
        }
        if (!pending) for (const resolve of idleWaiters.splice(0)) resolve();
        if (phase !== 'disposed' && queue.length) queueMicrotask(pump);
    }
    async function load(address: StateAddress): Promise<StateValue | undefined> {
        admit();
        const key = keyFor(address, 0);
        return new Promise((resolve, reject) => enqueue({ kind: 'load', key, bytes: 0, resolve, reject }));
    }
    async function mutate(kind: 'save' | 'remove', address: StateAddress, value?: StateValue): Promise<void> {
        admit();
        if (revision >= limits.maxRevision) throw stateError(stateIssue('REVISION_EXHAUSTED'));
        let bytes = 0, text: string | undefined;
        if (kind === 'save') {
            const captured = captureStateValue(value, limits);
            if (captured.status === 'rejected') throw stateError(captured.issue);
            let stamp: number;
            try { stamp = now!(); } catch { throw stateError(stateIssue('CLOCK_INVALID')); }
            const record = encodeStateRecord(captured.snapshot, stamp, limits);
            if (record.status === 'rejected') throw stateError(record.issue);
            ({ bytes, text } = record);
        }
        const key = keyFor(address, bytes), version = ++revision;
        const changed = new Promise<StateFlushEntry>(resolve =>
            enqueue({ kind, key, bytes, revision: version, resolve, ...(text === undefined ? {} : { text }) }));
        mutations.set(version, changed);
        const result = await changed;
        if (result.issue) throw stateError(result.issue);
    }
    function settled(failuresOnly = false): StateFlushEntry[] {
        const reports = new Set<StateFlushEntry>();
        for (const key of keys.values()) {
            if (key.latest && !failuresOnly) reports.add(key.latest);
            if (key.failure) reports.add(key.failure);
            if (key.unknown) reports.add(key.unknown);
        }
        return [...reports];
    }
    const ordered = (entries: StateFlushEntry[]) => Object.freeze(entries.sort((left, right) => left.revision - right.revision));
    async function flush(): Promise<StateFlushReport> {
        if (phase === 'disposed') return Object.freeze({ status: 'disposed', ok: false, entries: Object.freeze([]) });
        // Capture now, including individual outcomes of every queued or active mutation.
        const entries = ordered(await Promise.all([...settled(), ...mutations.values()]));
        return Object.freeze({ status: 'completed', ok: entries.every(successful), entries });
    }
    function dispose(): Promise<StateDisposeReport> {
        if (disposal) return disposal;
        phase = 'disposed';
        for (const job of queue.splice(0)) finish(job, job.kind === 'load' ? failedRead('DISPOSED') : failedMutation('DISPOSED'), false);
        disposal = Promise.resolve().then(async () => {
            if (pending) await new Promise<void>(resolve => idleWaiters.push(resolve));
            const unsaved = ordered(settled(true));
            releasePending = 1;
            let release: StateReleaseResult;
            try { release = captureStateReleaseResult(await storage!.release()); }
            catch { release = { status: 'unknown', issue: stateIssue('UNKNOWN_OUTCOME') }; }
            releasePending = 0;
            if (release.status === 'released') {
                keys.clear();
                retainedBytes = 0;
                storage = now = undefined;
            } else disposal = undefined;
            return Object.freeze({ status: 'disposed', unsaved, release });
        });
        return disposal;
    }

    return Object.freeze({ load, save: (address: StateAddress, value: StateValue) => mutate('save', address, value),
        remove: (address: StateAddress) => mutate('remove', address), flush, dispose,
        seal: () => { if (phase === 'open') phase = 'sealed'; return phase; },
        getStats: () => Object.freeze({ phase, retainedKeys: keys.size, retainedBytes, queuedRequests: queue.length, activeIO,
            pendingRequests: pending, unknownAddresses: [...keys.values()].filter(key => key.unknown).length,
            releasePending, ownerRetained: storage !== undefined }),
    });
}
