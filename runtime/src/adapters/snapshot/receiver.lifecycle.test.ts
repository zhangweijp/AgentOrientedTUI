import { expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { SemanticSnapshotReceiver } from './receiver.js';
import { createViewOwnedTools } from '../../core/tool/view-owned-tools.js';
import { compileOrdinaryParams } from '../../core/tool/ordinary-parameter-contract.js';
import type { SnapshotCore } from '../../core/snapshot/types.js';
import type { ExecutionBinding, AppInteractionPolicy } from '../../core/invocation/app-interaction-types.js';

function defer<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(instance = 'i', stage?: 'authorize' | 'execute', now?: () => number) {
    const r = now ? new SemanticSnapshotReceiver('a', instance, now) : new SemanticSnapshotReceiver('a', instance), core: SnapshotCore = (r as any).core;
    const registry = createViewOwnedTools('a', instance), view = registry.mount('v', 'T');
    const contract = compileOrdinaryParams({}, { additionalProperties: false });
    if (!contract.ok) throw Error('Fixture ordinary-v2 contract');
    const handler = async () => ({ success: true });
    registry.registerTypeTool({ viewType: 'T', name: 'read', description: 'Read', inputSchema: contract.contract.schema }, {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2',
        createSafeOrdinaryParametersInvoker: () => async () => ({ phase: 'entered-returned', result: await handler() }),
    });
    const tool = registry.listTools()[0]!;
    r.acceptPrepared({ schemaVersion: 3, appId: 'a', instanceId: instance, producerSeq: 1, sourceEpoch: 1, capturedAt: 0,
        views: [{ id: view.viewId, viewInstanceId: view.viewInstanceId, type: view.viewType, name: 'View', kind: 'state', content: { format: 'markdown-v1', value: 'value' } }],
        refs: {}, tools: { [tool.id]: tool } });
    expect(r.report().health).toBe('ready');
    const entered = defer<void>(), gate = defer<void>(); let handlers = 0, completed = 0;
    const binding: ExecutionBinding = { identity: {}, mode: 'ordinary-v2', validateInput: (_source, input) => ({ ok: true, value: input }),
        isLive: source => ({ ok: registry.validateTypeToolBinding(tool, source.execution).success }),
        execute: async () => { handlers++; if (stage === 'execute') { entered.resolve(); await gate.promise; } completed++;
            return { kind: 'tool-result', phase: 'entered-returned', result: { success: true, data: { value: 19 } } }; } };
    const policy: AppInteractionPolicy = { project: () => ({ views: [{ viewId: 'v', viewInstanceId: view.viewInstanceId }], refs: [], toolBindings: [{ toolId: tool.id, execution: tool.execution }], content: [] }),
        authorize: async () => { if (stage === 'authorize') { entered.resolve(); await gate.promise; } return true; }, canReadReceipt: () => true };
    const client = r.interaction(policy, { resolve: () => binding });
    async function observe() { const o = await client.observe({ viewIds: ['v'] }); if (o.status !== 'observed') throw Error(JSON.stringify(o));
        expect(client.adoptObservation(o.observation.observationId)).toEqual({ status: 'adopted' });
        return { invocationId: 'call', observationId: o.observation.observationId, bindingId: o.observation.bindings[0].bindingId, input: {} }; }
    return { r, core, client, observe, entered, gate, counts: () => ({ handlers, completed }) };
}

it('uses one integer monotonic default clock for snapshots and interactions when wall time moves backward', async () => {
    let elapsed = 10.25, wallTime = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Date, 'now').mockImplementation(() => wallTime);
    const f = fixture('monotonic-default');
    let releaseShortLease: (() => void) | undefined;
    try {
        const first = await f.observe();
        const activeLeases = f.core.store.inspect().activeLeases;
        const snapshotId = f.r.report().snapshotId!;
        const shortLease = f.core.store.acquire(snapshotId, 5);
        expect(shortLease.status).toBe('acquired');
        if (shortLease.status !== 'acquired') throw new Error('Snapshot lease unavailable');
        releaseShortLease = shortLease.lease.release;
        expect(Number.isSafeInteger(shortLease.lease.expiresAt)).toBe(true);
        elapsed = 20.75;
        wallTime = 1;
        const second = await f.observe();
        expect(f.core.store.inspect().activeLeases).toBe(activeLeases); // The new adoption replaced the old owner; the short timed lease expired.
        elapsed = 30.5;
        const result = await f.client.invoke({ ...second, invocationId: 'monotonic-call' });
        expect(result.kind).toBe('receipt');
        if (result.kind !== 'receipt') return;
        expect(Number.isSafeInteger(result.receipt.completedAt)).toBe(true);
        expect(Number.isSafeInteger(result.receipt.expiresAt)).toBe(true);
        expect(result.receipt.expiresAt - result.receipt.completedAt).toBe(60_000);
        expect(second.observationId).not.toBe(first.observationId);
    } finally {
        releaseShortLease?.();
        await f.r.close();
        vi.restoreAllMocks();
    }
    expect(f.r.getInteractionStats()).toMatchObject({ closed: true, combinedBytes: 0 });
    expect(f.core.store.inspect()).toMatchObject({ state: 'disposed', appRecords: 0, activeLeases: 0, currentBytes: 0 });
});

