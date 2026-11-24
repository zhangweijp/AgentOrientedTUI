import { expect, it } from 'vitest';
import { createMemoryStateStorage } from './memory-state-storage.js';
import { createStateSession, failedMutation, failedRead, stateIssue, unknownMutation } from '@aotui/core/persistence';
import type { StateAddress, StateSessionLimits, StateStorage, StateValue } from '@aotui/core';

const limits: StateSessionLimits = { maxKeys: 8, maxDepth: 10, maxNodes: 200, maxValueBytes: 512, maxRecordBytes: 1024,
    maxAddressBytes: 128, maxRetainedBytes: 8192, maxPendingRequests: 8, maxConcurrentRequests: 4, maxRevision: 1000 };
const a = (key = 'a', namespace = 'n'): StateAddress => ({ namespace, key });
const v1 = (value: StateValue) => JSON.stringify({ version: 1, updatedAt: 1, value });
const gate = () => Promise.withResolvers<void>();
const error = (code: string) => ({ code });
function fixture(initial: { address: StateAddress; text: string }[] = [], overrides: Partial<StateStorage> = {},
    custom: Partial<StateSessionLimits> = {}, now = () => 17) {
    const backend = createMemoryStateStorage({ maxStoredKeys: 20, maxStoredBytes: 20000, maxRecordBytes: 4096,
        maxAddressBytes: 128, maxActiveOwners: 3, maxClaimedNamespaces: 10 }, initial);
    const opened = backend.open('app');
    if (opened.status !== 'opened') throw Error('fixture owner');
    const base = opened.storage, calls: string[] = [];
    const storage: StateStorage = { owner: 'app',
        read: async address => { calls.push('load:' + address.key); return (overrides.read ?? base.read)(address); },
        replace: async (address, text) => { calls.push('save:' + address.key); return (overrides.replace ?? base.replace)(address, text); },
        remove: async address => { calls.push('remove:' + address.key); return (overrides.remove ?? base.remove)(address); },
        release: async () => { calls.push('release'); return (overrides.release ?? base.release)(); },
    };
    const session = createStateSession({ instanceId: 'app', storage, limits: { ...limits, ...custom }, now });
    return { session, base, backend, calls, storage };
}

