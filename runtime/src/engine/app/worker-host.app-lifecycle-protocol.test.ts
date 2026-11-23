import { EventEmitter } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { AppWorkerHost } from './worker-host.js';

const hosts: AppWorkerHost[] = [];
function fixture(fault?: (request: any, response: any) => any) {
    let host: AppWorkerHost;
    const worker = new class extends EventEmitter {
        messages: any[] = []; threadId = 1;
        pendingCloseResponse: any;
        postMessage(request: any) {
            this.messages.push(request);
            if (request.type === 'STATE_STORAGE_RESPONSE' && this.pendingCloseResponse) {
                const response = this.pendingCloseResponse;this.pendingCloseResponse = undefined;
                queueMicrotask(() => this.emit('message', response));return;
            }
            const report = { protocol: 'app-lifecycle-v2', instanceId: host.appInstanceId,
                state: request.type === 'APP_CLOSE' ? 'completed' : 'stopped', issues: [] };
            const response = { requestId: request.requestId, success: true,
                type: request.type === 'INIT' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE',
                ...(request.type === 'INIT' ? {
                    appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: host.appInstanceId },
                    persistence: { protocol: 'state-session-v2', version: 2, instanceId: host.appInstanceId },
                    protocol: request.protocol, toolsEnabled: request.toolsEnabled,
                    projectionLimits: request.projectionLimits,
                    appInstanceId: host.appInstanceId,
                } : ['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE'].includes(request.type) ? {
                    appCleanup: report,
                    ...(request.type === 'APP_CLOSE' ? { persistence: {
                        protocol: 'state-session-v2', instanceId: host.appInstanceId, ok: true, unmount: 'completed',
                        flush: { status: 'completed', ok: true, entries: [] },
                        dispose: { status: 'disposed', unsaved: [], release: { status: 'released' } },
                    } } : {}),
                } : {}) };
            if (request.type === 'APP_CLOSE') {
                this.pendingCloseResponse = fault ? fault(request, response) : response;
                queueMicrotask(() => this.emit('message', { type: 'STATE_STORAGE_REQUEST', version: 2, instanceId: host.appInstanceId,
                    sequence: 1, action: 'release', }));return;
            }
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
    expect((await x.host.waitForResourceRelease()).resourcesReleased).toBe(true);
});

it.each(['wrong-response-type', 'wrong-instance', 'wrong-protocol', 'wrong-version', 'missing-lifecycle-ack'])('rejects %s INIT and retires the Worker', async fault => {
    const x = fixture((request, response) => request.type !== 'INIT' ? response : fault === 'wrong-response-type'
        ? { requestId: response.requestId, type: 'LIFECYCLE_RESPONSE', success: true }
        : fault === 'missing-lifecycle-ack' ? (({ appLifecycle, ...missing }) => missing)(response)
        : { ...response, appLifecycle: { ...response.appLifecycle, ...(fault === 'wrong-instance' ? { instanceId: 'other' }
            : fault === 'wrong-protocol' ? { protocol: 'app-lifecycle-v3' } : { version: 1 }) } });
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
        appCleanup: { ...response.appCleanup, state: 'failed', issues: ['APP_CLEANUP_FAILED'] },
        persistence: { ...response.persistence, unmount: 'failed' } } : response);
    await x.host.start(); await x.host.open(); await expect(x.host.close()).rejects.toHaveProperty('code', 'APP_CLEANUP_FAILED');
    expect((await x.host.waitForResourceRelease()).appCleanup?.report).toMatchObject({ state: 'failed', issues: ['APP_CLEANUP_FAILED'] });
    expect(x.host.getResourceReport()).toMatchObject({ worker: 'exited', resourcesReleased: true,
        storage: { unsafe: false, lifecycle: { ok: true, unmount: 'failed' } } });
});

it.each(['missing', 'wrong-instance', 'contradictory-status'])('keeps a %s storage receipt visible when App cleanup also fails', async fault => {
    const x = fixture((request, response) => request.type === 'APP_CLOSE' ? { ...response, success: false,
        appCleanup: { ...response.appCleanup, state: 'failed', issues: ['APP_CLEANUP_FAILED'] },
        persistence: fault === 'missing' ? undefined : { ...response.persistence, unmount: 'failed',
            ...(fault === 'wrong-instance' ? { instanceId: 'different' } : { ok: false }) } } : response);
    await x.host.start(); await x.host.open(); await expect(x.host.close()).rejects.toHaveProperty('code', 'APP_CLEANUP_FAILED');
    const report = await x.host.waitForResourceRelease();
    expect(report).toMatchObject({ appCleanup: { report: { state: 'failed' } }, resourcesReleased: true,
        storage: { unsafe: true, release: { status: 'released' } } });
    expect(report.storage).not.toHaveProperty('lifecycle');
});

it('classifies a completed app cleanup and failed persistence flush as a persistence close failure', async () => {
    const x = fixture((request, response) => request.type === 'APP_CLOSE' ? { ...response, success: false,
        persistence: { ...response.persistence, ok: false,
            flush: { status: 'completed', ok: false, entries: [{ address: { namespace: 'd/app', key: 'state' },
                revision: 1, status: 'failed', issue: { code: 'IO_FAILED', message: 'Storage I/O failed' } }] },
            dispose: { status: 'disposed', unsaved: [{ address: { namespace: 'd/app', key: 'state' },
                revision: 1, status: 'failed', issue: { code: 'IO_FAILED', message: 'Storage I/O failed' } }],
                release: { status: 'released' } } } } : response);
    await x.host.start(); await x.host.open();

    await expect(x.host.close()).rejects.toThrow('PERSISTENCE_CLOSE_FAILED');

    expect(x.host.getResourceReport().appCleanup?.report).toMatchObject({ state: 'completed', issues: [] });
    expect(x.host.getPersistenceReport()).toMatchObject({
        unsafe: true,
        lifecycle: { ok: false, unmount: 'completed', flush: { ok: false, entries: [{ status: 'failed', issue: { code: 'IO_FAILED' } }] },
            dispose: { unsaved: [{ status: 'failed', issue: { code: 'IO_FAILED' } }], release: { status: 'released' } } },
    });
    expect((await x.host.waitForResourceRelease()).resourcesReleased).toBe(true);
});

it('rejects a false APP_CLOSE terminal even when both managed reports claim success', async () => {
    const x = fixture((request, response) => request.type === 'APP_CLOSE' ? { ...response, success: false } : response);
    await x.host.start(); await x.host.open();

    await expect(x.host.close()).rejects.toThrow();

    expect(x.host.getResourceReport().appCleanup?.report).toMatchObject({ state: 'completed', issues: [] });
    expect(x.host.getPersistenceReport()).toMatchObject({ unsafe: true, lifecycle: { ok: true, unmount: 'completed' } });
    expect((await x.host.waitForResourceRelease()).resourcesReleased).toBe(true);
});
