import { expect, it } from 'vitest';
import { compileOrdinaryParams, createSnapshotCore, createViewOwnedTools, createAppInteraction } from '../index.js';
import type { AppSnapshotV3, CancellationSignal, ExecutionBinding, ExecutionFact, InputValidation, InvocationContext,
    ReceiptMetadata, AppInteractionPolicy } from '../index.js';

function deferred<T = void>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
type Maybe<T> = T | Promise<T>;
const success = (): ExecutionFact => ({ kind: 'tool-result', phase: 'entered-returned', result: { success: true, data: { value: 19 } } });
function fixture(instanceId = 'run', namespace = 'close:run') {
    let time = 10;
    let clockMode = 'normal';
    const now = () => { if (clockMode === 'throw') throw Error('clock'); return clockMode === 'back' ? 9 : time; };
    const core = createSnapshotCore({ now }), registry = createViewOwnedTools('app', instanceId), view = registry.mount('v', 'Detail');
    core.lifecycle.startApp('app', instanceId);
    const contract = compileOrdinaryParams({}, { additionalProperties: false });
    if (!contract.ok) throw Error('Fixture ordinary-v2 contract');
    const handler = async () => ({ success: true });
    registry.registerTypeTool({ viewType: 'Detail', name: 'read', description: 'Read', inputSchema: contract.contract.schema }, {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2',
        createSafeOrdinaryParametersInvoker: () => async () => ({ phase: 'entered-returned', result: await handler() }),
    });
    const tool = registry.listTools()[0];
    const committed = core.committer.accept({ schemaVersion: 3, appId: 'app', instanceId, producerSeq: 1, sourceEpoch: 1, capturedAt: 10,
        views: [{ id: 'v', viewInstanceId: view.viewInstanceId, type: 'Detail', name: 'Detail', kind: 'state', content: { format: 'markdown-v1', value: 'value' } }], refs: {},
        tools: { [tool.id]: tool } });
    if (committed.status !== 'published' || committed.snapshot.schemaVersion !== 3) throw Error('Fixture source');
    const grant = (source: AppSnapshotV3) => ({ views: source.views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })), refs: [],
        toolBindings: Object.values(source.tools).map(t => ({ toolId: t.id, execution: t.execution })), content: [] });
    const controls = {
        project: (context: Parameters<AppInteractionPolicy['project']>[0]): ReturnType<AppInteractionPolicy['project']> => grant(context.source),
        validate: (_source: Parameters<ExecutionBinding['validateInput']>[0], input: Parameters<ExecutionBinding['validateInput']>[1], _signal: CancellationSignal): Maybe<InputValidation> => ({ ok: true, value: input }),
        authorize: (_context: InvocationContext): Maybe<boolean> => true,
        execute: (_context: InvocationContext): Maybe<ExecutionFact> => success(),
        read: (_metadata: ReceiptMetadata, _signal: CancellationSignal): Maybe<boolean> => true,
    };
    const calls = { handler: 0, authorize: 0, validate: 0, project: 0, read: 0 };
    const binding: ExecutionBinding = { identity: {}, mode: 'ordinary-v2',
        validateInput: (source, input, signal) => { calls.validate++; return controls.validate(source, input, signal); },
        isLive: source => ({ ok: registry.validateTypeToolBinding(tool, source.execution).success }),
        execute: context => { calls.handler++; return controls.execute(context); } };
    const input = { appId: 'app', instanceId, policy: {
        project: (context: Parameters<AppInteractionPolicy['project']>[0]) => { calls.project++; return controls.project(context); },
        authorize: (context: InvocationContext) => { calls.authorize++; return controls.authorize(context); },
        canReadReceipt: (metadata: ReceiptMetadata, signal: CancellationSignal) => { calls.read++; return controls.read(metadata, signal); },
    }, execution: { resolve: () => binding } };
    const authority = createAppInteraction(core.store, { namespace, now, ...input });
    const client = authority;
    async function observe(target = client) { const got = await target.observe({ viewIds: ['v'] }); if (got.status !== 'observed') throw Error(got.issue.code);
        expect(target.adoptObservation(got.observation.observationId)).toEqual({ status: 'adopted' });
        return { invocationId: 'call', observationId: got.observation.observationId, bindingId: got.observation.bindings[0].bindingId, input: {} }; }
    const completion = authority.whenClosed(); let completed = false; void completion.then(() => { completed = true; });
    async function pending() { await Promise.resolve(); expect(completed).toBe(false); expect(authority.whenClosed()).toBe(completion); }
    async function zero() { await completion; expect(completed).toBe(true);
        expect(authority.inspect()).toMatchObject({ closed: true, activeInvocations: 0, activeReads: 0,
            receiptEntries: 0, receiptContents: 0, sourceBytes: 0, fingerprintBytes: 0, metadataBytes: 0, workBytes: 0, resultBytes: 0, combinedBytes: 0 });
        clockMode = 'normal'; expect(core.store.inspect().activeLeases).toBe(0); core.lifecycle.dispose(); registry.dispose(); }
    return { core, registry, authority, client, input, observe, controls, calls, completion, pending, zero, setClock: (mode: string) => { clockMode = mode; }, setTime: (value: number) => { time = value; } };
}

