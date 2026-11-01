import { it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { AppWorkerHost } from './worker-host.js';

class TestWorker extends EventEmitter {
    sent: any[] = [];terminated = 0;shutdownFailed = false;closeFailed = false;openFailed = false;ack: 'valid' | 'missing' | 'invalid' = 'valid';
    pendingCloseResponse: any;
    postMessage(message: any) {
        this.sent.push(message);
        if (message.type === 'STATE_STORAGE_RESPONSE' && this.pendingCloseResponse) {
            const response = this.pendingCloseResponse;this.pendingCloseResponse = undefined;
            queueMicrotask(() => this.emit('message', response));return;
        }
        queueMicrotask(() => {
            if (message.type === 'INIT') this.emit('message', { type: 'INIT_RESPONSE', requestId: message.requestId, success: true,
                appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: message.appInstanceId },
                ...(this.ack === 'missing' ? {} : { persistence: { protocol: 'state-session-v1', version: 1, instanceId: this.ack === 'invalid' ? 'other' : message.appInstanceId } }) });
            else if (message.type === 'APP_OPEN' && this.openFailed) {
                const instanceId = this.sent[0].appInstanceId;
                this.emit('message', { type: 'LIFECYCLE_RESPONSE', requestId: message.requestId, success: false,
                    error: { code: 'PERSISTENCE_CLOSE_FAILED', message: 'Managed persistence did not complete successfully' },
                    appCleanup: { protocol: 'app-lifecycle-v2', instanceId, state: 'completed', issues: [] },
                    persistence: { protocol: 'state-session-v1', instanceId, ok: false, unmount: 'completed',
                        dispose: { status: 'disposed', unsaved: [], release: { status: 'released' } } } });
            } else {
                const instanceId = this.sent[0].appInstanceId, closing = message.type === 'APP_CLOSE';
                const lifecycleRequest = ['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE'].includes(message.type);
                const cleanupFailed = this.shutdownFailed && lifecycleRequest;
                const persistenceFailed = closing && (this.closeFailed || cleanupFailed);
                const response = { type: message.type === 'RESET' ? 'RESET_RESPONSE' : 'LIFECYCLE_RESPONSE', requestId: message.requestId,
                    success: closing ? !persistenceFailed : true,
                    ...(lifecycleRequest ? { appCleanup: {
                        protocol: 'app-lifecycle-v2', instanceId, state: closing ? cleanupFailed ? 'failed' : 'completed' : 'stopped',
                        issues: cleanupFailed ? [closing ? 'APP_CLEANUP_FAILED' : 'APP_STOP_FAILED'] : [],
                    } } : {}),
                    ...(['APP_SHUTDOWN', 'APP_CLOSE'].includes(message.type) ? { persistence: { protocol: 'state-session-v1', instanceId,
                        ok: closing && !persistenceFailed,
                        unmount: closing ? cleanupFailed ? 'failed' : 'completed' : 'pending', flush: { status: 'completed', ok: true, entries: [] },
                        ...(closing ? { dispose: { status: 'disposed', unsaved: [], release: { status: 'released' } } } : {}) } } : {}) };
                if (message.type === 'APP_CLOSE') {
                    this.pendingCloseResponse = response;
                    this.emit('message', { type: 'STATE_STORAGE_REQUEST', version: 1, instanceId, sequence: 1, operation: 'release' });
                } else this.emit('message', response);
            }
        });
    }
    terminate() { this.terminated++;return Promise.resolve(0); }
}
const setup = (worker = new TestWorker()) => ({ worker, host: new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any,
    appModulePath: '/unused', timeout: 1000, config: { AOTUI_DATA_DIR: '/unused' }, existingWorker: worker as any }) });
it.each(['missing', 'invalid', 'valid'] as const)('B02: separate persistence ACK %s; no backend opens merely from negotiation', async ack => {
    const { worker, host } = setup();worker.ack = ack;
    if (ack === 'valid') await host.start();
    else await expect(host.start()).rejects.toThrow('PERSISTENCE_NEGOTIATION_FAILED');
    expect(host.getPersistenceReport()).toMatchObject({ support: ack === 'valid' ? 'managed' : 'rejected', actualIO: 0, ownerRetained: false });
    host.terminate();
});
it('B04: one logical initialization; constructor timeout is bounded', async () => {
    const { host } = setup();await host.start();await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');host.terminate();
    for (const timeout of [0, -1, NaN, Infinity, 1.5, 300001, 2147483648]) expect(() => new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused', timeout })).toThrow('INVALID_INPUT');
});
it('B05/B18: retains failed initial persistence cleanup evidence and released ownership', async () => {
    const { worker, host } = setup();await host.start();worker.openFailed = true;
    await expect(host.open()).rejects.toThrow('Managed persistence did not complete successfully');
    expect(host.getPersistenceReport()).toMatchObject({ unsafe: true, lifecycle: {
        ok: false, unmount: 'completed', dispose: { release: { status: 'released' } },
    } });
    expect(host.getResourceReport().appCleanup?.report).toMatchObject({ state: 'completed', issues: [] });
    host.terminate();
});
it('B18: shutdown lifecycle failure still reaches APP_CLOSE and cannot pool', async () => {
    const { worker, host } = setup();worker.shutdownFailed = true;await host.start();
    const close = host.close();expect(host.close()).toBe(close);await expect(close).rejects.toThrow('APP_CLEANUP_FAILED');
    expect(worker.sent.filter(m => m.type === 'APP_CLOSE')).toHaveLength(1);expect(host.getPersistenceReport().unsafe).toBe(true);
    expect(await host.releaseWorker()).toBeNull();expect(worker.terminated).toBe(1);
});
it('B13: a storage type accessor never falls through into the legacy message router', async () => {
    const { host } = setup();await host.start();let calls = 0;
    const input = Object.defineProperty({}, 'type', { enumerable: true, get() { calls++;return 'STATE_STORAGE_REQUEST'; } });
    (host as any).handleMessage(input);expect(calls).toBe(0);expect(host.getPersistenceReport().actualIO).toBe(0);host.terminate();
});
