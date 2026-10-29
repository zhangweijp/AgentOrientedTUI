import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { refKey } from '../../core/snapshot/index.js';
import { REF_V1_CAPABILITY } from '../../adapters/ref-invocation-v1.js';

class Transport extends EventEmitter {
    messages: any[] = [];
    postMessage = vi.fn((message: any) => { this.messages.push(message); this.emit('sent', message); });
    terminate = vi.fn(async () => 0);
    answer(message: any, extra: any = {}) {
        this.emit('message', { type: message.type === 'INIT' ? 'INIT_RESPONSE' : message.type === 'RESET' ? 'RESET_RESPONSE' : 'LIFECYCLE_RESPONSE',
            requestId: message.requestId, success: true, ...extra });
    }
    get last() { return this.messages.at(-1); }
    waitFor(type: string): Promise<any> {
        if (this.last?.type === type) return Promise.resolve(this.last);
        return new Promise(resolve => {
            const receive = (m: any) => { if (m.type === type) { this.off('sent', receive); resolve(m); } };
            this.on('sent', receive);
        });
    }
}
const hosts: AppWorkerHost[] = [];
function make(options: any = {}) {
    const worker = new Transport();
    const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: 'unused', timeout: 25,
        existingWorker: worker as any, snapshotShadow: true, experimentalReadOnlyViewTools: true,
        experimentalSnapshotValueRefExecution: true, ...options });
    hosts.push(host); return { host, worker };
}
async function ready(options: any = {}, ack?: any) {
    const f = make(options); const init = f.host.start();
    f.worker.answer(f.worker.last, ack ?? { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: f.host.appInstanceId });
    await init; const open = f.host.open(); f.worker.answer(f.worker.last); await open; return f;
}
function source(host: AppWorkerHost) {
    const vi = 'vi'; const id = JSON.stringify(['app', 'File', 'read']);
    const receiver = (host as any).shadowReceiver;
    receiver.acceptPrepared({ schemaVersion: 2, appId: 'app', instanceId: host.appInstanceId, producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
        views: [{ id: 'v', viewInstanceId: vi, type: 'File', name: 'File', kind: 'state', content: { format: 'markdown-v1', value: 'File' } }],
        refs: { [refKey('v', vi, 'ref')]: { id: 'ref', ownerViewId: 'v', ownerViewInstanceId: vi,
            refType: 'unknown', target: { kind: 'snapshot-value', payload: { text: 'A' } } } },
        tools: { [id]: { id, name: 'read', description: 'Read', viewType: 'File', isMutating: false, inputSchema: {
            type: 'object', properties: { file: { type: 'string', 'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target' } } }, required: ['file'],
        }, targets: [{ viewId: 'v', viewInstanceId: vi, bindingVersion: 1 }] } } });
    const latest = receiver.core.store.readLatest('app'); expect(latest.status).toBe('ready');
    return { snapshotId: latest.snapshot.id, toolId: id, viewId: 'v', args: { file: 'ref', other: { nested: true } } };
}
function terminal(message: any, extra: any = {}) {
    return { type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE', requestId: message.requestId, appId: message.appId,
        instanceId: message.instanceId, argumentMode: 'snapshot-value-v1', success: true,
        terminal: { phase: 'not-entered', result: { success: false, error: { code: 'REF_EXECUTION_UNAVAILABLE', message: 'Closed' } } }, ...extra };
}
function clean(host: AppWorkerHost) {
    expect((host as any).pendingRequests.size).toBe(0);
    const store = (host as any).shadowReceiver?.core.store;
    if (store) expect(store.inspect().activeLeases).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
}
afterEach(() => { for (const h of hosts.splice(0)) h.terminate(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Ref v1 Host: capability belongs to pending INIT and physical Worker', () => {
    it.each([
        { experimentalSnapshotValueRefExecution: undefined }, { experimentalSnapshotValueRefExecution: false },
        { snapshotShadow: false }, { experimentalReadOnlyViewTools: false },
    ])('leaves defaults/dependencies disabled %#', async options => {
        const f = await ready(options); expect(f.worker.messages[0].requestedCapabilities).toBeUndefined();
        expect(f.host.hasSnapshotValueRefCapability()).toBe(false);
        const count = f.worker.messages.length;
        expect(await f.host.executeSnapshotValueRefTool({}, () => true)).toMatchObject({ error: { code: 'REF_EXECUTION_UNAVAILABLE' } });
        expect(f.worker.messages).toHaveLength(count);
    });
    it.each([{}, { acceptedCapabilities: ['view-tool-ref-invoke/v2'] }, { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: 'wrong' },
        { acceptedCapabilities: [REF_V1_CAPABILITY, 'unknown'] }, { acceptedCapabilities: 'bad' }, { acceptedCapabilities: [REF_V1_CAPABILITY, REF_V1_CAPABILITY] },
    ])('accepts legacy initialization without granting invalid ACK %#', async ack => {
        const f = await ready({}, ack); expect(f.host.getStatus()).toBe('running');
        expect(f.host.hasSnapshotValueRefCapability()).toBe(false);
        expect(f.worker.listenerCount('message')).toBe(1);
    });
    it('ignores wrong requestId, duplicate and late ACK', async () => {
        const f = make(); const start = f.host.start(); const init = f.worker.last;
        const ack = { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: f.host.appInstanceId };
        f.worker.answer({ ...init, requestId: 'wrong' }, ack); expect(f.host.hasSnapshotValueRefCapability()).toBe(false);
        f.worker.answer(init, ack); await start; expect(f.host.hasSnapshotValueRefCapability()).toBe(true);
        await expect(f.host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        expect(f.worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1);
        f.worker.answer(init, { ...ack, appInstanceId: 'wrong' });
        expect(f.host.hasSnapshotValueRefCapability()).toBe(true);
        const savedListener = f.worker.listeners('message')[0]!;
        f.host.terminate();
        savedListener({ type: 'INIT_RESPONSE', requestId: init.requestId, success: true, ...ack });
        expect(f.host.hasSnapshotValueRefCapability()).toBe(false);
    });
    it('cannot reopen capabilities when close is pending during INIT', async () => {
        const f = make(); const start = f.host.start().catch(e => e); const init = f.worker.last;
        const closing = f.host.close().catch(e => e);
        f.worker.answer(init, { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: f.host.appInstanceId });
        expect(await start).toBeInstanceOf(Error); await closing;
        expect(f.host.hasSnapshotValueRefCapability()).toBe(false); expect(f.host.getStatus()).toBe('closed');
        f.worker.answer(init, { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: f.host.appInstanceId });
        expect(f.host.hasSnapshotValueRefCapability()).toBe(false);
    });
    it('rejects overlapping Shadow start without invalidating the original pending ACK', async () => {
        const f = make(); const first = f.host.start(); const init = f.worker.last;
        await expect(f.host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        expect(f.worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1);
        expect(f.host.hasSnapshotValueRefCapability()).toBe(false);
        f.worker.answer(init, { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: f.host.appInstanceId });
        await first; expect(f.host.hasSnapshotValueRefCapability()).toBe(true);
    });
    it('RESET invalidates a pending INIT even before any RESET response', async () => {
        const f = make(); const start = f.host.start().catch(e => e); const init = f.worker.last;
        const reset = (f.host as any).sendRequest({ type: 'RESET', requestId: 'reset-in-flight' }); const resetMessage = f.worker.last;
        f.worker.answer(init, { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: f.host.appInstanceId });
        expect(await start).toBeInstanceOf(Error); expect(f.host.hasSnapshotValueRefCapability()).toBe(false);
        f.worker.answer(resetMessage); await reset;
        f.worker.answer(init, { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: f.host.appInstanceId });
        expect(f.host.hasSnapshotValueRefCapability()).toBe(false);
    });
    it('INIT timeout and send failure never permit a later ACK', async () => {
        vi.useFakeTimers(); const f = make(); const start = f.host.start().catch(e => e); const init = f.worker.last;
        await vi.advanceTimersByTimeAsync(26); expect(await start).toBeInstanceOf(Error);
        f.worker.answer(init, { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: f.host.appInstanceId });
        expect(f.host.hasSnapshotValueRefCapability()).toBe(false); clean(f.host);
        await expect(f.host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        expect(f.worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1);
        const failed = make();
        failed.worker.postMessage.mockImplementation(() => { throw new Error('SENTINEL'); });
        await expect(failed.host.start()).rejects.toThrow('Worker request could not be sent'); clean(failed.host);
        await expect(failed.host.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        expect(failed.host.hasSnapshotValueRefCapability()).toBe(false);
    });
    it('revokes at pool release and binds the next Host/new AppInstance to a fresh INIT', async () => {
        const f = await ready(); const savedListener = f.worker.listeners('message')[0]!;
        const release = f.host.releaseWorker(); expect(f.host.hasSnapshotValueRefCapability()).toBe(false);
        f.worker.answer(await f.worker.waitFor('RESET')); const returned = await release;
        expect(returned).toBe(f.worker); expect(f.worker.listenerCount('message')).toBe(0);
        const next = make({ existingWorker: returned }); const start = next.host.start(); const init = f.worker.last;
        expect(next.host.appInstanceId).not.toBe(f.host.appInstanceId);
        savedListener({ type: 'INIT_RESPONSE', requestId: init.requestId, success: true,
            acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: next.host.appInstanceId });
        expect(next.host.hasSnapshotValueRefCapability()).toBe(false);
        f.worker.answer(init, { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: next.host.appInstanceId }); await start;
        expect(next.host.hasSnapshotValueRefCapability()).toBe(true);
        expect(f.host.hasSnapshotValueRefCapability()).toBe(false);
    });
    it('ignores old ACK, terminal and prepared data after a new Host takes over the physical Worker', async () => {
        vi.useFakeTimers(); const first = await ready(); const request = source(first.host);
        const worker = first.worker; const oldInit = worker.messages[0]; const oldListener = worker.listeners('message')[0]!;
        const inFlight = first.host.executeSnapshotValueRefTool(request, () => true); await Promise.resolve(); const oldCall = worker.last;
        worker.emit('message', terminal(oldCall, { terminal: { phase: 'entered-returned', result: { success: true, data: { completed: true } } } }));
        expect(await inFlight).toMatchObject({ success: true, data: { completed: true } });
        const released = first.host.releaseWorker();
        worker.answer(await worker.waitFor('RESET')); const physical = await released;
        expect(physical).toBe(worker);
        const next = make({ existingWorker: physical }); const starting = next.host.start(); const freshInit = worker.last;
        worker.answer(oldInit, { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: first.host.appInstanceId });
        oldListener({ type: 'INIT_RESPONSE', requestId: freshInit.requestId, success: true,
            acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: next.host.appInstanceId });
        expect(next.host.hasSnapshotValueRefCapability()).toBe(false);
        expect((next.host as any).pendingRequests.size).toBe(1);
        worker.answer(freshInit, { acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: next.host.appInstanceId }); await starting;
        const opening = next.host.open(); worker.answer(worker.last); await opening;
        const current = source(next.host); const snapshotId = next.host.getSnapshotShadowReport()?.snapshotId;
        const active = next.host.executeSnapshotValueRefTool(current, () => true); await Promise.resolve(); const currentCall = worker.last;
        worker.emit('message', terminal(oldCall)); oldListener(terminal(currentCall));
        worker.emit('message', { type: 'SNAPSHOT_PREPARED', draft: { schemaVersion: 2, appId: 'app',
            instanceId: first.host.appInstanceId, producerSeq: 99, sourceEpoch: 99, capturedAt: 99, views: [], refs: {}, tools: {} } });
        expect((next.host as any).pendingRequests.size).toBe(1);
        expect(next.host.getSnapshotShadowReport()).toMatchObject({ health: 'ready', snapshotId });
        worker.emit('message', terminal(currentCall));
        expect(await active).toMatchObject({ error: { code: 'REF_EXECUTION_UNAVAILABLE' } });
        clean(next.host); clean(first.host); expect(worker.listenerCount('message')).toBe(1);
    });

});

describe('Ref v1 Host: simulated terminals and resource cleanup', () => {
    it.each(['not-entered', 'entered-true', 'entered-false'])('maps trusted %s without retry', async phase => {
        vi.useFakeTimers(); const f = await ready(); const request = source(f.host);
        const pending = f.host.executeSnapshotValueRefTool(request, () => true); await Promise.resolve(); const message = f.worker.last;
        expect(message).toMatchObject({ type: 'VIEW_TOOL_INVOKE_REF_V1', rawArgs: request.args,
            effectiveArgs: { file: { text: 'A' }, other: { nested: true } } });
        expect((f.host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(1);
        const response = terminal(message);
        if (phase !== 'not-entered') response.terminal = { phase: 'entered-returned', result: phase === 'entered-true'
            ? { success: true, data: { received: true } } : { success: false, error: { code: 'BUSINESS_FAILED', message: 'Expected' } } };
        f.worker.emit('message', response); expect(await pending).toEqual(response.terminal.result);
        clean(f.host); expect(f.worker.messages.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1')).toHaveLength(1);
    });
    it.each(['timeout', 'exit', 'error', 'throw', 'wrong-instance', 'wrong-mode', 'wrong-type', 'bad-phase', 'over-budget', 'closing', 'reset'])('reports unknown and frees resources for %s', async kind => {
        vi.useFakeTimers(); const f = await ready(); const request = source(f.host);
        if (kind === 'throw') f.worker.postMessage.mockImplementation(() => { throw new Error('SENTINEL'); });
        const pending = f.host.executeSnapshotValueRefTool(request, () => true); await Promise.resolve(); const message = f.worker.last;
        const response = terminal(message);
        let lifecycle: Promise<any> | undefined;
        if (kind === 'timeout') await vi.advanceTimersByTimeAsync(26);
        if (kind === 'exit') f.worker.emit('exit', 0);
        if (kind === 'error') { vi.spyOn(console, 'error').mockImplementation(() => {}); f.worker.emit('error', new Error('closed')); }
        if (kind === 'wrong-instance') { response.instanceId = 'wrong'; f.worker.emit('message', response); }
        if (kind === 'wrong-mode') { response.argumentMode = 'other'; f.worker.emit('message', response); }
        if (kind === 'wrong-type') { response.type = 'OPERATION_RESPONSE'; f.worker.emit('message', response); }
        if (kind === 'bad-phase') { response.terminal.phase = 'maybe'; f.worker.emit('message', response); }
        if (kind === 'over-budget') { response.terminal.result.data = { text: 'x'.repeat(525_000) }; f.worker.emit('message', response); }
        if (kind === 'closing') lifecycle = f.host.close();
        if (kind === 'reset') lifecycle = f.host.releaseWorker();
        const result = await pending;
        expect(result).toMatchObject({ success: false, error: { code: 'TOOL_OUTCOME_UNKNOWN' } });
        expect(JSON.stringify(result)).not.toContain('SENTINEL');
        if (lifecycle) {
            if (kind === 'reset') {
                expect(await lifecycle).toBe(null);expect(f.worker.messages.some(m => m.type === 'RESET')).toBe(false);
                expect(f.worker.terminate).toHaveBeenCalledOnce();
            }
            else {
                f.worker.answer(await f.worker.waitFor('APP_SHUTDOWN'));
                f.worker.answer(await f.worker.waitFor('APP_CLOSE'));
            }
            await lifecycle;
        }
        clean(f.host);
        expect(f.worker.messages.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1').length).toBeLessThanOrEqual(1);
        expect(f.worker.listenerCount('message')).toBe(['exit', 'reset'].includes(kind) ? 0 : 1);
    });
    it('a wrong requestId cannot complete another pending Ref call', async () => {
        vi.useFakeTimers(); const f = await ready(); const request = source(f.host);
        const a = f.host.executeSnapshotValueRefTool(request, () => true); await Promise.resolve(); const first = f.worker.last;
        const b = f.host.executeSnapshotValueRefTool(request, () => true); await Promise.resolve(); const second = f.worker.last;
        f.worker.emit('message', terminal({ ...first, requestId: 'missing' }));
        expect((f.host as any).pendingRequests.size).toBe(2);
        f.worker.emit('message', terminal(second)); expect((await b).error?.code).toBe('REF_EXECUTION_UNAVAILABLE');
        expect((f.host as any).pendingRequests.size).toBe(1);
        f.worker.emit('message', terminal(first)); expect((await a).error?.code).toBe('REF_EXECUTION_UNAVAILABLE'); clean(f.host);
    });
    it('new terminal cannot complete an ordinary operation; generic postMessage failure also cleans pending/timer', async () => {
        vi.useFakeTimers(); const f = await ready();
        const ordinary = (f.host as any).sendRequest({ type: 'VIEW_TOOL_INVOKE', requestId: 'plain', args: {} });
        f.worker.emit('message', terminal({ requestId: 'plain', appId: 'app', instanceId: f.host.appInstanceId }));
        expect((f.host as any).pendingRequests.size).toBe(1);
        f.worker.emit('message', { type: 'OPERATION_RESPONSE', requestId: 'plain', success: true, result: { success: false, error: { code: 'B', message: 'Business' } } });
        expect(await ordinary).toMatchObject({ error: { code: 'B' } });
        f.worker.postMessage.mockImplementation(() => { throw new Error('SENTINEL'); });
        await expect((f.host as any).sendRequest({ type: 'APP_PAUSE', requestId: 'fail' })).rejects.toThrow('Worker request could not be sent'); clean(f.host);
    });
});
