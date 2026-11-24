import { it, expect } from 'vitest';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { AppWorkerHost } from './worker-host.js';

class TestWorker extends EventEmitter {
    sent: any[] = [];terminated = 0;shutdownFailed = false;openFailed = false;
    ack: 'valid' | 'missing' | 'invalid' | 'undefined' | 'wrong-type' = 'valid';
    contactStorage = true;
    pendingCloseResponse: any;
    postMessage(message: any) {
        this.sent.push(message);
        if (message.type === 'STATE_STORAGE_RESPONSE' && message.action === 'release' && this.pendingCloseResponse) {
            const response = this.pendingCloseResponse;this.pendingCloseResponse = undefined;
            queueMicrotask(() => this.emit('message', response));return;
        }
        queueMicrotask(() => {
            if (message.type === 'INIT') {
                const reply = { type: 'INIT_RESPONSE', requestId: message.requestId, success: true,
                appLifecycle: { protocol: 'app-lifecycle-v2', instanceId: message.appInstanceId },
                protocol: message.protocol, toolsEnabled: message.toolsEnabled,
                projectionLimits: message.projectionLimits,
                appInstanceId: message.appInstanceId,
                ...(this.ack === 'missing' ? {} : { persistence: this.ack === 'undefined' ? undefined : this.ack === 'wrong-type' ? true :
                    { protocol: 'state-session-v2', version: 2, instanceId: this.ack === 'invalid' ? 'other' : message.appInstanceId } }) };
                this.emit('message', reply);
            }
            else if (message.type === 'APP_OPEN' && this.openFailed) {
                const instanceId = this.sent[0].appInstanceId;
                this.emit('message', { type: 'LIFECYCLE_RESPONSE', requestId: message.requestId, success: false,
                    error: { code: 'E_OPEN_FAILED', message: 'First App open failed' },
                    appCleanup: { protocol: 'app-lifecycle-v2', instanceId, state: 'completed', issues: [] },
                    persistence: { protocol: 'state-session-v2', instanceId, ok: true, unmount: 'completed',
                        flush: { status: 'completed', ok: true, entries: [] },
                        dispose: { status: 'disposed', unsaved: [], release: { status: 'released' } } } });
            } else {
                const instanceId = this.sent[0].appInstanceId, closing = message.type === 'APP_CLOSE';
                const lifecycleRequest = ['APP_STOP', 'APP_CLOSE'].includes(message.type);
                const cleanupFailed = this.shutdownFailed && lifecycleRequest;
                const response = { type: 'LIFECYCLE_RESPONSE', requestId: message.requestId,
                    success: !closing || !cleanupFailed,
                    ...(lifecycleRequest ? { appCleanup: {
                        protocol: 'app-lifecycle-v2', instanceId, state: closing ? cleanupFailed ? 'failed' : 'completed' : 'stopped',
                        issues: cleanupFailed ? [closing ? 'APP_CLEANUP_FAILED' : 'APP_STOP_FAILED'] : [],
                    } } : {}),
                    ...(this.ack !== 'missing' && closing ? { persistence: { protocol: 'state-session-v2', instanceId,
                        ok: true, unmount: cleanupFailed ? 'failed' : 'completed', flush: { status: 'completed', ok: true, entries: [] },
                        dispose: { status: 'disposed', unsaved: [], release: { status: 'released' } } } } : {}) };
                if (message.type === 'APP_CLOSE' && this.contactStorage && this.ack !== 'missing') {
                    this.pendingCloseResponse = response;
                    this.emit('message', { type: 'STATE_STORAGE_REQUEST', version: 2, instanceId, sequence: 2, action: 'release' });
                } else this.emit('message', response);
            }
        });
    }
    terminate() { this.terminated++;return Promise.resolve(0); }
}
const setup = (worker = new TestWorker(), options: Partial<ConstructorParameters<typeof AppWorkerHost>[0]> = {}) => ({
    worker, host: new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any,
        appModulePath: '/unused', timeout: 1000, config: { AOTUI_DATA_DIR: '/unused' }, existingWorker: worker as any, ...options }),
});
it.each(['missing', 'invalid', 'undefined', 'wrong-type', 'valid'] as const)('B02: separate persistence ACK %s; no backend opens merely from negotiation', async ack => {
    const { worker, host } = setup();worker.ack = ack;
    if (ack === 'valid' || ack === 'missing') await host.start();
    else await expect(host.start()).rejects.toThrow('PERSISTENCE_UNAVAILABLE');
    if (ack === 'valid') expect(host.getPersistenceReport()).toMatchObject({ actualIO: 0, ownerRetained: false });
    else expect(host.getPersistenceReport()).toBeUndefined();
    host.terminate();
});
it('ignores unsolicited storage and a bad directory for an unnegotiated App, then confirms App cleanup', async () => {
    let opens = 0;
    const { worker, host } = setup(new TestWorker(), { config: { AOTUI_DATA_DIR: 3 }, persistenceBackend: {
        async open() { opens++;throw Error('unexpected open'); },
    } });
    worker.ack = 'missing';
    await host.start();
    worker.emit('message', { type: 'STATE_STORAGE_REQUEST', version: 2, instanceId: host.appInstanceId,
        sequence: 1, action: 'read', address: { namespace: '["d","a"]', key: 'value' } });
    await host.open();
    await host.close();
    expect(opens).toBe(0);
    const report = await host.waitForResourceRelease();
    expect(report).toMatchObject({ resourcesReleased: true, appCleanup: { report: { state: 'completed' } } });
    expect(report).not.toHaveProperty('storage');
    expect(worker.sent.filter(message => message.type === 'STATE_STORAGE_RESPONSE')).toHaveLength(0);
});

