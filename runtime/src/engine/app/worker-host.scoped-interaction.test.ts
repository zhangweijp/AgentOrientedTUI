import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { SnapshotShadowReceiver } from '../../adapters/snapshot/shadow-receiver.js';
import { refKey } from '../../core/snapshot/index.js';
import { REF_V1_CAPABILITY } from '../../adapters/ref-invocation-v1.js';
import type { ScopePolicy } from '../../core/invocation/scoped-interaction.js';

const hosts: AppWorkerHost[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.terminate(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('C01: trusted Scope entry', () => {
    it('refuses before qualification without inspecting the policy', () => {
        const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: 'unused' }); hosts.push(host);
        let reads = 0;
        const policy = { get project() { reads++; throw Error('private'); } } as any;
        expect((host as any).createInteractionScope(policy)).toEqual({ status: 'rejected', issue: {
            code: 'REF_EXECUTION_UNAVAILABLE', message: 'Scoped Ref interaction is unavailable' } });
        expect(reads).toBe(0); expect((host as any).getInteractionReport()).toBeNull();
    });
});

function deferred<T = any>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Transport extends EventEmitter {
    messages: any[] = [];
    caps = [REF_V1_CAPABILITY];
    hold = new Set<string>();
    ref: (m: any) => void = m => this.answer(m, { phase: 'entered-returned', result: { success: true, data: { args: m.effectiveArgs } } });
    postMessage = vi.fn((m: any) => { this.messages.push(m); if (this.hold.has(m.type)) return;
        if (m.type === 'VIEW_TOOL_INVOKE_REF_V1') this.ref(m); else this.answer(m); });
    answer(m: any, terminal?: any) {
        this.emit('message', terminal ? { type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE', requestId: m.requestId, appId: m.appId,
            instanceId: m.instanceId, argumentMode: m.argumentMode, success: true, terminal }
            : { type: m.type === 'INIT' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE', requestId: m.requestId, success: true,
                ...(m.type === 'INIT' ? { appInstanceId: m.appInstanceId, acceptedCapabilities: this.caps } : {}) });
    }
    terminate = vi.fn(async () => 0);
}
async function fixture(config: any = {}, caps = [REF_V1_CAPABILITY]) {
    const worker = new Transport(); worker.caps = caps;
    const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: 'unused', existingWorker: worker as any,
        timeout: 30, snapshotShadow: true, experimentalReadOnlyViewTools: true, experimentalSnapshotValueRefExecution: true, ...config });
    hosts.push(host); await host.start(); await host.open();
    const receiver = (host as any).shadowReceiver;
    const toolId = JSON.stringify(['app', 'File', 'read']); let sequence = 0;
    const views = ['aa', 'bb'].map(id => ({ id, viewInstanceId: 'vi-' + id, type: 'File', name: id, kind: 'state', content: { format: 'markdown-v1', value: id } }));
    const tool = { id: toolId, name: 'read', description: 'Read', viewType: 'File', isMutating: false,
        inputSchema: { type: 'object', properties: { file: { type: 'string', 'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target' } } }, required: ['file'] },
        targets: views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId, bindingVersion: 1 })) };
    const refs = (payload: any = { text: 'A' }) => Object.fromEntries(views.map(v => [refKey(v.id, v.viewInstanceId, 'file'),
        { id: 'file', ownerViewId: v.id, ownerViewInstanceId: v.viewInstanceId, refType: 'unknown', target: { kind: 'snapshot-value', payload } }]));
    function publish(patch: any = {}) {
        sequence++; worker.emit('message', { type: 'SNAPSHOT_PREPARED', draft: { schemaVersion: 2, appId: 'app', instanceId: host.appInstanceId,
            producerSeq: sequence, sourceEpoch: sequence, capturedAt: sequence, views, refs: refs(), tools: { [toolId]: tool }, ...patch } });
        return receiver?.core.store.readLatest('app');
    }
    publish();
    const controls = { project: (ctx: any): any => ({ views: ctx.source.views.filter((v: any) => ctx.selection.viewIds.includes(v.id))
        .map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
        refs: Object.values(ctx.source.refs).filter((r: any) => ctx.selection.viewIds.includes(r.ownerViewId))
            .map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        targets: Object.values(ctx.source.tools).flatMap((t: any) => t.targets.filter((v: any) => ctx.selection.viewIds.includes(v.viewId)).map((target: any) => ({ toolId: t.id, target }))), content: [] }),
        authorize: (_ctx: any): any => true, read: (_metadata: any, _signal: any): any => true };
    const policy: ScopePolicy = { project: ctx => controls.project(ctx), authorize: ctx => controls.authorize(ctx), canReadReceipt: (m, s) => controls.read(m, s) };
    function open() { const result = host.createInteractionScope(policy); expect(result.status).toBe('opened'); if (result.status !== 'opened') throw Error(result.issue.code); return result.client; }
    async function observe(client: any, viewId = 'aa') { const r = await client.observe({ viewIds: [viewId] }); expect(r.status).toBe('observed'); return r.observation; }
    const request = (o: any, id = 'call', input: any = { file: 'file' }) => ({ invocationId: id, observationId: o.observationId, bindingId: o.bindings[0].bindingId, input });
    const sent = () => worker.messages.filter(m => m.type === 'VIEW_TOOL_INVOKE_REF_V1');
    return { host, worker, receiver, views, tool, toolId, refs, publish, controls, policy, open, observe, request, sent };
}
function receipt(r: any) { expect(r.kind).toBe('receipt'); if (r.kind !== 'receipt') throw Error(r.code); return r.receipt; }

