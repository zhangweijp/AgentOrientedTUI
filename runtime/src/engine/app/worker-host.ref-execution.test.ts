import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { createSnapshotCore, refKey } from '../../core/snapshot/index.js';
import { REF_V1_CAPABILITY } from '../../adapters/ref-invocation-v1.js';

const SENTINEL = 'W03_B_POLICY_PRIVATE_761cb';
const hosts: AppWorkerHost[] = [];
class Transport extends EventEmitter {
    messages: any[] = [];
    calls = 0;
    postMessage = vi.fn((m: any) => {
        this.messages.push(m);
        if (m.type === 'VIEW_TOOL_INVOKE_REF_V1') {
            this.calls++;
            this.emit('message', { type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE', requestId: m.requestId,
                appId: m.appId, instanceId: m.instanceId, argumentMode: m.argumentMode, success: true,
                terminal: { phase: 'entered-returned', result: { success: true, data: { args: m.effectiveArgs } } } });
        } else this.emit('message', { type: m.type === 'INIT' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE', requestId: m.requestId,
            success: true, ...(m.type === 'INIT' ? { appInstanceId: m.appInstanceId, acceptedCapabilities: [REF_V1_CAPABILITY] } : {}) });
    });
    terminate = vi.fn(async () => 0);
}
async function fixture(storeOptions: any = {}) {
    const worker = new Transport();
    const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: 'unused',
        existingWorker: worker as any, timeout: 30, snapshotShadow: true, experimentalReadOnlyViewTools: true,
        experimentalSnapshotValueRefExecution: true });
    hosts.push(host); await host.start(); await host.open();
    const receiver = (host as any).shadowReceiver; const core = createSnapshotCore(storeOptions);
    core.lifecycle.startApp('app', host.appInstanceId); receiver.core = core;
    const id = JSON.stringify(['app', 'File', 'read']); let seq = 0;
    const base: any = { schemaVersion: 2, appId: 'app', instanceId: host.appInstanceId,
        views: [{ id: 'view', viewInstanceId: 'vi', type: 'File', name: 'File', kind: 'state', content: { format: 'markdown-v1', value: 'File' } }],
        refs: { [refKey('view', 'vi', 'ref')]: { id: 'ref', ownerViewId: 'view', ownerViewInstanceId: 'vi', refType: 'unknown',
            target: { kind: 'snapshot-value', payload: { text: 'A' } } } },
        tools: { [id]: { id, name: 'read', description: 'Read', viewType: 'File', isMutating: false,
            inputSchema: { type: 'object', properties: { file: { type: 'string', 'x-aotui-ref': {
                version: 1, kind: 'snapshot-value', owner: 'tool-target' } } }, required: ['file'] },
            targets: [{ viewId: 'view', viewInstanceId: 'vi', bindingVersion: 1 }] } } };
    function publish(change: any = {}) {
        seq++; receiver.acceptPrepared({ ...base, ...change, producerSeq: seq, sourceEpoch: seq, capturedAt: seq });
        return core.store.readLatest('app');
    }
    const first: any = publish(); expect(first.status).toBe('ready');
    const request: any = { snapshotId: first.snapshot.id, toolId: id, viewId: 'view', args: { file: 'ref', other: { nested: [1, true] } } };
    return { host, worker, receiver, core, request, base, publish, tool: base.tools[id], id };
}
function barrier() { let release!: (x: boolean) => void; const promise = new Promise<boolean>(resolve => { release = resolve; }); return { promise, release }; }
function clean(f: Awaited<ReturnType<typeof fixture>>) {
    expect((f.host as any).pendingRequests.size).toBe(0); expect(f.core.store.inspect().activeLeases).toBe(0);
}
function frozen(value: any) { if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); for (const v of Object.values(value)) frozen(v); } }
afterEach(() => { for (const host of hosts.splice(0)) host.terminate(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('authorized Ref Host with controlled transport and exact source barriers', () => {
    it('a Worker error during a dispatched Ref call produces unknown and only a fixed safe log', async () => {
        const f = await fixture(); let reads = 0;
        const error = {}; for (const key of ['message', 'stack', 'toString']) Object.defineProperty(error, key, { get() { reads++; throw new Error(SENTINEL); } });
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        f.worker.postMessage.mockImplementation(m => { f.worker.messages.push(m); });
        const pending = f.host.executeSnapshotValueRefTool(f.request, () => true); await Promise.resolve();
        expect(f.worker.messages.at(-1).type).toBe('VIEW_TOOL_INVOKE_REF_V1');
        f.worker.emit('error', error);
        expect(await pending).toMatchObject({ error: { code: 'TOOL_OUTCOME_UNKNOWN' } });
        expect(log.mock.calls).toEqual([['[AppWorkerHost] Worker failed in Ref-capable execution']]);
        expect(reads).toBe(0); clean(f);
    });
    it.each([false, undefined, null, 1, 'true', {}, () => true])('requires strictly true, policy result %#', async result => {
        const f = await fixture(); const policy = vi.fn(() => result);
        expect(await f.host.executeSnapshotValueRefTool(f.request, policy)).toMatchObject({ error: { code: 'TOOL_PERMISSION_DENIED' } });
        expect(policy).toHaveBeenCalledOnce(); expect(f.worker.calls).toBe(0); clean(f);
    });
    it.each([undefined, null, true, {}])('denies a missing/non-callable policy %# and permanently closes the old preflight', async policy => {
        const f = await fixture();
        expect(await f.host.executeSnapshotValueRefTool(f.request, policy as any)).toMatchObject({ error: { code: 'TOOL_PERMISSION_DENIED' } });
        expect(await f.host.validateSnapshotValueRefTool(f.request)).toMatchObject({ error: { code: 'REF_EXECUTION_UNAVAILABLE' } });
        expect(f.worker.calls).toBe(0); clean(f);
    });
    it.each(['throw', 'reject'])('classifies policy %s without touching arbitrary exception text', async kind => {
        const f = await fixture(); let reads = 0; const error = {};
        for (const key of ['message', 'toString']) Object.defineProperty(error, key, { get() { reads++; throw new Error(SENTINEL); } });
        const logs = ['error', 'warn', 'log', 'info', 'debug'].map(k => vi.spyOn(console, k as 'log').mockImplementation(() => {}));
        const result = await f.host.executeSnapshotValueRefTool(f.request, () => { if (kind === 'throw') throw error; return Promise.reject(error); });
        expect(result).toEqual({ success: false, error: { code: 'TOOL_AUTHORIZATION_FAILED', message: 'Tool authorization failed' } });
        expect(reads).toBe(0); expect(JSON.stringify(result)).not.toContain(SENTINEL); for (const spy of logs) expect(spy).not.toHaveBeenCalled();
        expect(f.worker.calls).toBe(0); clean(f);
    });
    it('captures all caller IDs/args before await and exposes only frozen semantic authorization data', async () => {
        const f = await fixture(); const gate = barrier(); let authorization: any;
        const result = f.host.executeSnapshotValueRefTool(f.request, context => { authorization = context; return gate.promise; });
        expect(Object.keys(authorization).sort()).toEqual(['effectiveArgs', 'refSources', 'source']); frozen(authorization);
        expect(authorization.source).toEqual({ appId: 'app', instanceId: f.host.appInstanceId,
            snapshotId: f.request.snapshotId, toolId: f.id, viewId: 'view', viewInstanceId: 'vi', bindingVersion: 1 });
        expect(JSON.stringify(authorization.refSources)).not.toContain('text');
        expect(f.core.store.inspect().activeLeases).toBe(1); expect(f.worker.calls).toBe(0);
        f.request.args.file = 'other'; f.request.args.other.nested.push(9); f.request.viewId = 'other'; f.request.toolId = 'other'; f.request.snapshotId = 'other';
        gate.release(true);
        expect(await result).toMatchObject({ success: true, data: { args: { file: { text: 'A' }, other: { nested: [1, true] } } } });
        const wire = f.worker.messages.find(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1');
        expect(wire.rawArgs).toEqual({ file: 'ref', other: { nested: [1, true] } });
        expect(wire.effectiveArgs).toEqual(authorization.effectiveArgs); expect(f.worker.calls).toBe(1); clean(f);
    });
    it.each(['changed', 'deleted'])('uses original S1/A after Ref is %s while waiting for policy', async change => {
        const f = await fixture(); const gate = barrier();
        const result = f.host.executeSnapshotValueRefTool(f.request, () => gate.promise);
        f.publish({ refs: change === 'deleted' ? {} : { ...f.base.refs, [refKey('view', 'vi', 'ref')]: {
            ...f.base.refs[refKey('view', 'vi', 'ref')], target: { kind: 'snapshot-value', payload: { text: 'B' } } } } });
        gate.release(true); expect(await result).toMatchObject({ data: { args: { file: { text: 'A' } } } });
        expect(f.worker.calls).toBe(1); clean(f);
    });
    it.each(['disabled', 'schema', 'description', 'binding', 'remount', 'degraded', 'new-instance', 'close', 'reset'])('revalidates source after policy: %s', async change => {
        const f = await fixture(); const gate = barrier(); const result = f.host.executeSnapshotValueRefTool(f.request, () => gate.promise);
        if (change === 'disabled') f.publish({ tools: {} });
        if (change === 'schema') f.publish({ tools: { [f.id]: { ...f.tool, inputSchema: { ...f.tool.inputSchema, description: 'Changed' } } } });
        if (change === 'description') f.publish({ tools: { [f.id]: { ...f.tool, description: 'New contract' } } });
        if (change === 'binding') f.publish({ tools: { [f.id]: { ...f.tool, targets: [{ ...f.tool.targets[0], bindingVersion: 2 }] } } });
        if (change === 'remount') f.publish({ refs: {}, tools: {}, views: [{ ...f.base.views[0], viewInstanceId: 'replacement' }] });
        if (change === 'degraded') f.publish({ views: 'invalid' });
        if (change === 'new-instance') f.core.lifecycle.startApp('app', 'new');
        if (change === 'close') f.host.terminate();
        if (change === 'reset') await (f.host as any).sendRequest({ type: 'RESET', requestId: 'reset' });
        gate.release(true); const value = await result; expect(value.success).toBe(false);
        expect(value.error?.code).not.toBe('TOOL_OUTCOME_UNKNOWN'); expect(f.worker.calls).toBe(0); clean(f);
    });
    it('reacquires a still-current source after the original lease expires', async () => {
        let now = 0; const f = await fixture({ now: () => now, leaseTtlMs: 10, historyTtlMs: 20 }); const gate = barrier();
        const result = f.host.executeSnapshotValueRefTool(f.request, () => gate.promise);
        now = 10; expect(f.core.store.inspect().activeLeases).toBe(0); gate.release(true);
        expect((await result).success).toBe(true); expect(f.worker.calls).toBe(1); clean(f);
    });
    it('rejects retired S1 after history TTL even if a separate lease still pins it/getById can read it', async () => {
        let now = 0; const f = await fixture({ now: () => now, leaseTtlMs: 100, historyTtlMs: 20 }); const gate = barrier();
        const pin: any = f.core.store.acquire(f.request.snapshotId); expect(pin.status).toBe('acquired');
        const result = f.host.executeSnapshotValueRefTool(f.request, () => gate.promise);
        now = 1; f.publish({ refs: {} }); now = 21;
        expect(f.core.store.getById(f.request.snapshotId).status).toBe('found'); gate.release(true);
        expect(await result).toMatchObject({ error: { code: 'SNAPSHOT_EXPIRED' } }); expect(f.worker.calls).toBe(0);
        pin.lease.release(); clean(f);
    });
    it.each(['empty', 'array', 'object', 'missing', 'foreign-owner', 'optional', 'multi', 'entity', 'typed', 'scalar'])('rejects unsupported input before policy: %s', async kind => {
        const f = await fixture(); const policy = vi.fn(() => true); const ref = f.base.refs[refKey('view', 'vi', 'ref')];
        if (kind === 'empty') f.request.args.file = '';
        if (kind === 'array') f.request.args.file = ['ref'];
        if (kind === 'object') f.request.args.file = { id: 'ref' };
        if (kind === 'missing') delete f.request.args.file;
        if (kind === 'foreign-owner') f.publish({ refs: {} });
        if (kind === 'optional') f.publish({ tools: { [f.id]: { ...f.tool, inputSchema: { ...f.tool.inputSchema, required: [] } } } });
        if (kind === 'multi') f.publish({ tools: { [f.id]: { ...f.tool, inputSchema: { ...f.tool.inputSchema,
            properties: { ...f.tool.inputSchema.properties, another: f.tool.inputSchema.properties.file }, required: ['file', 'another'] } } } });
        if (kind === 'entity') f.publish({ refs: { [refKey('view', 'vi', 'ref')]: { ...ref,
            target: { kind: 'entity', entityType: 'File', entityId: 'a', entityVersion: '1' } } } });
        if (kind === 'typed') f.publish({ tools: { [f.id]: { ...f.tool, inputSchema: { ...f.tool.inputSchema,
            properties: { file: { ...f.tool.inputSchema.properties.file, 'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target', refType: 'File' } } } } } } });
        if (kind === 'scalar') f.publish({ refs: { [refKey('view', 'vi', 'ref')]: { ...ref, target: { kind: 'snapshot-value', payload: [] } } } });
        if (['foreign-owner', 'optional', 'multi', 'entity', 'typed', 'scalar'].includes(kind)) f.request.snapshotId = (f.core.store.readLatest('app') as any).snapshot.id;
        expect((await f.host.executeSnapshotValueRefTool(f.request, policy)).success).toBe(false);
        expect(policy).not.toHaveBeenCalled(); expect(f.worker.calls).toBe(0); clean(f);
    });
});
