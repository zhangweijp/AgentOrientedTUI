import { EventEmitter } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { AppWorkerHost } from './worker-host.js';

const hosts: AppWorkerHost[] = [];
function fixture(fault?: (request: any, response: any) => any) {
    let host: AppWorkerHost;
    const worker = new class extends EventEmitter {
        messages: any[] = []; threadId = 1;
        postMessage(request: any) {
            this.messages.push(request);
            const report = { protocol: 'app-lifecycle-v2', instanceId: host.appInstanceId,
                state: request.type === 'APP_CLOSE' ? 'completed' : 'stopped', issues: [] };
            const response = { requestId: request.requestId, success: true,
                type: request.type === 'INIT' ? 'INIT_RESPONSE' : request.type === 'RESET' ? 'RESET_RESPONSE' : 'LIFECYCLE_RESPONSE',
                ...(request.type === 'INIT' ? { appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: host.appInstanceId } }
                    : ['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE'].includes(request.type) ? { appCleanup: report } : {}) };
            queueMicrotask(() => this.emit('message', fault ? fault(request, response) : response));
        }
        async terminate() { this.threadId = -1; this.emit('exit', 0); return 0; }
    }();
    host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: 'unused', existingWorker: worker as any, timeout: 100 });
    hosts.push(host); return { host, worker };
}
afterEach(async () => { for (const host of hosts.splice(0)) { host.terminate(); await host.waitForResourceRelease(); } });

it('accepts the callback result without owner counts or resource-proof fields', async () => {
    const x = fixture(); await x.host.start(); await x.host.open(); await x.host.close();
    expect(x.host.getResourceReport().appCleanup?.report).toEqual({ protocol: 'app-lifecycle-v2', instanceId: x.host.appInstanceId,
        state: 'completed', issues: [] });
    expect(await x.host.releaseWorker()).toBe(x.worker);
    expect((await x.host.waitForResourceRelease()).resourcesReleased).toBe(true); await x.worker.terminate();
});

it.each(['APP_OPERATION', 'VIEW_OPERATION'] as const)('refuses %s synchronously after stopping, before sending it to the Worker', async type => {
    const x = fixture(); await x.host.start(); await x.host.open();
    const stopped = x.host.beginApplicationStop();
    const result = await x.host.executeOperation('operation' as any, {}, 'snapshot' as any,
        type === 'VIEW_OPERATION' ? 'view' as any : undefined);
    expect(result).toMatchObject({ success: false, error: { code: 'TOOL_UNAVAILABLE' } });
    expect(x.worker.messages.some(message => message.type === type)).toBe(false);
    await stopped; await x.host.close();
});

it.each(['wrong-type', 'wrong-instance', 'wrong-version'])('rejects %s INIT and never transfers it as legacy', async fault => {
    const x = fixture((request, response) => request.type !== 'INIT' ? response : fault === 'wrong-type'
        ? { requestId: response.requestId, type: 'OPERATION_RESPONSE', success: true }
        : { ...response, appLifecycle: { ...response.appLifecycle, ...(fault === 'wrong-instance' ? { instanceId: 'other' } : { version: 1 }) } });
    await expect(x.host.start()).rejects.toThrow(); expect(x.host.getResourceReport().appCleanup?.support).toBe('rejected');
    expect(await x.host.releaseWorker()).toBeNull(); expect(x.worker.messages.some(message => message.type === 'RESET')).toBe(false);
    expect((await x.host.waitForResourceRelease()).resourcesReleased).toBe(true);
});
it.each(['wrong-type', 'active', 'wrong-instance', 'missing'])('does not trust %s APP_CLOSE evidence', async fault => {
    const x = fixture((request, response) => {
        if (request.type !== 'APP_CLOSE') return response;
        if (fault === 'missing') { const { appCleanup, ...missing } = response; return missing; }
        return fault === 'wrong-type' ? { ...response, type: 'OPERATION_RESPONSE' } : { ...response,
            appCleanup: { ...response.appCleanup, ...(fault === 'active' ? { state: 'active' } : { instanceId: 'other' }) } };
    });
    await x.host.start(); await x.host.open(); await expect(x.host.close()).rejects.toThrow();
    expect(x.host.getResourceReport().appCleanup?.report).toMatchObject({ state: 'stopped' });
    expect(await x.host.releaseWorker()).toBeNull(); expect((await x.host.waitForResourceRelease()).resourcesReleased).toBe(true);
});
it('preserves cleanup failure while reporting the terminated execution resources separately', async () => {
    const x = fixture((request, response) => request.type === 'APP_CLOSE' ? { ...response, success: false,
        appCleanup: { ...response.appCleanup, state: 'failed', issues: ['APP_CLEANUP_FAILED'] } } : response);
    await x.host.start(); await x.host.open(); await expect(x.host.close()).rejects.toThrow();
    expect(await x.host.releaseWorker()).toBeNull(); expect((await x.host.waitForResourceRelease()).appCleanup?.report).toMatchObject({ state: 'failed', issues: ['APP_CLEANUP_FAILED'] });
    expect(x.host.getResourceReport()).toMatchObject({ worker: 'exited', resourcesReleased: true });
});
it('accepts an actual legacy INIT envelope without claiming managed App cleanup', async () => {
    const x = fixture((request, response) => { if (request.type !== 'INIT') return response; const { appLifecycle, ...legacy } = response; return legacy; });
    await x.host.start(); await x.host.open(); await x.host.close(); expect(await x.host.releaseWorker()).toBe(x.worker);
    expect((await x.host.waitForResourceRelease()).appCleanup).toEqual({ support: 'legacy-unverified' }); await x.worker.terminate();
});
