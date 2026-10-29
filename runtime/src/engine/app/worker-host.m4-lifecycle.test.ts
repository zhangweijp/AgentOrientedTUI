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
    (host as any).activeFileReplacements = 1;
    const finishDiskOperation = () => {
        (host as any).activeFileReplacements = 0;
        for (const resume of (host as any).fileReplacementWaiters.splice(0)) resume();
    };
    return { host, worker, request, finishDiskOperation };
}

describe('M4 Stage 7: graceful lifecycle waits for an in-flight disk CAS', () => {
    it('APP_CLOSE refuses new Tool calls and does not shutdown until the replacement settles', async () => {
        const { host, request, finishDiskOperation } = inFlightHost();
        const closed = host.close();
        expect(host.getStatus()).toBe('closing');
        await Promise.resolve();
        expect(request).not.toHaveBeenCalled();
        finishDiskOperation();
        await closed;
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[0][0]).toMatchObject({ type: 'APP_SHUTDOWN' });
        expect(request.mock.calls[1][0]).toMatchObject({ type: 'APP_CLOSE' });
        expect(host.getStatus()).toBe('closed');
    });

    it('WorkerPool RESET waits for the replacement, then severs listeners and closes old Host', async () => {
        const { host, worker, request, finishDiskOperation } = inFlightHost();
        const pool = host.releaseWorker();
        expect(host.getStatus()).toBe('closing');
        expect(request).not.toHaveBeenCalled();
        finishDiskOperation();
        const returned = await pool;
        expect(returned).toBe(worker);
        expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'RESET' }));
        expect(worker.removeAllListeners).not.toHaveBeenCalled();
        expect(worker.off.mock.calls).toEqual([
            ['message', (host as any).workerMessageListener],
            ['error', (host as any).workerErrorListener],
            ['exit', (host as any).workerExitListener],
        ]);
        expect(host.getStatus()).toBe('closed');
    });

    it('forced terminate defers physical Worker teardown while a disk operation is in progress', async () => {
        const { host, worker, finishDiskOperation } = inFlightHost();
        host.terminate();
        host.terminate(); // duplicate request must not double-register
        expect(host.getStatus()).toBe('closing');
        expect(worker.terminate).not.toHaveBeenCalled();
        finishDiskOperation();
        await vi.waitFor(() => {
            expect(worker.terminate).toHaveBeenCalledTimes(1);
        }, { timeout: 500 });
        expect(host.getStatus()).toBe('closed');
    });
});

describe('M4 Stage 7: lifecycle failure safety', () => {
    it('cannot reopen or resume while close is waiting for a versioned disk write', async () => {
        const { host, request, finishDiskOperation } = inFlightHost();
        const closing = host.close();
        await expect(host.open()).rejects.toThrow(/shutdown is pending/);
        await expect(host.resume()).rejects.toThrow(/shutdown is pending/);
        expect(request).not.toHaveBeenCalled();
        finishDiskOperation();
        await closing;
        expect(host.getStatus()).toBe('closed');
    });

    it('a failed shutdown kills the Worker instead of leaving it stranded in closing', async () => {
        const { host, worker, request, finishDiskOperation } = inFlightHost();
        request.mockRejectedValueOnce(new Error('Worker shutdown IPC failed'));
        const closing = host.close();
        finishDiskOperation();
        await expect(closing).rejects.toThrow(/Worker shutdown IPC failed/);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(host.getStatus()).toBe('closed');
    });
});


