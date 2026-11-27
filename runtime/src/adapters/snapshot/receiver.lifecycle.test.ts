import { expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { SemanticSnapshotReceiver } from './receiver.js';
import { createViewOwnedTools } from '@aotui/core/producer';
import type { SnapshotCore } from '@aotui/core';
import type { ExecutionBinding, AppInteractionPolicy } from '@aotui/core';

function defer<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(instance = 'i', stage?: 'authorize' | 'execute', now?: () => number) {
    const r = now ? new SemanticSnapshotReceiver('a', instance, now) : new SemanticSnapshotReceiver('a', instance), core: SnapshotCore = (r as any).core;
    const registry = createViewOwnedTools('a', instance);
    const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
    registry.defineViewTypes([{ name: "T", multiplicity: 'multiple', tools: [{ name: 'read', description: 'Read', inputSchema }] }]);
    const frame = registry.prepareFrame([{ idPrefix: 'v', type: 'T', owner: {},
        bindings: [{ name: 'read', enabled: true, execute: () => ({ success: true }) }] }]);
    frame.accept();
    const view = frame.instances[0]!, tool = frame.tools[0]!;
    r.acceptPrepared({ healthySince: 1,  schemaVersion: 9, appId: 'a', instanceId: instance, producerSeq: 1, sourceEpoch: 1, capturedAt: 0,
        views: [{ toolBindings: view.toolBindings, id: view.viewId, viewInstanceId: view.viewInstanceId, type: view.viewType, name: 'View',
            region: 'dynamic', content: { format: 'markdown-v1', value: 'value' } }],
        refs: {}, tools: { [tool.id]: tool } }, 'authoritative', registry.viewTypes());
    expect(core.store.readLatest('a').status).toBe('ready');
    const entered = defer<void>(), gate = defer<void>(); let handlers = 0, completed = 0;
    const binding: ExecutionBinding = { identity: {},
        isLive: source => registry.validateTypeToolBinding(tool, source.receiver).success,
        execute: async () => { handlers++; if (stage === 'execute') { entered.resolve(); await gate.promise; } completed++;
            return { kind: 'tool-result', phase: 'entered-returned', result: { success: true, data: { value: 19 } } }; } };
    const policy: AppInteractionPolicy = { project: () => ({ refs: [], toolIds: [tool.id] }),
        authorize: async () => { if (stage === 'authorize') { entered.resolve(); await gate.promise; } return true; }, canReadReceipt: () => true };
    const client = r.interaction(policy, { resolve: () => binding });
    async function observe() { const o = await client.observe(); if (o.status !== 'observed') throw Error(JSON.stringify(o));
        expect(client.adoptObservation(o.observation.observationId)).toEqual({ status: 'adopted' });
        return { invocationId: 'call', observationId: o.observation.observationId, toolId: o.observation.tools[0]!.id, viewId: 'v_1', input: {  } }; }
    return { r, core, client, observe, entered, gate, counts: () => ({ handlers, completed }) };
}

it('uses one integer monotonic default clock for snapshots and interactions when wall time moves backward', async () => {
    let elapsed = 10.25, wallTime = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Date, 'now').mockImplementation(() => wallTime);
    const f = fixture('monotonic-default');
    try {
        const first = await f.observe();
        const activeHolds = f.core.store.inspect().activeHolds;
        elapsed = 20.75;
        wallTime = 1;
        const second = await f.observe();
        expect(f.core.store.inspect().activeHolds).toBe(activeHolds);
        elapsed = 30.5;
        const result = await f.client.invoke({ ...second, invocationId: 'monotonic-call' });
        expect(result.kind).toBe('receipt');
        if (result.kind !== 'receipt') return;
        expect(Number.isSafeInteger(result.receipt.completedAt)).toBe(true);
        expect(Number.isSafeInteger(result.receipt.expiresAt)).toBe(true);
        expect(result.receipt.expiresAt - result.receipt.completedAt).toBe(60_000);
        expect(second.observationId).not.toBe(first.observationId);
    } finally {
        await f.r.close();
        vi.restoreAllMocks();
    }
    expect(f.r.getInteractionStats()).toMatchObject({ closed: true, });
    expect(f.core.store.inspect()).toMatchObject({ state: 'disposed', activeHolds: 0, currentBytes: 0 });
});

