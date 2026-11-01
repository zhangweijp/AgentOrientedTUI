import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';

function inFlightHost() {
    const host = new AppWorkerHost({
        appId: 'app_1' as any, desktopId: 'desktop_1' as any,
        appModulePath: 'not-loaded',
    });
    const worker = {
        postMessage: vi.fn(), terminate: vi.fn(),
        removeAllListeners: vi.fn(), off: vi.fn(),
    };
    const request = vi.spyOn(host as any, 'sendRequest').mockResolvedValue(undefined);
    (host as any).worker = worker;
    (host as any).status = 'running';
    return { host, worker, request };
}

describe('Worker Host lifecycle and physical resource release', () => {
    it('does not push new fire-and-forget LLM output during or after shutdown', async () => {
        const { host, worker, request } = inFlightHost();
        const closing = host.close();
        host.pushLLMOutput({ content: 'late output' }, 'complete');
        expect(worker.postMessage).not.toHaveBeenCalled();
        await closing;
        host.pushLLMOutput({ content: 'closed output' }, 'complete');
        expect(worker.postMessage).not.toHaveBeenCalled();
    });

    it('drains a lifecycle request before shutdown and never revives the closing Host', async () => {
        const { host, request } = inFlightHost();
        let finishLifecycle!: () => void;
        request.mockImplementationOnce(() => new Promise<void>(resolve => { finishLifecycle = resolve; }));
        const pending = host.pause().then(
            () => ({ completed: true }),
            (error: Error) => ({ completed: false, message: error.message }),
        );
        await Promise.resolve();
        const closing = host.close();
        expect(host.getStatus()).toBe('closing');
        expect(request.mock.calls.map(([message]) => message.type)).toEqual(['APP_PAUSE']);
        finishLifecycle();
        await Promise.all([pending, closing]);
        expect(await pending).toMatchObject({ completed: false });
        expect(host.getStatus()).toBe('closed');
        expect(request.mock.calls.map(([message]) => message.type))
            .toEqual(['APP_PAUSE', 'APP_SHUTDOWN', 'APP_CLOSE']);
    });

    it('a failed shutdown kills the Worker instead of leaving it stranded in closing', async () => {
        const { host, worker, request } = inFlightHost();
        request.mockRejectedValueOnce(new Error('Worker shutdown IPC failed'));
        await expect(host.close()).rejects.toThrow(/Worker shutdown IPC failed/);
        expect(request.mock.calls.map(([message]) => message.type))
            .toEqual(['APP_SHUTDOWN', 'APP_CLOSE']);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(host.getStatus()).toBe('closed');
    });

    it('two simultaneous close requests share one Promise and one shutdown/close pair', async () => {
        const { host, request } = inFlightHost();
        const first = host.close();
        const second = host.close();
        expect(second).toBe(first);
        expect(host.getStatus()).toBe('closing');
        await Promise.all([first, second]);
        expect(request.mock.calls.map(([message]) => message.type))
            .toEqual(['APP_SHUTDOWN', 'APP_CLOSE']);
        expect(host.getStatus()).toBe('closed');
        await host.close();
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('pause and reinitialize cannot send IPC after close starts', async () => {
        const { host, request } = inFlightHost();
        const closing = host.close();
        await expect(host.pause()).rejects.toThrow(/shutdown is pending/);
        await expect(host.reinitialize('concurrent maintenance')).rejects.toThrow(/shutdown is pending/);
        await closing;
        expect(request.mock.calls.map(([message]) => message.type))
            .toEqual(['APP_SHUTDOWN', 'APP_CLOSE']);
    });

    it('close waits for an already pending WorkerPool RESET instead of reporting completion early', async () => {
        const { host, worker, request } = inFlightHost();
        let finishReset!: () => void;
        let resetStarted!: () => void;
        const resetEntered = new Promise<void>(resolve => { resetStarted = resolve; });
        request.mockImplementationOnce(message => new Promise<void>(resolve => {
            if (message.type !== 'RESET') throw new Error('Expected RESET');
            finishReset = resolve;
            resetStarted();
        }));
        const released = host.releaseWorker();
        const closing = host.close();
        let closed = false;
        void closing.then(() => { closed = true; });
        await resetEntered;
        expect(closed).toBe(false);
        finishReset();
        expect(await released).toBe(worker);
        await closing;
        expect(closed).toBe(true);
        expect(host.getStatus()).toBe('closed');
    });

    it('can RESET and return a physically live Worker after graceful APP_CLOSE', async () => {
        const { host, worker, request } = inFlightHost();
        await host.close();
        expect(await host.releaseWorker()).toBe(worker);
        expect(request.mock.calls.map(([message]) => message.type))
            .toEqual(['APP_SHUTDOWN', 'APP_CLOSE', 'RESET']);
        expect(await host.releaseWorker()).toBeNull();
    });

    it('termination detaches Host listeners and preserves an external exit observer', async () => {
        const worker = Object.assign(new EventEmitter(), {
            postMessage: vi.fn(), terminate: vi.fn(),
        });
        const host = new AppWorkerHost({
            appId: 'app_1' as any, desktopId: 'desktop_1' as any,
            appModulePath: 'not-loaded', existingWorker: worker as any,
        });
        const externalExit = vi.fn();
        worker.once('exit', externalExit);
        host.terminate();
        const resources = host.waitForResourceRelease();
        expect(host.waitForResourceRelease()).toBe(resources);
        expect(worker.listenerCount('message')).toBe(0);
        expect(worker.listeners('exit')).toEqual(expect.arrayContaining([
            externalExit, (host as any).resourceExitListener,
        ]));
        expect(worker.listenerCount('exit')).toBe(2);
        expect(host.getResourceReport()).toMatchObject({ worker: 'retiring', resourcesReleased: false });
        worker.emit('exit', 1);
        expect(externalExit).toHaveBeenCalledWith(1);
        expect(externalExit).toHaveBeenCalledTimes(1);
        expect(worker.listenerCount('exit')).toBe(0);
        expect(await resources).toMatchObject({ worker: 'exited', resourcesReleased: true });
        expect(host.getStatus()).toBe('closed');
    });
});
