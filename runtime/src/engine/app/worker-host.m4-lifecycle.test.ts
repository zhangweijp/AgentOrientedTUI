import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';

function inFlightHost() {
    const worker = Object.assign(new EventEmitter(), {
        postMessage: vi.fn(), terminate: vi.fn(() => Promise.resolve(0)),
    });
    const host = new AppWorkerHost({
        appId: 'app_1' as any, desktopId: 'desktop_1' as any,
        appModulePath: 'not-loaded', existingWorker: worker as any,
    });
    const request = vi.spyOn(host as any, 'sendRequest').mockResolvedValue(undefined);
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

    it('close joins the physical exit even after all lifecycle responses', async () => {
        const { host, worker, request } = inFlightHost();
        let terminateEntered!: () => void;
        const terminating = new Promise<void>(resolve => { terminateEntered = resolve; });
        worker.terminate.mockImplementationOnce(() => { terminateEntered();return new Promise(() => {}); });
        const closing = host.close();
        await terminating;
        expect(host.close()).toBe(closing);
        expect(host.getResourceReport()).toMatchObject({ worker: 'retiring', resourcesReleased: false });
        expect(request.mock.calls.map(([message]) => message.type)).toEqual(['APP_SHUTDOWN', 'APP_CLOSE']);
        worker.emit('exit', 0);
        await closing;
        expect(await host.waitForResourceRelease()).toMatchObject({ worker: 'exited', resourcesReleased: true });
    });

    it('termination detaches Host listeners and preserves an external exit observer', async () => {
        const worker = Object.assign(new EventEmitter(), {
            postMessage: vi.fn(), terminate: vi.fn(() => new Promise<number>(() => {})),
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
        expect(worker.listenerCount('message')).toBe(1);
        expect(worker.listeners('exit')).toEqual(expect.arrayContaining([
            externalExit, (host as any).workerExitListener,
        ]));
        expect(worker.listenerCount('exit')).toBe(2);
        expect(host.getResourceReport()).toMatchObject({ worker: 'retiring', resourcesReleased: false });
        worker.emit('exit', 1);
        expect(externalExit).toHaveBeenCalledWith(1);
        expect(externalExit).toHaveBeenCalledTimes(1);
        expect(worker.listenerCount('exit')).toBe(0);
        expect(worker.listenerCount('message')).toBe(0);
        expect(await resources).toMatchObject({ worker: 'exited', resourcesReleased: true });
        expect(host.getStatus()).toBe('closed');
    });
});
