import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeCloseReport } from '../../spi/runtime/close.interface.js';
import { closeTimeout, closeVoid, createCloseHandle, sandboxCloseReport, newCloseState, mergeCloseReport, addCloseFailure, snapshotClose, displayCloseId } from './close-handle.js';
import { createMemoryStateStorage } from '../../adapters/storage/memory-state-storage.js';
import { createAppStatePersistence } from '../../worker-runtime/state-persistence.js';
import { failedMutation, unknownMutation } from '../../core/persistence/state-storage.js';

function fixture() {
    let finish!: (value: RuntimeCloseReport) => void;
    const report: RuntimeCloseReport = {
        scope: 'runtime', state: 'closing', intent: 'close', ok: false, hasFailures: false, resourcesReleased: false, verification: 'managed',
        apps: { accepted: 0, settled: 0, pending: 0, notVerifiedReleased: 0 }, desktops: { accepted: 0, settled: 0, pending: 0, notVerifiedReleased: 0 },
        pendingTasks: 0, unverifiedParticipants: 0,
        persistence: { managedApps: 0, unnegotiatedApps: 0, notUsedApps: 0, closeReceipts: 0, missingCloseReceipts: 0, confirmedFlushes: 0, failedFlushes: 0, absentFlushes: 0, unknownApps: 0, unsavedKeys: 0 },
        resources: { retainedStorageOwners: 0, storageActualIO: 0, openingStorageOwners: 0 },
        workers: { ownership: 'not-owned', report: null }, beforeClose: 'not-provided',
        cleanup: { signalBus: 'not-owned', llmOutput: 'not-owned', logger: 'not-owned' },
        failures: [], failureCount: 0, samplesTruncated: false,
    };
    const completion = new Promise<RuntimeCloseReport>(resolve => { finish = resolve; });
    const handle = createCloseHandle(() => report, completion);
    const settled = (extra = {}) => ({ ...report, state: 'settled' as const, ok: true, resourcesReleased: true, ...extra });
    return { report, handle, finish: (extra = {}) => finish(settled(extra)) };
}
afterEach(() => { vi.useRealTimers();vi.restoreAllMocks(); });
it('C2-01/03 independent frozen snapshots and deadlines never settle the actual handle', async () => {
    vi.useFakeTimers();const f = fixture(), before = f.handle.inspect();
    expect(Object.isFrozen(f.handle)).toBe(true);expect(Object.isFrozen(before.resources)).toBe(true);expect(f.handle.inspect()).not.toBe(before);
    const deadline = f.handle.wait({ timeoutMs: 1 });await vi.advanceTimersByTimeAsync(1);expect(await deadline).toMatchObject({ status: 'deadline', report: { state: 'closing', resourcesReleased: false } });
    expect(vi.getTimerCount()).toBe(0);const second = f.handle.wait({ timeoutMs: 300000 });f.finish();expect((await second).status).toBe('settled');
    expect(await f.handle.completion).toMatchObject({ state: 'settled', ok: true });expect(before.state).toBe('closing');expect(before.resourcesReleased).toBe(false);expect(vi.getTimerCount()).toBe(0);
});
it('C2-02 invalid options are rejected before timers and the seventeenth observer cannot allocate', async () => {
    vi.useFakeTimers();const f = fixture();expect(closeTimeout()).toBe(30000);
    for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 300001, Number.MAX_SAFE_INTEGER, null, '1']) await expect(f.handle.wait({ timeoutMs } as any)).rejects.toHaveProperty('code', 'CLOSE_OPTIONS_INVALID');
    await expect(f.handle.wait(Object.defineProperty({}, 'timeoutMs', { get() { throw Error('private getter'); } }))).rejects.toMatchObject({ code: 'CLOSE_OPTIONS_INVALID', message: 'CLOSE_OPTIONS_INVALID' });
    expect(vi.getTimerCount()).toBe(0);const waits = Array.from({ length: 16 }, () => f.handle.wait());expect(vi.getTimerCount()).toBe(16);
    await expect(f.handle.wait()).rejects.toHaveProperty('code', 'CLOSE_OBSERVER_LIMIT');expect(vi.getTimerCount()).toBe(16);f.finish();await Promise.all(waits);expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 20; i++) expect((await f.handle.wait({ timeoutMs: 1 })).status).toBe('settled');expect(vi.getTimerCount()).toBe(0);
});
it('C2-02 repeated expired observers do not attach unbounded completion callbacks', async () => {
    vi.useFakeTimers();const f = fixture(), then = vi.spyOn(f.handle.completion, 'then');
    for (let i = 0; i < 100; i++) { const wait = f.handle.wait({ timeoutMs: 1 });await vi.advanceTimersByTimeAsync(1);expect((await wait).status).toBe('deadline'); }
    expect(then).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);f.finish();await f.handle.completion;
});
it('labels a rejected close completion without the retired legacy name', async () => {
    const failure = Error('private completion failure');
    const handle = createCloseHandle(() => fixture().report, Promise.reject(failure));
    const waiting = handle.wait();
    await expect(waiting).rejects.toHaveProperty('code', 'CLOSE_COMPLETION_FAILED');
    await expect(handle.completion).rejects.toBe(failure);
});
it('C2-01 failed reports keep old void wrappers rejected, while mere unverified preserves compatibility', async () => {
    const f = fixture(), failed = closeVoid(f.handle.completion, 'RUNTIME_CLOSE_FAILED');f.finish({ ok: false, hasFailures: true });
    await expect(failed).rejects.toMatchObject({ code: 'RUNTIME_CLOSE_FAILED', report: { hasFailures: true } });await expect(failed).rejects.toHaveProperty('code', 'RUNTIME_CLOSE_FAILED');
    const old = fixture(), compatible = closeVoid(old.handle.completion, 'RUNTIME_CLOSE_FAILED');old.finish({ ok: false, verification: 'unverified', resourcesReleased: false });await compatible;
});
function envelope(lifecycle: any, extra: any = {}) {
    return { state: 'closing', intent: 'close', ok: false, resourcesReleased: false, issues: [],
        host: { state: 'closing', worker: 'owned', resourcesReleased: false, issues: [],
            interactions: { closed: true, retainedOperations: 0, retainedBytes: 0 },
            storage: { support: 'managed', unsafe: false, actualIO: 0, pending: 0, opening: false, ownerRetained: true, uncertain: false, lifecycle } }, ...extra } as any;
}
it('C2-25 Q01 rejected negotiation remains mixed without fabricating unknown resources or managed missing receipts', () => {
    const input = envelope(undefined, { state: 'settled', resourcesReleased: true });input.host.storage = { ...input.host.storage, support: 'rejected', ownerRetained: false, release: { status: 'released' } };
    const report = sandboxCloseReport(input, 'd', 'a');expect(report).toMatchObject({ ok: false, hasFailures: false, resourcesReleased: true, verification: 'mixed',
        unverifiedParticipants: 0, apps: { accepted: 1, settled: 1, pending: 0, notVerifiedReleased: 0 },
        persistence: { unnegotiatedApps: 1, managedApps: 0, missingCloseReceipts: 0, absentFlushes: 0, unknownApps: 0 } });
});
it.each(['normal', 'failed', 'unknown', 'unmount'])('C2-25 Q02 actual B2 controller/memory %s report keeps progress separate from known failure', async mode => {
    const backend = createMemoryStateStorage({ maxStoredKeys: 4, maxStoredBytes: 100000, maxRecordBytes: 10000, maxAddressBytes: 1024, maxActiveOwners: 2, maxClaimedNamespaces: 2 });
    const opened = backend.open('i');if (opened.status !== 'opened') throw Error('fixture');
    const storage = { ...opened.storage, ...(mode === 'failed' ? { replace: async () => failedMutation('IO_FAILED') } : mode === 'unknown' ? { replace: async () => unknownMutation() } : {}) };
    const managed = createAppStatePersistence({ instanceId: 'i', desktopId: 'd', appKey: 'a', storage, now: () => 1 });
    const bound = managed.port.bind('k', 0, { hydrate: false });if (bound.status !== 'bound') throw Error('fixture bind');const recovery = await bound.binding.recovery;bound.binding.confirmInitialization(recovery, { status: 'ready' });bound.binding.update(3);
    await managed.shutdown();const progress = envelope(managed.getReport()), before = sandboxCloseReport(progress, 'd', 'a');
    expect(managed.getReport()).toMatchObject({ ok: false, unmount: 'pending' });expect(before.hasFailures).toBe(mode === 'failed' || mode === 'unknown');
    expect(before.persistence.closeReceipts).toBe(1);expect(before.persistence.confirmedFlushes).toBe(mode === 'normal' || mode === 'unmount' ? 1 : 0);
    const lifecycle = await managed.close(() => { if (mode === 'unmount') throw Error('private unmount'); });
    const final = envelope(lifecycle, { state: 'settled', resourcesReleased: true });final.host = { ...final.host, state: 'settled', worker: 'exited', resourcesReleased: true,
        storage: { ...final.host.storage, ownerRetained: false, release: { status: 'released' } } };
    const report = sandboxCloseReport(final, 'd', 'a');expect(report.resourcesReleased).toBe(true);expect(report.ok).toBe(mode === 'normal');expect(backend.getStats().activeOwners).toBe(0);
    expect(report.persistence.unknownApps).toBe(mode === 'unknown' ? 1 : 0);expect(before.state).toBe('closing');
    if (mode === 'unmount') { expect(report.persistence.confirmedFlushes).toBe(1);expect(report.persistence.failedFlushes).toBe(0);expect(report.failures.some(x => x.codes.includes('APP_UNMOUNT_FAILED'))).toBe(true); }
    if (mode === 'normal') {
        const missing = sandboxCloseReport({ ...final, host: { ...final.host, storage: { ...final.host.storage, lifecycle: progress.host.storage.lifecycle } } }, 'd', 'a');
        expect(missing.hasFailures).toBe(true);expect(missing.persistence.closeReceipts).toBe(1);expect(missing.persistence.missingCloseReceipts).toBe(0);
    }
});
it('keeps callback failure separate from released resources through Runtime aggregation', async () => {
    const backend = createMemoryStateStorage({ maxStoredKeys: 4, maxStoredBytes: 100000, maxRecordBytes: 10000,
        maxAddressBytes: 1024, maxActiveOwners: 2, maxClaimedNamespaces: 2 });
    const opened = backend.open('i'); if (opened.status !== 'opened') throw Error('fixture');
    const managed = createAppStatePersistence({ instanceId: 'i', desktopId: 'd', appKey: 'a', storage: opened.storage });
    const lifecycle = await managed.close(() => {});
    const input = envelope(lifecycle, { state: 'settled', resourcesReleased: true });
    input.host = { ...input.host, state: 'settled', worker: 'exited', resourcesReleased: true,
        appCleanup: { support: 'managed', report: { protocol: 'app-lifecycle-v2', instanceId: 'i',
            state: 'failed', issues: ['APP_CLEANUP_FAILED'] } },
        storage: { ...input.host.storage, ownerRetained: false, release: { status: 'released' } } };
    const child = sandboxCloseReport(input, 'd', 'a');
    expect(child).toMatchObject({ ok: false, hasFailures: true, resourcesReleased: true,
        apps: { settled: 1, notVerifiedReleased: 0 },
        appCleanup: { managedApps: 1, completedApps: 0, failedApps: 1 },
        persistence: { confirmedFlushes: 1, failedFlushes: 0, unsavedKeys: 0 },
        resources: { retainedStorageOwners: 0, storageActualIO: 0 },
    });
    expect(child.failures).toEqual([{ stage: 'apps', codes: ['APP_CLOSE_FAILED'], desktopId: 'd', appId: 'a' }]);
    expect(backend.getStats().activeOwners).toBe(0);

    const state = newCloseState('runtime'); mergeCloseReport(state, child); state.state = 'settled';
    const report = snapshotClose(state);
    expect(report).toMatchObject({ ok: false, hasFailures: true, resourcesReleased: true,
        apps: { notVerifiedReleased: 0 }, appCleanup: { failedApps: 1 } });
    await expect(closeVoid(Promise.resolve(report), 'RUNTIME_CLOSE_FAILED')).rejects.toMatchObject({
        code: 'RUNTIME_CLOSE_FAILED', report: { resourcesReleased: true, hasFailures: true },
    });
});
it('C2-25 bounded failure samples and Unicode display IDs preserve complete counts and pending resource facts', () => {
    const state = newCloseState('runtime'), id = '\u0001'.repeat(1000), raw = '🙂'.repeat(100);
    expect(displayCloseId(raw)).toBe('🙂'.repeat(64));expect(raw).toHaveLength(200);
    const codes: RuntimeCloseReport['failures'][number]['codes'] = ['INSTALL_FAILED', 'DELETE_FAILED', 'APP_CLOSE_FAILED', 'APP_CLOSE_DEADLINE_EXCEEDED', 'RESOURCE_RELEASE_FAILED', 'WORKER_ERROR', 'WORKER_TERMINATION_FAILED', 'PERSISTENCE_CLOSE_FAILED', 'APP_UNMOUNT_FAILED', 'APP_DELETE_FAILED'];
    for (let i = 0; i < 100; i++) {
        const child = newCloseState('app-manager');child.apps = { accepted: 1, settled: 0, pending: 1, notVerifiedReleased: 1 };child.resourcesReleased = false;child.resources.retainedStorageOwners = 1;
        addCloseFailure(child, 'apps', [...codes, codes[0]], { desktopId: id + i, appId: id });mergeCloseReport(state, snapshotClose(child));
    }
    const report = snapshotClose(state);expect(report.failureCount).toBe(1000);expect(report.failures).toHaveLength(16);expect(report.failures.every(x => x.codes.length <= 8)).toBe(true);expect(report.samplesTruncated).toBe(true);
    expect(report.apps).toEqual({ accepted: 100, settled: 0, pending: 100, notVerifiedReleased: 100 });expect(report.resources.retainedStorageOwners).toBe(100);expect(report.resourcesReleased).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(report), 'utf8')).toBeLessThanOrEqual(65536);expect(Object.isFrozen(report.failures[0].codes)).toBe(true);
});
