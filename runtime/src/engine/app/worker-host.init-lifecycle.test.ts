import { SNAPSHOT_CAPABILITY } from '../../adapters/worker-message-capture.js';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { PARAMETERS_V4_CAPABILITY } from '../../adapters/ordinary-invocation-v2.js';

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
            ...(message.type === 'INIT' ? {
                appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: message.appInstanceId },
                persistence: { protocol: 'state-session-v1', version: 1, instanceId: message.appInstanceId },
                acceptedCapabilities: message.requestedCapabilities, appInstanceId: message.appInstanceId,
            } : {}),
        });
    }
    get last() { return this.messages.at(-1); }
}
const hosts: AppWorkerHost[] = [];
function make(options: any = {}) {
    const worker = new Channel();
    const host = new AppWorkerHost({ appId: 'app_init' as any, desktopId: 'd' as any, appModulePath: 'unused',
        existingWorker: worker as any, timeout: 100, ...options });
    hosts.push(host); return { host, worker };
}
const modes = [{ name: 'empty capability set', interactionModes: [] }, { name: 'qualified parameters', interactionModes: ['view-type-parameters-v1'] }];
function draft(host: AppWorkerHost, producerSeq = 1) {
    return { schemaVersion: 3, appId: host.appId, instanceId: host.appInstanceId, producerSeq, sourceEpoch: producerSeq,
        capturedAt: producerSeq, views: [{ id: 'vv', viewInstanceId: 'vi', type: 'File', name: 'File', kind: 'state',
            content: { format: 'markdown-v1', value: 'generation ' + producerSeq } }], refs: {}, tools: {} };
}
function clean(host: AppWorkerHost) {
    expect((host as any).pendingRequests.size).toBe(0);
    expect((host as any).snapshotReceiver.core.store.inspect().activeLeases).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
}
function initAck(host: AppWorkerHost, init: any, acceptedCapabilities: unknown) {
    return { type: 'INIT_RESPONSE', requestId: init.requestId, success: true,
        appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: host.appInstanceId },
        persistence: { protocol: 'state-session-v1', version: 1, instanceId: host.appInstanceId },
        acceptedCapabilities, appInstanceId: host.appInstanceId };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const host of hosts.splice(0)) host.terminate(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Worker Host owns exactly one application initialization', () => {
    it.each(modes.flatMap(mode => ['ready', 'running', 'paused'].map(state => ({ ...mode, state }))))(
        'rejects repeated start for $name in $state while preserving the first instance', async ({ interactionModes, state }) => {
            const { host, worker } = make({ interactionModes }); const first = host.start(); worker.reply(worker.last); await first;
            if (state !== 'ready') { const opened = host.open(); worker.reply(worker.last); await opened; }
            if (state === 'paused') { const paused = host.pause(); worker.reply(worker.last); await paused; }
            worker.emit('message', { type: 'SNAPSHOT_PREPARED', draft: draft(host) });
            const before = host.getSemanticSnapshotReport(); const capability = host.hasOrdinaryParametersCapability();
            const listeners = ['message', 'error', 'exit'].map(name => worker.listenerCount(name));
            await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1);
            expect(host.getStatus()).toBe(state); expect(host.getSemanticSnapshotReport()).toEqual(before);
            expect(host.hasOrdinaryParametersCapability()).toBe(capability);
            expect(['message', 'error', 'exit'].map(name => worker.listenerCount(name))).toEqual(listeners);
            clean(host);
        });
    it.each(modes)('claims the $name opportunity before the first INIT waits', async ({ interactionModes }) => {
        const { host, worker } = make({ interactionModes }); const first = host.start(); const init = worker.last;
        expect(init.requestedCapabilities).toEqual([SNAPSHOT_CAPABILITY, ...interactionModes.map(() => PARAMETERS_V4_CAPABILITY)]);
        expect((host as any).pendingRequests.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
        await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        expect((host as any).pendingRequests.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
        expect(worker.messages).toHaveLength(1); expect(worker.listenerCount('message')).toBe(1);
        worker.reply(init); await first; expect(host.getStatus()).toBe('ready'); clean(host);
    });
    it.each(['response-error', 'timeout', 'post-throw', 'worker-error', 'worker-exit'])(
        'retires a first %s and ignores late ACK/prepared data', async failure => {
            const { host, worker } = make({ interactionModes: ['view-type-parameters-v1'] });
            vi.spyOn(console, 'error').mockImplementation(() => {});
            if (failure === 'post-throw') worker.postMessage.mockImplementationOnce(message => {
                worker.messages.push(message); throw new Error('SENTINEL');
            });
            const savedListener = worker.listeners('message')[0]!;
            const first = host.start().catch(error => error); const init = worker.last;
            worker.emit('message', { type: 'SNAPSHOT_PREPARED', draft: draft(host) });
            expect(host.getSemanticSnapshotReport()?.health).toBe('ready');
            if (failure === 'response-error') worker.emit('message', { type: 'ERROR_RESPONSE', requestId: init.requestId,
                success: false, error: { code: 'E_INIT_FAILED', message: 'Initialization failed' } });
            if (failure === 'timeout') await vi.advanceTimersByTimeAsync(101);
            if (failure === 'worker-error') worker.emit('error', new Error('Worker failed'));
            if (failure === 'worker-exit') worker.emit('exit', 0);
            expect(await first).toBeInstanceOf(Error);
            expect(host.getSemanticSnapshotReport()?.health).toBe('stopped'); const retired = host.getSemanticSnapshotReport();
            savedListener({ type: 'INIT_RESPONSE', requestId: init.requestId, success: true,
                appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: host.appInstanceId },
                persistence: { protocol: 'state-session-v1', version: 1, instanceId: host.appInstanceId },
                acceptedCapabilities: [PARAMETERS_V4_CAPABILITY], appInstanceId: host.appInstanceId });
            savedListener({ type: 'SNAPSHOT_PREPARED', draft: draft(host, 2) });
            expect(host.hasOrdinaryParametersCapability()).toBe(false); expect(host.getSemanticSnapshotReport()).toEqual(retired);
            await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1); clean(host);
        });
    it('rejects a V2 execution capability in the V4 handshake immediately', async () => {
        const { host, worker } = make({ interactionModes: ['view-type-parameters-v1'] });
        const starting = host.start();
        const init = worker.last;
        worker.emit('message', { type: 'INIT_RESPONSE', requestId: init.requestId, success: true,
            appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: host.appInstanceId },
            persistence: { protocol: 'state-session-v1', version: 1, instanceId: host.appInstanceId },
            acceptedCapabilities: ['view-tool-ordinary-invoke/v2'], appInstanceId: host.appInstanceId });
        await expect(starting).rejects.toThrow('WORKER_PROTOCOL_V3_REQUIRED');
        expect(host.hasOrdinaryParametersCapability()).toBe(false);
        expect(host.hasOrdinaryParametersCapability()).toBe(false);
        expect(worker.messages.filter(message => message.type === 'INIT')).toHaveLength(1);
        expect(worker.terminate).toHaveBeenCalledOnce();
        await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        clean(host);
    });
    it('rejects a missing Snapshot ACK before accepting execution capabilities', async () => {
        const { host, worker } = make({ interactionModes: ['view-type-parameters-v1'] });
        const starting = host.start();
        const init = worker.last;
        worker.emit('message', initAck(host, init, []));
        await expect(starting).rejects.toThrow('WORKER_SNAPSHOT_UNSUPPORTED');
        expect(host.hasOrdinaryParametersCapability()).toBe(false);
        expect(host.hasOrdinaryParametersCapability()).toBe(false);
        clean(host);
    });
    it('requires every requested Tool capability even when Snapshot support is acknowledged', async () => {
        const { host, worker } = make({ interactionModes: ['view-type-parameters-v1'] });
        const starting = host.start(), init = worker.last;
        worker.emit('message', initAck(host, init, [SNAPSHOT_CAPABILITY]));
        await expect(starting).rejects.toThrow('WORKER_CAPABILITY_UNAVAILABLE');
        expect(host.hasOrdinaryParametersCapability()).toBe(false);clean(host);
    });
    it('accepts a requested qualified V4 capability', async () => {
        const { host, worker } = make({ interactionModes: ['view-type-parameters-v1'] });
        const starting = host.start();
        const init = worker.last;
        worker.emit('message', initAck(host, init, [SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY]));
        await starting;
        expect(host.hasOrdinaryParametersCapability()).toBe(true);
        clean(host);
    });
    it.each([
        { label: 'duplicate ACK entries', accepted: ['view-tool-ordinary-invoke/v3', 'view-tool-ordinary-invoke/v3'], code: 'WORKER_CAPABILITY_INVALID' },
        { label: 'unknown capability', accepted: ['view-tool-future-invoke/v9'], code: 'WORKER_CAPABILITY_UNSUPPORTED' },
        { label: 'an unrequested valid capability', accepted: [PARAMETERS_V4_CAPABILITY], code: 'WORKER_CAPABILITY_ACK_INVALID' },
        { label: 'retired V3 capability', accepted: ['view-tool-ref-invoke/v3'], code: 'WORKER_CAPABILITY_UNSUPPORTED' },
        { label: 'a malformed ACK', accepted: { capabilities: [] }, code: 'WORKER_CAPABILITY_INVALID' },
    ])('rejects $label rather than treating it as an empty capability set', async ({ accepted, code }) => {
        const { host, worker } = make({ interactionModes: code === 'WORKER_CAPABILITY_ACK_INVALID' ? [] : ['view-type-parameters-v1'] });
        const starting = host.start();
        const init = worker.last;
        worker.emit('message', initAck(host, init, accepted));
        await expect(starting).rejects.toThrow(code);
        expect(host.hasOrdinaryParametersCapability()).toBe(false);
        expect(worker.messages.filter(message => message.type === 'INIT')).toHaveLength(1);
        expect(worker.terminate).toHaveBeenCalledOnce();
        await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        clean(host);
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
            expect(f.host.getSemanticSnapshotReport()?.health).toBe('stopped'); clean(f.host);
        });
    it('rejects start while a pre-initialization close is still waiting', async () => {
        const { host, worker } = make(); const closed = host.close();
        await expect(host.start()).rejects.toThrow('Cannot start an App while shutdown is pending');
        worker.autoReply = true;
        if (worker.last?.type === 'APP_SHUTDOWN') worker.reply(worker.last);
        await closed; clean(host);
        expect(worker.messages.filter(m => m.type === 'INIT')).toHaveLength(0);
    });
});
