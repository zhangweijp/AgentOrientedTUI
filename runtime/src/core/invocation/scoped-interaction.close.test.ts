import { expect, it } from 'vitest';
import { createSnapshotCore, createViewOwnedTools, createScopedInteraction } from '../index.js';
import type { AppSnapshotV2, CancellationSignal, ExecutionBinding, ExecutionFact, InputValidation, InvocationContext,
    OperationQuery, ReceiptMetadata, ScopePolicy } from '../index.js';

function deferred<T = void>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
type Maybe<T> = T | Promise<T>;
const success = (): ExecutionFact => ({ kind: 'action', phase: 'entered-returned', outcome: { status: 'succeeded', value: 19 } });
function fixture(instanceId = 'run', namespace = 'close:run') {
    let clockMode = 'normal';
    const now = () => { if (clockMode === 'throw') throw Error('clock'); return clockMode === 'back' ? 9 : 10; };
    const core = createSnapshotCore({ now }), registry = createViewOwnedTools('app', instanceId), view = registry.mount('v', 'Detail');
    core.lifecycle.startApp('app', instanceId);
    registry.registerTool(view.viewInstanceId, { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} }, isMutating: false }, () => ({ success: true }));
    const tool = registry.listTools()[0];
    const committed = core.committer.accept({ schemaVersion: 2, appId: 'app', instanceId, producerSeq: 1, sourceEpoch: 1, capturedAt: 10,
        views: [{ id: 'v', viewInstanceId: view.viewInstanceId, type: 'Detail', name: 'Detail', kind: 'state', content: { format: 'markdown-v1', value: 'value' } }], refs: {},
        tools: { [tool.id]: { id: tool.id, name: tool.name, viewType: tool.viewType, description: tool.description, inputSchema: tool.inputSchema, isMutating: false, targets: tool.targets } } });
    if (committed.status !== 'published' || committed.snapshot.schemaVersion !== 2) throw Error('Fixture source');
    const grant = (source: AppSnapshotV2) => ({ views: source.views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })), refs: [],
        targets: Object.values(source.tools).flatMap(t => t.targets.map(target => ({ toolId: t.id, target }))), content: [] });
    const controls = {
        project: (context: Parameters<ScopePolicy['project']>[0]): ReturnType<ScopePolicy['project']> => grant(context.source),
        validate: (_source: Parameters<ExecutionBinding['validateInput']>[0], input: Parameters<ExecutionBinding['validateInput']>[1], _signal: CancellationSignal): Maybe<InputValidation> => ({ ok: true, value: input }),
        authorize: (_context: InvocationContext): Maybe<boolean> => true,
        execute: (_context: InvocationContext): Maybe<ExecutionFact> => success(),
        read: (_metadata: ReceiptMetadata, _signal: CancellationSignal): Maybe<boolean> => true,
        query: (_metadata: ReceiptMetadata, _id: string, _signal: CancellationSignal): Maybe<OperationQuery> => ({ status: 'pending' }),
    };
    const calls = { handler: 0, authorize: 0, validate: 0, project: 0, read: 0, query: 0 };
    const operations = new Map<string, { scopeId: string; invocationId: string }>();
    const binding: ExecutionBinding = { identity: {}, mode: 'ordinary',
        validateInput: (source, input, signal) => { calls.validate++; return controls.validate(source, input, signal); },
        isLive: source => ({ ok: registry.validate(tool, source.target).success }),
        execute: async context => { calls.handler++; const fact = await controls.execute(context);
            if (fact.kind === 'action' && fact.outcome.status === 'accepted') operations.set(fact.outcome.operationId, { scopeId: context.scopeId, invocationId: context.invocationId }); return fact; },
        operations: { owns: (metadata, id) => { const op = operations.get(id); return !!op && op.scopeId === metadata.scopeId && op.invocationId === metadata.invocationId; },
            query: (metadata, id, signal) => { calls.query++; return controls.query(metadata, id, signal); } } };
    const authority = createScopedInteraction(core.store, { namespace, now });
    const input = { appId: 'app', instanceId, policy: {
        project: (context: Parameters<ScopePolicy['project']>[0]) => { calls.project++; return controls.project(context); },
        authorize: (context: InvocationContext) => { calls.authorize++; return controls.authorize(context); },
        canReadReceipt: (metadata: ReceiptMetadata, signal: CancellationSignal) => { calls.read++; return controls.read(metadata, signal); },
    }, execution: { resolve: () => binding } };
    function open() { const opened = authority.createScope(input); if (opened.status !== 'opened') throw Error(opened.issue.code); return opened.client; }
    const client = open();
    async function observe(target = client) { const got = await target.observe({ viewIds: ['v'] }); if (got.status !== 'observed') throw Error(got.issue.code);
        return { invocationId: 'call', observationId: got.observation.observationId, bindingId: got.observation.bindings[0].bindingId, input: {} }; }
    const completion = authority.whenClosed(); let completed = false; void completion.then(() => { completed = true; });
    async function pending() { await Promise.resolve(); expect(completed).toBe(false); expect(authority.whenClosed()).toBe(completion); }
    async function zero() { await completion; expect(completed).toBe(true);
        expect(authority.inspect()).toMatchObject({ closed: true, scopes: 0, closingScopes: 0, activeInvocations: 0, activeReads: 0, activeQueries: 0,
            receiptEntries: 0, receiptContents: 0, acceptedOperations: 0, sourceBytes: 0, fingerprintBytes: 0, metadataBytes: 0, workBytes: 0, resultBytes: 0, combinedBytes: 0 });
        clockMode = 'normal'; expect(core.store.inspect().activeLeases).toBe(0); core.lifecycle.dispose(); registry.dispose(); }
    return { core, registry, authority, client, input, open, observe, controls, calls, completion, pending, zero, operations, setClock: (mode: string) => { clockMode = mode; } };
}

