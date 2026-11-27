import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeCloseReport } from '../../spi/runtime/close.interface.js';
import { closeTimeout, createCloseHandle, recordAppClose, newCloseState, mergeCloseReport, addCloseFailure, snapshotClose, displayCloseId } from './close-handle.js';

function fixture() {
    let finish!: (value: RuntimeCloseReport) => void;
    const report: RuntimeCloseReport = {
        scope: 'runtime', state: 'closing', ok: false, hasFailures: false, resourcesReleased: false, verification: 'managed',
        apps: { accepted: 0, settled: 0, pending: 0, notVerifiedReleased: 0 }, desktops: { accepted: 0, settled: 0, pending: 0, notVerifiedReleased: 0 },
        pendingTasks: 0, unverifiedParticipants: 0,
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
    expect(Object.isFrozen(f.handle)).toBe(true);expect(Object.isFrozen(before.apps)).toBe(true);expect(f.handle.inspect()).not.toBe(before);
    const deadline = f.handle.wait({ timeoutMs: 1 });await vi.advanceTimersByTimeAsync(1);expect(await deadline).toMatchObject({ status: 'deadline', report: { state: 'closing', resourcesReleased: false } });
    expect(vi.getTimerCount()).toBe(0);const second = f.handle.wait({ timeoutMs: 300000 });f.finish();
    const final = await f.handle.completion;
    expect(final).toMatchObject({ state: 'settled', ok: true });
    expect(f.handle.inspect()).toBe(final);
    expect((await second).report).toBe(final);
    expect((await f.handle.wait()).report).toBe(final);
    expect(Object.isFrozen(final.apps)).toBe(true);
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
function envelope(extra: any = {}) {
    return { state: 'closing', ok: false, resourcesReleased: false, issues: [],
        host: { state: 'closing', worker: 'owned', resourcesReleased: false, issues: [],
            interactions: { closed: true, retainedOperations: 0 } }, ...extra } as any;
}
it('records a clean App close without any persistence field', () => {
    const input = envelope({ state: 'settled' });
    input.host = { ...input.host, resourcesReleased: true, worker: 'exited' };
    const report = appReport(input);
    expect(report).toMatchObject({ ok: true, resourcesReleased: true, verification: 'managed',
        apps: { accepted: 1, settled: 1, pending: 0, notVerifiedReleased: 0 } });
    expect(report).not.toHaveProperty('persistence');
});
it('keeps callback failure separate from released resources through Runtime aggregation', async () => {
    const input = envelope({ state: 'settled', resourcesReleased: true });
    input.host = { ...input.host, state: 'settled', worker: 'exited', resourcesReleased: true,
        appCleanup: { support: 'managed', report: { protocol: 'app-lifecycle-v3', instanceId: 'i',
            state: 'failed', issues: ['APP_CLEANUP_FAILED'] } } };
    const child = appReport(input);
    expect(child).toMatchObject({ ok: false, hasFailures: true, resourcesReleased: true,
        apps: { settled: 1, notVerifiedReleased: 0 },
        appCleanup: { managedApps: 1, completedApps: 0, failedApps: 1 },
    });
    expect(child.failures).toEqual([{ stage: 'apps', codes: ['APP_CLOSE_FAILED'], desktopId: 'd', appId: 'a' }]);

    const state = newCloseState('runtime'); mergeCloseReport(state, child); state.state = 'settled';
    const report = snapshotClose(state);
    expect(report).toMatchObject({ ok: false, hasFailures: true, resourcesReleased: true,
        apps: { notVerifiedReleased: 0 }, appCleanup: { failedApps: 1 } });

});
it('C2-25 bounded failure samples and Unicode display IDs preserve complete counts and pending resource facts', () => {
    const state = newCloseState('runtime'), id = '\u0001'.repeat(1000), raw = '🙂'.repeat(100);
    expect(displayCloseId(raw)).toBe('🙂'.repeat(64));expect(raw).toHaveLength(200);
    const codes: RuntimeCloseReport['failures'][number]['codes'] = ['INSTALL_FAILED', 'APP_CLOSE_FAILED', 'APP_CLOSE_DEADLINE_EXCEEDED', 'RESOURCE_RELEASE_FAILED', 'WORKER_ERROR', 'WORKER_TERMINATION_FAILED', 'WORKER_EXITED_UNEXPECTEDLY', 'APP_UNMOUNT_FAILED'];
    for (let i = 0; i < 100; i++) {
        const child = newCloseState('app');child.apps = { accepted: 1, settled: 0, pending: 1, notVerifiedReleased: 1 };child.resourcesReleased = false;
        addCloseFailure(child, 'apps', [...codes, codes[0]], { desktopId: id + i, appId: id });mergeCloseReport(state, snapshotClose(child));
    }
    const report = snapshotClose(state);expect(report.failureCount).toBe(800);expect(report.failures).toHaveLength(16);expect(report.failures.every(x => x.codes.length <= 8)).toBe(true);expect(report.samplesTruncated).toBe(true);
    expect(report.apps).toEqual({ accepted: 100, settled: 0, pending: 100, notVerifiedReleased: 100 });expect(report.resourcesReleased).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(report), 'utf8')).toBeLessThanOrEqual(65536);expect(Object.isFrozen(report.failures[0].codes)).toBe(true);
});
