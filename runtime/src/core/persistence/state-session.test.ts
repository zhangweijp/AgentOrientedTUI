import { describe, expect, it } from 'vitest';
import { createMemoryStateStorage } from '../../adapters/storage/memory-state-storage.js';
import { createStateSession } from './state-session.js';
import { failedMutation, stateIssue } from './state-storage.js';
import type { StateBinding, StateRecovery, StateSessionLimits } from './state-session.js';
import type { StateAddress, StateStorage, StateValue } from './state-storage.js';

const limits: StateSessionLimits = { maxKeys: 8, maxDepth: 10, maxNodes: 200, maxValueBytes: 512, maxRecordBytes: 1024, maxAddressBytes: 128, maxRetainedBytes: 8192, maxPendingOperations: 8, maxConcurrentOperations: 4, maxRevision: 1000 };
const a = (key = 'a', namespace = 'n'): StateAddress => ({ namespace, key });
const v1Record = (value: StateValue): string => JSON.stringify({ version: 1, updatedAt: 1, value })!;
const defer = <T = void>() => { let resolve!: (v: T) => void;const promise = new Promise<T>(r => { resolve = r; });return { promise, resolve }; };
function fixture(initial: { address: StateAddress; text: string }[] = [], overrides: Partial<StateStorage> = {}, custom: Partial<StateSessionLimits> = {}) {
    const backend = createMemoryStateStorage({ maxStoredKeys: 20, maxStoredBytes: 20000, maxRecordBytes: 4096, maxAddressBytes: 128, maxActiveOwners: 3, maxClaimedNamespaces: 10 }, initial);
    const opened = backend.open('app');if (opened.status !== 'opened') throw Error('fixture owner');
    const base = opened.storage, calls = { read: 0, replace: 0, remove: 0, release: 0 };
    const storage: StateStorage = { owner: 'app',
        read: async address => { calls.read++;return (overrides.read ?? base.read)(address); },
        replace: async (address, text) => { calls.replace++;return (overrides.replace ?? base.replace)(address, text); },
        remove: async address => { calls.remove++;return (overrides.remove ?? base.remove)(address); },
        release: async () => { calls.release++;return (overrides.release ?? base.release)(); },
    };
    const session = createStateSession({ instanceId: 'app', storage, limits: { ...limits, ...custom }, now: () => 17 });
    const bind = (key = 'a', value: StateValue = 0, hydrate = true, namespace = 'n'): StateBinding => {
        const result = session.bind(a(key, namespace), value, { hydrate });expect(result.status).toBe('bound');
        if (result.status !== 'bound') throw Error('fixture bind');return result.binding;
    };
    return { session, bind, base, backend, calls, storage };
}
async function confirm(binding: StateBinding, value?: StateValue) {
    const recovery = await binding.recovery;
    const confirmation = recovery.status === 'found' ? { status: 'ready' as const, value: value === undefined ? recovery.value : value } : { status: 'ready' as const };
    return { recovery, result: binding.confirmInitialization(recovery, confirmation) };
}
const unchangedOrSaved = (r: Awaited<ReturnType<ReturnType<typeof fixture>['session']['flush']>>) => r.entries.every(e => e.status === 'saved' || e.status === 'unchanged');

describe('B01 generation-scoped read-only inspect', () => {
    it('observes only existing facts without starting I/O or changing accounting', async () => {
        const f = fixture(), binding = f.bind();const before = f.session.getStats();
        expect(binding.inspect()).toMatchObject({ phase: 'open', initialized: false, dirty: true });
        for (let i = 0; i < 20; i++) binding.inspect();
        expect(f.session.getStats()).toEqual(before);expect(f.calls.read).toBe(0);
        await confirm(binding);await f.session.flush();expect(binding.inspect()).toMatchObject({ initialized: true, dirty: false });
        binding.reportUpdateFailure();expect(binding.inspect()).toMatchObject({ dirty: true, issue: { code: 'SERIALIZATION_FAILED' } });
        binding.release();const next = f.bind();await confirm(next);
        expect(binding.inspect()).toEqual({ phase: 'released', issue: stateIssue('STALE_BINDING') });
        f.session.seal();expect(next.inspect().phase).toBe('sealed');await f.session.dispose();
        expect(next.inspect()).toEqual({ phase: 'released', issue: stateIssue('DISPOSED') });
    });
    it('prioritizes unknown and integrity blocks over failed attempts and clear facts', async () => {
        const f = fixture([{ address: a(), text: '{' }]);const binding = f.bind();await confirm(binding);
        binding.reportUpdateFailure();expect(binding.inspect()).toMatchObject({ issue: { code: 'CORRUPT' } });await f.session.dispose();
        const other = fixture([], { replace: async () => ({ status: 'unknown', issue: stateIssue('UNKNOWN_OUTCOME') }) });const b = other.bind();await confirm(b);await other.session.flush();
        b.reportUpdateFailure();expect(b.inspect()).toMatchObject({ issue: { code: 'UNKNOWN_OUTCOME' } });await other.session.dispose();
    });
});