it('C01 one stable Promise waits for explicit authority close, including zero Scopes', async () => {
    const f = fixture(); await f.pending(); f.client.close(); await f.pending(); expect(f.authority.inspect().scopes).toBe(0);
    const stats = f.authority.close(); expect(stats.closed).toBe(true); expect('then' in stats).toBe(false); await f.zero();
    expect(f.authority.whenClosed()).toBe(f.completion); f.authority.close(); expect(f.authority.whenClosed()).toBe(f.completion);
    const core = createSnapshotCore(), empty = createScopedInteraction(core.store, { namespace: 'empty', now: () => 0 }), p = empty.whenClosed(); let done = false;
    void p.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false); empty.close(); await p; expect(done).toBe(true); core.lifecycle.dispose();
});

it.each(['resolve', 'reject'] as const)('C02 actual project %s retains cancelled reservation until settlement', async outcome => {
    const f = fixture(), entered = deferred();
    const finish = deferred<Awaited<ReturnType<ScopePolicy['project']>>>();
    f.controls.project = context => { context.signal.addEventListener('abort', () => { expect(context.signal.aborted).toBe(true); }); entered.resolve();
        return finish.promise; };
    const work = f.client.observe({ viewIds: ['v'] }); await entered.promise; f.authority.close(); await f.pending();
    expect(f.authority.inspect()).toMatchObject({ scopes: 1, closingScopes: 1, observations: { reservations: 1, cancelledReservations: 1 } });
    if (outcome === 'reject') finish.reject(Error('project')); else finish.resolve({ views: [], refs: [], targets: [], content: [] });
    expect((await work).status).toBe('rejected'); await f.zero();
});

it.each(['resolve', 'reject'] as const)('C03 actual input validator %s never admits authorize/handler after close', async outcome => {
    const f = fixture(), request = await f.observe(), entered = deferred(), gate = deferred<InputValidation>();
    f.controls.validate = (_source, _input, signal) => { entered.resolve(); expect(signal.aborted).toBe(false); return gate.promise; };
    const work = f.client.invoke(request); await entered.promise; f.authority.close(); await f.pending();
    expect(f.authority.inspect().activeInvocations).toBe(1); expect(f.calls.authorize).toBe(0); expect(f.calls.handler).toBe(0);
    if (outcome === 'reject') gate.reject(Error('validate')); else gate.resolve({ ok: true, value: {} });
    await work; await f.zero(); expect(f.calls.authorize).toBe(0); expect(f.calls.handler).toBe(0);
});