it('validates limits, instance identity, and own storage methods before I/O', () => {
    const f = fixture();
    for (const name of Object.keys(limits)) {
        for (const invalid of [0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
            expect(() => createStateSession({ instanceId: 'app', storage: f.storage, limits: { ...limits, [name]: invalid }, now: () => 0 })).toThrow();
    }
    for (const id of ['', 'wrong', 'x'.repeat(200)])
        expect(() => createStateSession({ instanceId: id, storage: f.storage, limits, now: () => 0 })).toThrow();
    let getters = 0;
    const accessor = Object.defineProperty({ ...f.storage }, 'read', { enumerable: true, get() { getters++; } });
    expect(() => createStateSession({ instanceId: 'app', storage: accessor, limits, now: () => 0 })).toThrow();
    expect([getters, f.calls.length]).toEqual([0, 0]);
});

it.each([null, false, 0, '', { value: { version: 2, updatedAt: 1 } }] satisfies StateValue[])('reads original v1 JSON %j with no mutation', async value => {
    const f = fixture([{ address: a(), text: v1(value) }]);
    expect(await f.session.load(a())).toEqual(value);
    expect(await f.session.load(a('missing'))).toBeUndefined();
    expect(await f.session.flush()).toEqual({ status: 'completed', ok: true, entries: [] });
    expect((await f.session.dispose()).release.status).toBe('released');
    expect(f.calls).toEqual(['load:a', 'load:missing', 'release']);
});

it.each([
    ['{', 'CORRUPT'], ['{"version":1,"updatedAt":null,"value":0}', 'CORRUPT'],
    ['{"version":2,"updatedAt":1,"value":0}', 'UNSUPPORTED_FORMAT'], ['{"value":0}', 'UNSUPPORTED_FORMAT'],
    [v1('x'.repeat(900)), 'CAPACITY_EXCEEDED'], [' '.repeat(1025), 'CAPACITY_EXCEEDED'],
])('reports the read error for %s and leaves its original bytes', async (text, code) => {
    const f = fixture([{ address: a(), text }]);
    await expect(f.session.load(a())).rejects.toMatchObject(error(code));
    expect(f.calls).toEqual(['load:a']);
    expect(await f.base.read(a())).toEqual({ status: 'found', text });
    await f.session.dispose();
});

it('propagates backend read failures and an invalid receipt rather than treating them as missing', async () => {
    for (const [read, code] of [
        [async () => failedRead('PERMISSION_DENIED'), 'PERMISSION_DENIED'],
        [async () => { throw Error('raw cause'); }, 'IO_FAILED'],
        [async () => ({ status: 'missing', extra: 'bad' }), 'INVALID_RECEIPT'],
    ] as const) {
        const f = fixture([], { read: read as StateStorage['read'] });
        await expect(f.session.load(a())).rejects.toMatchObject(error(code));
        expect((await f.session.flush()).entries).toEqual([]);
        await f.session.dispose();
    }
});

it('captures distinct writes immediately and each flush waits only for its own accepted range', async () => {
    const first = gate(), second = gate(), firstEntered = gate(), secondEntered = gate();
    const values: unknown[] = [];
    const f = fixture([], { async replace(address, text) {
        values.push(JSON.parse(text).value);
        const opening = values.length === 1;
        (opening ? firstEntered : secondEntered).resolve();
        await (opening ? first : second).promise;
        return f.base.replace(address, text);
    } });
    const input = { draft: 'first' }, initial = f.session.save(a(), input), flush1 = f.session.flush();
    input.draft = 'second';
    const next = f.session.save(a(), input), flush2 = f.session.flush();
    input.draft = 'later';
    const read = f.session.load(a());
    await firstEntered.promise;
    expect(values).toEqual([{ draft: 'first' }]);
    expect(f.session.getStats()).toMatchObject({ pendingRequests: 3, activeIO: 1 });
    first.resolve();
    await initial;
    expect((await flush1).entries.map(entry => entry.revision)).toEqual([1]);
    await secondEntered.promise;
    let done = false; void flush2.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(values).toEqual([{ draft: 'first' }, { draft: 'second' }]);
    second.resolve();
    await next;
    expect((await flush2).entries.map(entry => [entry.revision, entry.status])).toEqual([[1, 'saved'], [2, 'saved']]);
    expect(await read).toEqual({ draft: 'second' });
    expect(f.calls).toEqual(['save:a', 'save:a', 'load:a']);
    await f.session.dispose();
});

it('orders save, remove and load per key and keeps other spaces independent', async () => {
    const f = fixture();
    const address = { namespace: 'n', key: 'a' };
    const first = f.session.save(address, 1);
    address.namespace = 'other';
    const second = f.session.save(address, 2);
    const removed = f.session.remove(a());
    const read = f.session.load(a());
    const flush = f.session.flush();
    await Promise.all([first, second, removed]);
    expect(await read).toBeUndefined();
    expect(await f.session.load(address)).toBe(2);
    expect((await flush).entries.map(item => item.status)).toEqual(['saved', 'saved', 'removed']);
    await f.session.dispose();
});

it('keeps the original known failure even when the same key later saves successfully', async () => {
    let attempts = 0;
    const f = fixture([], { async replace() { return ++attempts === 1 ? failedMutation('STORAGE_BUSY') : { status: 'applied' }; } });
    await expect(f.session.save(a(), 1)).rejects.toMatchObject(error('STORAGE_BUSY'));
    await f.session.save(a(), 2);
    expect((await f.session.flush()).entries.map(entry => entry.status)).toEqual(['failed', 'saved']);
    expect((await f.session.dispose()).unsaved).toMatchObject([{ revision: 1, issue: { code: 'STORAGE_BUSY' } }]);
    expect(attempts).toBe(2);
});

it.each(['throw', 'bad receipt', 'unconfirmed'])('retains the first unknown effect from %s and never dispatches a second mutation past it', async mode => {
    const f = fixture([], { async replace() {
        if (mode === 'throw') throw Error('lost');
        return mode === 'bad receipt' ? { status: 'applied', extra: true } : unknownMutation();
    } });
    const first = expect(f.session.save(a(), 1)).rejects.toMatchObject(error('UNKNOWN_OUTCOME'));
    const second = expect(f.session.remove(a())).rejects.toMatchObject(error('UNKNOWN_OUTCOME'));
    const read = expect(f.session.load(a())).rejects.toMatchObject(error('UNKNOWN_OUTCOME'));
    const report = await f.session.flush();
    await Promise.all([first, second, read]);
    expect(report.entries.map(entry => [entry.revision, entry.status])).toEqual([[1, 'unknown'], [2, 'failed']]);
    expect((await f.session.dispose()).release.status).toBe('released');
    expect(f.calls).toEqual(['save:a', 'release']);
});

it('reports explicit removal failures and preserves the known stored value', async () => {
    const f = fixture([{ address: a(), text: v1(7) }], { async remove() { return failedMutation('IO_FAILED'); } });
    await expect(f.session.remove(a())).rejects.toMatchObject(error('IO_FAILED'));
    expect(await f.session.load(a())).toBe(7);
    expect((await f.session.dispose()).unsaved).toMatchObject([{ revision: 1, status: 'failed' }]);
});

it('rejects invalid JSON and excess sizes before admitting storage work', async () => {
    const f = fixture([], {}, { maxValueBytes: 10 });
    let getters = 0;
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { getters++; } });
    for (const input of [undefined, NaN, { x: Infinity }, getter, new Date(), { [Symbol()]: 1 }])
        await expect(f.session.save(a(), input as StateValue)).rejects.toMatchObject(error('SERIALIZATION_FAILED'));
    await expect(f.session.save(a(), 'beyond ten bytes')).rejects.toMatchObject(error('CAPACITY_EXCEEDED'));
    await expect(f.session.load(a(''))).rejects.toMatchObject(error('INVALID_INPUT'));
    expect([getters, f.calls.length]).toEqual([0, 0]);
    expect((await f.session.flush()).entries).toEqual([]);
    await f.session.dispose();
});