describe('state session identity, initialization and capture (A02–A07)', () => {
    it('rejects invalid configuration and identities before I/O, including getters', () => {
        const f = fixture();let getters = 0;
        for (const invalid of [0, -1, Infinity, NaN, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
            for (const name of Object.keys(limits)) expect(() => createStateSession({ instanceId: 'app', storage: f.storage, limits: { ...limits, [name]: invalid }, now: () => 1 })).toThrow('INVALID_INPUT');
        }
        for (const instanceId of ['', 'other', 'x'.repeat(200)]) expect(() => createStateSession({ instanceId, storage: f.storage, limits, now: () => 1 })).toThrow('INVALID_INPUT');
        const accessor = { ...f.storage };Object.defineProperty(accessor, 'owner', { enumerable: true, get() { getters++;return 'app'; } });
        expect(() => createStateSession({ instanceId: 'app', storage: accessor, limits, now: () => 1 })).toThrow('INVALID_INPUT');
        expect(getters).toBe(0);expect(f.calls).toEqual({ read: 0, replace: 0, remove: 0, release: 0 });
    });
    it('keeps exact tuple identity, captures addresses and copies caller values', async () => {
        const f = fixture(), original = { nested: [1] }, addr = a('c', 'a:b');
        const one = f.session.bind(addr, original, { hydrate: true });if (one.status !== 'bound') throw Error('bind');
        addr.namespace = 'changed';original.nested.push(2);expect(Object.isFrozen(original)).toBe(false);
        const two = f.bind('b:c', 2, true, 'a');await confirm(one.binding);await confirm(two);
        expect((await f.session.flush()).ok).toBe(true);
        expect(await f.base.read(a('c', 'a:b'))).toMatchObject({ status: 'found', text: expect.stringContaining('"value":{"nested":[1]}') });
        expect(await f.base.read(a('b:c', 'a'))).toMatchObject({ status: 'found', text: expect.stringContaining('"value":2') });
        const update = { nested: [3] };one.binding.update(update);update.nested.push(4);await f.session.flush();
        expect(await f.base.read(a('c', 'a:b'))).toMatchObject({ text: expect.stringContaining('"nested":[3]') });
        await f.session.dispose();
    });
    it.each(['{', '{"value":{"value":1}}', '{"version":2,"updatedAt":1,"value":0}', '{"version":2,"updatedAt":1,"value":0,"extra":1}', '{"version":1,"updatedAt":1,"value":0,"extra":1}', '{"version":1,"updatedAt":null,"value":0}', ' '.repeat(1025)])('blocks invalid record %s without automatic mutation', async text => {
        const f = fixture([{ address: a(), text }]), binding = f.bind();const { recovery } = await confirm(binding);
        expect(recovery.status).toBe('blocked');expect((await f.session.flush()).entries[0]?.status).toBe('blocked');
        expect(f.calls.replace).toBe(0);expect(f.calls.remove).toBe(0);await f.session.dispose();
    });
    it.each(['{"version":1,"updatedAt":1,"value":{"version":2,"updatedAt":2,"value":{"value":1}}}'])('preserves one-layer business values on restart: %s', async text => {
        const f = fixture([{ address: a(), text }]), b = f.bind();const { recovery } = await confirm(b);
        expect(recovery.status).toBe('found');expect((await f.session.flush()).entries[0]?.status).toBe('unchanged');expect(f.calls.replace).toBe(0);
        await f.session.dispose();const next = f.backend.open('next');if (next.status !== 'opened') throw Error('open');expect(await next.storage.read(a())).toEqual({ status: 'found', text });await next.storage.release();
    });
    it('waits for explicit ack after read ended; rejects fabricated, cross-address and stale receipts', async () => {
        const f = fixture(), b = f.bind(), c = f.bind('b');const recovery = await b.recovery, other = await c.recovery;
        expect(f.session.getStats()).toMatchObject({ activeIO: 0, pendingInitializations: 2 });
        let ended = false;const flush = f.session.flush().then(r => { ended = true;return r; });await Promise.resolve();expect(ended).toBe(false);
        expect(b.confirmInitialization({ ...recovery } as StateRecovery, { status: 'ready' }).status).toBe('rejected');
        expect(b.confirmInitialization(other, { status: 'ready' }).status).toBe('rejected');
        expect(b.confirmInitialization(recovery, { status: 'ready', value: 99 }).status).toBe('rejected');
        expect(f.calls.replace).toBe(0);expect(b.confirmInitialization(recovery, { status: 'ready' }).status).toBe('accepted');
        expect(c.confirmInitialization(other, { status: 'failed' }).status).toBe('rejected');
        const report = await flush;expect(report.ok).toBe(false);expect(report.entries.map(e => e.status)).toEqual(['saved', 'blocked']);
        expect(f.session.getStats().pendingInitializations).toBe(0);expect(b.confirmInitialization(recovery, { status: 'ready' }).status).toBe('rejected');await f.session.dispose();
    });
    it('holds flush while read is pending and preserves update made during recovery', async () => {
        const started = defer(), gate = defer();const f = fixture([], { read: async () => { started.resolve();await gate.promise;return { status: 'found', text: v1Record(1) }; } });
        const b = f.bind();await started.promise;b.update(2);const flush = f.session.flush();gate.resolve();const recovery = await b.recovery;
        expect(f.session.getStats()).toMatchObject({ pendingInitializations: 1, activeIO: 0 });expect(recovery).toMatchObject({ status: 'found', value: 1 });
        b.confirmInitialization(recovery, { status: 'ready', value: 1 });expect((await flush).ok).toBe(true);
        expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":2') });await f.session.dispose();
    });
    it('read failure blocks a concurrent update; explicit clear then update recovers', async () => {
        const started = defer(), gate = defer();const f = fixture([], { read: async () => { started.resolve();await gate.promise;throw Error('SENTINEL raw cause'); } });
        const b = f.bind();await started.promise;b.update(3);gate.resolve();await confirm(b);expect((await f.session.flush()).ok).toBe(false);expect(f.calls.replace).toBe(0);
        expect(await b.clear()).toEqual({ status: 'applied' });b.update(4);expect((await f.session.flush()).ok).toBe(true);await f.session.dispose();
    });
    it('late old read and ack cannot alter a replacement generation', async () => {
        const started = defer(), gate = defer();let reads = 0;
        const f = fixture([], { read: async () => { if (++reads === 1) { started.resolve();await gate.promise;return { status: 'found', text: v1Record(111) }; }return { status: 'missing' }; } });
        const old = f.bind();await started.promise;expect(old.release()).toBe(true);const next = f.bind('a', 22);gate.resolve();
        const stale = await old.recovery;expect(stale.status).toBe('blocked');expect(old.confirmInitialization(stale, { status: 'ready' }).status).toBe('rejected');
        await confirm(next);await f.session.flush();expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":22') });await f.session.dispose();
    });
    it('hydrate=false resets only after ack, and still rejects corrupt records', async () => {
        const f = fixture([{ address: a(), text: v1Record(99) }]), b = f.bind('a', 7, false), recovery = await b.recovery;
        const flush = f.session.flush();expect(f.calls.replace).toBe(0);expect(b.confirmInitialization(recovery, { status: 'ready' }).status).toBe('accepted');await flush;
        expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":7') });await f.session.dispose();
        const bad = fixture([{ address: a(), text: '{' }]), bb = bad.bind('a', 7, false);await confirm(bb);expect((await bad.session.flush()).ok).toBe(false);expect(bad.calls.replace).toBe(0);await bad.session.dispose();
    });
});

describe('flush revisions, clear, failure and ownership (A08–A13)', () => {
    it('shares the exact in-flight Promise, including adapter reentry, and captures a finite set', async () => {
        const started = defer(), gate = defer();let reentrant: Promise<unknown> | undefined;
        const f = fixture([], { replace: async (address, text) => { reentrant = f.session.flush();started.resolve();await gate.promise;return f.base.replace(address, text); } });
        const b = f.bind();await confirm(b);const first = f.session.flush();expect(f.session.flush()).toBe(first);await started.promise;expect(reentrant).toBe(first);
        const late = f.bind('late');await confirm(late);gate.resolve();const report = await first;expect(report.entries).toHaveLength(1);expect(f.session.getStats().dirtyKeys).toBe(1);
        await f.session.flush();expect(f.calls.replace).toBe(2);await f.session.dispose();
        const empty = fixture();expect(await empty.session.flush()).toEqual({ status: 'completed', ok: true, entries: [] });await empty.session.dispose();
    });
    it('does not mark rev2 clean when held rev1 completes', async () => {
        const started = defer(), gate = defer();let writes = 0;
        const f = fixture([], { replace: async (address, text) => { if (++writes === 1) { started.resolve();await gate.promise; }return f.base.replace(address, text); } });
        const b = f.bind('a', 1);await confirm(b);const one = f.session.flush();await started.promise;const update = b.update(2);expect(update.status).toBe('accepted');
        gate.resolve();const oldReport = await one;expect(oldReport.entries[0]).toMatchObject({ revision: 1, status: 'saved' });expect(f.session.getStats().dirtyKeys).toBe(1);
        const next = await f.session.flush();expect(next.entries[0]).toMatchObject({ revision: 2, status: 'saved' });expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":2') });expect(oldReport.entries[0]?.revision).toBe(1);await f.session.dispose();
    });
    it('orders held write, clear, new update and next flush with explicit barriers', async () => {
        const writeStarted = defer(), writeGate = defer(), removeStarted = defer(), removeGate = defer(), order: string[] = [];
        const f = fixture([], { replace: async (address, text) => { order.push('write-start');if (f.calls.replace === 1) { writeStarted.resolve();await writeGate.promise; }const r = await f.base.replace(address, text);order.push('write-end');return r; }, remove: async address => { order.push('remove-start');removeStarted.resolve();await removeGate.promise;const r = await f.base.remove(address);order.push('remove-end');return r; } });
        const b = f.bind('a', 1);await confirm(b);const saving = f.session.flush();await writeStarted.promise;const clearing = b.clear();b.update(2);expect(f.calls.remove).toBe(0);
        writeGate.resolve();await removeStarted.promise;await saving;expect(f.session.getStats().dirtyKeys).toBe(1);const final = f.session.flush();expect(f.calls.replace).toBe(1);
        removeGate.resolve();expect(await clearing).toEqual({ status: 'applied' });expect((await final).ok).toBe(true);expect(order).toEqual(['write-start', 'write-end', 'remove-start', 'remove-end', 'write-start', 'write-end']);
        expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":2') });await f.session.dispose();
    });
    it('clear suppresses old values, including flush then clear in the same event', async () => {
        const f = fixture(), b = f.bind('a', 1);await confirm(b);
        const pending = f.session.flush(), clear = b.clear();expect(await clear).toEqual({ status: 'applied' });expect((await pending).ok).toBe(true);
        const writes = f.calls.replace;expect(unchangedOrSaved(await f.session.flush())).toBe(true);expect(f.calls.replace).toBe(writes);expect(await f.base.read(a())).toEqual({ status: 'missing' });
        b.release();const rebinding = f.bind('a', 77);await confirm(rebinding);await f.session.flush();expect(await f.base.read(a())).toEqual({ status: 'missing' });
        rebinding.update(3);await f.session.flush();expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":3') });await f.session.dispose();
    });
    it('reports failed remove and does not re-create the old value as a fake successful clear', async () => {
        const f = fixture([], { remove: async () => failedMutation('PERMISSION_DENIED') }), b = f.bind('a', 1);await confirm(b);await f.session.flush();
        expect(await b.clear()).toMatchObject({ status: 'failed', effects: 'none' });expect((await f.session.flush()).entries[0]).toMatchObject({ status: 'failed', issue: { code: 'PERMISSION_DENIED' } });expect(f.calls.replace).toBe(1);
        b.update(2);expect((await f.session.flush()).ok).toBe(true);await f.session.dispose();
    });
    it('retains partial saved / failed-none / unknown results and prevents unknown retries', async () => {
        const f = fixture([], { replace: async (address, text) => address.key === 'b' ? failedMutation('PERMISSION_DENIED') : address.key === 'c' ? { status: 'unknown', issue: stateIssue('UNKNOWN_OUTCOME') } : f.base.replace(address, text) });
        const bindings = ['a', 'b', 'c'].map(k => f.bind(k));await Promise.all(bindings.map(b => confirm(b)));const report = await f.session.flush();
        expect(report.ok).toBe(false);expect(report.entries.map(e => e.status)).toEqual(['saved', 'failed', 'unknown']);expect(Object.isFrozen(report.entries)).toBe(true);
        bindings[0]!.update(1);bindings[2]!.update(2);expect(await bindings[2]!.clear()).toMatchObject({ status: 'unknown' });const next = await f.session.flush();expect(next.entries.map(e => e.status)).toEqual(['saved', 'failed', 'unknown']);expect(f.calls.replace).toBe(5);expect(f.calls.remove).toBe(0);
        expect(report.entries.map(e => e.status)).toEqual(['saved', 'failed', 'unknown']);await f.session.dispose();
    });
    it.each(['throw', 'invalid', 'unproved'])('classifies %s mutation as unknown', async kind => {
        const f = fixture([], { replace: async () => { if (kind === 'throw') throw Error('SENTINEL');if (kind === 'unproved') return { status: 'failed', issue: stateIssue('IO_FAILED') } as any;return undefined as any; } }), b = f.bind();await confirm(b);
        expect((await f.session.flush()).entries[0]?.status).toBe('unknown');await f.session.flush();expect(f.calls.replace).toBe(1);expect(f.session.getStats().unknownAddresses).toBe(1);await f.session.dispose();
    });
    it('records capture and external serializer failures instead of saving an old value', async () => {
        const f = fixture(), b = f.bind('a', 1);await confirm(b);expect(b.reportUpdateFailure()).toMatchObject({ status: 'rejected', issue: { code: 'SERIALIZATION_FAILED' } });
        expect((await f.session.flush()).entries[0]).toMatchObject({ revision: 2, status: 'failed' });expect(f.calls.replace).toBe(0);
        expect(b.update({ bad: undefined } as any).status).toBe('rejected');expect((await f.session.flush()).entries[0]).toMatchObject({ revision: 3, status: 'failed' });expect(f.calls.replace).toBe(0);
        expect(b.update(4).status).toBe('accepted');expect((await f.session.flush()).ok).toBe(true);await f.session.dispose();
    });
    it('uses generation-safe handles and retains unsaved snapshots through unmount/rebind', async () => {
        const f = fixture(), old = f.bind('a', 1);await confirm(old);old.update(5);
        expect(f.session.bind(a(), 2, { hydrate: true })).toMatchObject({ status: 'rejected', issue: { code: 'OWNER_BUSY' } });expect(old.release()).toBe(true);
        expect(f.session.getStats()).toMatchObject({ activeBindings: 0, retainedKeys: 1, dirtyKeys: 1 });const next = f.bind('a', 999);const { recovery } = await confirm(next);expect(recovery).toMatchObject({ status: 'found', source: 'session', value: 5 });
        expect(old.release()).toBe(false);expect(old.update(99).status).toBe('rejected');expect(old.reportUpdateFailure().status).toBe('rejected');expect(await old.clear()).toMatchObject({ status: 'failed' });
        await f.session.flush();expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":5') });expect(next.release()).toBe(true);expect(f.session.getStats()).toMatchObject({ retainedKeys: 0, retainedBytes: 0 });await f.session.dispose();
    });
});

describe('seal, disposal and bounded resources (A12, A14–A17)', () => {
    it.each([true, false].flatMap(previousConfirmed => [true, false].flatMap(hydrate => [true, false].map(laterUpdate => ({ previousConfirmed, hydrate, laterUpdate })))))('F04: session baseline and current normalization are generation-local: %j', async ({ previousConfirmed, hydrate, laterUpdate }) => {
        const entered = defer(), gate = defer();let reads = 0;const f = fixture([{ address: a(), text: v1Record(1) }], { read: async () => { if (++reads === 1 && !previousConfirmed) { entered.resolve();await gate.promise; }return { status: 'found', text: v1Record(1) }; } });
        const old = f.bind();if (previousConfirmed) await confirm(old);else await entered.promise;
        old.update(7);old.release();const next = f.bind('a', 9, hydrate);gate.resolve();const recovery = await next.recovery;
        expect(recovery).toMatchObject({ status: 'found', source: 'session', value: 7 });expect(reads).toBe(previousConfirmed ? 1 : 2);
        if (laterUpdate) next.update(8);const confirmation = next.confirmInitialization(recovery, { status: 'ready', value: 70 });expect(confirmation).toMatchObject({ status: 'accepted', revision: 3 });
        expect((await f.session.flush()).ok).toBe(true);expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":' + (laterUpdate ? 8 : 70)) });await f.session.dispose();
    });
    it('F04: an old write cannot clean a newly normalized binding with a distinct revision', async () => {
        const entered = defer(), gate = defer();const f = fixture([], { replace: async (address, text) => { if (f.calls.replace === 1) { entered.resolve();await gate.promise; }return f.base.replace(address, text); } });
        const old = f.bind();await confirm(old);old.update(7);const saving = f.session.flush();await entered.promise;old.release();const next = f.bind(), r = await next.recovery;
        expect(r).toMatchObject({ status: 'found', source: 'session', value: 7 });expect(next.confirmInitialization(r, { status: 'ready', value: 70 })).toMatchObject({ status: 'accepted', revision: 3 });gate.resolve();
        expect((await saving).entries[0]).toMatchObject({ revision: 2, status: 'saved' });expect(f.session.getStats().dirtyKeys).toBe(1);expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":7') });
        expect((await f.session.flush()).entries[0]).toMatchObject({ revision: 3, status: 'saved' });expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":70') });await f.session.dispose();
    });
    it.each(['{BROKEN', '{"version":2,"updatedAt":1,"value":0}'])('F04: unconfirmed pending values cannot bypass integrity check: %s', async text => {
        const entered = defer(), gate = defer();let reads = 0;const f = fixture([], { read: async () => { if (++reads === 1) { entered.resolve();await gate.promise;return { status: 'missing' }; }return { status: 'found', text }; } });
        const old = f.bind();await entered.promise;old.update(7);old.release();const next = f.bind();gate.resolve();const r = await next.recovery;expect(r.status).toBe('blocked');next.confirmInitialization(r, { status: 'failed' });
        expect((await f.session.flush()).ok).toBe(false);expect(f.calls.replace).toBe(0);expect(await next.clear()).toEqual({ status: 'applied' });next.update(8);expect((await f.session.flush()).ok).toBe(true);await f.session.dispose();
    });
    it('F04: remount normalization can complete after seal; clear during init still suppresses it', async () => {
        const f = fixture(), old = f.bind();await confirm(old);old.update(7);old.release();const next = f.bind(), r = await next.recovery;f.session.seal();
        expect(next.confirmInitialization(r, { status: 'ready', value: 70 }).status).toBe('accepted');expect((await f.session.flush()).ok).toBe(true);expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":70') });await f.session.dispose();
        const g = fixture(), first = g.bind();await confirm(first);first.update(7);first.release();const last = g.bind(), recovery = await last.recovery;await last.clear();expect(last.confirmInitialization(recovery, { status: 'ready', value: 70 }).status).toBe('accepted');
        expect((await g.session.flush()).ok).toBe(true);expect(await g.base.read(a())).toEqual({ status: 'missing' });expect(g.calls.replace).toBe(0);await g.session.dispose();
    });
    it.each(['applied', 'failed'])('F04: a clear admitted before rebind resolves %s before recovery chooses a baseline', async outcome => {
        const entered = defer(), gate = defer();const f = fixture([{ address: a(), text: v1Record(1) }], { remove: async address => { entered.resolve();await gate.promise;return outcome === 'applied' ? f.base.remove(address) : failedMutation('PERMISSION_DENIED'); } });
        const old = f.bind();await confirm(old);old.update(7);const clearing = old.clear();await entered.promise;old.release();const next = f.bind();gate.resolve();await clearing;const r = await next.recovery;
        if (outcome === 'applied') { expect(r.status).toBe('missing');next.confirmInitialization(r, { status: 'ready' });expect((await f.session.flush()).ok).toBe(true);expect(await f.base.read(a())).toEqual({ status: 'missing' });expect(f.calls.replace).toBe(0); }
        else { expect(r).toMatchObject({ status: 'found', source: 'session', value: 7 });next.confirmInitialization(r, { status: 'ready', value: 70 });expect((await f.session.flush()).ok).toBe(true);expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":70') }); }
        await f.session.dispose();
    });
    it('F04: a failed post-clear update does not make a pre-clear snapshot recoverable again', async () => {
        const entered = defer(), gate = defer();const f = fixture([{ address: a(), text: v1Record(1) }], { remove: async address => { entered.resolve();await gate.promise;return f.base.remove(address); } });
        const old = f.bind();await confirm(old);old.update(7);const clearing = old.clear();await entered.promise;old.reportUpdateFailure();gate.resolve();await clearing;old.release();const next = f.bind('a', 9), r = await next.recovery;
        expect(r.status).toBe('missing');next.confirmInitialization(r, { status: 'ready' });expect((await f.session.flush()).ok).toBe(false);expect(f.calls.replace).toBe(0);next.update(8);expect((await f.session.flush()).ok).toBe(true);await f.session.dispose();
    });
    it.each(['read', 'replace', 'remove'].flatMap(operation => [0, 1, 2, 3, 4, 5].map(microtasks => ({ operation, microtasks }))))('F03: actual entry and disposal linearize: %j', async ({ operation, microtasks }) => {
        const gate = defer<any>();const f = fixture([], { [operation]: async () => gate.promise });
        const b = f.bind();let mutation: Promise<unknown>;
        if (operation === 'read') mutation = b.recovery;
        else { await confirm(b);mutation = operation === 'replace' ? f.session.flush() : b.clear(); }
        for (let tick = 0; tick < microtasks; tick++) await Promise.resolve();
        const before = f.calls[operation as 'read' | 'replace' | 'remove'], disposal = f.session.dispose();
        expect(f.session.getStats().activeIO).toBe(before);
        if (before) { expect(f.calls.release).toBe(0);expect(f.session.getStats().ownerRetained).toBe(true); }
        for (let tick = 0; tick < 6; tick++) await Promise.resolve();
        expect(f.calls[operation as 'read' | 'replace' | 'remove']).toBe(before);if (before) expect(f.calls.release).toBe(0);
        gate.resolve(operation === 'read' ? { status: 'missing' } : { status: 'applied' });await mutation;const report = await disposal;
        expect(report.release.status).toBe('released');expect(f.calls[operation as 'read' | 'replace' | 'remove']).toBe(before);expect(f.calls.release).toBe(1);
        expect(f.session.getStats()).toMatchObject({ retainedKeys: 0, retainedBytes: 0, activeIO: 0, pendingOperations: 0, pendingInitializations: 0, ownerRetained: false });
    });
    it('F03: already-entered adapter may dispose reentrantly and is still tracked to actual completion', async () => {
        const entered = defer(), gate = defer();let disposing: ReturnType<ReturnType<typeof fixture>['session']['dispose']> | undefined;
        const f = fixture([], { replace: async (address, text) => { disposing = f.session.dispose();entered.resolve();await gate.promise;return f.base.replace(address, text); } });
        const b = f.bind();await confirm(b);const saving = f.session.flush();await entered.promise;expect(f.session.getStats()).toMatchObject({ phase: 'disposed', activeIO: 1, ownerRetained: true });expect(f.calls.release).toBe(0);
        gate.resolve();expect((await saving).entries[0]?.status).toBe('saved');expect((await disposing!).release.status).toBe('released');expect(f.session.getStats().retainedBytes).toBe(0);
    });
    it.each([1, 2])('F02: a pending clean batch retains its key/address under maxKeys=%s', async maxKeys => {
        const firstAddress = a('a'.repeat(40)), secondAddress = a('b'.repeat(40)), addressBytes = new TextEncoder().encode(JSON.stringify(['n', firstAddress.key])).length;
        expect(addressBytes).toBe(48);const f = fixture([{ address: firstAddress, text: v1Record(0) }], {}, { maxKeys, maxRetainedBytes: 96 });
        const b = f.bind(firstAddress.key);await confirm(b);let settled = false;const saving = f.session.flush();saving.then(() => { settled = true; });b.release();
        expect(settled).toBe(false);expect(f.session.getStats()).toMatchObject({ retainedKeys: 1, retainedBytes: addressBytes + 1 });
        expect(f.session.bind(secondAddress, 0, { hydrate: true })).toMatchObject({ status: 'rejected', issue: { code: 'CAPACITY_EXCEEDED' } });
        expect(f.session.getStats()).toMatchObject({ retainedKeys: 1, retainedBytes: addressBytes + 1 });expect((await saving).entries[0]).toMatchObject({ address: firstAddress, status: 'unchanged' });
        expect(f.session.getStats()).toMatchObject({ retainedKeys: 0, retainedBytes: 0 });const next = f.bind(secondAddress.key);await confirm(next);await f.session.dispose();
    });
    it('F02: inactive dirty write stays retained between adapter completion and batch completion', async () => {
        const entered = defer(), receipt = defer<{ status: 'applied' }>();const f = fixture([], { replace: async () => { entered.resolve();return receipt.promise; } }, { maxKeys: 1 });
        const b = f.bind();await confirm(b);b.release();let settled = false;const saving = f.session.flush();saving.then(() => { settled = true; });await entered.promise;receipt.resolve({ status: 'applied' });
        for (let tick = 0; tick < 32 && f.session.getStats().activeIO !== 0; tick++) await Promise.resolve();
        expect(f.session.getStats().activeIO).toBe(0);expect(settled).toBe(false);expect(f.session.getStats().retainedKeys).toBe(1);
        expect(f.session.bind(a('b'), 0, { hydrate: true }).status).toBe('rejected');expect((await saving).ok).toBe(true);expect(f.session.getStats()).toMatchObject({ retainedKeys: 0, retainedBytes: 0 });
        const next = f.bind('b');await confirm(next);await f.session.dispose();
    });
    it('F02: same-key rebind shares the retained address and keeps already clean data clean', async () => {
        const f = fixture([{ address: a(), text: v1Record(0) }], {}, { maxKeys: 1 }), old = f.bind();await confirm(old);const saving = f.session.flush();old.release();
        const next = f.bind();expect(next.generation).not.toBe(old.generation);const r = await next.recovery;expect(r).toMatchObject({ status: 'found', source: 'session', value: 0 });next.confirmInitialization(r, { status: 'ready', value: 0 });
        expect(old.release()).toBe(false);expect((await saving).ok).toBe(true);expect((await f.session.flush()).entries[0]?.status).toBe('unchanged');expect(f.calls.replace).toBe(0);next.release();expect(f.session.getStats()).toMatchObject({ retainedKeys: 0, retainedBytes: 0 });await f.session.dispose();
    });
    it('F02: clear tombstone retains only its address after batch release, then dispose frees it', async () => {
        const entered = defer(), gate = defer();const f = fixture([{ address: a(), text: v1Record(0) }], { remove: async address => { entered.resolve();await gate.promise;return f.base.remove(address); } });
        const b = f.bind();await confirm(b);const saving = f.session.flush(), clearing = b.clear();b.release();await entered.promise;expect(f.session.getStats().retainedKeys).toBe(1);gate.resolve();await clearing;await saving;
        expect(f.session.getStats()).toMatchObject({ retainedKeys: 1, retainedBytes: new TextEncoder().encode(JSON.stringify(['n', 'a'])).length });expect(f.calls.replace).toBe(0);
        const final = f.session.flush(), disposal = f.session.dispose();await final;await disposal;expect(f.session.getStats()).toMatchObject({ retainedKeys: 0, retainedBytes: 0, pendingOperations: 0 });
    });
    it.each(['read-pending', 'ack-pending'].flatMap(phase => [true, false].flatMap(hydrate => [true, false].flatMap(update => [true, false].map(beforeRelease => ({ phase, hydrate, update, beforeRelease }))))))('F01: release cannot confer eligibility: %j', async ({ phase, hydrate, update, beforeRelease }) => {
        const entered = defer(), gate = defer();const original = phase === 'read-pending' ? '{BROKEN' : '{"version":1,"updatedAt":1,"value":{"original":7}}';
        const f = fixture([{ address: a(), text: original }], { read: async () => { entered.resolve();if (phase === 'read-pending') await gate.promise;return { status: 'found', text: original }; } });
        const b = f.bind('a', { initial: true }, hydrate);await entered.promise;if (phase === 'ack-pending') await b.recovery;
        if (update) expect(b.update({ explicit: true }).status).toBe('accepted');
        const old = beforeRelease ? f.session.flush() : undefined;expect(b.release()).toBe(true);const saving = old ?? f.session.flush();gate.resolve();const report = await saving;
        expect(report.ok).toBe(false);expect(report.entries[0]?.status).toBe('blocked');expect(f.calls.replace).toBe(0);expect(f.calls.remove).toBe(0);expect(await f.base.read(a())).toEqual({ status: 'found', text: original });
        expect(f.session.getStats().pendingInitializations).toBe(0);await f.session.dispose();
    });
    it.each([true, false])('F01: a new confirmed binding never grants an old batch eligibility (hydrate=%s)', async hydrate => {
        const f = fixture([{ address: a(), text: v1Record(1) }]), old = f.bind('a', 99);await old.recovery;old.release();const saving = f.session.flush();
        const next = f.bind('a', 2, hydrate), r = await next.recovery;
        expect(next.confirmInitialization(r, hydrate ? { status: 'ready', value: 1 } : { status: 'ready' }).status).toBe('accepted');
        const report = await saving;expect(report.entries[0]).toMatchObject({ revision: 1, status: 'blocked' });expect(f.calls.replace).toBe(0);
        expect((await f.session.flush()).ok).toBe(true);expect(f.calls.replace).toBe(hydrate ? 0 : 1);
        next.update(3);await f.session.flush();expect(await f.base.read(a())).toMatchObject({ text: expect.stringContaining('"value":3') });expect(report.entries[0]?.status).toBe('blocked');await f.session.dispose();
    });
    it('F01: sealed unconfirmed release stays blocked; explicit clear and legitimate rebind remain usable', async () => {
        const f = fixture([{ address: a(), text: '{BROKEN' }]), old = f.bind();await old.recovery;old.release();const blocked = await f.session.flush();expect(blocked.ok).toBe(false);
        const next = f.bind(), r = await next.recovery;expect(r.status).toBe('blocked');next.confirmInitialization(r, { status: 'failed' });expect(await next.clear()).toEqual({ status: 'applied' });
        next.update(7);f.session.seal();expect((await f.session.flush()).ok).toBe(true);next.release();expect((await f.session.flush()).ok).toBe(true);await f.session.dispose();
        const sealed = fixture(), binding = sealed.bind();await binding.recovery;sealed.session.seal();binding.release();expect((await sealed.session.flush()).ok).toBe(false);expect(sealed.calls.replace).toBe(0);expect((await sealed.session.dispose()).unsaved).toHaveLength(1);
    });
    it('seal accepts only the original initialization and requires a later flush for newer revisions', async () => {
        const started = defer(), gate = defer();const f = fixture([], { replace: async (address, text) => { if (f.calls.replace === 1) { started.resolve();await gate.promise; }return f.base.replace(address, text); } });
        const b = f.bind('a', 1), recovery = await b.recovery;const first = f.session.flush();
        b.update(2);expect(f.session.seal()).toBe('sealed');expect(f.session.bind(a('new'), 0, { hydrate: true }).status).toBe('rejected');expect(b.update(3).status).toBe('rejected');expect(b.reportUpdateFailure().status).toBe('rejected');expect(await b.clear()).toMatchObject({ status: 'failed', issue: { code: 'SEALED' } });
        expect(b.confirmInitialization({ ...recovery } as StateRecovery, { status: 'ready' }).status).toBe('rejected');expect(b.confirmInitialization(recovery, { status: 'ready' }).status).toBe('accepted');
        await started.promise;expect(f.session.flush()).toBe(first);gate.resolve();const report = await first;expect(report.entries[0]?.revision).toBe(1);expect(f.session.getStats().dirtyKeys).toBe(1);
        expect((await f.session.flush()).entries[0]).toMatchObject({ revision: 2, status: 'saved' });await f.session.dispose();
    });
    it('dispose invalidates immediately, cancels queued work, waits for active I/O and shares completion', async () => {
        const started = defer(), gate = defer();const f = fixture([], { replace: async (address, text) => { started.resolve();await gate.promise;return f.base.replace(address, text); } }, { maxConcurrentOperations: 1 });
        const one = f.bind('a', 1), two = f.bind('b', 2);await Promise.all([confirm(one), confirm(two)]);const saving = f.session.flush();await started.promise;
        expect(f.session.getStats()).toMatchObject({ activeIO: 1, queuedOperations: 1 });const disposal = f.session.dispose();expect(f.session.dispose()).toBe(disposal);expect(one.update(3).status).toBe('rejected');expect(one.release()).toBe(false);
        expect(f.session.getStats()).toMatchObject({ activeBindings: 0, activeIO: 1, ownerRetained: true });expect(f.calls.release).toBe(0);expect(f.backend.open('app').status).toBe('rejected');
        gate.resolve();expect((await saving).ok).toBe(false);const report = await disposal;expect(report.release.status).toBe('released');expect(report.unsaved.map(e => e.address.key)).toEqual(['b']);expect(f.calls.replace).toBe(1);
        expect(f.session.getStats()).toMatchObject({ retainedKeys: 0, retainedBytes: 0, pendingInitializations: 0, activeIO: 0, queuedOperations: 0, releasePending: 0, ownerRetained: false });
    });
    it('dispose cancels unacknowledged initialization without pretending to flush', async () => {
        const f = fixture(), b = f.bind(), r = await b.recovery;expect(f.session.getStats().pendingInitializations).toBe(1);const disposal = f.session.dispose();expect(b.confirmInitialization(r, { status: 'ready' }).status).toBe('rejected');
        expect((await disposal).unsaved).toHaveLength(1);expect(f.calls.replace).toBe(0);expect(f.session.getStats().retainedBytes).toBe(0);
    });
    it('unknown background work keeps owner/namespace until the backend really releases', async () => {
        const background = defer(), releaseEntered = defer();const f = fixture([], { replace: async address => { await f.base.read(address);return { status: 'unknown', issue: stateIssue('UNKNOWN_OUTCOME') }; }, release: async () => { releaseEntered.resolve();await background.promise;return f.base.release(); } });
        const b = f.bind();await confirm(b);const original = await f.session.flush();expect(original.entries[0]?.status).toBe('unknown');const disposal = f.session.dispose();await releaseEntered.promise;
        expect(f.session.getStats()).toMatchObject({ releasePending: 1, ownerRetained: true, unknownAddresses: 1 });expect(f.backend.open('app').status).toBe('rejected');
        const competitor = f.backend.open('next');if (competitor.status !== 'opened') throw Error('open');expect(await competitor.storage.read(a())).toMatchObject({ status: 'failed', issue: { code: 'NAMESPACE_BUSY' } });
        await f.base.replace(a(), '42');background.resolve();expect((await disposal).release.status).toBe('released');expect(await competitor.storage.read(a())).toEqual({ status: 'found', text: '42' });expect(original.entries[0]?.status).toBe('unknown');await competitor.storage.release();
    });
    it.each(['failed', 'unknown', 'throw', 'invalid'])('retains ownership diagnostics after release %s', async status => {
        const f = fixture([], { release: async () => { if (status === 'throw') throw Error('SENTINEL');if (status === 'invalid') return undefined as any;return { status, issue: stateIssue('IO_FAILED') } as any; } });
        f.bind();const report = await f.session.dispose();expect(report.release.status).toBe(status === 'failed' ? 'failed' : 'unknown');expect(f.session.getStats().ownerRetained).toBe(true);expect(f.session.getStats().retainedKeys).toBe(1);expect(JSON.stringify(report)).not.toContain('SENTINEL');
    });
    it('counts old in-flight versions and encoded buffers; rejects cumulative overflow without losing old data', async () => {
        const started = defer(), gate = defer();const f = fixture([], { replace: async (address, text) => { started.resolve();await gate.promise;return f.base.replace(address, text); } }, { maxRetainedBytes: 62 });
        const b = f.bind('a', 0);await confirm(b);const before = f.session.getStats().retainedBytes;const pending = f.session.flush();await started.promise;
        const recordBytes = new TextEncoder().encode('{"updatedAt":17,"value":0,"version":1}').length;expect(f.session.getStats().retainedBytes).toBe(before + recordBytes);
        expect(b.update('x'.repeat(20))).toMatchObject({ status: 'rejected', issue: { code: 'CAPACITY_EXCEEDED' } });expect(f.session.getStats().retainedBytes).toBe(before + recordBytes);
        gate.resolve();expect((await pending).entries[0]?.status).toBe('saved');expect(f.session.getStats().dirtyKeys).toBe(1);expect((await f.session.flush()).entries[0]?.status).toBe('failed');expect(f.calls.replace).toBe(1);
        expect(b.update(1).status).toBe('accepted');await f.session.flush();await f.session.dispose();
    });
    it('counts both distinct accepted versions while the old record is held', async () => {
        const started = defer(), gate = defer();const f = fixture([], { replace: async (address, text) => { if (f.calls.replace === 1) { started.resolve();await gate.promise; }return f.base.replace(address, text); } });
        const b = f.bind('a', 1);await confirm(b);const base = f.session.getStats().retainedBytes, saving = f.session.flush();await started.promise;
        const during = f.session.getStats().retainedBytes;expect(during).toBeGreaterThan(base);b.update(2);expect(f.session.getStats().retainedBytes).toBe(during + 1);
        gate.resolve();await saving;expect(f.session.getStats().retainedBytes).toBe(base);await f.session.flush();await f.session.dispose();
    });
    it.each([1, 2, 3])('respects explicit concurrent limit %s with queued buffers accounted', async maxConcurrentOperations => {
        const entered = defer(), gate = defer();let started = 0;
        const f = fixture([], { replace: async (address, text) => { if (++started === maxConcurrentOperations) entered.resolve();await gate.promise;return f.base.replace(address, text); } }, { maxConcurrentOperations });
        const bindings = ['a', 'b', 'c'].map(k => f.bind(k));await Promise.all(bindings.map(b => confirm(b)));const saving = f.session.flush();await entered.promise;
        expect(f.session.getStats()).toMatchObject({ activeIO: maxConcurrentOperations, queuedOperations: 3 - maxConcurrentOperations, pendingOperations: 3 });
        const addressAndValues = 3 * (new TextEncoder().encode(JSON.stringify(['n', 'a'])).length + 1), encoded = new TextEncoder().encode('{"updatedAt":17,"value":0,"version":1}').length;
        expect(f.session.getStats().retainedBytes).toBe(addressAndValues + 3 * encoded);gate.resolve();expect((await saving).ok).toBe(true);expect(started).toBe(3);await f.session.dispose();
    });
    it('waits for an admitted clear of blocked data before reporting its captured revision', async () => {
        const entered = defer(), gate = defer();const f = fixture([{ address: a(), text: '{' }], { remove: async address => { entered.resolve();await gate.promise;return f.base.remove(address); } });
        const b = f.bind();await confirm(b);const clearing = b.clear();await entered.promise;let completed = false;const saving = f.session.flush();saving.then(() => { completed = true; });await Promise.resolve();expect(completed).toBe(false);
        gate.resolve();expect(await clearing).toEqual({ status: 'applied' });expect((await saving).entries[0]).toMatchObject({ revision: 2, status: 'unchanged' });expect(f.calls.replace).toBe(0);await f.session.dispose();
    });
    it('does not unblock damaged input when a later valid update clears serialization failure', async () => {
        const f = fixture([{ address: a(), text: '{' }]), b = f.bind();await confirm(b);b.reportUpdateFailure();b.update(2);
        expect((await f.session.flush()).entries[0]?.status).toBe('blocked');expect(f.calls.replace).toBe(0);await f.session.dispose();
    });
    it('keeps initial/recovered bytes plus pending ack distinct from I/O; tighter aggregate wins', async () => {
        const f = fixture([{ address: a(), text: v1Record(1) }], {}, { maxRetainedBytes: 11 });const b = f.bind('a', 0);const recovery = await b.recovery;
        expect(recovery).toMatchObject({ status: 'blocked', issue: { code: 'CAPACITY_EXCEEDED' } });expect(f.session.getStats()).toMatchObject({ activeIO: 0, pendingInitializations: 1 });await confirm(b);expect(f.calls.replace).toBe(0);await f.session.dispose();
    });
    it('blocks old bare JSON without rewriting it and releases the owner on dispose', async () => {
        const original = '{"value":{"value":"business"}}';
        const f = fixture([{ address: a(), text: original }]), binding = f.bind();
        const recovery = await binding.recovery;
        expect(recovery).toMatchObject({ status: 'blocked', issue: { code: 'UNSUPPORTED_FORMAT' } });
        expect(binding.confirmInitialization(recovery, { status: 'ready' })).toMatchObject({ status: 'rejected', issue: { code: 'UNSUPPORTED_FORMAT' } });
        expect(await f.session.flush()).toMatchObject({ ok: false, entries: [{ status: 'blocked', issue: { code: 'UNSUPPORTED_FORMAT' } }] });
        expect(f.calls.replace).toBe(0);
        expect(await f.base.read(a())).toEqual({ status: 'found', text: original });
        expect((await f.session.dispose()).release).toEqual({ status: 'released' });
        expect(f.calls.release).toBe(1);
    });
    it('bounds maxKeys / pending / concurrency without evicting unsaved keys', async () => {
        const started = defer(), gate = defer();const f = fixture([], { read: async () => { started.resolve();await gate.promise;return { status: 'missing' }; } }, { maxKeys: 2, maxPendingOperations: 1, maxConcurrentOperations: 1 });
        const first = f.bind();await started.promise;expect(f.session.bind(a('b'), 0, { hydrate: true })).toMatchObject({ status: 'rejected', issue: { code: 'CAPACITY_EXCEEDED' } });
        expect(f.session.getStats()).toMatchObject({ retainedKeys: 1, pendingOperations: 1, activeIO: 1 });gate.resolve();await confirm(first);first.release();
        const second = f.bind('b');await confirm(second);expect(f.session.bind(a('c'), 0, { hydrate: true }).status).toBe('rejected');expect(f.session.getStats().retainedKeys).toBe(2);await f.session.dispose();
    });
    it('checks exact retained-byte boundaries at bind and retains old snapshots on failed update', async () => {
        const addressBytes = new TextEncoder().encode(JSON.stringify(['n', 'a'])).length;
        for (const capacity of [addressBytes, addressBytes + 1, addressBytes + 2]) {
            const f = fixture([], {}, { maxRetainedBytes: capacity });const bound = f.session.bind(a(), 0, { hydrate: true });expect(bound.status).toBe(capacity === addressBytes ? 'rejected' : 'bound');
            if (bound.status === 'bound') { await confirm(bound.binding);const previous = f.session.getStats().retainedBytes;expect(bound.binding.update('large').status).toBe('rejected');expect(f.session.getStats().retainedBytes).toBe(previous); }
            await f.session.dispose();
        }
    });
    it('rejects revision/generation overflow without wrapping or saving the old revision as latest', async () => {
        const f = fixture([], {}, { maxRevision: 2 }), b = f.bind();await confirm(b);expect(b.update(1)).toMatchObject({ status: 'accepted', revision: 2 });expect(b.update(2)).toMatchObject({ status: 'rejected', issue: { code: 'REVISION_EXHAUSTED' } });
        expect((await f.session.flush()).entries[0]).toMatchObject({ revision: 2, status: 'failed', issue: { code: 'REVISION_EXHAUSTED' } });expect(f.calls.replace).toBe(0);b.release();expect(f.session.bind(a(), 0, { hydrate: true })).toMatchObject({ status: 'rejected', issue: { code: 'REVISION_EXHAUSTED' } });await f.session.dispose();
    });
    it.each([NaN, Infinity, 'wrong', 'throw'])('uses only the explicit finite clock: %s', async clock => {
        const f = fixture();const s = createStateSession({ instanceId: 'app', storage: f.storage, limits, now: () => { if (clock === 'throw') throw Error('SENTINEL');return clock as number; } });
        const result = s.bind(a(), 0, { hydrate: true });if (result.status !== 'bound') throw Error('bind');await confirm(result.binding);expect((await s.flush()).entries[0]).toMatchObject({ status: 'failed', issue: { code: 'CLOCK_INVALID' } });expect(f.calls.replace).toBe(0);await s.dispose();
    });
});