describe('M4 Stage 7: resource version cannot prove an identical-content write was not replayed', () => {
    it('fails closed after a successful same-hash write, even if unrelated UI publishes another V2 snapshot', async () => {
        const host = new AppWorkerHost({
            appId: 'file_app' as any, desktopId: 'desktop_1' as any,
            appModulePath: 'not-loaded',
            snapshotShadow: true, experimentalVersionedMutations: true,
        });
        (host as any).status = 'running';
        const id = host.appInstanceId;
        const viewInstanceId = 'vi:v1:' + JSON.stringify([id, 1]);
        const toolId = JSON.stringify(['file_app', 'FileDetail', 'replace_file']);
        const hash = 'sha256:' + 'a'.repeat(64);
        const view = (description: string) => ({
            id: 'fd_0', viewInstanceId, type: 'FileDetail', name: 'App.tsx',
            kind: 'state', content: { format: 'markdown-v1', value: description },
        });
        const draft = (producerSeq: number, text: string) => ({
            schemaVersion: 2, appId: 'file_app', instanceId: id,
            producerSeq, sourceEpoch: producerSeq, capturedAt: producerSeq,
            views: [view(text)],
            refs: {
                [JSON.stringify(['fd_0', viewInstanceId, 'file'])]: {
                    id: 'file', ownerViewId: 'fd_0', ownerViewInstanceId: viewInstanceId,
                    refType: 'File', target: {
                        kind: 'entity', entityType: 'File',
                        entityId: '/workspace/App.tsx', entityVersion: hash,
                    },
                },
            },
            tools: {
                [toolId]: {
                    id: toolId, name: 'replace_file', viewType: 'FileDetail',
                    description: 'Replace current file',
                    inputSchema: { type: 'object' }, isMutating: true,
                    targets: [{ viewId: 'fd_0', viewInstanceId, bindingVersion: 1 }],
                },
            },
        });
        const receiver = (host as any).shadowReceiver;
        receiver.acceptPrepared(draft(1, 'first view'));
        expect(host.getSnapshotShadowReport()).toMatchObject({ health: 'ready' });
        const send = vi.spyOn(host as any, 'sendRequest').mockResolvedValue({ success: true });
        const replace = vi.fn(async () => ({ status: 'written' as const, version: hash }));
        const request = (snapshotId: string) => ({
            snapshotId, toolId, viewId: 'fd_0', refId: 'file',
            newContent: 'same bytes',
        });
        const original = host.getSnapshotShadowReport()!.snapshotId!;
        expect(await host.executeVersionedFileReplace(request(original), () => true, replace))
            .toMatchObject({ success: true, data: { version: hash } });
        expect(await host.executeVersionedFileReplace(request(original), () => true, replace))
            .toMatchObject({ success: false, error: { code: 'SNAPSHOT_SOURCE_CONFLICT' } });
        receiver.acceptPrepared(draft(2, 'unrelated UI changed'));
        const newSnapshot = host.getSnapshotShadowReport()!.snapshotId!;
        expect(newSnapshot).not.toBe(original);
        expect(await host.executeVersionedFileReplace(request(newSnapshot), () => true, replace))
            .toMatchObject({ success: false, error: { code: 'SNAPSHOT_SOURCE_CONFLICT' } });
        expect(replace).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(1);
        host.terminate();
    });
});