describe('C01/C02/C05/C08: one real Core authority on a controlled channel', () => {
    it.each(['snapshotShadow', 'experimentalReadOnlyViewTools', 'experimentalSnapshotValueRefExecution'])('requires %s and exact ACK', async flag => {
        const f = await fixture({ [flag]: false }); let reads = 0;
        expect(f.host.createInteractionScope({ get project() { reads++; throw Error('secret'); } } as any).status).toBe('rejected');
        expect(reads).toBe(0); expect(f.host.getInteractionReport()).toBeNull();
        const noAck = await fixture({}, []); expect(noAck.host.createInteractionScope(noAck.policy).status).toBe('rejected');
    });
    it('captures policy without getters or implicit authority and keeps bindings stable across rechecks', async () => {
        const f = await fixture(); expect(f.host.getInteractionReport()).toBeNull(); let reads = 0;
        expect(f.host.createInteractionScope({ ...f.policy, get authorize() { reads++; throw Error('secret'); } } as any).status).toBe('rejected');
        expect(reads).toBe(0); const client = f.open(); expect(Object.isFrozen(client)).toBe(true);
        expect(Object.keys(client).sort()).toEqual(['close', 'invoke', 'observe', 'readReceipt', 'releaseObservation']);
        const o = await f.observe(client); let called = 0; f.controls.authorize = ctx => { called++; expect(Object.isFrozen(ctx.effectiveInput)).toBe(true); return true; };
        const legacy = vi.spyOn(f.host, 'executeSnapshotValueRefTool').mockRejectedValue(Error('No second orchestration'));
        expect(receipt(await client.invoke(f.request(o))).outcome.status).toBe('succeeded');
        expect(called).toBe(1); expect(legacy).not.toHaveBeenCalled(); expect(f.sent()).toHaveLength(1);
        expect(f.host.getInteractionReport()).toMatchObject({ transportUncertain: false, core: { scopes: 1 } }); client.close();
    });
    it('shares sixteen slots and retains the closing slot until an ignored policy settles', async () => {
        const f = await fixture(), gate = deferred(), entered = deferred(); let signal: any;
        const clients = Array.from({ length: 16 }, () => f.open());
        f.controls.project = ctx => { signal = ctx.signal; entered.resolve(undefined); return gate.promise; };
        const projecting = clients[0]!.observe({ viewIds: ['aa'] }); await entered.promise; clients[0]!.close();
        expect(signal.aborted).toBe(true); expect(f.host.createInteractionScope(f.policy).status).toBe('rejected');
        expect(f.host.getInteractionReport()?.core).toMatchObject({ scopes: 16, closingScopes: 1 });
        gate.resolve({}); expect((await projecting).status).toBe('rejected'); const replacement = f.open(); replacement.close();
        for (const c of clients) c.close(); expect(f.host.getInteractionReport()?.core.combinedBytes).toBe(0);
    });
    it('checks read permission on first, duplicate and explicit reads without replaying', async () => {
        const f = await fixture(), client = f.open(), o = await f.observe(client); let reads = 0;
        f.controls.read = () => ++reads === 1;
        const first = receipt(await client.invoke(f.request(o))); expect(first.outcome.status).toBe('succeeded');
        expect(await client.invoke(f.request(o))).toMatchObject({ code: 'RECEIPT_PERMISSION_DENIED' });
        expect(await client.readReceipt('call')).toMatchObject({ code: 'RECEIPT_PERMISSION_DENIED' });
        f.controls.read = () => true; expect(receipt(await client.readReceipt('call'))).toEqual(first);
        expect(f.sent()).toHaveLength(1); client.close();
    });
    it('refuses moved bindings and hidden Refs before the transport', async () => {
        const f = await fixture(), a = f.open(), b = f.open(), o = await f.observe(a);
        expect(receipt(await b.invoke(f.request(o))).outcome.status).toBe('rejected');
        f.controls.project = ctx => ({ ...({ views: ctx.source.views.slice(0, 1).map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })), refs: [], targets: [{ toolId: f.toolId, target: f.tool.targets[0] }], content: [] }) });
        const hidden = await f.observe(a); expect(receipt(await a.invoke(f.request(hidden, 'hidden'))).outcome.code).toBe('REF_NOT_VISIBLE');
        expect(f.sent()).toHaveLength(0); a.close(); b.close();
    });
    it.each(['', ' ', 'ordinary'])('preserves compatible errors (%j) without marking completed business false as transport loss', async message => {
        const f = await fixture(), client = f.open(), o = await f.observe(client);
        f.worker.ref = m => f.worker.answer(m, { phase: 'not-entered', result: { success: false, error: { code: ' ', message } } });
        const rejected = receipt(await client.invoke(f.request(o, 'before'))); expect(rejected).toMatchObject({ executionPhase: 'not-entered', outcome: { status: 'rejected', details: { result: { error: { code: ' ', message } } } } });
        f.worker.ref = m => f.worker.answer(m, { phase: 'entered-returned', result: { success: false, error: { code: 'E_INVALID_ARGS', message }, data: { retained: true } } });
        expect(receipt(await client.invoke(f.request(o, 'entered')))).toMatchObject({ executionPhase: 'entered-returned', outcome: { status: 'unknown', details: { result: { data: { retained: true } } } } });
        expect(f.host.getInteractionReport()?.transportUncertain).toBe(false); expect(f.sent()).toHaveLength(2); client.close();
    });
});

