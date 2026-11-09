import { afterEach, describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.js';
import { addCloseFailure, createCloseHandle, freezeClose, newCloseState, snapshotClose } from './close-handle.js';
import type { AppManagerCloseReport } from '../../spi/runtime/close.interface.js';
import { SignalBus } from './signal-bus.js';
import { DesktopLogger } from './desktop-logger.js';
import { LLMOutputChannelService } from './llm-output-channel.js';

function appBarrier() {
    const state = newCloseState('app-manager');state.resourcesReleased = false;
    const report = (): AppManagerCloseReport => freezeClose({ ...snapshotClose(state), scope: 'app-manager' });
    let finish!: (report: AppManagerCloseReport) => void;
    const completion = new Promise<AppManagerCloseReport>(resolve => { finish = resolve; });
    const handle = createCloseHandle(report, completion);
    return { state, handle, manager: { beginClose: vi.fn(() => handle), cleanupAsync: vi.fn(async () => handle.completion), getInstalledApps: () => [], getAppStates: () => [] },
        release(fail = false) { if (fail) addCloseFailure(state, 'apps', ['APP_CLOSE_FAILED']);state.state = 'settled';state.resourcesReleased = true;finish(report()); } };
}
afterEach(() => { vi.useRealTimers();vi.restoreAllMocks(); });

describe('Desktop actual close ownership', () => {
    it('default empty close is managed, shared and freezes fresh snapshots', async () => {
        const desktop = new Desktop('empty');const handle = desktop.beginClose();const snapshot = handle.inspect();
        expect(desktop.beginClose()).toBe(handle);const voidPromise = desktop.dispose();expect(desktop.dispose()).toBe(voidPromise);
        expect(Object.isFrozen(snapshot.cleanup)).toBe(true);expect(handle.inspect()).not.toBe(snapshot);
        const report = await handle.completion;await voidPromise;
        expect(report).toMatchObject({ ok: true, resourcesReleased: true, verification: 'managed', state: 'settled', desktops: { accepted: 1, settled: 1, pending: 0 } });
        expect(snapshot.state).toBe('closing');expect(report.cleanup).toMatchObject({ signalBus: 'done', llmOutput: 'done', logger: 'done' });
        expect(report.cleanup).not.toHaveProperty('registry');
    });
    it('beginClose closes admission immediately, waits for App cleanup, and shares one close handle', async () => {
        const child = appBarrier(), desktop = new Desktop('join', { appManager: child.manager as any });
        const callback = vi.fn(async () => {}), handle = desktop.beginClose({ beforeClose: callback });
        expect(desktop.beginClose({ beforeClose: callback })).toBe(handle);
        await expect(desktop.openApp('x')).rejects.toMatchObject({ code: 'DESKTOP_DISPOSED' });
        await expect(desktop.installDynamicWorkerApp('x')).rejects.toMatchObject({ code: 'DESKTOP_DISPOSED' });
        expect(() => desktop.beginClose({ beforeClose: async () => {} })).toThrow('LIFECYCLE_CONFLICT');
        expect(() => desktop.beginClose({ intent: 'delete' })).toThrow('LIFECYCLE_CONFLICT');
        expect(child.manager.beginClose).toHaveBeenCalledTimes(1);expect(callback).not.toHaveBeenCalled();
        child.release();await handle.completion;expect(callback).toHaveBeenCalledTimes(1);expect(child.manager.cleanupAsync).toHaveBeenCalledOnce();
        expect(desktop.beginClose({ beforeClose: callback })).toBe(handle);
    });
    it('dispose first prevents a later callback; delete intent cannot upgrade close', async () => {
        const desktop = new Desktop('first');const closing = desktop.dispose();
        expect(() => desktop.beginClose({ beforeClose: async () => {} })).toThrow('LIFECYCLE_CONFLICT');
        await expect(desktop.delete()).rejects.toMatchObject({ code: 'LIFECYCLE_CONFLICT' });await closing;
        const deleted = new Desktop('deleted');const handle = deleted.beginClose({ intent: 'delete' });expect(deleted.beginClose()).toBe(handle);await handle.completion;
    });
    it('eligibility expires independently of a shorter observer and retains the frozen deadline snapshot', async () => {
        vi.useFakeTimers();const child = appBarrier(), desktop = new Desktop('deadline', { appManager: child.manager as any });
        const callback = vi.fn(async () => {}), handle = desktop.beginClose({ timeoutMs: 100, beforeClose: callback });
        const waiting = handle.wait({ timeoutMs: 1 });await vi.advanceTimersByTimeAsync(1);
        const early = await waiting;expect(early.status).toBe('deadline');expect(handle.inspect().beforeClose).toBe('pending');
        child.release();const report = await handle.completion;
        expect(report.beforeClose).toBe('done');expect(callback).toHaveBeenCalledOnce();expect(early.report.state).toBe('closing');expect(vi.getTimerCount()).toBe(0);
    });
    it('never enters a callback after monotonic deadline, even before timer delivery or with wall clock rollback', async () => {
        vi.useFakeTimers();const child = appBarrier(), desktop = new Desktop('late', { appManager: child.manager as any });
        const clock = vi.spyOn(performance, 'now').mockReturnValue(0), callback = vi.fn(async () => {});
        const handle = desktop.beginClose({ timeoutMs: 10, beforeClose: callback });
        vi.setSystemTime(new Date(0));clock.mockReturnValue(11);child.release();
        const report = await handle.completion;expect(report.beforeClose).toBe('skipped-deadline');expect(report.hasFailures).toBe(true);
        expect(callback).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
        await expect(desktop.dispose()).rejects.toMatchObject({ code: 'DESKTOP_CLOSE_FAILED' });
    });
    it('real event-loop blocking cannot start an expired callback before its timer has been delivered', async () => {
        const child=appBarrier(),desktop=new Desktop('blocked-loop',{appManager:child.manager as any}),callback=vi.fn(async()=>{});
        const handle=desktop.beginClose({timeoutMs:1,beforeClose:callback}),end=performance.now()+10;
        // The timer cannot run until this synchronous turn yields; microtasks still see an expired clock.
        while(performance.now()<end) {}
        child.release();const report=await handle.completion;
        expect(callback).not.toHaveBeenCalled();expect(report.beforeClose).toBe('skipped-deadline');expect(report.hasFailures).toBe(true);
    });
    it('entered callback remains supervised past its eligibility and observer deadlines', async () => {
        vi.useFakeTimers();const child = appBarrier();let release!: () => void;
        const callback = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));const desktop = new Desktop('running', { appManager: child.manager as any });
        const handle = desktop.beginClose({ timeoutMs: 10, beforeClose: callback });child.release();
        await vi.advanceTimersByTimeAsync(0);expect(handle.inspect().beforeClose).toBe('running');
        const wait = handle.wait({ timeoutMs: 20 });await vi.advanceTimersByTimeAsync(30);expect((await wait).status).toBe('deadline');
        expect(child.manager.cleanupAsync).not.toHaveBeenCalled();expect(handle.inspect().state).toBe('closing');
        release();expect((await handle.completion).beforeClose).toBe('done');expect(vi.getTimerCount()).toBe(0);
    });
    it('failed drain skips callback; callback failure still attempts all independent cleanup branches', async () => {
        const child = appBarrier(), skipped = vi.fn(async () => {}), desktop = new Desktop('failed-drain', { appManager: child.manager as any });
        const handle = desktop.beginClose({ beforeClose: skipped });child.release(true);
        expect((await handle.completion).beforeClose).toBe('skipped-drain-failed');expect(skipped).not.toHaveBeenCalled();expect(child.manager.cleanupAsync).toHaveBeenCalledOnce();
        const bus = new SignalBus(), logger = new DesktopLogger(), llm = new LLMOutputChannelService();
        const cleanBus = vi.spyOn(bus, 'cleanup').mockImplementation(() => { throw Error('private'); });
        const cleanLog = vi.spyOn(logger, 'cleanup').mockImplementation(() => { throw Error('private'); });
        const cleanLLM = vi.spyOn(llm, 'cleanup');
        const other = new Desktop('failures', { signalBus: bus, logger, llmOutputChannelService: llm });
        const final = await other.beginClose({ beforeClose: async () => { throw Error('user secret'); } }).completion;
        expect(final).toMatchObject({ hasFailures: true, resourcesReleased: false, beforeClose: 'failed', cleanup: { signalBus: 'failed', logger: 'failed', llmOutput: 'done' } });
        expect(cleanBus).toHaveBeenCalledOnce();expect(cleanLog).toHaveBeenCalledOnce();expect(cleanLLM).toHaveBeenCalledOnce();
        expect(JSON.stringify(final)).not.toMatch(/private|user secret/);
    });
    it('uses the single managed AppManager close owner and preserves its report', async () => {
        const child = appBarrier(), desktop = new Desktop('managed', { appManager: child.manager as any });
        const handle = desktop.beginClose();
        expect(child.manager.beginClose).toHaveBeenCalledOnce();expect(handle.inspect().verification).toBe('managed');
        child.release();const report = await handle.completion;
        expect(report).toMatchObject({ ok: true, hasFailures: false, resourcesReleased: true, verification: 'managed', apps: { accepted: 0, settled: 0, pending: 0 } });
        expect(child.manager.cleanupAsync).toHaveBeenCalledOnce();
    });
});