it('bounds queued requests, addresses, and retained encoded bytes while an older write is held', async () => {
    const enter = gate(), release = gate();
    const f = fixture([], { async replace() { enter.resolve(); await release.promise; return { status: 'applied' }; } },
        { maxRetainedBytes: 115, maxPendingRequests: 2, maxConcurrentRequests: 1, maxKeys: 1 });
    const old = f.session.save(a(), 'x'.repeat(25));
    await enter.promise;
    await expect(f.session.save(a(), 'x'.repeat(25))).rejects.toMatchObject(error('CAPACITY_EXCEEDED'));
    await expect(f.session.load(a('b'))).rejects.toMatchObject(error('CAPACITY_EXCEEDED'));
    const queued = f.session.load(a());
    await expect(f.session.load(a())).rejects.toMatchObject(error('CAPACITY_EXCEEDED'));
    release.resolve();
    await old; await queued;
    await f.session.save(a('b'), 3);
    await f.session.dispose();
    expect(f.session.getStats()).toMatchObject({ retainedKeys: 0, retainedBytes: 0, activeIO: 0, pendingRequests: 0 });
});

it('seals admission, cancels only queued operations on disposal, and waits for actual entered I/O', async () => {
    const enter = gate(), release = gate();
    const f = fixture([], { async replace(address, text) { enter.resolve(); await release.promise; return f.base.replace(address, text); } },
        { maxConcurrentRequests: 1 });
    const current = f.session.save(a(), 1);
    await enter.promise;
    const queued = expect(f.session.save(a(), 2)).rejects.toMatchObject(error('DISPOSED'));
    expect(f.session.seal()).toBe('sealed');
    await expect(f.session.save(a(), 3)).rejects.toMatchObject(error('SEALED'));
    const before = f.session.flush(), disposed = f.session.dispose();
    expect(f.session.dispose()).toBe(disposed);
    await queued;
    expect(f.calls).toEqual(['save:a']);
    expect(f.session.getStats()).toMatchObject({ ownerRetained: true, activeIO: 1, phase: 'disposed' });
    release.resolve(); await current;
    expect((await before).entries.map(entry => entry.status)).toEqual(['saved', 'failed']);
    expect(await disposed).toMatchObject({ release: { status: 'released' }, unsaved: [{ revision: 2 }] });
    expect(f.calls).toEqual(['save:a', 'release']);
});

it('retries only releasing the original retained owner after a failed release', async () => {
    let releasing = 0;
    const f = fixture([], { async release() {
        return ++releasing === 1 ? { status: 'failed', issue: stateIssue('IO_FAILED') } : f.base.release();
    } });
    await f.session.save(a(), 4);
    expect((await f.session.dispose()).release.status).toBe('failed');
    expect(f.session.getStats().ownerRetained).toBe(true);
    expect((await f.session.dispose()).release.status).toBe('released');
    expect(f.calls).toEqual(['save:a', 'release', 'release']);
});

it('rejects a clock failure or revision exhaustion without reusing an admitted revision', async () => {
    const f = fixture([], {}, { maxRevision: 1 });
    await f.session.save(a(), 1);
    await expect(f.session.remove(a())).rejects.toMatchObject(error('REVISION_EXHAUSTED'));
    expect((await f.session.flush()).entries).toMatchObject([{ revision: 1, status: 'saved' }]);
    await f.session.dispose();
    const bad = fixture([], {}, {}, () => Infinity);
    await expect(bad.session.save(a(), 1)).rejects.toMatchObject(error('CLOCK_INVALID'));
    expect(bad.calls).toEqual([]);
    await bad.session.dispose();
});