describe('C10/C11/C12/C14: pending facts, lifecycle and one-way uncertainty', () => {
    it('closes the never-created authority after INIT fails and cannot accept a later capability', async () => {
        const worker = new Transport(); worker.postMessage.mockImplementation(() => { throw Error('private init failure'); });
        const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: 'unused', existingWorker: worker as any,
            snapshotShadow: true, experimentalReadOnlyViewTools: true, experimentalSnapshotValueRefExecution: true }); hosts.push(host);
        await expect(host.start()).rejects.toThrow('Worker request could not be sent');
        const receiver = (host as any).shadowReceiver;
        expect(receiver.createInteractionScope({}, {}).status).toBe('rejected'); expect(host.getInteractionReport()).toBeNull();
        expect(host.hasSnapshotValueRefCapability()).toBe(false); expect((host as any).pendingRequests.size).toBe(0);
    });
    it('keeps uncertainty and dedup after receipt TTL, Scope close and pause/resume', async () => {
        vi.useFakeTimers(); vi.setSystemTime(1000);
        const f = await fixture(), client = f.open(), o = await f.observe(client), entered = deferred();
        f.worker.ref = () => entered.resolve(undefined); const pending = client.invoke(f.request(o)); await entered.promise;
        await vi.advanceTimersByTimeAsync(31); expect(receipt(await pending).outcome.status).toBe('unknown');
        await vi.advanceTimersByTimeAsync(60001); expect(await client.invoke(f.request(o))).toMatchObject({ code: 'RESULT_EXPIRED' });
        expect(f.host.getInteractionReport()).toMatchObject({ transportUncertain: true, core: { receiptContents: 0, receiptEntries: 1 } });
        await f.host.pause(); await f.host.resume(); client.close();
        expect(f.host.createInteractionScope(f.policy).status).toBe('rejected'); expect(f.sent()).toHaveLength(1);
        expect(await f.host.releaseWorker()).toBeNull();
    });
    it('ignores wrong IDs and late duplicates while another already-dispatched request can still settle', async () => {
        const f = await fixture(), client = f.open(), o = await f.observe(client); vi.useFakeTimers();
        const firstPosted = deferred(), secondPosted = deferred();
        f.worker.ref = () => { (f.sent().length === 1 ? firstPosted : secondPosted).resolve(undefined); };
        (f.host as any).timeout = 20; const a = client.invoke(f.request(o, 'a')); await firstPosted.promise;
        (f.host as any).timeout = 100; const b = client.invoke(f.request(o, 'b')); await secondPosted.promise;
        const [ma, mb] = f.sent(); f.worker.answer({ ...ma, requestId: 'absent' }, { phase: 'entered-returned', result: { success: true } });
        expect((f.host as any).pendingRequests.size).toBe(2);
        await vi.advanceTimersByTimeAsync(21); const unknown = receipt(await a); expect(unknown.outcome.status).toBe('unknown');
        expect((f.host as any).pendingRequests.size).toBe(1);
        f.worker.answer(ma, { phase: 'entered-returned', result: { success: true } }); f.worker.answer(ma, { phase: 'entered-returned', result: { success: true } });
        expect((f.host as any).pendingRequests.size).toBe(1);
        f.worker.answer(mb, { phase: 'entered-returned', result: { success: true, data: { retained: 'b' } } });
        expect(receipt(await b).outcome).toMatchObject({ status: 'succeeded', value: { data: { retained: 'b' } } });
        expect(receipt(await client.readReceipt('a'))).toEqual(unknown); expect(f.host.getInteractionReport()?.transportUncertain).toBe(true); client.close();
    });
    it.each(['rebind', 'remount'])('rechecks a published %s after authorization before transport', async change => {
        const f = await fixture(), client = f.open(), o = await f.observe(client), gate = deferred(), entered = deferred();
        f.controls.authorize = () => { entered.resolve(undefined); return gate.promise; };
        const running = client.invoke(f.request(o)); await entered.promise;
        if (change === 'rebind') f.publish({ tools: { [f.toolId]: { ...f.tool, targets: f.tool.targets.map(t => ({ ...t, bindingVersion: 2 })) } } });
        else {
            const views = f.views.map(v => ({ ...v, viewInstanceId: v.viewInstanceId + '-new' }));
            f.publish({ views, refs: Object.fromEntries(views.map(v => [refKey(v.id, v.viewInstanceId, 'file'), { id: 'file', ownerViewId: v.id,
                ownerViewInstanceId: v.viewInstanceId, refType: 'unknown', target: { kind: 'snapshot-value', payload: {} } }])),
                tools: { [f.toolId]: { ...f.tool, targets: views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId, bindingVersion: 1 })) } } });
        }
        gate.resolve(true); expect(receipt(await running).outcome.status).toBe('rejected'); expect(f.sent()).toHaveLength(0); client.close();
    });
    it.each(['throw', 'timeout', 'wrong-instance', 'bad-phase', 'wrong-mode', 'wrong-type', 'wrong-version', 'error', 'exit'])('fails closed after dispatched %s', async kind => {
        const f = await fixture(), client = f.open(), o = await f.observe(client), entered = deferred(); vi.useFakeTimers();
        f.worker.ref = () => { entered.resolve(undefined); if (kind === 'throw') throw Error('private'); };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const pending = client.invoke(f.request(o)); await entered.promise; const m = f.sent()[0];
        if (kind === 'timeout') await vi.advanceTimersByTimeAsync(31);
        else if (kind === 'error') f.worker.emit('error', Error('private'));
        else if (kind === 'exit') f.worker.emit('exit', 0);
        else if (kind !== 'throw') {
            const response: any = { type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE', requestId: m.requestId, appId: m.appId, instanceId: m.instanceId,
                argumentMode: m.argumentMode, success: true, terminal: { phase: 'entered-returned', result: { success: true } } };
            if (kind === 'wrong-instance') response.instanceId = 'other';
            if (kind === 'bad-phase') response.terminal.phase = 'maybe';
            if (kind === 'wrong-mode') response.argumentMode = 'other';
            if (kind === 'wrong-type') response.type = 'OPERATION_RESPONSE';
            if (kind === 'wrong-version') (f.host as any).lifecycleContextVersion++;
            f.worker.emit('message', response);
        }
        const result = await pending;
        if (kind === 'error' || kind === 'exit') expect(result).toMatchObject({ code: 'SCOPE_UNAVAILABLE' });
        else {
            const unknown = receipt(result); expect(unknown).toMatchObject({ executionPhase: 'unknown', outcome: { status: 'unknown' } });
            expect(receipt(await client.invoke(f.request(o)))).toEqual(unknown);
            expect(receipt(await client.invoke(f.request(o, 'new'))).outcome.status).toBe('rejected');
            f.worker.answer(m, { phase: 'entered-returned', result: { success: true } });
            expect(receipt(await client.readReceipt('call'))).toEqual(unknown);
        }
        expect(f.host.getInteractionReport()?.transportUncertain).toBe(true); expect(f.host.createInteractionScope(f.policy).status).toBe('rejected');
        expect(f.sent()).toHaveLength(1); expect((f.host as any).pendingRequests.size).toBe(0); client.close();
    });
    it('does not treat Scope abort as a remote cancel, and another Scope continues to run', async () => {
        const f = await fixture(), a = f.open(), b = f.open(), oa = await f.observe(a), ob = await f.observe(b), entered = deferred();
        f.worker.ref = () => entered.resolve(undefined); const first = a.invoke(f.request(oa)); await entered.promise; const m = f.sent()[0]; a.close();
        expect((f.host as any).pendingRequests.size).toBe(1); expect(f.host.getInteractionReport()?.core).toMatchObject({ activeInvocations: 1, closingScopes: 1 });
        expect(f.host.getInteractionReport()?.transportUncertain).toBe(false);
        f.worker.ref = x => f.worker.answer(x, { phase: 'entered-returned', result: { success: true } });
        expect(receipt(await b.invoke(f.request(ob))).outcome.status).toBe('succeeded');
        f.worker.answer(m, { phase: 'entered-returned', result: { success: true } }); expect(await first).toMatchObject({ code: 'SCOPE_UNAVAILABLE' });
        expect(f.host.getInteractionReport()?.core.activeInvocations).toBe(0); b.close();
    });
    it('keeps read-policy responsibility and immediate abort while a peer policy ignores cancellation', async () => {
        const f = await fixture(), client = f.open(), o = await f.observe(client), gate = deferred(), entered = deferred(); let signal: any;
        f.controls.authorize = ctx => { signal = ctx.signal; entered.resolve(undefined); return gate.promise; };
        const pending = client.invoke(f.request(o)); await entered.promise; client.close(); expect(signal.aborted).toBe(true);
        expect(f.sent()).toHaveLength(0); expect(f.host.getInteractionReport()?.core.activeInvocations).toBe(1);
        gate.resolve(true); expect(await pending).toMatchObject({ code: 'SCOPE_UNAVAILABLE' }); expect(f.host.getInteractionReport()?.core.combinedBytes).toBe(0);
    });
    it.each(['close', 'delete', 'reinitialize', 'release', 'terminate', 'reset'])('permanently revokes on %s and keeps unknown work out of the pool', async mode => {
        const f = await fixture(), client = f.open(), o = await f.observe(client), entered = deferred(); f.worker.ref = () => entered.resolve(undefined);
        const pending = client.invoke(f.request(o)); await entered.promise;
        if (mode === 'close') await f.host.close();
        if (mode === 'delete') await f.host.delete();
        if (mode === 'reinitialize') await f.host.reinitialize();
        if (mode === 'release') { expect(await f.host.releaseWorker()).toBeNull(); expect(f.worker.terminate).toHaveBeenCalledTimes(1); }
        if (mode === 'terminate') f.host.terminate();
        if (mode === 'reset') await (f.host as any).sendRequest({ type: 'RESET', requestId: 'reset' });
        expect(await pending).toMatchObject({ code: 'SCOPE_UNAVAILABLE' }); expect(f.host.createInteractionScope(f.policy).status).toBe('rejected');
        expect(f.host.getInteractionReport()).toMatchObject({ transportUncertain: true, core: { closed: true, combinedBytes: 0 } });
        if (mode !== 'release' && mode !== 'terminate') expect(await f.host.releaseWorker()).toBeNull();
        expect(f.worker.messages.filter(m => m.type === 'RESET')).toHaveLength(mode === 'reset' ? 1 : 0);
    });
    it('pause preserves settled reads, prevents new dispatch, and resume shares the same authority', async () => {
        const f = await fixture(), client = f.open(), o = await f.observe(client), result = receipt(await client.invoke(f.request(o)));
        await f.host.pause(); expect(receipt(await client.readReceipt('call'))).toEqual(result);
        expect(f.host.createInteractionScope(f.policy).status).toBe('rejected');
        expect(receipt(await client.invoke(f.request(o, 'paused'))).outcome.status).toBe('rejected'); expect(f.sent()).toHaveLength(1);
        await f.host.resume(); expect(receipt(await client.invoke(f.request(o, 'resumed'))).outcome.status).toBe('succeeded');
        expect(f.host.getInteractionReport()?.core.scopes).toBe(1); client.close();
    });
    it('release waits for lifecycle and FileReplacement responsibility before terminating an uncertain Worker', async () => {
        const f = await fixture(), client = f.open(), o = await f.observe(client), entered = deferred();
        f.worker.ref = () => entered.resolve(undefined); const pending = client.invoke(f.request(o)); await entered.promise;
        const lifecycle = deferred<void>(); (f.host as any).lifecycleRequests.add(lifecycle.promise); (f.host as any).activeFileReplacements = 1;
        const a = f.host.releaseWorker(), b = f.host.releaseWorker();
        expect(f.worker.terminate).not.toHaveBeenCalled(); lifecycle.resolve(); await Promise.resolve(); expect(f.worker.terminate).not.toHaveBeenCalled();
        (f.host as any).activeFileReplacements = 0; for (const release of (f.host as any).fileReplacementWaiters.splice(0)) release();
        expect(await a).toBeNull(); expect(await b).toBeNull(); expect(f.worker.terminate).toHaveBeenCalledTimes(1);
        expect(await pending).toMatchObject({ code: 'SCOPE_UNAVAILABLE' });
    });
    it('enforces pre-post signal, address and full wire budgets without setting uncertainty', async () => {
        const f = await fixture(), client = f.open(), o = await f.observe(client), latest = f.receiver.core.store.readLatest('app').snapshot;
        const source = { appId: 'app', instanceId: f.host.appInstanceId, snapshotId: latest.id, tool: latest.tools[f.toolId], target: latest.tools[f.toolId].targets[0] };
        const binding = (f.host as any).resolveInteractionSource(source); expect((f.host as any).resolveInteractionSource(source)).toBe(binding);
        const base = { scopeId: 'internal-boundary', invocationId: 'internal', source, rawInput: {}, effectiveInput: {}, refSources: [] };
        const aborted = new AbortController(); aborted.abort();
        expect(await binding.execute({ ...base, signal: aborted.signal })).toMatchObject({ phase: 'not-entered', result: { error: { code: 'REF_EXECUTION_UNAVAILABLE' } } });
        expect(await binding.execute({ ...base, signal: new AbortController().signal, rawInput: { text: 'x'.repeat(525000) } }))
            .toMatchObject({ phase: 'not-entered', result: { error: { code: 'REF_ARGUMENT_BUDGET_EXCEEDED' } } });
        expect((f.host as any).resolveInteractionSource({ ...source, instanceId: 'wrong' })).toBeNull();
        expect((f.host as any).resolveInteractionSource({ ...source, resource: {} })).toBeNull();
        expect((f.host as any).resolveInteractionSource({ ...source, tool: { ...source.tool, isMutating: true } })).toBeNull();
        (f.host as any).lifecycleContextVersion++;
        expect(await binding.execute({ ...base, signal: new AbortController().signal })).toMatchObject({ phase: 'not-entered', result: { error: { code: 'REF_EXECUTION_UNAVAILABLE' } } });
        expect(f.sent()).toHaveLength(0); expect(f.host.getInteractionReport()?.transportUncertain).toBe(false); client.close();
    });
});
