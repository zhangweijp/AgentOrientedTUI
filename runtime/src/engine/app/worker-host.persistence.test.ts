import { it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { AppWorkerHost } from './worker-host.js';

class TestWorker extends EventEmitter {
    sent: any[] = [];terminated = 0;shutdownFailed = false;closeFailed = false;ack: 'valid' | 'missing' | 'invalid' = 'valid';
    postMessage(message: any) {
        this.sent.push(message);
        queueMicrotask(() => {
            if (message.type === 'INIT') this.emit('message', { type: 'INIT_RESPONSE', requestId: message.requestId, success: true,
                ...(this.ack === 'missing' ? {} : { persistence: { protocol: 'state-session-v1', version: 1, instanceId: this.ack === 'invalid' ? 'other' : message.appInstanceId } }) });
            else {
                const instanceId = this.sent[0].appInstanceId, closing = message.type === 'APP_CLOSE', failed = closing ? this.closeFailed : this.shutdownFailed;
                this.emit('message', { type: message.type === 'RESET' ? 'RESET_RESPONSE' : 'LIFECYCLE_RESPONSE', requestId: message.requestId, success: !failed,
                    ...(['APP_SHUTDOWN', 'APP_CLOSE'].includes(message.type) ? { persistence: { protocol: 'state-session-v1', instanceId, ok: closing && !failed,
                        unmount: closing ? 'completed' : 'pending', flush: { status: 'completed', ok: true, entries: [] },
                        ...(closing ? { dispose: { status: 'disposed', unsaved: [], release: { status: 'released' } } } : {}) } } : {}) });
            }
        });
    }
    terminate() { this.terminated++;return Promise.resolve(0); }
}
const setup = (worker = new TestWorker()) => ({ worker, host: new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any,
    appModulePath: '/unused', timeout: 1000, config: { AOTUI_DATA_DIR: '/unused' }, existingWorker: worker as any }) });
it.each(['missing', 'invalid', 'valid'] as const)('B02: separate persistence ACK %s; no backend opens merely from negotiation', async ack => {
    const { worker, host } = setup();worker.ack = ack;
    if (ack === 'invalid') await expect(host.start()).rejects.toThrow('PERSISTENCE_NEGOTIATION_FAILED');else await host.start();
    expect(host.getPersistenceReport()).toMatchObject({ support: ack === 'valid' ? 'managed' : ack === 'missing' ? 'legacy-unverified' : 'rejected', actualIO: 0, ownerRetained: false });
    host.terminate();
});
it('B04: one logical initialization even without Shadow; constructor timeout is bounded', async () => {
    const { host } = setup();await host.start();await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');host.terminate();
    for (const timeout of [0, -1, NaN, Infinity, 1.5, 300001, 2147483648]) expect(() => new AppWorkerHost({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused', timeout })).toThrow('INVALID_INPUT');
});
it('B18: shutdown failure still reaches APP_CLOSE, remains failed and cannot pool', async () => {
    const { worker, host } = setup();worker.shutdownFailed = true;await host.start();
    const close = host.close();expect(host.close()).toBe(close);await expect(close).rejects.toThrow('PERSISTENCE_CLOSE_FAILED');
    expect(worker.sent.filter(m => m.type === 'APP_CLOSE')).toHaveLength(1);expect(host.getPersistenceReport().unsafe).toBe(true);
    expect(await host.releaseWorker()).toBeNull();expect(worker.terminated).toBe(1);
});
it('B13: a storage type accessor never falls through into the legacy message router', async () => {
    const { host } = setup();await host.start();let calls = 0;
    const input = Object.defineProperty({}, 'type', { enumerable: true, get() { calls++;return 'STATE_STORAGE_REQUEST'; } });
    (host as any).handleMessage(input);expect(calls).toBe(0);expect(host.getPersistenceReport().actualIO).toBe(0);host.terminate();
});