it('recovers observation and invocation after a rejected injected clock rollback without replacing the App', async () => {
    let time = 10;
    const f = fixture('clock-recovery', undefined, () => time);
    try {
        const first = await f.observe();
        time = 9;
        expect(await f.client.observe({ viewIds: ['v'] })).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_INTERNAL_ERROR' } });
        expect(f.counts().handlers).toBe(0);
        time = 10;
        const recovered = await f.observe();
        expect(recovered.observationId).not.toBe(first.observationId);
        expect(await f.client.invoke({ ...recovered, invocationId: 'after-clock-recovery' })).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.counts()).toEqual({ handlers: 1, completed: 1 });
    } finally { await f.r.close(); }
    expect(f.r.getInteractionStats()).toMatchObject({ closed: true, combinedBytes: 0 });
    expect(f.core.store.inspect()).toMatchObject({ state: 'disposed', appRecords: 0, activeLeases: 0, currentBytes: 0 });
});

it('A16 closes authority before disposing Core and retains stopped state and resource facts', async () => {
    const f = fixture(); await f.observe();
    const original = f.r.closeInteractions.bind(f.r); let checked = 0;
    vi.spyOn(f.r, 'closeInteractions').mockImplementation(async () => { expect(f.core.store.inspect().state).toBe(checked++ ? 'disposed' : 'active'); await original(); expect(f.r.getInteractionStats()?.closed).toBe(true); });
    await f.r.close(); await f.r.close();
    expect(f.core.store.inspect()).toMatchObject({ state: 'disposed', appRecords: 0, activeLeases: 0, currentBytes: 0 });
    expect(f.r.report()).toMatchObject({ health: 'stopped', published: 1 });
    const poison: any = new Proxy({}, { get() { throw Error('read'); } }); f.r.acceptPrepared(poison); f.r.acceptPrepareFailure(poison);
    expect(f.r.report()).toMatchObject({ health: 'stopped', published: 1 });
    expect(() => f.r.interaction(poison, poison)).toThrow('unavailable');
});
it.each(['authorize', 'execute'] as const)('A16 keeps actual %s work tracked after close and never admits a late handler', async stage => {
    const f = fixture('i', stage), request = await f.observe(), pending = f.client.invoke(request); await f.entered.promise;
    expect(f.r.getInteractionStats()?.activeInvocations).toBe(1);
    const closing = f.r.close();
    expect(f.core.store.inspect().state).toBe('active');
    expect(f.r.getInteractionStats()).toMatchObject({ closed: true, activeInvocations: 1 });
    expect(f.counts()).toEqual({ handlers: stage === 'execute' ? 1 : 0, completed: 0 });
    await f.client.invoke({ ...request, invocationId: 'late' }); expect(f.counts().handlers).toBe(stage === 'execute' ? 1 : 0);
    f.gate.resolve(); await pending; await closing;
    expect(f.core.store.inspect().state).toBe('disposed');
    expect(f.counts()).toEqual({ handlers: stage === 'execute' ? 1 : 0, completed: stage === 'execute' ? 1 : 0 });
    expect(f.r.getInteractionStats()).toMatchObject({ closed: true, activeInvocations: 0, combinedBytes: 0 });
});
it('A16 real invalid Draft diagnostics forwarded to Receiver have bounded paths', () => {
    const r = new SemanticSnapshotReceiver('a', 'i');
    r.acceptPrepared({ schemaVersion: 2, appId: 'a', instanceId: 'i', producerSeq: 1, sourceEpoch: 1, capturedAt: 0, views: [], refs: { ['x'.repeat(200000)]: null }, tools: {} });
    expect(r.report().health).toBe('degraded'); expect(new TextEncoder().encode(r.report().lastIssuePath).byteLength).toBeLessThanOrEqual(512); r.close();
});
it('A18 fresh AppInstance and namespace isolate old Client and serialized requests', async () => {
    const old = fixture('old'), request = await old.observe(); await old.client.invoke(request); old.r.close();
    const fresh = fixture('fresh'), current = await fresh.observe();
    expect(current.observationId).not.toBe(request.observationId);
    await old.client.invoke({ ...current, invocationId: 'old-client' }); expect(fresh.counts().handlers).toBe(0);
    const rejected = await fresh.client.invoke(request); expect(rejected).not.toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
    expect(fresh.counts().handlers).toBe(0); await fresh.client.invoke({ ...current, invocationId: 'current' }); expect(fresh.counts().handlers).toBe(1); fresh.r.close();
});
it('A18 negative control: deliberately reusing AppInstance AND namespace violates trusted assembly and collides', async () => {
    const first = fixture('colliding'), request = await first.observe(); first.r.close();
    const second = fixture('colliding'), current = await second.observe(); expect(current.observationId).toBe(request.observationId); expect(current.bindingId).toBe(request.bindingId);
    expect(await second.client.invoke(request)).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
    expect(second.counts().handlers).toBe(1); second.r.close();
});
