import { it, expect, vi, afterEach } from 'vitest';
import { createStateStorageProxy } from './state-storage-proxy.js';
import { DEFAULT_STATE_TRANSPORT_LIMITS as defaults } from '../adapters/storage/state-storage-protocol.js';
import type { StateStorageRequest } from '../adapters/storage/state-storage-protocol.js';
const address = { namespace: '["d","a"]', key: 'k' };
afterEach(() => vi.useRealTimers());
it('B14/B15: sent mutation timeout is unknown, late response cannot heal it; new refused write has no effects', async () => {
    vi.useFakeTimers();const sent: StateStorageRequest[] = [];
    const proxy = createStateStorageProxy('i', { ...defaults, timeoutMs: 10 }, r => { sent.push(r); });
    const pending = proxy.storage.replace(address, '{}');await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ status: 'unknown' });
    proxy.receive({ ...sent[0], type: 'STATE_STORAGE_RESPONSE', result: { status: 'applied' } });
    expect(proxy.getStats()).toMatchObject({ uncertain: true, pending: 0 });
    expect(await proxy.storage.remove(address)).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'UNKNOWN_OUTCOME' } });
    expect(sent).toHaveLength(1);
});
it('B14: wrong operation/malformed matching response cannot become applied; disconnect drains pending timers', async () => {
    vi.useFakeTimers();const sent: StateStorageRequest[] = [];
    const proxy = createStateStorageProxy('i', defaults, r => { sent.push(r); });
    const first = proxy.storage.remove(address);
    proxy.receive({ ...sent[0], type: 'STATE_STORAGE_RESPONSE', operation: 'replace', result: { status: 'applied' } });
    expect((await first).status).toBe('unknown');
    const read = proxy.storage.read(address);proxy.disconnect();
    expect((await read).status).toBe('failed');expect(vi.getTimerCount()).toBe(0);
});
it('B15: definite send rejection is failed/none without poisoning transport', async () => {
    const proxy = createStateStorageProxy('i', defaults, () => false);
    expect(await proxy.storage.remove(address)).toMatchObject({ status: 'failed', effects: 'none' });
    expect(proxy.getStats()).toMatchObject({ uncertain: false, pending: 0 });
});
it('B16: release has independent supervision admission and shared completion; sequence never wraps', async () => {
    const sent: StateStorageRequest[] = [];
    const proxy = createStateStorageProxy('i', { ...defaults, maxPendingOperations: 1, maxSequence: 2 }, r => { sent.push(r); });
    const read = proxy.storage.read(address);
    expect((await proxy.storage.read(address)).status).toBe('failed');
    const release = proxy.storage.release();expect(proxy.storage.release()).toBe(release);expect(sent).toHaveLength(2);
    proxy.receive({ type: 'STATE_STORAGE_RESPONSE', version: 1, instanceId: 'i', sequence: 1, operation: 'read', result: { status: 'missing' } });
    proxy.receive({ type: 'STATE_STORAGE_RESPONSE', version: 1, instanceId: 'i', sequence: 2, operation: 'release', result: { status: 'released' } });
    expect((await read).status).toBe('missing');expect((await release).status).toBe('released');
    expect((await proxy.storage.remove(address)).status).toBe('failed');expect(proxy.getStats().sequence).toBe(2);
});
it('B14/B16: exhausted sequence refuses before send and never wraps', async () => {
    const sent: StateStorageRequest[] = [], proxy = createStateStorageProxy('i', { ...defaults, maxSequence: 1 }, r => { sent.push(r); });
    const first = proxy.storage.read(address);proxy.receive({ type: 'STATE_STORAGE_RESPONSE', version: 1, instanceId: 'i', sequence: 1, operation: 'read', result: { status: 'missing' } });
    await first;expect(await proxy.storage.remove(address)).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'REVISION_EXHAUSTED' } });
    expect(sent).toHaveLength(1);expect(proxy.getStats().sequence).toBe(1);
});
