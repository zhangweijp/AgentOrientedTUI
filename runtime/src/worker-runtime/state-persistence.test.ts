import { it, expect } from 'vitest';
import { createAppStatePersistence } from './state-persistence.js';
import { createMemoryStateStorage } from '../adapters/storage/memory-state-storage.js';
import { failedMutation, stateIssue } from '../core/persistence/state-storage.js';
import { DEFAULT_STATE_SESSION_LIMITS } from '../adapters/storage/state-storage-protocol.js';
import type { StateStorage } from '../core/persistence/state-storage.js';
const defer = <T = void>() => { let resolve!: (v: T) => void;const promise = new Promise<T>(r => { resolve = r; });return { promise, resolve }; };
function fixture(overrides: Partial<StateStorage> = {}) {
    const backend = createMemoryStateStorage({ maxStoredKeys: 32, maxStoredBytes: 100000, maxRecordBytes: 10000, maxAddressBytes: 1024, maxActiveOwners: 4, maxClaimedNamespaces: 8 });
    const open = backend.open('i');if (open.status !== 'opened') throw Error('fixture');
    const storage = { ...open.storage, ...overrides }, managed = createAppStatePersistence({ instanceId: 'i', desktopId: 'd', appKey: 'a', storage, now: () => 1 });
    const bind = async (key = 'k') => {
        const result = managed.port.bind(key, 0, { hydrate: true });if (result.status !== 'bound') throw Error('bind');
        const recovery = await result.binding.recovery;result.binding.confirmInitialization(recovery, { status: 'ready' });return result.binding;
    };
    return { managed, bind, storage, backend };
}
it('B06/B17: same-turn bind/update participates in deferred shared flush; final close captures later admitted update', async () => {
    const f = fixture();const flush = f.managed.port.flush();expect(f.managed.port.flush()).toBe(flush);
    const bound = f.managed.port.bind('k', 0, { hydrate: false });if (bound.status !== 'bound') throw Error();
    const recovery = await bound.binding.recovery;bound.binding.confirmInitialization(recovery, { status: 'ready' });bound.binding.update(2);
    expect((await flush).ok).toBe(true); // Initial captured batch may predate this asynchronous setter.
    bound.binding.update(3);
    let unmounted = 0;const close = f.managed.close(() => { unmounted++;bound.binding.release(); });
    expect(f.managed.close(() => { throw Error(); })).toBe(close);expect((await close).ok).toBe(true);expect(unmounted).toBe(1);
    expect(f.backend.getStats().activeOwners).toBe(0);
    const check = f.backend.open('check');if (check.status !== 'opened') throw Error();
    expect(await check.storage.read({ namespace: '["d","a"]', key: 'k' })).toMatchObject({ text: expect.stringContaining('"value":3') });await check.storage.release();
});
it('B17: a pending successful manual batch is followed by one final snapshot after seal', async () => {
    const entered = defer(), finish = defer();let writes = 0;const f = fixture({ replace: async () => { writes++;if (writes === 1) { entered.resolve();await finish.promise; }return { status: 'applied' }; } });
    const b = await f.bind();b.update(1);const manual = f.managed.port.flush();await entered.promise;b.update(2);
    const close = f.managed.close(() => {});expect(b.update(3)).toMatchObject({ status: 'rejected', issue: { code: 'SEALED' } });
    finish.resolve();await manual;expect((await close).ok).toBe(true);expect(writes).toBe(2);
});
it('B18: failed in-flight manual batch is not silently retried; cleanup still attempts unmount and release', async () => {
    const entered = defer(), finish = defer();let writes = 0, unmount = 0;
    const f = fixture({ replace: async () => { writes++;entered.resolve();await finish.promise;return failedMutation('IO_FAILED'); } });
    await f.bind();const manual = f.managed.port.flush();await entered.promise;
    const close = f.managed.close(() => { unmount++;throw Error('private'); });finish.resolve();expect((await manual).ok).toBe(false);
    const result = await close;expect(result).toMatchObject({ ok: false, unmount: 'failed', dispose: { release: { status: 'released' } } });
    expect(result.dispose!.unsaved).toHaveLength(1);expect([writes, unmount]).toEqual([1, 1]);expect(JSON.stringify(result)).not.toContain('private');
});
it('B18: initial failure never writes partial defaults, release failure remains explicit', async () => {
    let writes = 0;const f = fixture({ replace: async () => { writes++;return { status: 'applied' }; }, release: async () => ({ status: 'failed', issue: stateIssue('IO_FAILED') }) });
    await f.bind();const result = await f.managed.close(() => {}, true);
    expect(writes).toBe(0);expect(result.ok).toBe(false);expect(result.dispose!.release.status).toBe('failed');expect(f.managed.getStats().ownerRetained).toBe(true);
});
it('B05/B09 F01: captureValue reuses exact captured session budgets, is pure, and never grants a disposed binding', async () => {
    const backend = createMemoryStateStorage({ maxStoredKeys: 2, maxStoredBytes: 10000, maxRecordBytes: 1000, maxAddressBytes: 1024, maxActiveOwners: 1, maxClaimedNamespaces: 1 });
    const opened = backend.open('i');if (opened.status !== 'opened') throw Error();let reads = 0;
    const limits = { ...DEFAULT_STATE_SESSION_LIMITS, maxValueBytes: 8 };
    const managed = createAppStatePersistence({ instanceId: 'i', desktopId: 'd', appKey: 'a', limits,
        storage: { ...opened.storage, async read(a) { reads++;return opened.storage.read(a); } } });
    limits.maxValueBytes = 100000;
    const before = managed.getStats(), input = { n: 1 }, captured = managed.port.captureValue(input);input.n = 2;
    expect(captured).toMatchObject({ status: 'captured', snapshot: { value: { n: 1 } } });expect(Object.isFrozen(input)).toBe(false);
    expect(managed.port.captureValue('long string')).toMatchObject({ status: 'rejected', issue: { code: 'CAPACITY_EXCEEDED' } });
    let getters = 0;const accessor = Object.defineProperty({}, 'n', { enumerable: true, get() { getters++;return 1; } });
    const hidden = Object.defineProperty({ n: 1 }, 'hidden', { value: 2 });const symbol = { [Symbol()]: 1 };class Instance { n = 1; }
    for (const value of [NaN, { n: Infinity }, accessor, hidden, symbol, new Instance()]) expect(managed.port.captureValue(value).status).toBe('rejected');
    expect(getters).toBe(0);expect(reads).toBe(0);expect(managed.getStats()).toEqual(before);
    expect(managed.port.bind('k', 'long string', { hydrate: true })).toMatchObject({ status: 'rejected', issue: { code: 'CAPACITY_EXCEEDED' } });
    await managed.close(() => {});const disposed = managed.getStats();expect(managed.port.captureValue(1).status).toBe('captured');
    expect(managed.port.bind('k', 1, { hydrate: true })).toMatchObject({ status: 'rejected', issue: { code: 'DISPOSED' } });expect(managed.getStats()).toEqual(disposed);
});
