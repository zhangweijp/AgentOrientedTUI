import { emitHealthyOpen, fixtureHost } from './__tests__/worker-fixture.js';
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
            const report = { protocol: 'app-lifecycle-v3', instanceId: host.appInstanceId,
                state: request.type === 'APP_CLOSE' ? 'completed' : 'stopped', issues: [] };
            const response = { requestId: request.requestId, success: true,
                type: request.type === 'INIT' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE',
                ...(request.type === 'INIT' ? {
                    appLifecycle: { protocol: 'app-lifecycle-v3', instanceId: host.appInstanceId },
                    protocol: request.protocol, toolsEnabled: request.toolsEnabled,
                    projectionLimits: request.projectionLimits,
                    appInstanceId: host.appInstanceId,
                } : ['APP_STOP', 'APP_CLOSE'].includes(request.type) ? {
                    appCleanup: report,
                } : {}) };
            queueMicrotask(() => {
                const reply = fault ? fault(request, response) : response;
                if (request.type === 'APP_OPEN' && reply.success === true) reply.publication = emitHealthyOpen(this, request, host.appId, host.appInstanceId);
                this.emit('message', reply);
            });
        }
        async terminate() { this.threadId = -1; this.emit('exit', 0); return 0; }
    }();
    host = fixtureHost(AppWorkerHost, { appId: 'app' as any, desktopId: 'd' as any, appModulePath: 'unused', }, { worker: worker as any, timeoutMs: 100 });
    hosts.push(host); return { host, worker };
}
afterEach(async () => { for (const host of hosts.splice(0)) { host.terminate(); await host.waitForResourceRelease(); } });

it('accepts the callback result without owner counts or resource-proof fields', async () => {
    const x = fixture(); await x.host.start(); await x.host.open(); await x.host.close();
    expect(x.host.getResourceReport().appCleanup?.report).toEqual({ protocol: 'app-lifecycle-v3', instanceId: x.host.appInstanceId,
        state: 'completed', issues: [] });
    expect((await x.host.waitForResourceRelease()).resourcesReleased).toBe(true);
});

it.each(['pending', 'completed'])('joins a valid App cleanup already %s at APP_STOP', async state => {
    const x = fixture((request, response) => request.type === 'APP_STOP'
        ? { ...response, appCleanup: { ...response.appCleanup, state } } : response);
    await x.host.start(); await x.host.open(); await x.host.close();
    expect((await x.host.waitForResourceRelease())).toMatchObject({ resourcesReleased: true, worker: 'exited',
        appCleanup: { report: { state: 'completed', issues: [] } } });
});

it.each(['wrong-response-type', 'wrong-instance', 'wrong-protocol', 'retired-numeric-version', 'missing-lifecycle-ack'])('rejects %s INIT and retires the Worker', async fault => {
    const x = fixture((request, response) => request.type !== 'INIT' ? response : fault === 'wrong-response-type'
        ? { requestId: response.requestId, type: 'LIFECYCLE_RESPONSE', success: true }
        : fault === 'missing-lifecycle-ack' ? (({ appLifecycle, ...missing }) => missing)(response)
        : { ...response, appLifecycle: { ...response.appLifecycle, ...(fault === 'wrong-instance' ? { instanceId: 'other' }
            : fault === 'wrong-protocol' ? { protocol: 'app-lifecycle-v2' } : { version: 2 }) } });
    const error = fault === 'wrong-response-type' ? 'APP_INIT_ACK_INVALID' : 'APP_LIFECYCLE_NEGOTIATION_FAILED';
    await expect(x.host.start()).rejects.toThrow(error);
    expect(x.host.getResourceReport().appCleanup?.support).toBe('rejected');
    expect(x.host.getResourceReport().worker).toBe('exited');
    expect((await x.host.waitForResourceRelease()).resourcesReleased).toBe(true);
});
it.each(['wrong-type', 'active', 'wrong-instance', 'missing'])('does not trust %s APP_CLOSE evidence', async fault => {
    const x = fixture((request, response) => {
        if (request.type !== 'APP_CLOSE') return response;
        if (fault === 'missing') { const { appCleanup, ...missing } = response; return missing; }
        return fault === 'wrong-type' ? { ...response, type: 'VIEW_TOOL_INVOKE_RESPONSE' } : { ...response,
            appCleanup: { ...response.appCleanup, ...(fault === 'active' ? { state: 'active' } : { instanceId: 'other' }) } };
    });
    await x.host.start(); await x.host.open(); await expect(x.host.close()).rejects.toThrow();
    expect(x.host.getResourceReport().appCleanup?.report).toMatchObject({ state: 'stopped' });
    expect((await x.host.waitForResourceRelease()).resourcesReleased).toBe(true);
});
it('preserves cleanup failure while reporting the terminated execution resources separately', async () => {
    const x = fixture((request, response) => request.type === 'APP_CLOSE' ? { ...response, success: false,
        appCleanup: { ...response.appCleanup, state: 'failed', issues: ['APP_CLEANUP_FAILED'] } } : response);
    await x.host.start(); await x.host.open(); await expect(x.host.close()).rejects.toHaveProperty('code', 'APP_CLEANUP_FAILED');
    expect((await x.host.waitForResourceRelease()).appCleanup?.report).toMatchObject({ state: 'failed', issues: ['APP_CLEANUP_FAILED'] });
    expect(x.host.getResourceReport()).toMatchObject({ worker: 'exited', resourcesReleased: true });
});

it('rejects a false APP_CLOSE terminal even when appCleanup reports completed', async () => {
    const x = fixture((request, response) => request.type === 'APP_CLOSE' ? { ...response, success: false } : response);
    await x.host.start(); await x.host.open();

    await expect(x.host.close()).rejects.toThrow();

    expect(x.host.getResourceReport().appCleanup?.report).toMatchObject({ state: 'completed', issues: [] });
    expect((await x.host.waitForResourceRelease()).resourcesReleased).toBe(true);
});


it('retains a confirmed cleanup failure when a later lifecycle report contradicts it', async () => {
    const x = fixture((request, response) => request.type === 'APP_STOP' ? {
        ...response, success: false,
        appCleanup: { ...response.appCleanup, state: 'failed', issues: ['APP_CLEANUP_FAILED'] },
    } : response);
    await x.host.start(); await x.host.open();
    await expect(x.host.close()).rejects.toHaveProperty('code', 'APP_CLEANUP_FAILED');
    expect(await x.host.waitForResourceRelease()).toMatchObject({
        worker: 'exited', resourcesReleased: true,
        appCleanup: { report: { state: 'failed', issues: ['APP_CLEANUP_FAILED'] } },
    });
});
