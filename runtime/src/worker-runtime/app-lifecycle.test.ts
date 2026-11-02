import { describe, expect, it, vi } from 'vitest';
import { createAppLifecycle } from './app-lifecycle.js';
import { captureAppCleanupReport } from '../adapters/app-lifecycle-protocol.js';
const deferred = () => { let resolve!: () => void, reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('Optional App cleanup', () => {
    it('stops synchronously, retains detached callbacks, and waits for cleanup exactly once', async () => {
        const x = createAppLifecycle('a'), gate = deferred(), events: string[] = [];
        const close = vi.fn(async () => { events.push('close'); await gate.promise; events.push('released'); });
        const detach = x.port.register({ stop: () => { events.push('stop'); }, close });
        x.stop(); expect(events).toEqual(['stop']);
        detach(); const pending = x.close(); expect(x.close()).toBe(pending);
        await Promise.resolve(); expect(x.getReport()).toMatchObject({ state: 'pending' });
        gate.resolve(); await pending;
        expect(events).toEqual(['stop', 'close', 'released']); expect(close).toHaveBeenCalledOnce();
        expect(captureAppCleanupReport(x.getReport(), 'a')).toEqual({ protocol: 'app-lifecycle-v2', instanceId: 'a', state: 'completed', issues: [] });
    });
    it('reports a callback failure without claiming resource verification', async () => {
        const x = createAppLifecycle('a'); x.port.register({ stop() {}, close() { throw Error('private'); } });
        await expect(x.close()).rejects.toThrow('APP_CLEANUP_FAILED');
        expect(x.getReport()).toEqual({ protocol: 'app-lifecycle-v2', instanceId: 'a', state: 'failed', issues: ['APP_CLEANUP_FAILED'] });
        expect(JSON.stringify(x.getReport())).not.toContain('private');
    });
    it('still cleans resources after a stop failure while retaining that failure', async () => {
        const close = vi.fn(), x = createAppLifecycle('a'); x.port.register({ stop() { throw Error(); }, close });
        await expect(x.close()).rejects.toThrow(); expect(close).toHaveBeenCalledOnce();
        expect(x.getReport()).toMatchObject({ state: 'failed', issues: ['APP_STOP_FAILED'] });
    });
    it('closes without a registration and rejects late or duplicate callback replacement', async () => {
        const x = createAppLifecycle('a'); x.stop(); const closed = x.close();
        expect(() => x.port.register({ stop() {}, close() {} })).toThrow();
        await closed; expect(x.getReport()).toMatchObject({ state: 'completed', issues: [] });
        const y = createAppLifecycle('b'); y.port.register({ stop() {}, close() {} });
        expect(() => y.port.register({ stop() {}, close() {} })).toThrow(); await y.close();
    });
    it('retains and immediately stops an owner committed while opening is being joined', async () => {
        const x = createAppLifecycle('a'), stop = vi.fn(), close = vi.fn();
        x.stop(); expect(x.getReport().issues).toEqual([]);
        x.port.register({ stop, close }); expect(stop).toHaveBeenCalledOnce();
        await x.close(); expect(close).toHaveBeenCalledOnce(); expect(x.getReport().state).toBe('completed');
    });
    it('an asynchronous stop remains a contract failure even after its resource settles', async () => {
        const x = createAppLifecycle('a'), gate = deferred(), close = vi.fn();
        x.port.register({ stop: () => gate.promise, close }); const pending = x.close();
        await Promise.resolve(); expect(close).not.toHaveBeenCalled(); gate.resolve(); await expect(pending).rejects.toThrow();
        expect(x.getReport()).toMatchObject({ state: 'failed', issues: ['APP_STOP_ASYNC'] });
    });
    it.each(['stop', 'close', 'neither'] as const)('allows %s callbacks without requiring both phases', async phase => {
        const x = createAppLifecycle('a'), callback = vi.fn();
        x.port.register(phase === 'stop' ? { stop: callback } : phase === 'close' ? { close: callback } : {});
        x.stop(); await x.close();
        expect(callback).toHaveBeenCalledTimes(phase === 'neither' ? 0 : 1);
        expect(x.getReport()).toEqual({ protocol: 'app-lifecycle-v2', instanceId: 'a', state: 'completed', issues: [] });
    });
    it('does not reinterpret the old resource-proof report as the new callback result', async () => {
        const x = createAppLifecycle('a'); await x.close();
        expect(captureAppCleanupReport({ ...x.getReport(), protocol: 'app-lifecycle-v1', callbackCount: 1, verifiedReleased: true }, 'a')).toBeNull();
        expect(captureAppCleanupReport({ ...x.getReport(), verifiedReleased: true }, 'a')).toBeNull();
        expect(captureAppCleanupReport(x.getReport(), 'other')).toBeNull();
    });
});