it('waits for explicit instance close and provides one stable completion', async () => {
    const f = fixture();
    await f.pending();
    const stats = f.authority.close();
    expect(stats.closed).toBe(true);
    await f.zero();
    f.authority.close();
    expect(f.authority.whenClosed()).toBe(f.completion);
});

it.each(['resolve', 'reject'] as const)('C02 actual project %s retains cancelled reservation until settlement', async outcome => {
    const f = fixture(), entered = deferred();
    const finish = deferred<Awaited<ReturnType<AppInteractionPolicy['project']>>>();
    f.controls.project = context => { context.signal.addEventListener('abort', () => { expect(context.signal.aborted).toBe(true); }); entered.resolve();
        return finish.promise; };
    const work = f.client.observe({ viewIds: ['v'] }); await entered.promise; f.authority.close(); await f.pending();
    expect(f.authority.inspect()).toMatchObject({ observations: { reservations: 1, cancelledReservations: 1 } });
    if (outcome === 'reject') finish.reject(Error('project')); else finish.resolve({ views: [], refs: [], toolBindings: [], content: [] });
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
    expect(await f.client.invoke(request)).toMatchObject({ kind: 'unavailable', code: 'APP_INTERACTION_UNAVAILABLE' }); await f.zero(); expect(f.calls.handler).toBe(0);
});

const outcomes = ['success', 'business', 'throw', 'unknown'] as const;
function fact(kind: typeof outcomes[number]): ExecutionFact {
    if (kind === 'throw') throw Error('business exception');
    if (kind === 'unknown') return { kind: 'unknown' };
    if (kind === 'business') return { kind: 'tool-result', phase: 'entered-returned', failureEffects: 'none', result: { success: false, error: { code: 'BUSINESS', message: 'kept' } } };
    return success();
}
it.each(outcomes)('C05 preserves existing %s mapping and waits for an actually entered execution', async kind => {
    const before = fixture(), requestBefore = await before.observe(); before.controls.execute = () => fact(kind);
    expect(await before.client.invoke(requestBefore)).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: kind === 'success' ? 'succeeded' : kind === 'business' ? 'failed' : 'unknown' } } });
    before.authority.close(); await before.zero();
    const f = fixture(), request = await f.observe(), entered = deferred(), gate = deferred(); let returned = false;
    f.controls.execute = async () => { entered.resolve(); await gate.promise; returned = true; return fact(kind); };
    const work = f.client.invoke(request); await entered.promise; f.authority.close(); await f.pending(); expect(returned).toBe(false);
    expect(await f.client.invoke(request)).toMatchObject({ kind: 'refused', code: 'APP_INTERACTION_UNAVAILABLE' }); expect(f.calls.handler).toBe(1);
    gate.resolve(); expect(await work).toMatchObject({ kind: 'unavailable', code: 'APP_INTERACTION_UNAVAILABLE' }); await f.zero(); expect(returned).toBe(true); expect(f.calls.handler).toBe(1);
});

it.each(['automatic', 'duplicate'].flatMap(mode => ['allow', 'deny', 'reject'].map(outcome => ({ mode, outcome }))))('C06 $mode receipt permission $outcome remains owned until actual settlement', async ({ mode, outcome }) => {
    const f = fixture(), request = await f.observe(), entered = deferred(), gate = deferred<boolean>();
    if (mode === 'duplicate') expect(await f.client.invoke(request)).toMatchObject({ kind: 'receipt' });
    f.controls.read = (_metadata, signal) => { entered.resolve(); expect(signal.aborted).toBe(false); return gate.promise; };
    const work = f.client.invoke(request); await entered.promise;
    f.authority.close(); await f.pending(); expect(f.authority.inspect().activeReads).toBe(1);
    if (outcome === 'reject') gate.reject(Error('read permission')); else gate.resolve(outcome === 'allow');
    expect(await work).toMatchObject({ kind: 'unavailable', code: 'APP_INTERACTION_UNAVAILABLE' }); await f.zero();
});

it.each(['rep', 'rpe', 'erp', 'epr', 'pre', 'per'])('C07 receipt permission + execute + project settle in order %s; only last work completes close', async order => {
    const f = fixture(), request = await f.observe(); await f.client.invoke(request);
    const readEntered = deferred(), executeEntered = deferred(), projectEntered = deferred();
    const read = deferred<boolean>(), execute = deferred<ExecutionFact>(), project = deferred<Awaited<ReturnType<AppInteractionPolicy['project']>>>();
    f.controls.read = () => { readEntered.resolve(); return read.promise; }; const reading = f.client.invoke(request); await readEntered.promise;
    f.controls.execute = () => { executeEntered.resolve(); return execute.promise; }; const executing = f.client.invoke({ ...request, invocationId: 'second' }); await executeEntered.promise;
    f.controls.project = () => { projectEntered.resolve(); return project.promise; }; const projecting = f.client.observe({ viewIds: ['v'] }); await projectEntered.promise;
    f.authority.close(); await f.pending(); expect(f.authority.inspect()).toMatchObject({ activeReads: 2, activeInvocations: 1, observations: { cancelledReservations: 1 } });
    for (let n = 0; n < order.length; n++) {
        if (order[n] === 'r') { read.resolve(true); await reading; }
        if (order[n] === 'e') { execute.resolve(success()); await executing; }
        if (order[n] === 'p') { project.resolve({ views: [], refs: [], toolBindings: [], content: [] }); await projecting; }
        if (n < 2) { await f.pending(); expect(f.authority.inspect().combinedBytes).toBeGreaterThan(0); }
    }
    await f.zero(); expect(f.calls.handler).toBe(2); expect(f.calls.read).toBe(2);
});