it.each(['allow', 'deny', 'reject'] as const)('C04 actual authorize %s cannot enter handler after close', async outcome => {
    const f = fixture(), request = await f.observe(), entered = deferred(), gate = deferred<boolean>();
    f.controls.authorize = context => { entered.resolve(); expect(context.signal.aborted).toBe(false); return gate.promise; };
    const work = f.client.invoke(request); await entered.promise; f.authority.close(); await f.pending();
    if (outcome === 'reject') gate.reject(Error('authorize')); else gate.resolve(outcome === 'allow');
    await work; await f.zero(); expect(f.calls.handler).toBe(0);
});
it('C04 synchronous authorization throw with reentrant close completes after finally', async () => {
    const f = fixture(), request = await f.observe();
    f.controls.authorize = () => { f.authority.close(); throw Error('sync authorization'); };
    expect(await f.client.invoke(request)).toMatchObject({ kind: 'unavailable', code: 'SCOPE_UNAVAILABLE' }); await f.zero(); expect(f.calls.handler).toBe(0);
});

const outcomes = ['success', 'business', 'throw', 'unknown', 'accepted'] as const;
function fact(kind: typeof outcomes[number]): ExecutionFact {
    if (kind === 'throw') throw Error('business exception');
    if (kind === 'unknown') return { kind: 'unknown' };
    if (kind === 'accepted') return { kind: 'action', phase: 'entered-returned', outcome: { status: 'accepted', operationId: 'external-operation' } };
    if (kind === 'business') return { kind: 'operation-result', phase: 'entered-returned', failureEffects: 'none', result: { success: false, error: { code: 'BUSINESS', message: 'kept' } } };
    return success();
}
it.each(outcomes)('C05 preserves existing %s mapping and waits for an actually entered execution', async kind => {
    const before = fixture(), requestBefore = await before.observe(); before.controls.execute = () => fact(kind);
    expect(await before.client.invoke(requestBefore)).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: kind === 'success' ? 'succeeded' : kind === 'business' ? 'failed' : kind === 'accepted' ? 'accepted' : 'unknown' } } });
    before.authority.close(); await before.zero();
    const f = fixture(), request = await f.observe(), entered = deferred(), gate = deferred(); let returned = false;
    f.controls.execute = async () => { entered.resolve(); await gate.promise; returned = true; return fact(kind); };
    const work = f.client.invoke(request); await entered.promise; f.authority.close(); await f.pending(); expect(returned).toBe(false);
    expect(await f.client.invoke(request)).toMatchObject({ kind: 'refused', code: 'SCOPE_UNAVAILABLE' }); expect(f.calls.handler).toBe(1);
    gate.resolve(); expect(await work).toMatchObject({ kind: 'unavailable', code: 'SCOPE_UNAVAILABLE' }); await f.zero(); expect(returned).toBe(true); expect(f.calls.handler).toBe(1);
});

it.each(['automatic', 'explicit'].flatMap(mode => ['allow', 'deny', 'reject'].map(outcome => ({ mode, outcome }))))('C06 $mode receipt permission $outcome remains owned until actual settlement', async ({ mode, outcome }) => {
    const f = fixture(), request = await f.observe(), entered = deferred(), gate = deferred<boolean>();
    if (mode === 'explicit') expect(await f.client.invoke(request)).toMatchObject({ kind: 'receipt' });
    f.controls.read = (_metadata, signal) => { entered.resolve(); expect(signal.aborted).toBe(false); return gate.promise; };
    const work = mode === 'automatic' ? f.client.invoke(request) : f.client.readReceipt('call'); await entered.promise;
    f.authority.close(); await f.pending(); expect(f.authority.inspect().activeReads).toBe(1);
    if (outcome === 'reject') gate.reject(Error('read permission')); else gate.resolve(outcome === 'allow');
    expect(await work).toMatchObject({ kind: 'unavailable', code: 'SCOPE_UNAVAILABLE' }); await f.zero();
});

