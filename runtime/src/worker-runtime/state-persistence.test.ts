import { it, expect, vi } from 'vitest';
import { createAppStatePersistence } from './state-persistence.js';
import { createMemoryStateStorage } from '../adapters/storage/memory-state-storage.js';
import { failedMutation } from '@aotui/core/persistence';
import type { StateStorage } from '@aotui/core';

function fixture(wrap: (storage: StateStorage) => StateStorage = storage => storage) {
    const backend = createMemoryStateStorage({ maxStoredKeys: 8, maxStoredBytes: 8192, maxRecordBytes: 1024,
        maxAddressBytes: 512, maxActiveOwners: 2, maxClaimedNamespaces: 4 });
    const opened = backend.open('i');
    if (opened.status !== 'opened') throw Error('fixture');
    return { backend, managed: createAppStatePersistence({ instanceId: 'i', desktopId: 'd', appKey: 'a',
        storage: wrap(opened.storage), now: () => 1 }) };
}

it('keeps the normal namespace and explicitly selected storage space separate', async () => {
    const { managed, backend } = fixture();
    const options = { storageKey: 'custom' };
    await managed.port.save('k', null);
    await managed.port.save('k', false, options);
    expect(await managed.port.load('k')).toBe(null);
    expect(await managed.port.load('k', options)).toBe(false);
    await managed.port.remove('k', options);
    expect(await managed.port.load('k', options)).toBeUndefined();
    expect(await managed.port.load('k')).toBe(null);
    let getters = 0;
    const accessor = Object.defineProperty({}, 'storageKey', { enumerable: true, get() { getters++; return 'custom'; } });
    for (const invalid of [{ storageKey: '' }, { hydrate: true }, accessor])
        await expect(managed.port.load('k', invalid)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(getters).toBe(0);
    expect((await managed.close(() => {})).ok).toBe(true);
    const check = backend.open('check');
    if (check.status !== 'opened') throw Error('fixture');
    expect(await check.storage.read({ namespace: '["d","a"]', key: 'k' })).toMatchObject({ text: expect.stringContaining('"value":null') });
    await check.storage.release();
});

it('allows a single cleanup callback to save and seals only after it completes', async () => {
    const calls: string[] = [], gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    const { managed } = fixture(base => ({ ...base,
        async replace(address, text) { calls.push('write'); return base.replace(address, text); },
        async release() { calls.push('release'); return base.release(); },
    }));
    const close = managed.close(async () => {
        calls.push('cleanup');
        started.resolve();
        await gate.promise;
        await managed.port.save('k', 'last draft');
    });
    expect(managed.close(() => { throw Error('must not run'); })).toBe(close);
    await started.promise;
    expect(managed.getStats().phase).toBe('open');
    expect(managed.getReport()).toBeUndefined();
    gate.resolve();
    expect(await close).toMatchObject({ ok: true, unmount: 'completed',
        flush: { entries: [{ revision: 1, status: 'saved' }] }, dispose: { unsaved: [], release: { status: 'released' } } });
    expect(calls).toEqual(['cleanup', 'write', 'release']);
    await expect(managed.port.save('k', 'too late')).rejects.toMatchObject({ code: 'DISPOSED' });
});

it('settles an admitted write and releases the owner even if the App cleanup fails', async () => {
    let writes = 0;
    const { managed, backend } = fixture(base => ({ ...base,
        async replace() { writes++; return failedMutation('IO_FAILED'); },
    }));
    const close = await managed.close(() => {
        void managed.port.save('k', 4).catch(() => {});
        throw Error('private error detail');
    });
    expect(close).toMatchObject({ ok: false, unmount: 'failed',
        flush: { ok: false, entries: [{ issue: { code: 'IO_FAILED' } }] },
        dispose: { release: { status: 'released' }, unsaved: [{ issue: { code: 'IO_FAILED' } }] } });
    expect([writes, backend.getStats().activeOwners]).toEqual([1, 0]);
    expect(JSON.stringify(close)).not.toContain('private error detail');
});

it('allows failed App cleanup to leave an unused store healthy', async () => {
    const unexpected = vi.fn();
    const { managed } = fixture(base => ({ ...base,
        async read() { unexpected('read'); throw Error('unexpected read'); },
        async replace() { unexpected('write'); throw Error('unexpected write'); },
    }));
    expect(await managed.close(() => { throw Error('App cleanup failed'); })).toMatchObject({ ok: true, unmount: 'failed',
        flush: { ok: true, entries: [] }, dispose: { unsaved: [], release: { status: 'released' } } });
    expect(unexpected).not.toHaveBeenCalled();
});
