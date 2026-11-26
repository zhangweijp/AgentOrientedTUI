import { committedState, fixtureHost } from './__tests__/worker-fixture.js';
import { defineRuntimeConfig } from '../../spi/config/index.js';
import { WORKER_PROTOCOL } from '../../spi/worker-protocol/types.js';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';

class Channel extends EventEmitter {
    messages: any[] = [];
    autoReply = false;
    terminate = vi.fn(async () => 0);
    postMessage = vi.fn((message: any) => {
        this.messages.push(message);
        if (this.autoReply && message.requestId) this.reply(message);
    });
    reply(message: any) {
        this.emit('message', { type: message.type === 'INIT' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE',
            requestId: message.requestId, success: true,
            ...(message.type === 'INIT' ? {
                appLifecycle: { protocol: 'app-lifecycle-v2', instanceId: message.appInstanceId },
                protocol: message.protocol, toolsEnabled: message.toolsEnabled, appInstanceId: message.appInstanceId,
                projectionLimits: message.projectionLimits,
            } : {}),
        });
    }
    get last() { return this.messages.at(-1); }
}
const hosts: AppWorkerHost[] = [];
function make(options: any = {}) {
    const worker = new Channel();
    const host = fixtureHost(AppWorkerHost, { appId: 'app_init' as any, desktopId: 'd' as any, appModulePath: 'unused',
        ...options }, { worker: worker as any, timeoutMs: 100 });
    hosts.push(host); return { host, worker };
}
const modes = [{ name: 'read-only mode', toolsEnabled: false }, { name: 'tools enabled', toolsEnabled: true }];
function draft(host: AppWorkerHost, producerSeq = 1) {
    return { schemaVersion: 8, appId: host.appId, instanceId: host.appInstanceId, producerSeq, sourceEpoch: producerSeq,
        capturedAt: producerSeq, views: [{ toolBindings: [], id: 'vv', viewInstanceId: 'vi', type: 'File', name: 'File', region: 'dynamic',
            content: { format: 'markdown-v1', value: 'generation ' + producerSeq } }], refs: {}, tools: {} };
}
function clean(host: AppWorkerHost) {
    expect((host as any).pendingRequests.size).toBe(0);
    expect((host as any).snapshotReceiver.core.store.inspect().activeHolds).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
}
function initAck(host: AppWorkerHost, init: any, patch: Record<string, unknown> = {}) {
    return { type: 'INIT_RESPONSE', requestId: init.requestId, success: true,
        appLifecycle: { protocol: 'app-lifecycle-v2', instanceId: host.appInstanceId },
        protocol: init.protocol, toolsEnabled: init.toolsEnabled, appInstanceId: host.appInstanceId,
        projectionLimits: init.projectionLimits, ...patch };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const host of hosts.splice(0)) host.terminate(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Worker Host owns exactly one application initialization', () => {
    it.each(modes.flatMap(mode => ['ready', 'running'].map(state => ({ ...mode, state }))))(
        'rejects repeated start for $name in $state while preserving the first instance', async ({ toolsEnabled, state }) => {
            const { host, worker } = make({ toolsEnabled }); const first = host.start(); worker.reply(worker.last); await first;
            if (state !== 'ready') { const opened = host.open(); worker.reply(worker.last); await opened; }
            worker.emit('message', { type: 'SNAPSHOT_PREPARED', draft: draft(host) });
            const before = committedState(host); const capability = host.canExecuteTools();
            const listeners = ['message', 'error', 'exit'].map(name => worker.listenerCount(name));
            await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1);
            expect(host.getStatus()).toBe(state); expect(committedState(host)).toEqual(before);
            expect(host.canExecuteTools()).toBe(capability);
            expect(['message', 'error', 'exit'].map(name => worker.listenerCount(name))).toEqual(listeners);
            clean(host);
        });
    it.each([{ name: 'default tools enabled', toolsEnabled: undefined }, ...modes])('claims the $name opportunity before the first INIT waits', async ({ toolsEnabled }) => {
        const { host, worker } = make({ toolsEnabled }); const first = host.start(); const init = worker.last;
        expect(init).toMatchObject({ protocol: WORKER_PROTOCOL, toolsEnabled: toolsEnabled !== false });
        expect((host as any).pendingRequests.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
        await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        expect((host as any).pendingRequests.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
        expect(worker.messages).toHaveLength(1); expect(worker.listenerCount('message')).toBe(1);
        worker.reply(init); await first; expect(host.getStatus()).toBe('ready'); clean(host);
    });
    it.each(['response-error', 'timeout', 'post-throw', 'worker-error', 'worker-exit'])(
        'retires a first %s and ignores late ACK/prepared data', async failure => {
            const { host, worker } = make({ toolsEnabled: true });
            vi.spyOn(console, 'error').mockImplementation(() => {});
            if (failure === 'post-throw') worker.postMessage.mockImplementationOnce(message => {
                worker.messages.push(message); throw new Error('SENTINEL');
            });
            const first = host.start().catch(error => error); const init = worker.last;
            const savedListener = worker.listeners('message')[0]!;
            worker.emit('message', { type: 'SNAPSHOT_PREPARED', draft: draft(host) });
            expect(committedState(host).status).toBe('ready');
            if (failure === 'response-error') worker.emit('message', { type: 'ERROR_RESPONSE', requestId: init.requestId,
                success: false, error: { code: 'E_INIT_FAILED', message: 'Initialization failed' } });
            if (failure === 'timeout') await vi.advanceTimersByTimeAsync(101);
            if (failure === 'worker-error') worker.emit('error', new Error('Worker failed'));
            if (failure === 'worker-exit') worker.emit('exit', 0);
            expect(await first).toBeInstanceOf(Error);
            expect(committedState(host).status).toBe('stopped'); const retired = committedState(host);
            savedListener({ type: 'INIT_RESPONSE', requestId: init.requestId, success: true,
                appLifecycle: { protocol: 'app-lifecycle-v2', instanceId: host.appInstanceId },
                protocol: WORKER_PROTOCOL, toolsEnabled: true, appInstanceId: host.appInstanceId,
                projectionLimits: init.projectionLimits });
            savedListener({ type: 'SNAPSHOT_PREPARED', draft: draft(host, 2) });
            expect(host.canExecuteTools()).toBe(false); expect(committedState(host)).toEqual(retired);
            await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1); clean(host);
        });
    it('accepts only the correlated INIT reply', async () => {
        const { host, worker } = make({ toolsEnabled: true });
        const starting = host.start();
        const init = worker.last;
        const ack = initAck(host, init);
        worker.emit('message', { ...ack, type: 'UNSUPPORTED_RESPONSE' });
        expect((host as any).pendingRequests.has(init.requestId)).toBe(true);
        worker.emit('message', ack);
        await starting;
        expect(host.canExecuteTools()).toBe(true);
        clean(host);
    });
    it.each(['missing', 'invalid', 'different'])('retires the Worker when its projection limit reply is %s', async fault => {
        const { host, worker } = make({ projectionLimits: { maxViews: 2, observation: { maxCanonicalBytes: 12345 } } });
        const starting = host.start(), init = worker.last;
        expect(init.projectionLimits).toMatchObject({ maxViews: 2, observation: { maxCanonicalBytes: 12345 } });
        const { projectionLimits, ...ack } = initAck(host, init);
        worker.emit('message', fault === 'missing' ? ack : { ...ack,
            projectionLimits: { ...projectionLimits, maxViews: fault === 'invalid' ? 0 : 3 },
        });
        await expect(starting).rejects.toMatchObject({ code: 'APP_INIT_ACK_INVALID',
            path: fault === 'invalid' ? 'INIT_RESPONSE.projectionLimits.maxViews' : 'INIT_RESPONSE.projectionLimits' });
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(host.canExecuteTools()).toBe(false);
        await expect(host.waitForResourceRelease()).resolves.toMatchObject({ resourcesReleased: true });
        clean(host);
    });
    it.each([
        { label: 'missing protocol', patch: { protocol: undefined }, code: 'WORKER_PROTOCOL_UNSUPPORTED' },
        { label: 'retired protocol', patch: { protocol: 'app-worker/v9' }, code: 'WORKER_PROTOCOL_UNSUPPORTED' },
        { label: 'unknown protocol', patch: { protocol: 'app-worker/future' }, code: 'WORKER_PROTOCOL_UNSUPPORTED' },
        { label: 'missing toolsEnabled', patch: { toolsEnabled: undefined }, code: 'APP_INIT_ACK_INVALID' },
        { label: 'different authorization', patch: { toolsEnabled: true }, code: 'APP_INIT_ACK_INVALID' },
        { label: 'malformed authorization', patch: { toolsEnabled: 'false' }, code: 'APP_INIT_ACK_INVALID' },
        { label: 'wrong instance', patch: { appInstanceId: 'other' }, code: 'APP_INIT_ACK_INVALID' },
    ])('rejects INIT acknowledgment with $label', async ({ patch, code }) => {
        const { host, worker } = make({ toolsEnabled: false });
        const starting = host.start();
        worker.emit('message', initAck(host, worker.last, patch));
        await expect(starting).rejects.toThrow(code);
        expect(host.canExecuteTools()).toBe(false);
        expect(worker.messages.filter(message => message.type === 'INIT')).toHaveLength(1);
        expect(worker.terminate).toHaveBeenCalledOnce();
        await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        clean(host);
    });
    it.each(['close', 'terminate'])(
        'refuses the first start after pre-initialization %s', async terminal => {
            const f = make();
            vi.spyOn(console, 'error').mockImplementation(() => {}); f.worker.autoReply = true;
            if (terminal.startsWith('close')) await f.host.close();
            if (terminal === 'terminate') f.host.terminate();
            await expect(f.host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
            expect(f.worker.messages.filter(m => m.type === 'INIT')).toHaveLength(0);
            expect(committedState(f.host).status).toBe('stopped'); clean(f.host);
        });
    it('rejects a second start while closing during initialization', async () => {
        const { host, worker } = make();
        const starting = host.start().catch(error => error);
        const closed = host.close();
        await expect(host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        worker.autoReply = true;
        if (worker.last?.type === 'APP_STOP') worker.reply(worker.last);
        await vi.runAllTimersAsync();
        await starting;
        await closed.catch(() => {});
        clean(host);
        expect(worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1);
    });
    it('bounds the Runtime timeout configuration', () => {
        for (const timeout of [0, -1, NaN, Infinity, 1.5, 300001, 2147483648]) {
            expect(() => defineRuntimeConfig({ worker: { timeoutMs: timeout } }))
                .toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
        }
    });
});