it('recovers observation and invocation after a rejected injected clock rollback without replacing the App', async () => {
    let time = 10;
    const f = fixture('clock-recovery', undefined, () => time);
    try {
        const first = await f.observe();
        time = 9;
        expect(await f.client.observe()).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_INTERNAL_ERROR' } });
        expect(f.counts().handlers).toBe(0);
        time = 10;
        const recovered = await f.observe();
        expect(recovered.observationId).not.toBe(first.observationId);
        expect(await f.client.invoke({ ...recovered, invocationId: 'after-clock-recovery' })).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.counts()).toEqual({ handlers: 1, completed: 1 });
    } finally { await f.r.close(); }
    expect(f.r.getInteractionStats()).toMatchObject({ closed: true, });
    expect(f.core.store.inspect()).toMatchObject({ state: 'disposed', activeHolds: 0, currentBytes: 0 });
});

it('A16 closes authority before disposing Core and retains stopped state and resource facts', async () => {
    const f = fixture(); await f.observe();
    const original = f.r.closeInteractions.bind(f.r); let checked = 0;
    vi.spyOn(f.r, 'closeInteractions').mockImplementation(async () => { expect(f.core.store.inspect().state).toBe(checked++ ? 'disposed' : 'active'); await original(); expect(f.r.getInteractionStats()?.closed).toBe(true); });
    await f.r.close(); await f.r.close();
    expect(f.core.store.inspect()).toMatchObject({ state: 'disposed', activeHolds: 0, currentBytes: 0 });
    expect(f.core.store.readLatest('a')).toEqual({ status: 'stopped' });
    const poison: any = new Proxy({}, { get() { throw Error('read'); } }); f.r.acceptPrepared(poison); f.r.acceptPrepareFailure(poison);
    expect(f.core.store.readLatest('a')).toEqual({ status: 'stopped' });
    expect(() => f.r.interaction(poison, poison)).toThrow('unavailable');
});
it.each(['authorize', 'execute'] as const)('A16 keeps actual %s work tracked after close and never admits a late handler', async stage => {
    const f = fixture('i', stage), request = await f.observe(), pending = f.client.invoke(request); await f.entered.promise;
    const latest = f.core.store.readLatest('a');
    if (latest.status !== 'ready') throw Error('Expected a committed snapshot');
    const snapshotId = latest.snapshot.id;
    expect(f.r.getInteractionStats()?.activeInvocations).toBe(1);
    const closing = f.r.close();
    expect(f.core.store.inspect()).toMatchObject({ state: 'active', currentSnapshots: 0, heldSnapshots: 1, activeHolds: 1 });
    expect(f.core.store.getById(snapshotId)).toMatchObject({ status: 'found', snapshot: { id: snapshotId } });
    expect(f.core.store.readLatest('a')).toEqual({ status: 'stopped' });
    expect(f.r.getInteractionStats()).toMatchObject({ closed: true, activeInvocations: 1 });
    expect(await f.client.observe()).toMatchObject({ status: 'rejected', issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
    expect(f.counts()).toEqual({ handlers: stage === 'execute' ? 1 : 0, completed: 0 });
    await f.client.invoke({ ...request, invocationId: 'late' }); expect(f.counts().handlers).toBe(stage === 'execute' ? 1 : 0);
    f.gate.resolve(); await pending; await closing;
    expect(f.core.store.inspect()).toMatchObject({ state: 'disposed', heldSnapshots: 0, activeHolds: 0 });
    expect(f.core.store.getById(snapshotId)).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_UNAVAILABLE' } });
    expect(f.counts()).toEqual({ handlers: stage === 'execute' ? 1 : 0, completed: stage === 'execute' ? 1 : 0 });
    expect(f.r.getInteractionStats()).toMatchObject({ closed: true, activeInvocations: 0, });
});
it('A16 real invalid Draft diagnostics forwarded to Receiver have bounded paths', () => {
    const r = new SemanticSnapshotReceiver('a', 'i');
    r.acceptPrepared({ schemaVersion: 2, appId: 'a', instanceId: 'i', producerSeq: 1, sourceEpoch: 1, capturedAt: 0, views: [], refs: { ['x'.repeat(200000)]: null }, tools: {} });
    const state = r['core'].store.readLatest('a');
    if (state.status !== 'degraded') throw Error('Expected a bounded projection error');
    expect(new TextEncoder().encode(state.issue.path).byteLength).toBeLessThanOrEqual(512);
    r.close();
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
    const second = fixture('colliding'), current = await second.observe(); expect(current.observationId).toBe(request.observationId); expect(current.toolId).toBe(request.toolId);
    expect(await second.client.invoke(request)).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
    expect(second.counts().handlers).toBe(1); second.r.close();
});