it.each(['qep', 'qpe', 'eqp', 'epq', 'pqe', 'peq'])('C07 query + execute + project settle in order %s; only last work completes close', async order => {
    const f = fixture(), request = await f.observe(); f.controls.execute = () => fact('accepted'); await f.client.invoke(request);
    const queryEntered = deferred(), executeEntered = deferred(), projectEntered = deferred();
    const query = deferred<OperationQuery>(), execute = deferred<ExecutionFact>(), project = deferred<Awaited<ReturnType<ScopePolicy['project']>>>();
    f.controls.query = () => { queryEntered.resolve(); return query.promise; }; const querying = f.client.readReceipt('call'); await queryEntered.promise;
    f.controls.execute = () => { executeEntered.resolve(); return execute.promise; }; const executing = f.client.invoke({ ...request, invocationId: 'second' }); await executeEntered.promise;
    f.controls.project = () => { projectEntered.resolve(); return project.promise; }; const projecting = f.client.observe({ viewIds: ['v'] }); await projectEntered.promise;
    f.authority.close(); await f.pending(); expect(f.authority.inspect()).toMatchObject({ activeQueries: 1, activeInvocations: 1, observations: { cancelledReservations: 1 } });
    for (let n = 0; n < order.length; n++) {
        if (order[n] === 'q') { query.resolve({ status: 'pending' }); await querying; }
        if (order[n] === 'e') { execute.resolve(success()); await executing; }
        if (order[n] === 'p') { project.resolve({ views: [], refs: [], targets: [], content: [] }); await projecting; }
        if (n < 2) { await f.pending(); expect(f.authority.inspect().combinedBytes).toBeGreaterThan(0); }
    }
    await f.zero(); expect(f.calls.handler).toBe(2); expect(f.calls.query).toBe(1);
});
it('C07 accepted external operation is not a background completion Promise', async () => {
    const f = fixture(), request = await f.observe(); f.controls.execute = () => fact('accepted'); await f.client.invoke(request);
    expect(f.operations.size).toBe(1); f.authority.close(); await f.zero(); expect(f.operations.size).toBe(1); expect(f.calls.query).toBe(0);
});

it('C08 abort reentry, two Scopes, duplicates and malformed requests keep one completion and one effect each', async () => {
    const f = fixture(), second = f.open(), a = await f.observe(), b = await f.observe(second), entered = deferred(), gate = deferred(); let entries = 0;
    f.controls.execute = async context => { context.signal.addEventListener('abort', () => { f.authority.close(); f.client.close(); f.authority.inspect(); expect(f.authority.whenClosed()).toBe(f.completion); });
        if (++entries === 2) entered.resolve(); await gate.promise; return success(); };
    const pending = [f.client.invoke(a), f.client.invoke(a), second.invoke(b)]; await entered.promise;
    await f.client.invoke({ invalid: true }); f.authority.close(); f.authority.close(); await f.pending(); expect(entries).toBe(2);
    gate.resolve(); await Promise.all(pending); await f.zero(); expect(f.calls.handler).toBe(2);
    expect(Object.keys(f.client).sort()).toEqual(['close', 'invoke', 'observe', 'readReceipt', 'releaseObservation']);
});

it.each(['project', 'validate', 'authorize', 'execute', 'read', 'query'].flatMap(stage => ['throw', 'back'].map(clock => ({ stage, clock }))))('C09 $stage finally completes with clock $clock', async ({ stage, clock }) => {
    const f = fixture(), request = stage === 'project' ? undefined : await f.observe(), entered = deferred(), gate = deferred();
    let work: Promise<unknown>;
    if (stage === 'project') { f.controls.project = async () => { entered.resolve(); await gate.promise; return { views: [], refs: [], targets: [], content: [] }; }; work = f.client.observe({ viewIds: ['v'] }); }
    else if (stage === 'query') { f.controls.execute = () => fact('accepted'); await f.client.invoke(request!); f.controls.query = async () => { entered.resolve(); await gate.promise; return { status: 'pending' }; }; work = f.client.readReceipt('call'); }
    else {
        if (stage === 'validate') f.controls.validate = async (_source, input) => { entered.resolve(); await gate.promise; return { ok: true, value: input }; };
        if (stage === 'authorize') f.controls.authorize = async () => { entered.resolve(); await gate.promise; return true; };
        if (stage === 'execute') f.controls.execute = async () => { entered.resolve(); await gate.promise; return success(); };
        if (stage === 'read') f.controls.read = async () => { entered.resolve(); await gate.promise; return true; };
        work = f.client.invoke(request!);
    }
    await entered.promise; f.setClock(clock); f.authority.close(); await f.pending(); gate.resolve(); await work; await f.zero();
});

it('C10 completion is permanent; old clients cannot authorize a fresh identity domain', async () => {
    const old = fixture(), request = await old.observe(); old.authority.close(); await old.zero();
    expect(old.authority.createScope(old.input).status).toBe('rejected'); expect(await old.client.invoke(request)).toMatchObject({ kind: 'refused' });
    const next = fixture('fresh', 'close:fresh'), current = await next.observe(); expect(current.observationId).not.toBe(request.observationId);
    await next.client.invoke(request); expect(next.calls.handler).toBe(0);
    expect(await next.client.invoke({ ...current, invocationId: 'fresh-call' })).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } }); next.authority.close(); await next.zero();
});