describe('M4 Stage 8: lifecycle operations are single-flight', () => {
    it('does not push new fire-and-forget LLM output during or after shutdown', async () => {
        const { host, worker, finishDiskOperation } = inFlightHost();
        const closing = host.close();
        try {
            host.pushLLMOutput({ content: 'late output' }, 'complete');
            expect(worker.postMessage).not.toHaveBeenCalled();
        } finally {
            finishDiskOperation();
            await closing;
        }
        host.pushLLMOutput({ content: 'closed output' }, 'complete');
        expect(worker.postMessage).not.toHaveBeenCalled();
    });

    it('termination detaches only Host listeners and preserves an external exit observer', async () => {
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

    it('close reaches closed if the Worker exits while a Host disk operation is still pending', async () => {
        const { host, request, finishDiskOperation } = inFlightHost();
        const closing = host.close();
        (host as any).handleExit(0);
        finishDiskOperation();
        await closing;
        expect(host.getStatus()).toBe('closed');
        expect(request).not.toHaveBeenCalled();
    });

    it('an unexpected Worker exit immediately rejects pending requests', async () => {
        const { host, request, finishDiskOperation } = inFlightHost();
        finishDiskOperation();
        request.mockRestore();
        const pending = host.executeOperation('inspect' as any, {}, 'source' as any)
            .then(() => 'unexpected success', () => 'rejected');
        try {
            expect((host as any).pendingRequests.size).toBe(1);
            (host as any).handleExit(0);
            expect((host as any).pendingRequests.size).toBe(0);
        } finally { host.terminate(); await pending; }
        expect(await pending).toBe('rejected');
    });

    it('close waits for a deferred forced termination and its in-flight disk result', async () => {
        const { host, worker, finishDiskOperation } = inFlightHost();
        host.terminate();
        let closed = false;
        const closing = host.close().then(() => { closed = true; });
        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(closed).toBe(false);
            expect(worker.terminate).not.toHaveBeenCalled();
        } finally {
            finishDiskOperation();
            await closing;
        }
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(host.getStatus()).toBe('closed');
    });

    it('a failed terminate post still tears down the Worker and closes the Host', () => {
        const { host, worker, finishDiskOperation } = inFlightHost();
        finishDiskOperation();
        worker.postMessage.mockImplementation(() => { throw new Error('Channel is already closed'); });
        expect(() => host.terminate()).not.toThrow();
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(host.getStatus()).toBe('closed');
    });

    it('close waits for an already pending WorkerPool RESET instead of reporting completion early', async () => {
        const { host, request, finishDiskOperation } = inFlightHost();
        let finishReset!: () => void;
        let resetStarted!: () => void;
        const resetEntered = new Promise<void>(resolve => { resetStarted = resolve; });
        request.mockImplementation(() => new Promise<void>(resolve => {
            finishReset = resolve;
            resetStarted();
        }));
        const released = host.releaseWorker();
        let closed = false;
        const closing = host.close().then(() => { closed = true; });
        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(closed).toBe(false);
            finishDiskOperation();
            await resetEntered;
            expect(request.mock.calls.map(([message]) => message.type)).toEqual(['RESET']);
            expect(closed).toBe(false);
        } finally {
            finishDiskOperation();
            await resetEntered;
            finishReset();
            await Promise.all([released, closing]);
        }
        expect(closed).toBe(true);
        expect(host.getStatus()).toBe('closed');
    });

    it('can RESET and return a physically live Worker after graceful APP_CLOSE', async () => {
        const { host, worker, request, finishDiskOperation } = inFlightHost();
        finishDiskOperation();
        await host.close();
        expect(await host.releaseWorker()).toBe(worker);
        expect(request.mock.calls.map(([message]) => message.type))
            .toEqual(['APP_SHUTDOWN', 'APP_CLOSE', 'RESET']);
        expect(await host.releaseWorker()).toBeNull();
    });

    it.each(['start', 'open', 'pause', 'resume', 'reinitialize'] as const)(
        'drains an in-flight %s before shutdown and never revives the closing Host', async method => {
            const { host, request, finishDiskOperation } = inFlightHost();
            finishDiskOperation();
            let finishLifecycle!: () => void;
            request.mockImplementationOnce(() => new Promise<void>(resolve => { finishLifecycle = resolve; }));
            const pending = host[method]().then(
                () => ({ completed: true }),
                (error: Error) => ({ completed: false, message: error.message }),
            );
            const closing = host.close();
            try {
                await Promise.resolve();
                await Promise.resolve();
                expect(request).toHaveBeenCalledTimes(1);
                expect(host.getStatus()).toBe('closing');
            } finally {
                finishLifecycle();
                await Promise.all([pending, closing]);
            }
            expect(await pending).toMatchObject({ completed: false });
            expect(host.getStatus()).toBe('closed');
            expect(request.mock.calls.slice(1).map(([message]) => message.type))
                .toEqual(['APP_SHUTDOWN', 'APP_CLOSE']);
        },
    );

    it('two simultaneous close() requests share one Promise and send exactly one shutdown/close pair', async () => {
        const { host, request, finishDiskOperation } = inFlightHost();
        const first = host.close();
        const second = host.close();
        expect(second).toBe(first);
        expect(host.getStatus()).toBe('closing');
        expect(request).not.toHaveBeenCalled();
        finishDiskOperation();
        await Promise.all([first, second]);
        expect(request.mock.calls.map(([message]) => message.type))
            .toEqual(['APP_SHUTDOWN', 'APP_CLOSE']);
        expect(host.getStatus()).toBe('closed');
        await host.close();
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('pause and reinitialize cannot send IPC after close starts', async () => {
        const { host, request, finishDiskOperation } = inFlightHost();
        const pending = host.close();
        await expect(host.pause()).rejects.toThrow(/shutdown is pending/);
        await expect(host.reinitialize('concurrent maintenance')).rejects.toThrow(/shutdown is pending/);
        expect(request).not.toHaveBeenCalled();
        finishDiskOperation();
        await pending;
        expect(request.mock.calls.map(([message]) => message.type))
            .toEqual(['APP_SHUTDOWN', 'APP_CLOSE']);
    });
});
