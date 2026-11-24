import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeCloseReport } from '../../spi/runtime/close.interface.js';
import { closeTimeout, createCloseHandle, recordAppClose, newCloseState, mergeCloseReport, addCloseFailure, snapshotClose, displayCloseId } from './close-handle.js';
import { createMemoryStateStorage } from '../../adapters/storage/memory-state-storage.js';
import { createAppStatePersistence } from '../../worker-runtime/state-persistence.js';
import { failedMutation, unknownMutation } from '@aotui/core/persistence';

function fixture() {
    let finish!: (value: RuntimeCloseReport) => void;
    const report: RuntimeCloseReport = {
        scope: 'runtime', state: 'closing', ok: false, hasFailures: false, resourcesReleased: false, verification: 'managed',
        apps: { accepted: 0, settled: 0, pending: 0, notVerifiedReleased: 0 }, desktops: { accepted: 0, settled: 0, pending: 0, notVerifiedReleased: 0 },
        pendingTasks: 0, unverifiedParticipants: 0,
        resources: { retainedOwners: 0, pendingOperations: 0 },
        workers: { ownership: 'not-owned', report: null },
        cleanup: { signalBus: 'not-owned', logger: 'not-owned' },
        failures: [], failureCount: 0, samplesTruncated: false,
    };
    const completion = new Promise<RuntimeCloseReport>(resolve => { finish = resolve; });
    const handle = createCloseHandle(() => snapshotClose(structuredClone(report)), completion);
    const settled = (extra = {}) => snapshotClose({ ...structuredClone(report), state: 'settled' as const, resourcesReleased: true, ...extra });
    return { report, handle, finish: (extra = {}) => finish(settled(extra)) };
}
afterEach(() => { vi.useRealTimers();vi.restoreAllMocks(); });
it('C2-01/03 independent frozen snapshots and deadlines never settle the actual handle', async () => {
    vi.useFakeTimers();const f = fixture(), before = f.handle.inspect();
    expect(Object.isFrozen(f.handle)).toBe(true);expect(Object.isFrozen(before.resources)).toBe(true);expect(f.handle.inspect()).not.toBe(before);
    const deadline = f.handle.wait({ timeoutMs: 1 });await vi.advanceTimersByTimeAsync(1);expect(await deadline).toMatchObject({ status: 'deadline', report: { state: 'closing', resourcesReleased: false } });
    expect(vi.getTimerCount()).toBe(0);const second = f.handle.wait({ timeoutMs: 300000 });f.finish();
    const final = await f.handle.completion;
    expect(final).toMatchObject({ state: 'settled', ok: true });
    expect(f.handle.inspect()).toBe(final);
    expect((await second).report).toBe(final);
    expect((await f.handle.wait()).report).toBe(final);
    expect(Object.isFrozen(final.resources)).toBe(true);
    expect(before.state).toBe('closing');expect(before.resourcesReleased).toBe(false);expect(vi.getTimerCount()).toBe(0);
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
    const handle = createCloseHandle(() => snapshotClose(fixture().report), Promise.reject(failure));
    const waiting = handle.wait();
    await expect(waiting).rejects.toHaveProperty('code', 'CLOSE_COMPLETION_FAILED');
    await expect(handle.completion).rejects.toBe(failure);
});
function appReport(input: any) {
    const state = newCloseState('app');
    state.state = input.state;
    recordAppClose(state, input.host, { desktopId: 'd', appId: 'a' }, new Set(input.issues));
    return snapshotClose(state);
}
function envelope(lifecycle: any, extra: any = {}) {
    return { state: 'closing', ok: false, resourcesReleased: false, issues: [],
        host: { state: 'closing', worker: 'owned', resourcesReleased: false, issues: [],
            interactions: { closed: true, retainedOperations: 0 },
            storage: { support: 'managed', unsafe: false, actualIO: 0, pending: 0, opening: false, ownerRetained: true, uncertain: false, lifecycle } }, ...extra } as any;
}
it('omits the storage summary when the App never requested it', () => {
    const input = envelope(undefined, { state: 'settled' });
    input.host = { ...input.host, resourcesReleased: true, worker: 'exited', storage: undefined };
    const report = appReport(input);
    expect(report).toMatchObject({ ok: true, resourcesReleased: true, verification: 'managed',
        apps: { accepted: 1, settled: 1, pending: 0, notVerifiedReleased: 0 } });
    expect(report).not.toHaveProperty('persistence');
});
it.each(['normal', 'failed', 'unknown', 'unmount', 'both'])('C2-25 Q02 actual controller/memory %s report keeps App and storage failures separate', async mode => {
    const backend = createMemoryStateStorage({ maxStoredKeys: 4, maxStoredBytes: 100000, maxRecordBytes: 10000, maxAddressBytes: 1024, maxActiveOwners: 2, maxClaimedNamespaces: 2 });
    const opened = backend.open('i');if (opened.status !== 'opened') throw Error('fixture');
    const unmountFailed = mode === 'unmount' || mode === 'both';
    const storageFailed = mode === 'failed' || mode === 'both' || mode === 'unknown';
    const storage = { ...opened.storage, ...(storageFailed ? { replace: async () => mode === 'unknown' ? unknownMutation() : failedMutation('IO_FAILED') } : {}) };
    const managed = createAppStatePersistence({ instanceId: 'i', desktopId: 'd', appKey: 'a', storage, now: () => 1 });
    const progress = envelope(managed.getReport()), before = appReport(progress);
    expect(managed.getReport()).toBeUndefined();expect(before.hasFailures).toBe(false);
    expect(before.persistence!.closeReceipts).toBe(0);expect(before.persistence!.confirmedFlushes).toBe(0);
    const lifecycle = await managed.close(async () => {
        await managed.port.save('k', 3).catch(() => {});
        if (unmountFailed) throw Error('private unmount');
    });
    const final = envelope(lifecycle, { state: 'settled', resourcesReleased: true,
        issues: storageFailed && !unmountFailed ? ['PERSISTENCE_CLOSE_FAILED'] : [] });
    final.host = { ...final.host, state: 'settled', worker: 'exited', resourcesReleased: true,
        storage: { ...final.host.storage, ownerRetained: false, release: { status: 'released' } } };
    const report = appReport(final);expect(report.resourcesReleased).toBe(true);expect(report.ok).toBe(mode === 'normal');expect(backend.getStats().activeOwners).toBe(0);
    expect(report.persistence!.unknownApps).toBe(mode === 'unknown' ? 1 : 0);expect(before.state).toBe('closing');
    expect(report.persistence).toMatchObject({ confirmedFlushes: storageFailed ? 0 : 1, failedFlushes: storageFailed ? 1 : 0 });
    expect(report.failures.some(x => x.stage === 'persistence')).toBe(storageFailed);
    expect(report.failures.some(x => x.stage === 'apps')).toBe(unmountFailed);
    expect(report.failures.some(x => x.codes.includes('APP_UNMOUNT_FAILED'))).toBe(unmountFailed);
    if (mode === 'normal') {
        const missing = appReport({ ...final, host: { ...final.host, storage: { ...final.host.storage, lifecycle: progress.host.storage.lifecycle } } });
        expect(missing.hasFailures).toBe(true);expect(missing.persistence!.closeReceipts).toBe(0);expect(missing.persistence!.missingCloseReceipts).toBe(1);
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
    const child = appReport(input);
    expect(child).toMatchObject({ ok: false, hasFailures: true, resourcesReleased: true,
        apps: { settled: 1, notVerifiedReleased: 0 },
        appCleanup: { managedApps: 1, completedApps: 0, failedApps: 1 },
        persistence: { confirmedFlushes: 1, failedFlushes: 0, unsavedKeys: 0 },
        resources: { retainedOwners: 0, pendingOperations: 0 },
    });
    expect(child.failures).toEqual([{ stage: 'apps', codes: ['APP_CLOSE_FAILED'], desktopId: 'd', appId: 'a' }]);
    expect(backend.getStats().activeOwners).toBe(0);

    const state = newCloseState('runtime'); mergeCloseReport(state, child); state.state = 'settled';
    const report = snapshotClose(state);
    expect(report).toMatchObject({ ok: false, hasFailures: true, resourcesReleased: true,
        apps: { notVerifiedReleased: 0 }, appCleanup: { failedApps: 1 } });

});
it('C2-25 bounded failure samples and Unicode display IDs preserve complete counts and pending resource facts', () => {
    const state = newCloseState('runtime'), id = '\u0001'.repeat(1000), raw = '🙂'.repeat(100);
    expect(displayCloseId(raw)).toBe('🙂'.repeat(64));expect(raw).toHaveLength(200);
    const codes: RuntimeCloseReport['failures'][number]['codes'] = ['INSTALL_FAILED', 'APP_CLOSE_FAILED', 'APP_CLOSE_DEADLINE_EXCEEDED', 'RESOURCE_RELEASE_FAILED', 'WORKER_ERROR', 'WORKER_TERMINATION_FAILED', 'PERSISTENCE_CLOSE_FAILED', 'APP_UNMOUNT_FAILED'];
    for (let i = 0; i < 100; i++) {
        const child = newCloseState('app');child.apps = { accepted: 1, settled: 0, pending: 1, notVerifiedReleased: 1 };child.resourcesReleased = false;child.resources.retainedOwners = 1;
        addCloseFailure(child, 'apps', [...codes, codes[0]], { desktopId: id + i, appId: id });mergeCloseReport(state, snapshotClose(child));
    }
    const report = snapshotClose(state);expect(report.failureCount).toBe(800);expect(report.failures).toHaveLength(16);expect(report.failures.every(x => x.codes.length <= 8)).toBe(true);expect(report.samplesTruncated).toBe(true);
    expect(report.apps).toEqual({ accepted: 100, settled: 0, pending: 100, notVerifiedReleased: 100 });expect(report.resources.retainedOwners).toBe(100);expect(report.resourcesReleased).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(report), 'utf8')).toBeLessThanOrEqual(65536);expect(Object.isFrozen(report.failures[0].codes)).toBe(true);
});
