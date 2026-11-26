import { afterEach, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.js';
import { createRuntime } from '../../index.js';
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
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const cleanup = vi.spyOn(DesktopLogger.prototype, 'cleanup');
    const runtime = createRuntime({ executionBackends: { delayed: {
        start(_launch, emit) {
            return {
                send({ kind, id }) {
                    if (kind === 'initialize') { emit({ kind: 'reply', id, status: 'ready' });return; }
                    if (kind === 'close') {
                        entered.resolve();
                        void release.promise.then(() => emit({ kind: 'reply', id, status: 'done', cleanup: { state: 'completed', issues: [] } }));
                        return;
                    }
                    emit({ kind: 'reply', id, status: 'done', ...(kind === 'stop' && { cleanup: { state: 'stopped', issues: [] } }) });
                },
                terminate() { emit({ kind: 'exited' }); },
            };
        },
    } } });
    try {
        const desktop = await runtime.createDesktop('joined');
        await desktop.registerPendingApp({ installationId: 'draft', name: 'draft', backend: 'delayed' });
        await desktop.openApp('draft');
        const handle = desktop.beginClose();
        await entered.promise;
        expect(desktop.beginClose()).toBe(handle);
        await expect(desktop.openApp('draft')).rejects.toHaveProperty('code', 'DESKTOP_DISPOSED');
        expect(cleanup).not.toHaveBeenCalled();
        expect(handle.inspect().apps).toMatchObject({ pending: 1 });
        release.resolve();
        expect(await handle.completion).toMatchObject({ ok: true, apps: { accepted: 1, settled: 1 },
            resourcesReleased: true, cleanup: { signalBus: 'done', logger: 'done' } });
        expect(cleanup).toHaveBeenCalledOnce();
    } finally {
        release.resolve();
        await runtime.beginClose().completion;
    }
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
