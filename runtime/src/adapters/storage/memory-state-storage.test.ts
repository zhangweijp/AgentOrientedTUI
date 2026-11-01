import { describe, expect, it } from 'vitest';
import { utf8Size } from '../../core/snapshot/json.js';
import { createMemoryStateStorage } from './memory-state-storage.js';
const limits = { maxStoredKeys: 3, maxStoredBytes: 300, maxRecordBytes: 100, maxAddressBytes: 64, maxActiveOwners: 2, maxClaimedNamespaces: 3 };
describe('A02/A16/A17/Q04 bounded owner and namespace memory storage', () => {
    it('uses exact tuple identities, protects a namespace and preserves values across owner handoff', async () => {
        const backend = createMemoryStateStorage(limits), first = backend.open('first'), second = backend.open('second');if (first.status !== 'opened' || second.status !== 'opened') throw Error('fixture');
        const a = { namespace: 'a:b', key: 'c' }, b = { namespace: 'a', key: 'b:c' };
        expect(await first.storage.replace(a, 'raw-a')).toEqual({ status: 'applied' });expect(await second.storage.replace(b, 'raw-b')).toEqual({ status: 'applied' });
        expect(await second.storage.read(a)).toMatchObject({ status: 'failed', issue: { code: 'NAMESPACE_BUSY' } });expect(backend.open('first')).toMatchObject({ status: 'rejected', issue: { code: 'OWNER_BUSY' } });
        await first.storage.release();const replacement = backend.open('first');if (replacement.status !== 'opened') throw Error('fixture');expect(await replacement.storage.read(a)).toEqual({ status: 'found', text: 'raw-a' });
        expect(await first.storage.replace(a, 'old')).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'OWNER_RELEASED' } });await first.storage.release();expect(await replacement.storage.read(a)).toEqual({ status: 'found', text: 'raw-a' });
        await replacement.storage.release();await second.storage.release();expect(backend.getStats()).toMatchObject({ activeOwners: 0, claimedNamespaces: 0, storedKeys: 2 });
        expect(backend.getStats()).not.toHaveProperty('activeOperations');
    });
    it('bounds owners and even empty namespaces without evicting another owner', async () => {
        const backend = createMemoryStateStorage({ ...limits, maxActiveOwners: 1, maxClaimedNamespaces: 1 }), result = backend.open('owner');if (result.status !== 'opened') throw Error('fixture');
        expect(backend.open('other')).toMatchObject({ status: 'rejected', issue: { code: 'CAPACITY_EXCEEDED' } });expect(await result.storage.read({ namespace: 'empty', key: 'a' })).toEqual({ status: 'missing' });
        expect(await result.storage.read({ namespace: 'another', key: 'a' })).toMatchObject({ status: 'failed', issue: { code: 'CAPACITY_EXCEEDED' } });expect(backend.getStats()).toMatchObject({ storedKeys: 0, claimedNamespaces: 1 });
        await result.storage.release();const next = backend.open('other');if (next.status !== 'opened') throw Error('fixture');expect(await next.storage.read({ namespace: 'another', key: 'a' })).toEqual({ status: 'missing' });
    });
    it('counts address plus text bytes and preserves prior data on each capacity rejection', async () => {
        const address = { namespace: 'n', key: 'k' }, bytes = utf8Size('["n","k"]') + utf8Size('😀');
        for (const maxStoredBytes of [bytes - 1, bytes, bytes + 1]) {
            const backend = createMemoryStateStorage({ ...limits, maxStoredKeys: 1, maxStoredBytes }), owner = backend.open('owner');if (owner.status !== 'opened') throw Error('fixture');
            const result = await owner.storage.replace(address, '😀');expect(result.status).toBe(maxStoredBytes < bytes ? 'failed' : 'applied');
            if (result.status === 'applied') { expect((await owner.storage.replace({ namespace: 'n', key: 'other' }, 'x')).status).toBe('failed');expect((await owner.storage.replace(address, 'x'.repeat(101))).status).toBe('failed');expect(await owner.storage.read(address)).toEqual({ status: 'found', text: '😀' }); }
        }
    });
    it('enforces owner/address/record lengths and snapshots limits', async () => {
        const config = { ...limits, maxAddressBytes: 9, maxRecordBytes: 3 }, backend = createMemoryStateStorage(config);config.maxRecordBytes = 1000;
        expect(backend.open('x'.repeat(8)).status).toBe('rejected');const owner = backend.open('o');if (owner.status !== 'opened') throw Error('fixture');
        expect((await owner.storage.replace({ namespace: 'n', key: 'k' }, '123')).status).toBe('applied');expect((await owner.storage.replace({ namespace: 'n', key: 'k' }, '1234')).status).toBe('failed');expect((await owner.storage.read({ namespace: 'nn', key: 'k' })).status).toBe('failed');
    });
    it('takes raw bounded fixtures without parsing their business value, and refuses fixture accessors', async () => {
        const address = { namespace: 'n', key: 'k' }, backend = createMemoryStateStorage(limits, [{ address, text: '{corrupt' }]), owner = backend.open('owner');if (owner.status !== 'opened') throw Error('fixture');expect(await owner.storage.read(address)).toEqual({ status: 'found', text: '{corrupt' });
        let reads = 0;const initial: any[] = [];Object.defineProperty(initial, '0', { enumerable: true, get() { reads++;return { address, text: 'bad' }; } });expect(() => createMemoryStateStorage(limits, initial)).toThrow('INVALID_INPUT');expect(reads).toBe(0);
    });
});
