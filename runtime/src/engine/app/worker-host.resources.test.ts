import { it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { AppWorkerHost } from './worker-host.js';
import { WorkerCapacity } from './worker-capacity.js';
class ControlledWorker extends EventEmitter {
    threadId = 1;sent: any[] = [];termination: () => Promise<number> = () => Promise.resolve(0);terminations = 0;
    pendingCloseResponse: any;
    postMessage(message: any) {
        this.sent.push(message);
        if (message.type === 'STATE_STORAGE_RESPONSE' && this.pendingCloseResponse) {
            const response = this.pendingCloseResponse;this.pendingCloseResponse = undefined;
            queueMicrotask(() => this.emit('message', response));return;
        }
        queueMicrotask(() => {
            const init = message.type === 'INIT';
            const initMessage = this.sent.find(item => item.type === 'INIT');
            const instanceId = initMessage?.appInstanceId;
            const response: any = { type: init ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE',
                requestId: message.requestId, success: true };
            if (init) Object.assign(response, { appInstanceId: instanceId, acceptedCapabilities: message.requestedCapabilities,
                appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId },
                persistence: { protocol: 'state-session-v1', version: 1, instanceId } });
            if (['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE'].includes(message.type)) Object.assign(response, {
                appCleanup: { protocol: 'app-lifecycle-v2', instanceId,
                    state: message.type === 'APP_CLOSE' ? 'completed' : 'stopped', issues: [] },
            });
            if (message.type === 'APP_SHUTDOWN' || message.type === 'APP_CLOSE') Object.assign(response, {
                persistence: { protocol: 'state-session-v1', instanceId, ok: message.type === 'APP_CLOSE',
                    unmount: message.type === 'APP_CLOSE' ? 'completed' : 'pending',
                    flush: { status: 'completed', ok: true, entries: [] },
                    ...(message.type === 'APP_CLOSE' ? { dispose: { status: 'disposed', unsaved: [], release: { status: 'released' } } } : {}) },
            });
            if (message.type === 'APP_CLOSE') {
                this.pendingCloseResponse = response;
                this.emit('message', { type: 'STATE_STORAGE_REQUEST', version: 1, instanceId, sequence: 1, action: 'release' });
                return;
            }
            this.emit('message', response);
        });
    }
    terminate() { this.terminations++;return this.termination(); }
    exit() { this.threadId = -1;this.emit('exit', 0); }
}
const fixture = () => { const worker = new ControlledWorker();const host = new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused', timeout: 1000, existingWorker: worker as any });return { worker, host }; };
it('after exit detaches only Host listeners and releases its physical capacity once', async () => {
    const worker = new ControlledWorker(), capacity = new WorkerCapacity(1);
    let messages = 0, exits = 0;
    const external = () => { messages++; }, observer = () => { exits++; };
    worker.on('message', external);worker.on('exit', observer);worker.on('error', () => {});
    const host = new AppWorkerHost({ appId: 'a', desktopId: 'd', appModulePath: '/unused',
        existingWorker: worker as any, workerCapacity: capacity });
    let entered!: () => void;
    const terminating = new Promise<void>(resolve => { entered = resolve; });
    worker.termination = () => { entered();return new Promise(() => {}); };
    await host.start();await host.open();
    const closing = host.close();
    await terminating;
    expect(host.close()).toBe(closing);
    expect(capacity.getReport().total).toBe(1);
    expect(() => capacity.reserve()).toThrow(expect.objectContaining({ code: 'WORKER_CAPACITY_EXCEEDED' }));
    worker.exit();
    await closing;
    expect(worker.listeners('message')).toEqual([external]);
    expect(worker.listeners('exit')).toEqual([observer]);
    expect(await host.waitForResourceRelease()).toMatchObject({ state: 'settled', worker: 'exited', resourcesReleased: true });
    const next = capacity.reserve();
    host.terminate();
    expect(capacity.getReport().total).toBe(1);
    next();
    expect(worker.terminations).toBe(1);
    expect(exits).toBe(1);
    expect(messages).toBeGreaterThan(0);
});
it('C1-10 wait is shared and never implies close; terminate receipt is not actual exit', async () => {
    const { host, worker } = fixture();await expect(host.waitForResourceRelease()).rejects.toMatchObject({ code: 'RESOURCE_RELEASE_NOT_STARTED' });
    worker.termination = () => new Promise(() => {});
    expect(worker.sent).toHaveLength(0);await host.start();host.terminate();const pending = host.waitForResourceRelease();expect(host.waitForResourceRelease()).toBe(pending);
    await Promise.resolve();expect(host.getResourceReport()).toMatchObject({ state: 'closing', worker: 'retiring', resourcesReleased: false });
    expect(worker.terminations).toBe(1);worker.exit();expect(await pending).toMatchObject({ state: 'settled', worker: 'exited', resourcesReleased: true });
});
it('C1-10/19 fixed issues survive rejected termination and actual later exit', async () => {
    const { host, worker } = fixture();worker.termination = () => Promise.reject(Error('private detail'));await host.start();host.terminate();
    const pending = host.waitForResourceRelease();await Promise.resolve();worker.emit('error', Error('private payload'));
    expect(host.getResourceReport()).toMatchObject({ worker: 'retiring', issues: expect.arrayContaining(['WORKER_ERROR', 'WORKER_TERMINATION_FAILED']) });
    worker.exit();const report = await pending;expect(report.resourcesReleased).toBe(true);expect(report.issues).toContain('WORKER_TERMINATION_FAILED');expect(Object.isFrozen(report)).toBe(true);expect(JSON.stringify(report)).not.toContain('private');
});
it('C1-10 a never-created Host releases without constructing a Worker', async () => {
    const host = new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused' });host.terminate();
    expect(await host.waitForResourceRelease()).toMatchObject({ state: 'settled', worker: 'not-created', resourcesReleased: true });
});