it('does not open a backend for an ACK that arrives during close', async () => {
    const { worker, host } = setup();
    worker.contactStorage = false;
    const starting = host.start();
    const closed = host.close();
    await expect(starting).rejects.toThrow();
    await closed;
    const report = await host.waitForResourceRelease();
    expect(report).toMatchObject({ resourcesReleased: true, appCleanup: { report: { state: 'completed' } } });
    expect(report.storage).toMatchObject({ pending: 0, ownerRetained: false, release: { status: 'released' } });
    expect(worker.sent.some(message => message.type === 'APP_OPEN')).toBe(false);
});

it('captures a relative directory and backend before negotiation', async () => {
    let directory: string | undefined;
    const config = { AOTUI_DATA_DIR: 'captured' };
    const { worker, host } = setup(new TestWorker(), { config, persistenceBackend: {
        async open(input) {
            directory = input.rootDirectory;
            return { status: 'rejected', issue: { code: 'IO_FAILED', message: 'test' } };
        },
    } });
    try {
        const pending = host.start();
        config.AOTUI_DATA_DIR = 'changed';
        await pending;
        worker.emit('message', { type: 'STATE_STORAGE_REQUEST', version: 2, instanceId: host.appInstanceId,
            sequence: 1, action: 'read', address: { namespace: '["d","a"]', key: 'value' } });
        await host.close();
        expect(directory).toBe(resolve('captured/app-state'));
    } finally { host.terminate(); await host.waitForResourceRelease(); }
});
it('B04: one logical initialization; constructor timeout is bounded', async () => {
    const { host } = setup();await host.start();await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');host.terminate();
    for (const timeout of [0, -1, NaN, Infinity, 1.5, 300001, 2147483648]) expect(() => new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused', timeout })).toThrow('INVALID_INPUT');
});
it('preserves an initial App error and the successful storage cleanup independently', async () => {
    const { worker, host } = setup();await host.start();worker.openFailed = true;
    await expect(host.open()).rejects.toMatchObject({ code: 'E_OPEN_FAILED', message: 'E_OPEN_FAILED: First App open failed' });
    expect(host.getPersistenceReport()).toMatchObject({ unsafe: false, lifecycle: {
        ok: true, unmount: 'completed', dispose: { release: { status: 'released' } },
    } });
    expect(host.getResourceReport().appCleanup?.report).toMatchObject({ state: 'completed', issues: [] });
    host.terminate();
});
it('B18: shutdown lifecycle failure still reaches APP_CLOSE and cannot pool', async () => {
    const { worker, host } = setup();worker.shutdownFailed = true;await host.start();
    const close = host.close();expect(host.close()).toBe(close);await expect(close).rejects.toThrow('APP_CLEANUP_FAILED');
    expect(worker.sent.filter(m => m.type === 'APP_CLOSE')).toHaveLength(1);
    expect(host.getPersistenceReport()).toMatchObject({ unsafe: false, lifecycle: { ok: true, unmount: 'failed' }, release: { status: 'released' } });
    expect((await host.waitForResourceRelease()).worker).toBe('exited');expect(worker.terminated).toBe(1);
});
it('B13: a storage request with the wrong version performs no I/O', async () => {
    const { host, worker } = setup();
    await host.start();
    worker.emit('message', { type: 'STATE_STORAGE_REQUEST', version: '2', instanceId: host.appInstanceId,
        sequence: 1, action: 'read', address: { namespace: '["d","a"]', key: 'value' } });
    await Promise.resolve();
    expect(host.getPersistenceReport()).toMatchObject({ actualIO: 0, ownerRetained: false });
    expect(worker.sent.some(message => message.type === 'STATE_STORAGE_RESPONSE')).toBe(false);
    host.terminate();
});
