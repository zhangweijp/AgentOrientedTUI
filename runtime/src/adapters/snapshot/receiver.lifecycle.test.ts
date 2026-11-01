import { expect, it, vi } from 'vitest';
import { SemanticSnapshotReceiver } from './receiver.js';
import { createViewOwnedTools } from '../../core/tool/view-owned-tools.js';
import { compileOrdinaryParams } from '../../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../../core/tool/ordinary-parameter-profile.js';
import type { SnapshotCore } from '../../core/snapshot/types.js';
import type { ExecutionBinding, ScopePolicy } from '../../core/invocation/scoped-interaction-types.js';

function defer<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(instance = 'i', stage?: 'authorize' | 'execute') {
    const r = new SemanticSnapshotReceiver('a', instance, () => 0), core: SnapshotCore = (r as any).core;
    const registry = createViewOwnedTools('a', instance), view = registry.mount('v', 'T');
    const contract = compileOrdinaryParams({}, { additionalProperties: false });
    if (!contract.ok) throw Error('Fixture ordinary-v2 contract');
    const handler = async () => ({ success: true });
    const safe = async () => ({ phase: 'entered-returned' as const, result: await handler() });
    registry.registerTool(view.viewInstanceId, { name: 'read', description: 'Read', inputSchema: ordinaryParameterProfile(contract.contract), isMutating: false },
        handler, { safeOrdinaryParametersInvocationMode: 'ordinary-v2' }, safe);
    const tool = registry.listTools()[0], { appId: _app, appInstanceId: _instance, ...descriptor } = tool;
    r.acceptPrepared({ schemaVersion: 2, appId: 'a', instanceId: instance, producerSeq: 1, sourceEpoch: 1, capturedAt: 0,
        views: [{ id: view.viewId, viewInstanceId: view.viewInstanceId, type: view.viewType, name: 'View', kind: 'state', content: { format: 'markdown-v1', value: 'value' } }],
        refs: {}, tools: { [tool.id]: descriptor } });
    expect(r.report().health).toBe('ready');
    const entered = defer<void>(), gate = defer<void>(); let handlers = 0, completed = 0;
    const binding: ExecutionBinding = { identity: {}, mode: 'ordinary-v2', validateInput: (_source, input) => ({ ok: true, value: input }),
        isLive: source => ({ ok: registry.validateOrdinaryParametersBinding(tool, source.target).success }),
        execute: async () => { handlers++; if (stage === 'execute') { entered.resolve(); await gate.promise; } completed++;
            return { kind: 'action', phase: 'entered-returned', outcome: { status: 'succeeded', value: 19 } }; } };
    const policy: ScopePolicy = { project: () => ({ views: [{ viewId: 'v', viewInstanceId: view.viewInstanceId }], refs: [], targets: [{ toolId: tool.id, target: tool.targets[0] }], content: [] }),
        authorize: async () => { if (stage === 'authorize') { entered.resolve(); await gate.promise; } return true; }, canReadReceipt: () => true };
    const opened = r.createInteractionScope(policy, { resolve: () => binding }); expect(opened.status).toBe('opened');
    const client = opened.status === 'opened' ? opened.client : (() => { throw Error(); })();
    async function observe() { const o = await client.observe({ viewIds: ['v'] }); expect(o.status).toBe('observed'); if (o.status !== 'observed') throw Error();
        return { invocationId: 'call', observationId: o.observation.observationId, bindingId: o.observation.bindings[0].bindingId, input: {} }; }
    return { r, core, client, observe, entered, gate, counts: () => ({ handlers, completed }) };
}

it('A16 closes authority before disposing Core and retains stopped state and resource facts', async () => {
    const f = fixture(); await f.observe();
    const original = f.r.closeInteractions.bind(f.r); let checked = 0;
    vi.spyOn(f.r, 'closeInteractions').mockImplementation(async () => { expect(f.core.store.inspect().state).toBe(checked++ ? 'disposed' : 'active'); await original(); expect(f.r.getInteractionStats()?.closed).toBe(true); });
    f.r.close(); f.r.close();
    expect(f.core.store.inspect()).toMatchObject({ state: 'disposed', appRecords: 0, activeLeases: 0, currentBytes: 0 });
    expect(f.r.report()).toMatchObject({ health: 'stopped', published: 1 });
    const poison: any = new Proxy({}, { get() { throw Error('read'); } }); f.r.acceptPrepared(poison); f.r.acceptPrepareFailure(poison);
    expect(f.r.report()).toMatchObject({ health: 'stopped', published: 1 });
    expect(f.r.createInteractionScope(poison, poison).status).toBe('rejected');
});
it.each(['authorize', 'execute'] as const)('A16 keeps actual %s work tracked after close and never admits a late handler', async stage => {
    const f = fixture('i', stage), request = await f.observe(), pending = f.client.invoke(request); await f.entered.promise;
    expect(f.r.getInteractionStats()?.activeInvocations).toBe(1); f.r.close();
    expect(f.core.store.inspect().state).toBe('disposed');
    expect(f.r.getInteractionStats()).toMatchObject({ closed: true, activeInvocations: 1, closingScopes: 1 });
    expect(f.counts()).toEqual({ handlers: stage === 'execute' ? 1 : 0, completed: 0 });
    await f.client.invoke({ ...request, invocationId: 'late' }); expect(f.counts().handlers).toBe(stage === 'execute' ? 1 : 0);
    f.gate.resolve(); await pending;
    expect(f.counts()).toEqual({ handlers: stage === 'execute' ? 1 : 0, completed: stage === 'execute' ? 1 : 0 });
    expect(f.r.getInteractionStats()).toMatchObject({ closed: true, activeInvocations: 0, scopes: 0, combinedBytes: 0 });
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
