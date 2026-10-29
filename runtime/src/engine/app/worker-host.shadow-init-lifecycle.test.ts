import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { REF_V1_CAPABILITY } from '../../adapters/ref-invocation-v1.js';

class Channel extends EventEmitter {
    messages: any[] = [];
    autoReply = false;
    terminate = vi.fn(async () => 0);
    postMessage = vi.fn((message: any) => {
        this.messages.push(message);
        if (this.autoReply && message.requestId) this.reply(message);
    });
    reply(message: any) {
        this.emit('message', { type: message.type === 'INIT' ? 'INIT_RESPONSE' : message.type === 'RESET' ? 'RESET_RESPONSE' : 'LIFECYCLE_RESPONSE',
            requestId: message.requestId, success: true,
            ...(message.type === 'INIT' && message.requestedCapabilities ? {
                acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: message.appInstanceId,
            } : {}),
        });
    }
    get last() { return this.messages.at(-1); }
}
const hosts: AppWorkerHost[] = [];
function make(options: any = {}) {
    const worker = new Channel();
    const host = new AppWorkerHost({ appId: 'shadow_init' as any, desktopId: 'd' as any, appModulePath: 'unused',
        existingWorker: worker as any, snapshotShadow: true, timeout: 100, ...options });
    hosts.push(host); return { host, worker };
}
const modes = [
    { name: 'Shadow only', flags: {} },
    { name: 'ordinary read-only', flags: { experimentalReadOnlyViewTools: true } },
    { name: 'M5', flags: { experimentalVersionedMutations: true } },
    { name: 'Ref', flags: { experimentalReadOnlyViewTools: true, experimentalSnapshotValueRefExecution: true } },
    { name: 'Ref flag without read-only dependency', flags: { experimentalSnapshotValueRefExecution: true } },
];
function draft(host: AppWorkerHost, producerSeq = 1) {
    return { schemaVersion: 2, appId: host.appId, instanceId: host.appInstanceId, producerSeq, sourceEpoch: producerSeq,
        capturedAt: producerSeq, views: [{ id: 'vv', viewInstanceId: 'vi', type: 'File', name: 'File', kind: 'state',
            content: { format: 'markdown-v1', value: 'generation ' + producerSeq } }], refs: {}, tools: {} };
}
function clean(host: AppWorkerHost) {
    expect((host as any).pendingRequests.size).toBe(0);
    expect((host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const host of hosts.splice(0)) host.terminate(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Shadow Host owns exactly one application initialization', () => {
    it.each(modes.flatMap(mode => ['ready', 'running', 'paused'].map(state => ({ ...mode, state }))))(
        'rejects repeated start for $name in $state while preserving the first instance', async ({ flags, state }) => {
            const { host, worker } = make(flags); const first = host.start(); worker.reply(worker.last); await first;
            if (state !== 'ready') { const opened = host.open(); worker.reply(worker.last); await opened; }
            if (state === 'paused') { const paused = host.pause(); worker.reply(worker.last); await paused; }
            worker.emit('message', { type: 'SNAPSHOT_PREPARED', draft: draft(host) });
            const before = host.getSnapshotShadowReport(); const capability = host.hasSnapshotValueRefCapability();
            const listeners = ['message', 'error', 'exit'].map(name => worker.listenerCount(name));
            await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1);
            expect(host.getStatus()).toBe(state); expect(host.getSnapshotShadowReport()).toEqual(before);
            expect(host.hasSnapshotValueRefCapability()).toBe(capability);
            expect(['message', 'error', 'exit'].map(name => worker.listenerCount(name))).toEqual(listeners);
            clean(host);
        });
    it.each(modes)('claims the $name opportunity before the first INIT waits', async ({ flags }) => {
        const { host, worker } = make(flags); const first = host.start(); const init = worker.last;
        expect((host as any).pendingRequests.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
        await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        expect((host as any).pendingRequests.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
        expect(worker.messages).toHaveLength(1); expect(worker.listenerCount('message')).toBe(1);
        worker.reply(init); await first; expect(host.getStatus()).toBe('ready'); clean(host);
    });
    it.each(['response-error', 'timeout', 'post-throw', 'worker-error', 'worker-exit'])(
        'retires a first %s and ignores late ACK/prepared data', async failure => {
            const { host, worker } = make({ experimentalReadOnlyViewTools: true, experimentalSnapshotValueRefExecution: true });
            vi.spyOn(console, 'error').mockImplementation(() => {});
            if (failure === 'post-throw') worker.postMessage.mockImplementationOnce(message => {
                worker.messages.push(message); throw new Error('SENTINEL');
            });
            const savedListener = worker.listeners('message')[0]!;
            const first = host.start().catch(error => error); const init = worker.last;
            worker.emit('message', { type: 'SNAPSHOT_PREPARED', draft: draft(host) });
            expect(host.getSnapshotShadowReport()?.health).toBe('ready');
            if (failure === 'response-error') worker.emit('message', { type: 'ERROR_RESPONSE', requestId: init.requestId,
                success: false, error: { code: 'E_INIT_FAILED', message: 'Initialization failed' } });
            if (failure === 'timeout') await vi.advanceTimersByTimeAsync(101);
            if (failure === 'worker-error') worker.emit('error', new Error('Worker failed'));
            if (failure === 'worker-exit') worker.emit('exit', 0);
            expect(await first).toBeInstanceOf(Error);
            expect(host.getSnapshotShadowReport()?.health).toBe('stopped'); const retired = host.getSnapshotShadowReport();
            savedListener({ type: 'INIT_RESPONSE', requestId: init.requestId, success: true,
                acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: host.appInstanceId });
            savedListener({ type: 'SNAPSHOT_PREPARED', draft: draft(host, 2) });
            expect(host.hasSnapshotValueRefCapability()).toBe(false); expect(host.getSnapshotShadowReport()).toEqual(retired);
            await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1); clean(host);
        });
    it.each(['close', 'terminate', 'release', 'release-without-worker', 'error', 'exit'])(
        'refuses the first start after pre-initialization %s', async terminal => {
            const f = make(terminal === 'release-without-worker' ? { existingWorker: undefined } : {});
            vi.spyOn(console, 'error').mockImplementation(() => {}); f.worker.autoReply = true;
            if (terminal === 'close') await f.host.close();
            if (terminal === 'terminate') f.host.terminate();
            if (terminal.startsWith('release')) await f.host.releaseWorker();
            if (terminal === 'error') f.worker.emit('error', new Error('Prior failure'));
            if (terminal === 'exit') f.worker.emit('exit', 0);
            await expect(f.host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(f.worker.messages.filter(m => m.type === 'INIT')).toHaveLength(0);
            expect(f.host.getSnapshotShadowReport()?.health).toBe('stopped'); clean(f.host);
        });
    it('rejects start while a pre-initialization close is still waiting', async () => {
        const { host, worker } = make(); const closed = host.close();
        await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        worker.autoReply = true;
        if (worker.last?.type === 'APP_SHUTDOWN') worker.reply(worker.last);
        await closed; clean(host);
        expect(worker.messages.filter(m => m.type === 'INIT')).toHaveLength(0);
    });
});