it('abort reentry keeps one completion and duplicate waiters share one execution', async () => {
    const f = fixture(), a = await f.observe(), entered = deferred(), gate = deferred();
    f.controls.execute = async context => {
        context.signal.addEventListener('abort', () => {
            f.authority.close();
            expect(f.authority.whenClosed()).toBe(f.completion);
        });
        entered.resolve();
        await gate.promise;
        return success();
    };
    const pending = [f.client.invoke(a), f.client.readReceipt(a)];
    await entered.promise;
    expect(await f.client.invoke({ ...a, invocationId: 'other' })).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
    expect(await f.client.invoke({ invalid: true })).toMatchObject({ kind: 'refused', code: 'INVOCATION_INVALID' });
    f.authority.close();
    await f.pending();
    gate.resolve();
    await Promise.all(pending);
    await f.zero();
    expect(f.calls.handler).toBe(1);
});

it.each(['project', 'validate', 'authorize', 'execute', 'read'].flatMap(stage => ['throw', 'back'].map(clock => ({ stage, clock }))))('C09 $stage finally completes with clock $clock', async ({ stage, clock }) => {
    const f = fixture(), request = stage === 'project' ? undefined : await f.observe(), entered = deferred(), gate = deferred();
    let work: Promise<unknown>;
    if (stage === 'project') { f.controls.project = async () => { entered.resolve(); await gate.promise; return { views: [], refs: [], toolBindings: [], content: [] }; }; work = f.client.observe({ viewIds: ['v'] }); }
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
    expect((await old.client.observe({ all: true })).status).toBe('rejected'); expect(await old.client.invoke(request)).toMatchObject({ kind: 'refused' });
    const next = fixture('fresh', 'close:fresh'), current = await next.observe(); expect(current.observationId).not.toBe(request.observationId);
    await next.client.invoke(request); expect(next.calls.handler).toBe(0);
    expect(await next.client.invoke({ ...current, invocationId: 'fresh-call' })).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } }); next.authority.close(); await next.zero();
});


it('reads multiple authorized receipts after adoption and prunes retired calls at their terminal TTL', async () => {
    const f = fixture(), first = await f.observe(), settled = { ...first, invocationId: 'first' };
    expect(await f.client.invoke(settled)).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
    const gate = deferred<ExecutionFact>(), entered = deferred();
    f.controls.execute = () => { entered.resolve(); return gate.promise; };
    const held = { ...first, invocationId: 'held' };
    const work = f.client.invoke(held);
    try {
        await entered.promise;
        const next = await f.observe();
        expect(await f.client.invoke(next)).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
        expect(await f.client.readReceipt(settled)).toMatchObject({ kind: 'receipt' });
        expect(await f.client.readReceipt({ ...settled, input: { extra: true } })).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_ID_CONFLICT' });
        f.controls.read = () => false;
        expect(await f.client.readReceipt(settled)).toMatchObject({ kind: 'unavailable', code: 'RECEIPT_PERMISSION_DENIED' });
        f.controls.read = () => true;
        f.setTime(30);
        gate.resolve(success());
        expect(await work).toMatchObject({ kind: 'receipt', receipt: { completedAt: 30 } });
        expect(await f.client.readReceipt(held)).toMatchObject({ kind: 'receipt', receipt: { completedAt: 30 } });
        expect(await f.client.invoke({ ...first, invocationId: 'unseen' })).toMatchObject({ kind: 'refused', code: 'OBSERVATION_UNAVAILABLE' });
        expect(f.calls.handler).toBe(2);
        f.setTime(60_010);
        expect(await f.client.readReceipt(settled)).toMatchObject({ kind: 'unavailable', code: 'RESULT_UNAVAILABLE' });
        expect(await f.client.readReceipt(held)).toMatchObject({ kind: 'receipt' });
        f.setTime(60_030);
        expect(f.authority.inspect().receiptEntries).toBe(0);
        expect(await f.client.invoke(held)).toMatchObject({ kind: 'refused', code: 'OBSERVATION_UNAVAILABLE' });
        expect(f.core.store.inspect().activeLeases).toBe(1);
    } finally {
        gate.resolve(success());
        await work;
        f.authority.close();
        await f.zero();
    }
});
