import { it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { AppWorkerHost } from './worker-host.js';
class ControlledWorker extends EventEmitter {
    threadId = 1;sent: any[] = [];termination: () => Promise<number> = () => Promise.resolve(0);terminations = 0;
    postMessage(message: any) { this.sent.push(message);queueMicrotask(() => this.emit('message', { type: message.type === 'INIT' ? 'INIT_RESPONSE' : message.type === 'RESET' ? 'RESET_RESPONSE' : 'LIFECYCLE_RESPONSE', requestId: message.requestId, success: true })); }
    terminate() { this.terminations++;return this.termination(); }
    exit() { this.threadId = -1;this.emit('exit', 0); }
}
const fixture = () => { const worker = new ControlledWorker();const host = new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused', timeout: 1000, existingWorker: worker as any });return { worker, host }; };
it('C1-09 RESET removes only this Host callbacks and preserves Pool/external observation', async () => {
    const worker = new ControlledWorker();let messages = 0, exits = 0;const external = () => { messages++; }, pool = () => { exits++; };
    worker.on('message', external);worker.on('exit', pool);worker.on('error', () => {});
    const host = new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused', existingWorker: worker as any });
    await host.start();await host.open();await host.close();const first = host.releaseWorker(), second = host.releaseWorker();
    expect(await first).toBe(worker);expect(await second).toBeNull();expect(worker.listeners('message')).toEqual([external]);expect(worker.listeners('exit')).toEqual([pool]);
    const report = await host.waitForResourceRelease();expect(report).toMatchObject({ state: 'settled', worker: 'transferred', resourcesReleased: true });
    host.terminate();expect(worker.terminations).toBe(0);worker.exit();expect(exits).toBe(1);expect(messages).toBeGreaterThan(0);
});
it('C1-10 wait is shared and never implies close; terminate receipt is not actual exit', async () => {
    const { host, worker } = fixture();await expect(host.waitForResourceRelease()).rejects.toMatchObject({ code: 'RESOURCE_RELEASE_NOT_STARTED' });
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
