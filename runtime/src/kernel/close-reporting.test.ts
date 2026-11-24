import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime, createDesktopId, type IKernel } from '../index.js';
import { Desktop } from '../engine/core/desktop.js';
import { Kernel } from './index.js';
import type { DesktopLogger } from '../engine/core/desktop-logger.js';

const localPath = fileURLToPath(new URL('../../test/fixtures/pending-app/', import.meta.url));

const barrier = () => Promise.withResolvers<void>();
const id = createDesktopId;
const logger = (desktop: unknown) => (desktop as { logger: DesktopLogger }).logger;
const missing = (runtime: IKernel, desktopId: string) =>
    expect(() => runtime.getDesktop(id(desktopId))).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
afterEach(() => { vi.restoreAllMocks();vi.useRealTimers(); });

describe('Kernel close reporting', () => {
    it('rejects new lifecycle work while a closing Desktop catalog remains readable', async () => {
        const runtime = createRuntime(), key = (await runtime.createDesktop(id('single'))).id;
        const desktop = runtime.getDesktop(key), gate = barrier();
        await desktop.registerPendingApp({ installationId: 'registered', localPath });
        vi.spyOn(logger(desktop), 'cleanup').mockImplementation(() => gate.promise);
        const closing = desktop.beginClose();
        await expect(desktop.openApp('registered')).rejects.toHaveProperty('code', 'DESKTOP_DISPOSED');
        expect(runtime.getDesktop(key)).toBe(desktop);
        expect(desktop.listApps()).toMatchObject([{ installationId: 'registered', status: 'pending' }]);
        gate.resolve();await closing.completion;
        missing(runtime, key);
        await runtime.beginClose().completion;
    });

    it('reports a missing ID without inventing resources or Desktop counts', async () => {
        const runtime = createRuntime(), key = id('missing');
        missing(runtime, key);
        expect(await runtime.beginClose().completion).toMatchObject({
            ok: true, resourcesReleased: true, verification: 'managed', desktops: { accepted: 0, settled: 0 },
        });
    });

    it('starts every registered Desktop and stops Runtime and pool admission before waiting', async () => {
        const runtime = createRuntime();
        const slowId = (await runtime.createDesktop(id('held'))).id;
        const otherId = (await runtime.createDesktop(id('other'))).id;
        const slow = runtime.getDesktop(slowId), other = runtime.getDesktop(otherId);
        const entered = barrier(), gate = barrier();
        vi.spyOn(logger(slow), 'cleanup').mockImplementation(async () => { entered.resolve(); await gate.promise; });
        const direct = slow.beginClose();
        await entered.promise;
        const shutdown = runtime.beginClose();
        try {
            expect(runtime.beginClose()).toBe(shutdown);
            expect(other.isClosing).toBe(true);
            expect(shutdown.inspect().workers.report?.state).toBe('closed');
            expect(shutdown.inspect().desktops.accepted).toBe(2);
            await expect(runtime.createDesktop()).rejects.toHaveProperty('code', 'RUNTIME_SHUTDOWN');
            await expect(slow.installDynamicWorkerApp('/none')).rejects.toHaveProperty('code', 'DESKTOP_DISPOSED');
            await expect(other.installDynamicWorkerApp('/none')).rejects.toHaveProperty('code', 'DESKTOP_DISPOSED');
            expect(runtime.getDesktop(slowId)).toBe(slow);
            await other.beginClose().completion;
            missing(runtime, otherId);
            expect(slow.beginClose()).toBe(direct);
        } finally { gate.resolve(); }
        expect(await shutdown.completion).toMatchObject({ ok: true, resourcesReleased: true,
            workers: { ownership: 'owned', report: { state: 'closed', total: 0 } },
            desktops: { accepted: 2, settled: 2, pending: 0 } });
    });

    it('shares one managed close handle and its completion', async () => {
        const runtime = createRuntime();
        const desktop = await runtime.createDesktop(id('empty')), handle = runtime.beginClose();
        expect(runtime.beginClose()).toBe(handle);
        const first = runtime.beginClose().completion;expect(runtime.beginClose().completion).toBe(first);
        await expect(runtime.createDesktop()).rejects.toMatchObject({ code: 'RUNTIME_SHUTDOWN' });
        expect(desktop.getRunningApp('app', 'instance')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
        const report = await handle.completion;
        await first;
        expect(report).toMatchObject({ ok: true, resourcesReleased: true, workers: { report: { state: 'closed', total: 0 } } });
        expect(Object.isFrozen(report.failures)).toBe(true);
    });

    it('bounds pending Desktop creations and restores a slot once they settle', async () => {
        const runtime = createRuntime();
        try {
            const accepted = Array.from({ length: 128 }, () => runtime.createDesktop());
            await expect(runtime.createDesktop()).rejects.toHaveProperty('code', 'LIFECYCLE_CAPACITY_EXCEEDED');
            await Promise.all(accepted);
            const desktop = await runtime.createDesktop();
            expect(runtime.getDesktop(desktop.id)).toBe(desktop);
        } finally { await runtime.beginClose().completion; }
    });

    it('settles admitted Desktop creations when shutdown begins before delivery and counts each object once', async () => {
        const runtime = createRuntime(), early = runtime.createDesktop(id('early'));
        const late = runtime.createDesktop(id('late'));
        const shutdown = runtime.beginClose();
        expect(shutdown.inspect().pendingTasks).toBe(2);
        expect(shutdown.inspect().desktops.accepted).toBe(2);
        await expect(early).rejects.toHaveProperty('code', 'RUNTIME_SHUTDOWN');
        await expect(late).rejects.toHaveProperty('code', 'RUNTIME_SHUTDOWN');
        expect(await shutdown.completion).toMatchObject({ ok: true, resourcesReleased: true,
            pendingTasks: 0, desktops: { accepted: 2, settled: 2, notVerifiedReleased: 0 } });
        missing(runtime, 'early');
        missing(runtime, 'late');
    });

    it('a deadline keeps the logger cleanup supervised and the ID reserved', async () => {
        vi.useFakeTimers();
        const runtime = createRuntime(), key = (await runtime.createDesktop(id('closed'))).id;
        const gate = barrier(), desktop = runtime.getDesktop(key);
        await desktop.registerPendingApp({ installationId: 'registered', localPath });
        const callback = vi.spyOn(logger(desktop), 'cleanup').mockImplementation(async () => {
            expect(runtime.getDesktop(key).listApps()).toMatchObject([{ installationId: 'registered' }]);
            await gate.promise;
        });
        const handle = desktop.beginClose();
        const waiting = handle.wait({ timeoutMs: 10 });
        await vi.advanceTimersByTimeAsync(0);
        expect(callback).toHaveBeenCalledOnce();
        expect(desktop.beginClose()).toBe(handle);
        await vi.advanceTimersByTimeAsync(11);
        expect(await waiting).toMatchObject({ status: 'deadline', report: { state: 'closing', resourcesReleased: false } });
        await expect(runtime.createDesktop(key)).rejects.toHaveProperty('code', 'DESKTOP_ALREADY_EXISTS');
        expect(handle.inspect().cleanup.logger).toBe('pending');
        gate.resolve();
        expect((await handle.completion).cleanup.logger).toBe('done');
        await runtime.createDesktop(key);
        expect(runtime.getDesktop(key)).not.toBe(desktop);
        await runtime.beginClose().completion;
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an old release notification checks the actual registered object', async () => {
        const runtime = new Kernel(), key = (await runtime.createDesktop(id('identity'))).id;
        const old = runtime.getDesktop(key), entered = barrier(), gate = barrier();
        vi.spyOn(logger(old), 'cleanup').mockImplementation(async () => { entered.resolve(); await gate.promise; });
        const closing = old.beginClose();
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
        } finally { gate.resolve();await closing.completion;await runtime.beginClose().completion; }
    });

    it('a Desktop close exception has a bounded report and leaves the other Desktop closed', async () => {
        const runtime = createRuntime(), failed = (await runtime.createDesktop(id('failed'))).id;
        const healthy = (await runtime.createDesktop(id('healthy'))).id;
        const desktop = runtime.getDesktop(failed);
        const close = vi.spyOn(desktop, 'beginClose').mockImplementation(() => { throw Error('private failure'); });
        const report = await runtime.beginClose().completion;
        expect(report).toMatchObject({ state: 'settled', hasFailures: true, resourcesReleased: false,
            desktops: { accepted: 2, settled: 2, notVerifiedReleased: 1 } });
        expect(report.failures).toContainEqual({ stage: 'admission', desktopId: failed, codes: ['DESKTOP_CLEANUP_FAILED'] });
        expect(JSON.stringify(report)).not.toContain('private failure');
        expect(runtime.getDesktop(failed)).toBe(desktop);
        missing(runtime, healthy);
        close.mockRestore();
        expect(await runtime.beginClose().completion).toMatchObject({ hasFailures: true, resourcesReleased: true });
    });
});
