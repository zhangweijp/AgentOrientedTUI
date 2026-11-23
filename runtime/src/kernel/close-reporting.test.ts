import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime, createDesktopId, type IKernel } from '../index.js';
import { Desktop } from '../engine/core/desktop.js';
import { Kernel } from './index.js';

const localPath = fileURLToPath(new URL('../../test/fixtures/pending-app/', import.meta.url));

const barrier = () => Promise.withResolvers<void>();
const id = createDesktopId;
const missing = (runtime: IKernel, desktopId: string) =>
    expect(() => runtime.getDesktop(id(desktopId))).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
afterEach(() => { vi.restoreAllMocks();vi.useRealTimers(); });

describe('Kernel close reporting', () => {
    it('rejects new lifecycle work while a closing Desktop catalog remains readable', async () => {
        const runtime = createRuntime(), key = await runtime.createDesktop(id('single'));
        const desktop = runtime.getDesktop(key), gate = barrier();
        await desktop.registerPendingApp({ installationId: 'registered', localPath });
        const closing = runtime.beginDesktopShutdown(key, { beforeClose: () => gate.promise });
        await expect(desktop.openApp('registered')).rejects.toHaveProperty('code', 'DESKTOP_DISPOSED');
        await expect(runtime.reinitializeDesktopApps(key)).rejects.toHaveProperty('code', 'DESKTOP_DISPOSED');
        expect(runtime.getDesktop(key)).toBe(desktop);
        expect(desktop.getInstalledApps()).toMatchObject([{ installationId: 'registered', status: 'pending' }]);
        gate.resolve();await closing.completion;
        missing(runtime, key);
        await runtime.shutdown();
    });

    it('reports a missing ID without inventing resources or Desktop counts', async () => {
        const runtime = createRuntime(), key = id('missing');
        await expect(runtime.destroyDesktop(key)).resolves.toBeUndefined();
        expect(await runtime.beginDesktopShutdown(key).completion).toMatchObject({
            found: false, ok: true, desktops: { accepted: 0, settled: 0 }, apps: { accepted: 0 },
        });
        expect(await runtime.beginShutdown().completion).toMatchObject({
            ok: true, resourcesReleased: true, verification: 'managed', desktops: { accepted: 0, settled: 0 },
        });
    });

    it('starts every registered Desktop and stops Runtime and pool admission before waiting', async () => {
        const runtime = createRuntime();
        const slowId = await runtime.createDesktop(id('held'));
        const otherId = await runtime.createDesktop(id('other'));
        const slow = runtime.getDesktop(slowId), other = runtime.getDesktop(otherId);
        const entered = barrier(), gate = barrier();
        const direct = slow.beginClose({ beforeClose: async () => { entered.resolve();await gate.promise; } });
        await entered.promise;
        const install = vi.spyOn(slow, 'installDynamicWorkerApp');
        const shutdown = runtime.beginShutdown();
        try {
            expect(runtime.beginShutdown()).toBe(shutdown);
            expect(other.isClosing).toBe(true);
            expect(shutdown.inspect().workers.report?.state).toBe('closed');
            expect(shutdown.inspect().desktops.accepted).toBe(2);
            for (const call of [() => runtime.createDesktop(), () => runtime.installDynamicWorkerApp(slowId, '/none'),
                () => runtime.reinitializeDesktopApps(slowId)]) await expect(call()).rejects.toHaveProperty('code', 'RUNTIME_SHUTDOWN');
            expect(install).not.toHaveBeenCalled();
            expect(runtime.getDesktop(slowId)).toBe(slow);
            await other.beginClose().completion;
            missing(runtime, otherId);
            expect(runtime.beginDesktopShutdown(slowId)).toBe(direct);
        } finally { gate.resolve(); }
        expect(await shutdown.completion).toMatchObject({ ok: true, resourcesReleased: true,
            workers: { ownership: 'owned', report: { state: 'closed', total: 0 } },
            desktops: { accepted: 2, settled: 2, pending: 0 } });
    });

    it('provides one managed shutdown handle and a stable void Promise', async () => {
        const runtime = createRuntime();
        const key = await runtime.createDesktop(id('empty')), handle = runtime.beginShutdown();
        expect(runtime.beginShutdown()).toBe(handle);
        const first = runtime.shutdown();expect(runtime.shutdown()).toBe(first);
        await expect(runtime.createDesktop()).rejects.toMatchObject({ code: 'RUNTIME_SHUTDOWN' });
        expect(runtime.getAppInteraction(key, 'app', 'instance')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
        const report = await handle.completion;
        await first;
        expect(report).toMatchObject({ ok: true, resourcesReleased: true, workers: { report: { state: 'closed', total: 0 } } });
        expect(Object.isFrozen(report.failures)).toBe(true);
    });

    it('enforces 128 accepted asynchronous calls before invoking more work and restores a slot', async () => {
        const runtime = createRuntime(), key = await runtime.createDesktop();
        const gate = barrier();
        const install = vi.spyOn(runtime.getDesktop(key), 'installDynamicWorkerApp').mockImplementation(async () => {
            await gate.promise;return 'installed';
        });
        const calls = Array.from({ length: 128 }, () => runtime.installDynamicWorkerApp(key, '/controlled'));
        expect(install).toHaveBeenCalledTimes(128);
        await expect(runtime.installDynamicWorkerApp(key, '/controlled')).rejects.toHaveProperty('code', 'LIFECYCLE_CAPACITY_EXCEEDED');
        expect(install).toHaveBeenCalledTimes(128);
        gate.resolve();await Promise.all(calls);
        await runtime.installDynamicWorkerApp(key, '/controlled');
        expect(install).toHaveBeenCalledTimes(129);
        await runtime.shutdown();
    });

    it('settles admitted Desktop creations when shutdown begins before delivery and counts each object once', async () => {
        const runtime = createRuntime(), early = runtime.createDesktop(id('early'));
        const late = runtime.createDesktop(id('late'));
        const shutdown = runtime.beginShutdown();
        expect(shutdown.inspect().pendingTasks).toBe(2);
        expect(shutdown.inspect().desktops.accepted).toBe(2);
        await expect(early).rejects.toHaveProperty('code', 'RUNTIME_SHUTDOWN');
        await expect(late).rejects.toHaveProperty('code', 'RUNTIME_SHUTDOWN');
        expect(await shutdown.completion).toMatchObject({ ok: true, resourcesReleased: true,
            pendingTasks: 0, desktops: { accepted: 2, settled: 2, notVerifiedReleased: 0 } });
        missing(runtime, 'early');
        missing(runtime, 'late');
    });

    it('a deadline neither cancels the entered callback nor makes the ID reusable', async () => {
        vi.useFakeTimers();
        const runtime = createRuntime(), key = await runtime.createDesktop(id('closed'));
        const gate = barrier(), desktop = runtime.getDesktop(key);
        await desktop.registerPendingApp({ installationId: 'registered', localPath });
        const callback = vi.fn(async () => {
            expect(runtime.getDesktop(key).getInstalledApps()).toMatchObject([{ installationId: 'registered' }]);
            await gate.promise;
        });
        const handle = desktop.beginClose({ timeoutMs: 10, beforeClose: callback });
        const waiting = handle.wait({ timeoutMs: 10 });
        await vi.advanceTimersByTimeAsync(0);
        expect(callback).toHaveBeenCalledOnce();
        expect(runtime.beginDesktopShutdown(key, { beforeClose: callback })).toBe(handle);
        await vi.advanceTimersByTimeAsync(11);
        expect(await waiting).toMatchObject({ status: 'deadline', report: { state: 'closing', resourcesReleased: false } });
        await expect(runtime.createDesktop(key)).rejects.toHaveProperty('code', 'DESKTOP_ALREADY_EXISTS');
        expect(handle.inspect().beforeClose).toBe('running');
        gate.resolve();
        expect((await handle.completion).beforeClose).toBe('done');
        await runtime.createDesktop(key);
        expect(runtime.getDesktop(key)).not.toBe(desktop);
        await runtime.shutdown();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an old release notification checks the actual registered object', async () => {
        const runtime = new Kernel(), key = await runtime.createDesktop(id('identity'));
        const old = runtime.getDesktop(key), entered = barrier(), gate = barrier();
        const closing = old.beginClose({ beforeClose: async () => { entered.resolve();await gate.promise; } });
        const desktops = (runtime as unknown as { desktops: Map<string, Desktop> }).desktops;
        try {
            await entered.promise;
            // Force an identity change at the notification seam. Public creation rejects while held.
            desktops.delete(key);
            await runtime.createDesktop(key);
            const successor = runtime.getDesktop(key);
            gate.resolve();
            expect((await closing.completion).resourcesReleased).toBe(true);
            expect(runtime.getDesktop(key)).toBe(successor);
        } finally { gate.resolve();await closing.completion;await runtime.shutdown(); }
    });

    it('a Desktop close exception has a bounded report and leaves the other Desktop closed', async () => {
        const runtime = createRuntime(), failed = await runtime.createDesktop(id('failed'));
        const healthy = await runtime.createDesktop(id('healthy'));
        const desktop = runtime.getDesktop(failed);
        const close = vi.spyOn(desktop, 'beginClose').mockImplementation(() => { throw Error('private failure'); });
        const report = await runtime.beginShutdown().completion;
        expect(report).toMatchObject({ state: 'settled', hasFailures: true, resourcesReleased: false,
            desktops: { accepted: 2, settled: 2, notVerifiedReleased: 1 } });
        expect(report.failures).toContainEqual({ stage: 'admission', desktopId: failed, codes: ['DESKTOP_CLEANUP_FAILED'] });
        expect(JSON.stringify(report)).not.toContain('private failure');
        expect(runtime.getDesktop(failed)).toBe(desktop);
        missing(runtime, healthy);
        close.mockRestore();
        await desktop.beginClose().completion;
    });
});
