import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createStateStorageHost, DEFAULT_NODE_STATE_LIMITS, resolveStateDirectory } from './state-storage-host.js';
import { createNodeStateStorage } from '../../adapters/storage/node-state-storage.js';
import { DEFAULT_STATE_TRANSPORT_LIMITS } from '../../adapters/storage/state-storage-protocol.js';
import { stateIssue } from '../../core/persistence/state-storage.js';
const defer = <T = void>() => { let resolve!: (v: T) => void;const promise = new Promise<T>(r => { resolve = r; });return { promise, resolve }; };
const req = (sequence: number, action = 'read', extra: object = {}) => ({ type: 'STATE_STORAGE_REQUEST', version: 1, instanceId: 'i', sequence, action,
    ...(action === 'release' ? {} : { address: { namespace: '["d","a"]', key: 'k' } }), ...extra });
it('B03: no use means zero open; release is shared and closes admission synchronously', async () => {
    let calls = 0;const host = createStateStorageHost({ instanceId: 'i', desktopId: 'd', rootDirectory: '/unused', backend: { open: async () => { calls++;return { status: 'rejected', issue: stateIssue('IO_FAILED') }; } } });
    const release = host.release();expect(host.release()).toBe(release);expect((await release).status).toBe('released');
    expect(await host.accept(req(1))).toMatchObject({ result: { status: 'failed', issue: { code: 'OWNER_RELEASED' } } });expect(calls).toBe(0);
});
it('B03/B15/B16: close waits for delayed open and admitted actual access; one owner is released once', async () => {
    const entered = defer(), opened = defer(), readEntered = defer(), finishRead = defer();let opens = 0, releases = 0;
    const host = createStateStorageHost({ instanceId: 'i', desktopId: 'd', rootDirectory: '/unused', limits: { ...DEFAULT_STATE_TRANSPORT_LIMITS, maxPendingRequests: 1 },
        backend: { async open() { opens++;entered.resolve();await opened.promise;return { status: 'opened', storage: { owner: 'i',
            async read() { readEntered.resolve();await finishRead.promise;return { status: 'missing' }; },
            async replace() { return { status: 'applied' }; }, async remove() { return { status: 'applied' }; },
            async release() { releases++;return { status: 'released' }; } } }; } } });
    const read = host.accept(req(1))!;await entered.promise;
    expect(await host.accept(req(2))).toMatchObject({ result: { issue: { code: 'CAPACITY_EXCEEDED' } } });
    const closing = host.release();expect(host.getStats()).toMatchObject({ opening: true, actualIO: 1, closing: true });expect(releases).toBe(0);
    opened.resolve();await readEntered.promise;expect(host.getStats().ownerRetained).toBe(true);expect(releases).toBe(0);
    finishRead.resolve();expect((await read).result.status).toBe('missing');expect((await closing).status).toBe('released');
    expect([opens, releases]).toEqual([1, 1]);expect(host.getStats()).toMatchObject({ actualIO: 0, ownerRetained: false, bufferedBytes: 0 });
});
it('B03: shared failed open leaves target mutations failed/none', async () => {
    let opens = 0;const host = createStateStorageHost({ instanceId: 'i', desktopId: 'd', rootDirectory: '/unused', backend: { async open() { opens++;return { status: 'rejected', issue: stateIssue('PERMISSION_DENIED') }; } } });
    const results = await Promise.all([host.accept(req(1)), host.accept(req(2, 'replace', { text: '{}' }))]);
    expect(opens).toBe(1);expect(results[1]).toMatchObject({ result: { status: 'failed', effects: 'none', issue: { code: 'PERMISSION_DENIED' } } });
    expect((await host.release()).status).toBe('released');
});
it('B12: resolves explicit merged configuration and both historical defaults without I/O', () => {
    expect(resolveStateDirectory({ AOTUI_DATA_DIR: 'data' }, '/tmp/launch')).toBe('/tmp/launch/data/app-state');
    expect(resolveStateDirectory({ AOTUI_DATA_DIR: '/tmp/data' })).toBe('/tmp/data/app-state');
    expect(resolveStateDirectory({ AOTUI_DATA_DIR: '' })).toBe(resolveStateDirectory(undefined));
    expect(() => resolveStateDirectory({ AOTUI_DATA_DIR: 42 })).toThrow('INVALID_INPUT');
});
it('B04/B11/B13/B14: real Node path, shared backend ownership, exact highwater and desktop fence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aotui-b2-host-')), backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS);
    const first = createStateStorageHost({ instanceId: 'i', desktopId: 'd', rootDirectory: root, backend });
    const second = createStateStorageHost({ instanceId: 'j', desktopId: 'd', rootDirectory: root, backend });
    try {
        expect(first.accept({ ...req(1), rootDirectory: '/elsewhere' })).toBeNull();
        expect(await first.accept(req(1, 'read', { address: { namespace: '["other","a"]', key: 'k' } }))).toMatchObject({ result: { status: 'failed' } });
        expect(backend.getStats().ownerSlots).toBe(0);
        expect(await first.accept(req(2, 'replace', { text: '{"value":7}' }))).toMatchObject({ result: { status: 'applied' } });
        expect(await first.accept(req(2, 'remove'))).toMatchObject({ result: { status: 'failed' } });
        expect(await readFile(path.join(root, 'd/a/k.json'), 'utf8')).toBe('{"value":7}');
        expect(await second.accept({ ...req(1), instanceId: 'j' })).toMatchObject({ result: { status: 'failed', issue: { code: 'NAMESPACE_BUSY' } } });
        expect((await first.release()).status).toBe('released');
        expect(await second.accept({ ...req(2), instanceId: 'j' })).toMatchObject({ result: { status: 'found' } });
    } finally { await first.release();await second.release();await rm(root, { recursive: true, force: true }); }
});
