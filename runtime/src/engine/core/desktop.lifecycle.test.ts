import { afterEach, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.js';
import { createCloseHandle, newCloseState, snapshotClose } from './close-handle.js';
import type { AppCloseReport } from '../../spi/runtime/close.interface.js';
import { SignalBus } from './signal-bus.js';
import { DesktopLogger } from './desktop-logger.js';

afterEach(() => vi.restoreAllMocks());

it('default empty close is managed, shared and freezes fresh snapshots', async () => {
    const desktop = new Desktop('empty');
    const handle = desktop.beginClose(), before = handle.inspect();
    expect(desktop.beginClose()).toBe(handle);
    expect(Object.isFrozen(before.cleanup)).toBe(true);
    expect(await handle.completion).toMatchObject({ ok: true, resourcesReleased: true, verification: 'managed',
        desktops: { accepted: 1, settled: 1, pending: 0 }, cleanup: { signalBus: 'done', logger: 'done' } });
    expect(before.state).toBe('closing');
    expect(await handle.completion).not.toHaveProperty('persistence');
});

it('stops admission and joins the accepted App before cleaning the Desktop', async () => {
    const state = newCloseState('app');
    state.apps = { accepted: 1, settled: 0, pending: 1, notVerifiedReleased: 1 };
    state.resourcesReleased = false;
    const report = (): AppCloseReport => snapshotClose({ ...structuredClone(state), scope: 'app',
        desktopId: 'joined', appId: 'draft', instanceId: 'i', worker: state.state === 'settled' ? 'exited' : 'owned' });
    const child = Promise.withResolvers<AppCloseReport>();
    const app = { beginClose: vi.fn(() => createCloseHandle(report, child.promise)) };
    const manager = { stopAdmission: () => ({ apps: [app], accepted: [] }), pendingStarts: 0, clearInactiveInstallations: vi.fn() };
    const cleanup = vi.spyOn(DesktopLogger.prototype, 'cleanup');
    const desktop = new Desktop('joined', { appManager: manager as any });
    const handle = desktop.beginClose();
    expect(desktop.beginClose()).toBe(handle);
    await expect(desktop.openApp('draft')).rejects.toHaveProperty('code', 'DESKTOP_DISPOSED');
    expect(app.beginClose).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(handle.inspect().apps).toMatchObject({ pending: 1 });
    state.state = 'settled';
    state.resourcesReleased = true;
    state.apps = { accepted: 1, settled: 1, pending: 0, notVerifiedReleased: 0 };
    child.resolve(report());
    expect(await handle.completion).toMatchObject({ ok: true, apps: { accepted: 1, settled: 1 } });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(manager.clearInactiveInstallations).toHaveBeenCalledOnce();
});

it('reports logger failure separately and retries its release without repeating signal cleanup', async () => {
    const cleanBus = vi.spyOn(SignalBus.prototype, 'cleanup');
    const cleanLog = vi.spyOn(DesktopLogger.prototype, 'cleanup').mockImplementationOnce(() => { throw Error('private'); });
    const desktop = new Desktop('failed-log');
    const first = desktop.beginClose(), report = await first.completion;
    expect(report).toMatchObject({ hasFailures: true, resourcesReleased: false, cleanup: { signalBus: 'done', logger: 'failed' } });
    expect(report.failures).toMatchObject([{ stage: 'logger', codes: ['DESKTOP_CLEANUP_FAILED'] }]);
    expect(JSON.stringify(report)).not.toContain('private');
    expect(await desktop.beginClose().completion).toMatchObject({ hasFailures: true, resourcesReleased: true,
        cleanup: { signalBus: 'done', logger: 'done' }, failures: report.failures });
    expect(await first.completion).toBe(report);
    expect(first.inspect()).toBe(report);
    expect(Object.isFrozen(report.failures[0].codes)).toBe(true);
    expect(cleanBus).toHaveBeenCalledOnce();
    expect(cleanLog).toHaveBeenCalledTimes(2);
});
