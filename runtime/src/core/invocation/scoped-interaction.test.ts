import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { AppSnapshotV3, JsonValue, PreparedAppSnapshotDraftV3, SnapshotStoreOptions, ToolDescriptorV3 } from '../snapshot/types.js';
import { createViewOwnedTools } from '../tool/view-owned-tools.js';
import { createAppInteraction, DEFAULT_INTERACTION_LIMITS as HARD } from './app-interaction.js';
import type { CancellationSignal, ExecutionBinding, ExecutionFact, InteractionLimitOverrides, InvocationContext, ReceiptMetadata, InstanceInteraction, AppInvocation } from './app-interaction-types.js';
import type { Observation, ObservationGrant, ObservationRegistryLimitOverrides } from './observation-types.js';
import { compileOrdinaryParams } from '../tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../tool/ordinary-parameter-profile.js';
import { compileOrdinarySchema } from '../tool/ordinary-parameter-contract.js';

afterEach(() => vi.restoreAllMocks());

it('a receipt deadline preserves read permission and tracks the actual callback until it ends', async () => {
    vi.useFakeTimers();
    const f = fixture(), client = f.open(), entered = deferred<void>(), gate = deferred<boolean>();
    try {
        const request = f.request(await f.observe(client));
        f.controls.read = () => { entered.resolve(); return gate.promise; };
        const first = client.invoke(request, 100);
        await entered.promise;
        const signal = f.seen.readSignal;
        await vi.advanceTimersByTimeAsync(100);
        expect(await first).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_DEADLINE_EXCEEDED' });
        expect(signal?.aborted).toBe(true);
        expect(f.authority.inspect()).toMatchObject({ activeInvocations: 0, activeReads: 1 });
        f.controls.read = () => true;
        expect(receipt(await client.invoke(request)).outcome.status).toBe('succeeded');
        expect(f.calls.handler).toBe(1);
    } finally {
        client.close();
        gate.resolve(false);
        f.authority.close();
        await f.authority.whenClosed();
        vi.useRealTimers();
    }
    f.zero();
});

describe('R1-F01: real App interaction preserves compatible business errors', () => {
    it('returns not-entered rejection with an empty message and the full captured result', async () => {
        const f = fixture(), client = f.open(), observed = await f.observe(client);
        const result = { success: false, error: { code: 'E_RESULT', message: '', context: { retained: true } } };
        f.controls.execute = () => ({ kind: 'tool-result', phase: 'not-entered', result });
        const r = receipt(await client.invoke(f.request(observed)));
        expect(r).toMatchObject({ executionPhase: 'not-entered', outcome: { status: 'rejected', details: { result } } });
        expect(f.calls.handler).toBe(1); expect(receipt(await client.invoke(f.request(observed)))).toEqual(r); f.zero();
    });
    it.each(['none', 'partial', undefined] as const)('preserves business failure details with effects %s on duplicate invocation', async effects => {
        const f = fixture(), client = f.open(), observed = await f.observe(client);
        const result = { success: false, data: { retained: 'data' }, error: { code: ' ', message: '', context: { retained: 'context' } } };
        f.controls.execute = () => ({ kind: 'tool-result', phase: 'entered-returned', result,
            ...(effects === undefined ? {} : { failureEffects: effects }) });
        const first = receipt(await client.invoke(f.request(observed)));
        expect(first).toMatchObject({ executionPhase: 'entered-returned', outcome: { status: effects ? 'failed' : 'unknown', details: { result } } });
        f.setTime(2); const duplicate = receipt(await client.invoke(f.request(observed)));
        expect(duplicate).toEqual(first); expect(f.calls.handler).toBe(1); f.zero();
    });
});

describe('R1-F02: await settlement propagates revocation before another public call', () => {
    const changes = ['stop-start', 'direct-start', 'close'] as const;
    function invalidate(f: ReturnType<typeof fixture>, client: InstanceInteraction, change: typeof changes[number]) {
        if (change === 'close') { client.close(); client.close(); }
        else {
            if (change === 'stop-start') f.core.lifecycle.stopApp('app', 'run');
            f.core.lifecycle.startApp('app', 'new-unready-instance');
        }
    }
    const modes = ['resolve', 'reject', 'uncapturable'] as const;
    it.each(changes.flatMap(change => modes.map(mode => ({ change, mode }))))('project $mode propagates $change to a peer execute', async ({ change, mode }) => {
        const f = fixture(), client = f.open(), observed = await f.observe(client);
        const execute = deferred<unknown>(), entered = deferred<void>(); let executionSignal!: CancellationSignal, projectSignal!: CancellationSignal;
        f.controls.execute = ctx => { executionSignal = ctx.signal; entered.resolve(); return execute.promise; };
        const running = client.invoke(f.request(observed)); await entered.promise;
        const project = deferred<unknown>(), started = deferred<void>(); let getterReads = 0;
        f.controls.project = ctx => { projectSignal = ctx.signal; started.resolve(); return project.promise; };
        const projecting = client.observe({ viewIds: ['v0'] }); await started.promise; invalidate(f, client, change);
        if (mode === 'reject') project.reject(new Error('synthetic project rejection'));
        else project.resolve(mode === 'uncapturable' ? { get views() { getterReads++; return []; } } : f.grant(f.source, ['v0']));
        const response = await projecting;
        expect(executionSignal.aborted).toBe(true); expect(projectSignal.aborted).toBe(true); // Before inspect/sweep/read/invoke.
        expect(response.status).toBe('rejected'); expect(getterReads).toBe(0);
        const charged = f.authority.inspect(); expect(charged).toMatchObject({ activeInvocations: 1, activeReads: 1,
            receiptContents: 0, observations: { reservations: 0 } });
        expect(charged.sourceBytes).toBeGreaterThan(0); expect(charged.workBytes).toBeGreaterThanOrEqual(1024 * 1024);
        expect(charged.resultBytes).toBeGreaterThan(0); expect((await client.observe({ all: true })).status).toBe('rejected');
        client.close(); client.close();
        execute.resolve(success('entered before revocation')); expect(code(await running)).toBe('APP_INTERACTION_UNAVAILABLE');
        expect(f.calls.handler).toBe(1); f.zero();
    });
    it.each(modes)('a valid instance survives project %s without cancelling unrelated execution', async mode => {
        const f = fixture(), client = f.open(), observed = await f.observe(client), execute = deferred<unknown>(), entered = deferred<void>();
        let signal!: CancellationSignal;
        f.controls.execute = ctx => { signal = ctx.signal; entered.resolve(); return execute.promise; };
        const running = client.invoke(f.request(observed)); await entered.promise;
        const project = deferred<unknown>(), started = deferred<void>(); let reads = 0;
        f.controls.project = () => { started.resolve(); return project.promise; };
        const projecting = client.observe({ viewIds: ['v0'] }); await started.promise;
        if (mode === 'reject') project.reject(new Error('business project refusal'));
        else project.resolve(mode === 'uncapturable' ? { get views() { reads++; return []; } } : f.grant(f.source, ['v0']));
        const response = await projecting; expect(signal.aborted).toBe(false); expect(reads).toBe(0);
        expect(response.status).toBe(mode === 'resolve' ? 'observed' : 'rejected');
        if (mode === 'reject') expect(code(response)).toBe('OBSERVATION_INTERNAL_ERROR');
        if (mode === 'uncapturable') expect(code(response)).toBe('OBSERVATION_PROJECTION_INVALID');
        execute.resolve(success()); expect(receipt(await running).outcome.status).toBe('succeeded'); f.zero();
    });

});
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const success = (value: JsonValue = { synthetic: true }): ExecutionFact => ({ kind: 'tool-result', phase: 'entered-returned', result: { success: true, data: { value } } });
const context = { appId: 'app', instanceId: 'run' };
const code = (value: unknown): string | undefined => (value as { code?: string; issue?: { code: string } }).code ?? (value as { issue?: { code: string } }).issue?.code;
function receipt(value: Awaited<ReturnType<InstanceInteraction['invoke']>>) {
    expect(value.kind).toBe('receipt'); if (value.kind !== 'receipt') throw new Error('Expected receipt: ' + value.code); return value.receipt;
}
function fixture(options: { mode?: ExecutionBinding['mode'];  limits?: InteractionLimitOverrides; observationLimits?: ObservationRegistryLimitOverrides;
    store?: SnapshotStoreOptions; payload?: JsonValue; refType?: string; schema?: JsonValue; namespace?: string } = {}) {
    let time = 0, sequence = 0, clockThrows = false, clockMessageReads = 0;
    const now = () => { if (clockThrows) throw { get message() { clockMessageReads++; return 'secret-clock'; } }; return time; };
    const core = createSnapshotCore({ now, ...options.store }); core.lifecycle.startApp('app', 'run');
    const tools = createViewOwnedTools('app', 'run'), owners = [tools.mount('v0', 'File'), tools.mount('v1', 'File')];
    const mode = options.mode ?? 'ordinary-v2';
    const ordinary = compileOrdinaryParams({});
    const snapshotValue = compileOrdinarySchema({ type: 'object', properties: {
        file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } },
        line: { type: 'string' },
    }, required: ['file'], additionalProperties: true }, 'view-type-parameters-v1');
    if (!ordinary.ok || !snapshotValue.ok) throw new Error('Invalid interaction fixture');
    const schema: JsonValue = options.schema ?? (mode === 'view-type-parameters-v1'
        ? snapshotValue.contract.schema : ordinary.contract.schema);
    const typeDefinition = { viewType: 'File', name: 'run', description: 'Synthetic tool', inputSchema: schema };
    const register = () => tools.registerTypeTool(typeDefinition, {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2',
        createSafeOrdinaryParametersInvoker: () => async () => ({ phase: 'entered-returned' as const, result: { success: true } }),
    });
    let typeRelease = register();
    function rebindTool() { typeRelease(); typeRelease = register(); }
    function remountAll() {
        for (const owner of owners) tools.unmount(owner.viewInstanceId);
        owners.splice(0, owners.length, tools.mount('v0', 'File'));
    }
    function refs(value: JsonValue = options.payload ?? { version: 'S1' }) {
        return Object.fromEntries(owners.flatMap(owner => (owner.viewId === 'v0' ? ['visible', 'hidden'] : ['visible-v1', 'hidden-v1']).map(id => [refKey(owner.viewId, owner.viewInstanceId, id), {
            id, ownerViewId: owner.viewId, ownerViewInstanceId: owner.viewInstanceId, refType: options.refType ?? 'File',
            target: { kind: 'snapshot-value' as const, payload: value },
        }])));
    }
    function publish(patch: Partial<PreparedAppSnapshotDraftV3> = {}): AppSnapshotV3 {
        const seq = ++sequence, result = core.committer.accept({ schemaVersion: 3, ...context, producerSeq: seq, sourceEpoch: seq, capturedAt: time,
            views: owners.map(v => ({ id: v.viewId, viewInstanceId: v.viewInstanceId, type: 'File', name: v.viewId, kind: 'state',
                content: { format: 'markdown-v1', value: 'content-secret-' + v.viewId } })), refs: refs(),
            tools: Object.fromEntries(tools.listTools().map(t => [t.id, t])), ...patch });
        expect(['published', 'unchanged']).toContain(result.status);
        if (result.status === 'rejected' || result.snapshot.schemaVersion !== 3) throw new Error('Expected V3 fixture'); return result.snapshot;
    }
    const source = publish();
    const calls = { project: 0, validate: 0, authorize: 0, handler: 0, read: 0, live: 0, resolve: 0, resolveRef: 0 };
    const seen: { validateInput?: Readonly<Record<string, JsonValue>>; authorize?: InvocationContext; execute?: InvocationContext; metadata?: ReceiptMetadata; validateSignal?: CancellationSignal; readSignal?: CancellationSignal } = {};
    function grant(snapshot = source, visible = ['v0', 'v1'], refIds = ['visible']): ObservationGrant {
        return { views: snapshot.views.filter(v => visible.includes(v.id)).map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
            refs: Object.values(snapshot.refs).filter(r => visible.includes(r.ownerViewId) && refIds.includes(r.id)).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
            toolBindings: Object.values(snapshot.tools).filter(tool => snapshot.views.some(view => view.type === tool.viewType && visible.includes(view.id)))
                .map(tool => ({ toolId: tool.id, execution: tool.execution })), content: [] };

    }
    const controls = {
        project: (ctx: Parameters<import('./app-interaction-types.js').AppInteractionPolicy['project']>[0]): unknown => grant(ctx.source, ctx.selection.viewIds as string[]),
        validate: (_source: unknown, input: Readonly<Record<string, JsonValue>>, _signal?: CancellationSignal): unknown => ({ ok: true, value: input }),
        authorize: (_ctx: InvocationContext): unknown => true,
        execute: (_ctx: InvocationContext): unknown => success(),
        read: (_metadata: ReceiptMetadata, _signal?: CancellationSignal): unknown => true,
        live: (): unknown => ({ ok: true }),
    };
    let current: ExecutionBinding | null = { identity: {}, mode,
        validateInput: (source, input, signal) => { calls.validate++; seen.validateInput = input; seen.validateSignal = signal; return controls.validate(source, input, signal) as never; },
        isLive: () => { calls.live++; return controls.live() as never; },
        execute: ctx => { calls.handler++; seen.execute = ctx; return controls.execute(ctx) as never; } };
    const store = { ...core.store, resolveRef(selector: Parameters<typeof core.store.resolveRef>[0]) { calls.resolveRef++; return core.store.resolveRef(selector); } };
    const input = { ...context, policy: {
        project: (ctx: Parameters<typeof controls.project>[0]) => { calls.project++; return controls.project(ctx) as never; },
        authorize: (ctx: InvocationContext) => { calls.authorize++; seen.authorize = ctx; return controls.authorize(ctx) as never; },
        canReadReceipt: (metadata: ReceiptMetadata, signal: CancellationSignal) => { calls.read++; seen.metadata = metadata; seen.readSignal = signal; return controls.read(metadata, signal) as never; },
    }, execution: { resolve: () => { calls.resolve++; return current; } } };
    const authority = createAppInteraction(store, { ...input, namespace: options.namespace ?? 'instance-test', now,
        limits: options.limits, observationLimits: options.observationLimits });
    function open() { return authority; }
    async function observe(client: InstanceInteraction) {
        const viewed = await client.observe({ viewIds: ['v0', 'v1'] }); expect(viewed.status).toBe('observed');
        if (viewed.status !== 'observed') throw new Error(viewed.issue.code);
        expect(client.adoptObservation(viewed.observation.observationId)).toEqual({ status: 'adopted' }); return viewed.observation;
    }
    function request(viewed: Observation, id = 'invocation', input: Readonly<Record<string, JsonValue>> = mode === 'view-type-parameters-v1' ? { file: 'v0.visible', line: '7' } : {}): AppInvocation {
        return { invocationId: id, observationId: viewed.observationId, bindingId: viewed.bindings[0]!.bindingId, input };
    }
    function zero() {
        authority.close(); expect(authority.inspect()).toMatchObject({ receiptEntries: 0, receiptContents: 0,
            activeInvocations: 0, activeReads: 0, invocationBytes: 0, combinedBytes: 0 });
        expect(core.store.inspect().activeLeases).toBe(0);
    }
    return { authority, core, tools, owners, source, refs, publish, calls, seen, controls, store, input, open, observe, request, grant, now,
        setTime: (value: number) => { time = value; }, setClockError: (value: boolean) => { clockThrows = value; }, get clockMessageReads() { return clockMessageReads; },
        get binding() { return current; }, set binding(value: ExecutionBinding | null) { current = value; }, rebindTool, remountAll, zero };
}

describe('B2-T01/T02: real instance publication and trusted assembly', () => {
    it('executes an ordinary mutation without an entity Ref and retains invocation deduplication', async () => {
        const f = fixture({  }), client = f.open(), observed = await f.observe(client);
        let value = 0;
        f.controls.execute = ctx => {
            expect(ctx.source.tool).not.toHaveProperty('isMutating'); expect(ctx.source).not.toHaveProperty('resource');
            value++; return success({ value });
        };
        const request = f.request(observed, 'mutate');
        expect(receipt(await client.invoke(request)).outcome).toMatchObject({ status: 'succeeded', value: { success: true, data: { value: { value: 1 } } } });
        expect(receipt(await client.invoke(request)).outcome).toMatchObject({ status: 'succeeded', value: { success: true, data: { value: { value: 1 } } } });
        expect(value).toBe(1); expect(f.calls.handler).toBe(1); f.zero();
    });
    it('keeps Tool revocation after an await for ordinary mutations', async () => {
        const f = fixture({  }), client = f.open(), observed = await f.observe(client);
        const gate = deferred<unknown>(), started = deferred<void>();
        f.controls.authorize = () => { started.resolve(); return gate.promise; };
        const pending = client.invoke(f.request(observed, 'stopped-mutation'));
        await started.promise; f.rebindTool(); f.publish(); gate.resolve(true);
        expect(receipt(await pending).outcome.status).toBe('rejected'); expect(f.calls.handler).toBe(0); f.zero();
    });
    it('runs the ordinary closed loop and isolates observations across App instances', async () => {
        const f = fixture(), g = fixture({ namespace: 'other-instance' }), a = f.open(), b = g.open(), observed = await f.observe(a);
        expect(Object.isFrozen(a)).toBe(true);
        expect(JSON.stringify(observed)).not.toMatch(/payload-secret|content-secret|hidden/);
        const response = receipt(await a.invoke(f.request(observed)));
        expect(response).toMatchObject({ executionPhase: 'entered-returned', outcome: { status: 'succeeded' }, source: { snapshotId: f.source.id } });
        expect(f.calls.handler).toBe(1);
        expect(await b.invoke(f.request(observed))).toMatchObject({ kind: 'refused', code: 'OBSERVATION_UNAVAILABLE' });
        expect(g.calls.handler).toBe(0);
        expect(Object.keys(f.seen.metadata!).sort()).toEqual(['appId', 'bindingId', 'instanceId', 'invocationId', 'observationId', 'source']); f.zero(); g.zero();
    });
    it.each(['actor', 'mode', 'source', 'effects', 'tasks'])('refuses caller-selected %s before any business callback', async key => {
        const f = fixture(), client = f.open(), observation = await f.observe(client), before = { ...f.calls };
        expect(await client.invoke({ ...f.request(observation), [key]: 'forged' })).toMatchObject({ kind: 'refused', code: 'INVOCATION_INVALID' });
        expect(f.calls).toEqual(before); expect(f.authority.inspect().receiptEntries).toBe(0); f.zero();
    });
    it('captures trusted function references and refuses getters without calling them', async () => {
        const f = fixture(); let reads = 0;
        const invalid = { ...f.input, namespace: 'invalid', now: f.now, get policy() { reads++; throw new Error('secret'); } };
        expect(() => createAppInteraction(f.store, invalid)).toThrow('Invalid App interaction configuration'); expect(reads).toBe(0);
        const client = f.open(); f.input.policy.authorize = () => { throw new Error('replacement must not be called'); };
        const observation = await f.observe(client); expect(receipt(await client.invoke(f.request(observation))).outcome.status).toBe('succeeded'); f.zero();
    });
    it('retains B1 project reservations until a cancelled real policy Promise settles', async () => {
        const f = fixture(), client = f.open(), gate = deferred<ObservationGrant>(), started = deferred<void>();
        f.controls.project = () => { started.resolve(); return gate.promise; };
        const observed = client.observe({ viewIds: ['v0'] }); await started.promise; client.close();
        expect(f.authority.inspect()).toMatchObject({ observations: { reservations: 1, cancelledReservations: 1 } });
        expect((await client.observe({ all: true })).status).toBe('rejected');
        gate.resolve(f.grant()); expect((await observed).status).toBe('rejected'); expect(f.authority.inspect().combinedBytes).toBe(0); f.zero();
    });
    it('detaches original selection and invocation input before caller mutation', async () => {
        const f = fixture(), client = f.open(), selection = { viewIds: ['v0'] }, gate = deferred<ObservationGrant>(), started = deferred<void>();
        f.controls.project = ctx => { expect(ctx.selection.viewIds).toEqual(['v0']); started.resolve(); return gate.promise; };
        const pending = client.observe(selection); selection.viewIds[0] = 'v1'; await started.promise; gate.resolve(f.grant(f.source, ['v0']));
        const result = await pending; expect(result.status).toBe('observed'); if (result.status !== 'observed') return;
        expect(client.adoptObservation(result.observation.observationId)).toEqual({ status: 'adopted' });
        const request = { ...f.request(result.observation), input: { value: 'captured' } }, invoked = client.invoke(request);
        request.input.value = 'mutated'; receipt(await invoked); expect(f.seen.execute!.rawInput.value).toBe('captured'); f.zero();
    });
});

describe('B2-T11: cancellation and actual settlement', () => {
    it.each(['validate', 'authorize', 'execute', 'read'] as const)('retains closing instance resources until ignored cancellation of %s settles', async stage => {
        const f = fixture();
        const client = f.open(), observation = await f.observe(client), gate = deferred<unknown>(), started = deferred<void>();
        if (stage === 'validate') f.controls.validate = (_, input) => { started.resolve(); return gate.promise.then(() => ({ ok: true, value: input })); };
        if (stage === 'authorize') f.controls.authorize = () => { started.resolve(); return gate.promise; };
        if (stage === 'execute') f.controls.execute = () => { started.resolve(); return gate.promise; };
        if (stage === 'read') f.controls.read = () => { started.resolve(); return gate.promise; };
        const pending = client.invoke(f.request(observation));
        await started.promise; client.close();
        expect(f.authority.inspect()).toMatchObject({ observations: { observations: 0 } });
        expect((await client.observe({ all: true })).status).toBe('rejected'); expect(f.authority.inspect().workBytes).toBeGreaterThan(0);
        if (stage === 'validate') expect(f.seen.validateSignal!.aborted).toBe(true);
        if (stage === 'authorize') expect(f.seen.authorize!.signal.aborted).toBe(true);
        if (stage === 'execute') expect(f.seen.execute!.signal.aborted).toBe(true);
        if (stage === 'read') expect(f.seen.readSignal!.aborted).toBe(true);
        gate.resolve(stage === 'execute' ? success() : true);
        expect(code(await pending)).toBe('APP_INTERACTION_UNAVAILABLE'); expect(f.authority.inspect().combinedBytes).toBe(0); f.zero();
    });
    it('releases an observation while retaining the source of actual dispatched work', async () => {
        const f = fixture({ store: { historyTtlMs: 10, leaseTtlMs: 10 } }), client = f.open(), observation = await f.observe(client),
            gate = deferred<unknown>(), started = deferred<void>();
        f.controls.execute = () => { started.resolve(); return gate.promise; };
        const request = f.request(observation), pending = client.invoke(request); await started.promise;
        const charged = f.authority.inspect().sourceBytes;
        client.releaseObservation(observation.observationId);
        f.publish({ refs: f.refs({ version: 'S2' }) }); f.setTime(10);
        expect(f.core.store.inspect().activeLeases).toBe(1);
        expect(f.authority.inspect().sourceBytes).toBe(charged);
        expect(f.seen.execute!.signal.aborted).toBe(false);
        gate.resolve(success()); expect(receipt(await pending).outcome.status).toBe('succeeded');
        expect(receipt(await client.readReceipt(request)).outcome.status).toBe('succeeded');
        expect(f.core.store.inspect().activeLeases).toBe(0); expect(f.authority.inspect().sourceBytes).toBe(0); f.zero();
    });
    it.each(['validate', 'execute'] as const)('settles %s work during a bad completion clock without inventing a receipt time or replaying it', async stage => {
        const f = fixture(); f.setTime(10); const client = f.open(), observation = await f.observe(client), gate = deferred<unknown>(), started = deferred<void>();
        if (stage === 'validate') f.controls.validate = (_, input) => { started.resolve(); return gate.promise.then(() => ({ ok: true, value: input })); };
        else f.controls.execute = () => { started.resolve(); return gate.promise; };
        const pending = client.invoke(f.request(observation)); await started.promise; f.setTime(9); gate.resolve(stage === 'execute' ? success() : true);
        expect(code(await pending)).toBe('RESULT_UNAVAILABLE'); expect(f.authority.inspect()).toMatchObject({ activeInvocations: 0, activeReads: 0, workBytes: 0, resultBytes: 0, sourceBytes: 0, receiptEntries: 1 });
        expect(code(await client.invoke(f.request(observation)))).toBe('RESULT_UNAVAILABLE');
        f.setTime(10); expect(code(await client.invoke(f.request(observation)))).toBe('RESULT_UNAVAILABLE');
        expect(f.calls.handler).toBe(stage === 'execute' ? 1 : 0); f.zero();
    });
});

describe('B2-T03/T04/T05: deduplication and ordinary/Ref parameter paths', () => {
    it('synchronously reserves before callback reentry, reuses execution and checks each read independently', async () => {
        const f = fixture(), client = f.open(), observation = await f.observe(client), request = f.request(observation);
        let reentered: ReturnType<InstanceInteraction['invoke']> | undefined;
        f.controls.validate = (_, input) => { reentered = client.invoke(request); return { ok: true, value: input }; };
        const first = client.invoke(request), concurrent = client.invoke(structuredClone(request));
        expect(receipt(await first).outcome.status).toBe('succeeded'); receipt(await concurrent); receipt(await reentered!); receipt(await client.invoke(request));
        expect(f.calls.handler).toBe(1); expect(f.calls.validate).toBe(1); expect(f.calls.authorize).toBe(1); expect(f.calls.read).toBe(4);
        expect(await client.invoke({ ...request, input: { changed: true } })).toMatchObject({ kind: 'refused', code: 'INVOCATION_ID_CONFLICT' }); f.zero();
    });
    it('preserves ordinary transformation and shares the exact frozen effective object with authorization/execute', async () => {
        const f = fixture(), client = f.open(), observed = await f.observe(client);
        f.controls.validate = () => ({ ok: true, value: { line: 7, defaulted: true } });
        receipt(await client.invoke(f.request(observed, 'ordinary', { line: '7', surplus: true })));
        expect(f.seen.execute!.effectiveInput).toEqual({ line: 7, defaulted: true });
        expect(f.seen.execute!.rawInput).toEqual({ line: '7', surplus: true });
        expect(f.seen.authorize!.effectiveInput).toBe(f.seen.execute!.effectiveInput); expect(Object.isFrozen(f.seen.execute!.effectiveInput)).toBe(true); f.zero();
    });
    it('prepares a legal 6000+ node Ref without the old M5 whole-request cap or ordinary conversion', async () => {
        const f = fixture({ mode: 'view-type-parameters-v1' }), client = f.open(), observed = await f.observe(client);
        const raw = { file: 'v0.visible', line: '7', surplus: true, nodes: Array(6000).fill(null) };
        const result = receipt(await client.invoke(f.request(observed, 'ref', raw)));
        expect(result.outcome.status).toBe('succeeded'); expect(f.seen.execute!.effectiveInput).toMatchObject({ file: { version: 'S1' }, line: '7', surplus: true });
        expect(f.seen.execute!.effectiveInput).toBe(f.seen.validateInput); expect(f.seen.execute!.rawInput.file).toBe('v0.visible');
        expect(f.seen.execute!.refSources[0]).toMatchObject({ snapshotId: f.source.id, viewId: 'v0', refId: 'visible' }); f.zero();
    });
    it('rejects Ref validators that transform values and never calls authorize/execute', async () => {
        const f = fixture({ mode: 'view-type-parameters-v1' }), client = f.open(), observation = await f.observe(client);
        f.controls.validate = (_, input) => ({ ok: true, value: { ...input, line: 7 } });
        expect(receipt(await client.invoke(f.request(observation))).outcome).toMatchObject({ status: 'rejected', code: 'REF_ARGUMENT_CHANGED' });
        expect(f.calls.authorize).toBe(0); expect(f.calls.handler).toBe(0); f.zero();
    });
    it('rejects invisible same-owner Ref before any Store.resolveRef/validation/authorization', async () => {
        const f = fixture({ mode: 'view-type-parameters-v1' }), client = f.open(), observation = await f.observe(client);
        expect(receipt(await client.invoke(f.request(observation, 'hidden', { file: 'v0.hidden' }))).outcome).toMatchObject({ code: 'REF_NOT_VISIBLE' });
        expect(f.calls.resolveRef).toBe(0); expect(f.calls.validate).toBe(0); expect(f.calls.authorize).toBe(0); expect(f.calls.handler).toBe(0); f.zero();
    });
    it('keeps Ref type and mixed root selector restrictions', async () => {
        const f = fixture({ mode: 'view-type-parameters-v1', refType: 'Other' }), client = f.open(), observation = await f.observe(client);
        expect(receipt(await client.invoke(f.request(observation))).outcome).toMatchObject({ code: 'REF_TYPE_MISMATCH', message: expect.stringMatching(/file.*File.*Other.*view_id\.ref_id/) });
        expect(await client.invoke({ ...f.request(observation, 'mixed'), refId: 'visible' } as any)).toMatchObject({ kind: 'refused', code: 'INVOCATION_INVALID' });
        expect(f.calls.handler).toBe(0); f.zero();
    });
});

describe('B2-T06: post-await original source and callable revalidation', () => {
    it('invokes the same observed Binding after a long model turn while reading the exact original Ref', async () => {
        const f = fixture({ mode: 'view-type-parameters-v1', store: { historyTtlMs: 10, leaseTtlMs: 10 } }), client = f.open();
        const observed = await client.observe({ all: true });
        expect(observed.status).toBe('observed'); if (observed.status !== 'observed') return;
        expect(observed.observation.expiresAt).toBeNull();
        expect(client.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
        f.publish({ refs: f.refs({ version: 'S2' }) }); f.setTime(1_000_000);
        const request = f.request(observed.observation), result = receipt(await client.invoke(request));
        expect(result.outcome.status).toBe('succeeded');
        expect(f.seen.execute!.effectiveInput.file).toEqual({ version: 'S1' });
        expect(f.calls.authorize).toBe(1); expect(f.calls.handler).toBe(1);
        expect(receipt(await client.invoke(request))).toEqual(result); expect(f.calls.handler).toBe(1);
        f.rebindTool(); f.publish();
        expect(receipt(await client.invoke(f.request(observed.observation, 'disabled'))).outcome.status).toBe('rejected');
        expect(f.calls.handler).toBe(1); f.zero();
    });
    it('keeps an original source through long authorization without expiring ownership or bypassing current permission', async () => {
        const f = fixture({ mode: 'view-type-parameters-v1', store: { historyTtlMs: 10, leaseTtlMs: 10 } });
        const client = f.open(), observation = await f.observe(client), gate = deferred<boolean>(), started = deferred<void>();
        f.controls.authorize = () => { started.resolve(); return gate.promise; };
        const pending = client.invoke(f.request(observation)); await started.promise;
        f.publish({ refs: f.refs({ version: 'S2' }) }); f.setTime(1_000_000);
        expect(f.core.store.inspect().activeLeases).toBe(2);
        expect(f.seen.authorize!.signal.aborted).toBe(false);
        gate.resolve(false);
        expect(receipt(await pending).outcome).toMatchObject({ status: 'rejected', code: 'TOOL_PERMISSION_DENIED' });
        expect(f.calls.handler).toBe(0); expect(f.core.store.inspect().activeLeases).toBe(1); f.zero();
    });
    it('publishes an empty semantic projection through all after the App removes its Views', async () => {
        const f = fixture(), client = f.open();
        for (const owner of f.owners) f.tools.unmount(owner.viewInstanceId);
        f.publish({ views: [], refs: {}, tools: {} });
        expect(await client.observe({ all: true })).toMatchObject({ status: 'observed',
            observation: { views: [], refs: [], tools: [], bindings: [] } });
        expect(f.calls.project).toBe(1); expect(f.calls.handler).toBe(0); f.zero();
    });
    it.each(['validate', 'authorize'] as const)('uses the original Ref snapshot after %s is suspended', async stage => {
        const f = fixture({ mode: 'view-type-parameters-v1' }), client = f.open(), observation = await f.observe(client), gate = deferred<unknown>(), started = deferred<void>();
        if (stage === 'validate') f.controls.validate = (_, input) => { started.resolve(); return gate.promise.then(() => ({ ok: true, value: input })); };
        else f.controls.authorize = () => { started.resolve(); return gate.promise; };
        const pending = client.invoke(f.request(observation)); await started.promise; f.publish({ refs: f.refs({ version: 'S2' }) }); gate.resolve(true);
        expect(receipt(await pending).outcome.status).toBe('succeeded'); expect(f.seen.execute!.effectiveInput.file).toEqual({ version: 'S1' }); f.zero();
    });
    it.each(['release', 'disable', 'remount', 'schema', 'identity', 'function', 'live', 'null', 'getter'] as const)('blocks %s after validation without entering business', async change => {
        const f = fixture(), client = f.open(), observation = await f.observe(client), gate = deferred<unknown>(), started = deferred<void>();
        f.controls.validate = (_, input) => { started.resolve(); return gate.promise.then(() => ({ ok: true, value: input })); };
        const pending = client.invoke(f.request(observation)); await started.promise;
        if (change === 'release') client.releaseObservation(observation.observationId);
        else if (change === 'disable') { f.rebindTool(); f.publish(); }
        else if (change === 'remount') { f.remountAll(); f.publish();
        } else if (change === 'schema') {
            const tool = Object.values(f.source.tools)[0]!;
            const changed = compileOrdinaryParams({ x: { type: 'string' } }); if (!changed.ok) throw new Error('Changed Tool schema must compile');
            f.publish({ tools: { [tool.id]: { ...tool, inputSchema: ordinaryParameterProfile(changed.contract) } } });
        } else if (change === 'identity') f.binding = { ...f.binding!, identity: {} };
        else if (change === 'function') f.binding = { ...f.binding!, execute: () => success('must-not-run') };
        else if (change === 'live') f.controls.live = () => ({ ok: false });
        else if (change === 'null') f.binding = null;
        else if (change === 'getter') f.binding = { ...f.binding!, get execute() { throw new Error('secret'); } };
        gate.resolve(true); expect(receipt(await pending).outcome.status).toBe('rejected'); expect(f.calls.handler).toBe(0); f.zero();
    });
    it.each((['ordinary-v2', 'view-type-parameters-v1'] as const).flatMap(mode =>
        (['allow', 'deny', 'rebind', 'adopt'] as const).map(action => ({ mode, action }))))(
        'preserves the final authorization boundary for $mode after $action', async ({ mode, action }) => {
            const f = fixture({ mode }), client = f.open(), observation = await f.observe(client);
            const started = deferred<void>(), gate = deferred<boolean>();
            f.controls.authorize = () => { started.resolve(); return gate.promise; };
            const pending = client.invoke(f.request(observation)); await started.promise;
            expect(f.calls.handler).toBe(0);
            if (action === 'rebind') { f.rebindTool(); f.publish(); }
            if (action === 'adopt') await f.observe(client);
            gate.resolve(action !== 'deny');
            const result = receipt(await pending);
            expect(result.outcome.status).toBe(action === 'allow' ? 'succeeded' : 'rejected');
            if (action === 'deny') expect(result.outcome).toMatchObject({ code: 'TOOL_PERMISSION_DENIED' });
            expect(f.calls.authorize).toBe(1); expect(f.calls.handler).toBe(action === 'allow' ? 1 : 0);
            f.zero();
        });
});

describe('B2-T07/T08/T09: phases, current reading and deletable results', () => {
    it.each([false, true] as const)('never turns entered business false into success; effect proof=%s', async effects => {
        const f = fixture(), client = f.open(), observation = await f.observe(client);
        f.controls.execute = () => ({ kind: 'tool-result', phase: 'entered-returned', result: { success: false, error: { code: 'E_INVALID_ARGS', message: 'Business declined' } }, ...(effects ? { failureEffects: 'none' } : {}) });
        const result = receipt(await client.invoke(f.request(observation)));
        expect(result.executionPhase).toBe('entered-returned'); expect(result.outcome.status).toBe(effects ? 'failed' : 'unknown');
        expect(result.outcome).toHaveProperty('details.result.error.code', 'E_INVALID_ARGS'); f.zero();
    });
    it.each(['validator-throw', 'validator-getter', 'validator-false', 'live-getter', 'authorize-throw', 'authorize-false', 'execute-throw', 'execute-getter', 'execute-oversize'] as const)('classifies %s by the actual boundary and keeps exception text private', async mode => {
        const f = fixture(), client = f.open(), observation = await f.observe(client); let reads = 0;
        const exception = { get message() { reads++; return 'secret-marker'; }, toString() { reads++; return 'secret-marker'; } };
        if (mode === 'validator-throw') f.controls.validate = () => { throw exception; };
        if (mode === 'validator-getter') f.controls.validate = () => ({ get ok() { reads++; throw exception; } });
        if (mode === 'validator-false') f.controls.validate = () => ({ ok: false });
        if (mode === 'live-getter') f.controls.live = () => ({ get ok() { reads++; throw exception; } });
        if (mode === 'authorize-throw') f.controls.authorize = () => { throw exception; };
        if (mode === 'authorize-false') f.controls.authorize = () => 'true';
        if (mode === 'execute-throw') f.controls.execute = () => { throw exception; };
        if (mode === 'execute-getter') f.controls.execute = () => ({ get kind() { reads++; throw exception; } });
        if (mode === 'execute-oversize') f.controls.execute = () => success('\u0000'.repeat(100000));
        const result = receipt(await client.invoke(f.request(observation))), entered = mode.startsWith('execute');
        expect(result.executionPhase).toBe(entered ? 'unknown' : 'not-dispatched'); expect(result.outcome.status).toBe(entered ? 'unknown' : 'rejected');
        expect(f.calls.handler).toBe(entered ? 1 : 0); expect(reads).toBe(0); expect(JSON.stringify(result)).not.toContain('secret-marker'); f.zero();
    });
    it('checks first and duplicate result reads every time and keeps the original result across denied/failed reads', async () => {
        const f = fixture(), client = f.open(), observation = await f.observe(client), request = f.request(observation);
        f.controls.read = () => false;
        expect(code(await client.invoke(request))).toBe('RECEIPT_PERMISSION_DENIED'); expect(f.calls.handler).toBe(1);
        f.controls.read = () => { throw new Error('secret'); }; expect(code(await client.invoke(f.request(observation)))).toBe('RECEIPT_READ_FAILED');
        f.controls.read = () => true; receipt(await client.invoke(request)); receipt(await client.invoke(f.request(observation)));
        expect(f.calls.read).toBe(4); expect(f.calls.handler).toBe(1); f.zero();
    });
    it('reads settled results after releasing Observation and expiring the original history', async () => {
        const f = fixture({ store: { historyTtlMs: 10 } }), client = f.open(), observation = await f.observe(client), request = f.request(observation);
        receipt(await client.invoke(request)); client.releaseObservation(observation.observationId);
        f.publish({ refs: f.refs({ version: 'S2' }) }); f.setTime(10);
        expect(f.core.store.acquire(f.source.id).status).toBe('rejected'); receipt(await client.invoke(request)); receipt(await client.invoke(f.request(observation)));
        expect(f.calls.handler).toBe(1); f.zero();
    });
    it('expires content at the exact deadline but retains complete fingerprint responsibility', async () => {
        const f = fixture({ limits: { receiptTtlMs: 10, maxReceiptsPerObservation: 1 } }), client = f.open(), observation = await f.observe(client), request = f.request(observation);
        const first = receipt(await client.invoke(request)); expect(first.expiresAt).toBe(10); const before = f.authority.inspect();
        f.setTime(9); receipt(await client.invoke(request)); f.setTime(10);
        expect(code(await client.invoke(f.request(observation)))).toBe('RESULT_EXPIRED'); expect(code(await client.invoke(request))).toBe('RESULT_EXPIRED');
        expect(f.authority.inspect()).toMatchObject({ receiptEntries: 1, receiptContents: 0, resultBytes: 0, fingerprintBytes: before.fingerprintBytes, sourceBytes: 0 });
        expect(await client.invoke(f.request(observation, 'another'))).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
        expect(f.calls.handler).toBe(1); f.zero();
    });
    it('rechecks close and expiry after a suspended read policy and retains read charges until settlement', async () => {
        const f = fixture(), client = f.open(), observation = await f.observe(client), gate = deferred<boolean>(), started = deferred<void>();
        receipt(await client.invoke(f.request(observation)));
        f.controls.read = () => { started.resolve(); return gate.promise; };
        const pending = client.invoke(f.request(observation)); await started.promise; client.close();
        expect(f.authority.inspect()).toMatchObject({ activeReads: 1, receiptContents: 0 });
        expect((await client.observe({ all: true })).status).toBe('rejected'); gate.resolve(true);
        expect(code(await pending)).toBe('APP_INTERACTION_UNAVAILABLE'); f.zero();
    });
});

describe('B2-T01/T11 additional revocation and completion faults', () => {
    it.each(['stop', 'restart'] as const)('revokes settled interactions on %s with no double refund or revival', async mode => {
        const f = fixture(), client = f.open(), observation = await f.observe(client);
        receipt(await client.invoke(f.request(observation)));
        f.core.lifecycle.stopApp('app', 'run');
        if (mode === 'restart') { f.core.lifecycle.startApp('app', 'run-2'); f.publish({ instanceId: 'run-2' }); }
        expect(code(await client.invoke(f.request(observation)))).toBe('APP_INTERACTION_UNAVAILABLE');
        expect(f.authority.inspect()).toMatchObject({ receiptEntries: 0, invocationBytes: 0, combinedBytes: 0 }); f.zero();
    });
    it('keeps settled reading separate from temporary degraded source availability', async () => {
        const f = fixture(), client = f.open(), observation = await f.observe(client);
        receipt(await client.invoke(f.request(observation)));
        expect(f.core.committer.accept({ schemaVersion: 3, ...context, producerSeq: 20, sourceEpoch: 20, capturedAt: 0,
            views: f.source.views, refs: { malformed: null }, tools: f.source.tools }).status).toBe('rejected');
        expect(f.core.store.readLatest('app').status).toBe('degraded');
        receipt(await client.invoke(f.request(observation))); expect((await client.observe({ viewIds: ['v0'] })).status).toBe('rejected'); f.zero();
    });
    it('settles a dispatched call while now throws without reading its exception or retaining active fees', async () => {
        const f = fixture(), client = f.open(), observation = await f.observe(client), started = deferred<void>(), gate = deferred<unknown>();
        f.controls.execute = () => { started.resolve(); return gate.promise; };
        const pending = client.invoke(f.request(observation)); await started.promise; f.setClockError(true); gate.resolve(success());
        expect(code(await pending)).toBe('RESULT_UNAVAILABLE'); expect(code(await client.invoke(f.request(observation)))).toBe('RESULT_UNAVAILABLE');
        expect(f.authority.inspect()).toMatchObject({ activeInvocations: 0, activeReads: 0, sourceBytes: 0, workBytes: 0, resultBytes: 0, receiptEntries: 1 });
        expect(f.clockMessageReads).toBe(0); f.setClockError(false);
        expect(code(await client.invoke(f.request(observation)))).toBe('RESULT_UNAVAILABLE'); expect(f.calls.handler).toBe(1); f.zero();
    });
    it('refuses an invalid admission clock before claiming any ID or running callbacks', async () => {
        const f = fixture(); f.setTime(10); const client = f.open(), observation = await f.observe(client); f.setTime(9);
        expect(await client.invoke(f.request(observation))).toMatchObject({ kind: 'refused', code: 'OBSERVATION_INTERNAL_ERROR' });
        expect(f.authority.inspect()).toMatchObject({ receiptEntries: 0, invocationBytes: 0 }); expect(f.calls.validate).toBe(0);
        f.setTime(10); f.zero();
    });
});

describe('B2-T12: individual counters and transactional byte responsibility', () => {
    it('checks first-read admission before business and independently limits duplicate/cache reads', async () => {
        const f = fixture({ limits: { maxReads: 1 } }), client = f.open(), observation = await f.observe(client), gate = deferred<boolean>(), started = deferred<void>();
        f.controls.read = () => { started.resolve(); return gate.promise; };
        const pending = client.invoke(f.request(observation)); await started.promise;
        expect(await client.invoke(f.request(observation))).toMatchObject({ kind: 'unavailable', code: 'RECEIPT_READ_CAPACITY' });
        expect(await client.invoke(f.request(observation, 'new'))).toMatchObject({ kind: 'refused', code: 'RECEIPT_READ_CAPACITY' });
        expect(code(await client.invoke(f.request(observation)))).toBe('RECEIPT_READ_CAPACITY');
        expect(f.calls.handler).toBe(1); expect(f.authority.inspect().receiptEntries).toBe(1); gate.resolve(true); receipt(await pending); f.zero();
    });
    it.each(['maxReceiptsPerObservation', 'maxReceipts'] as const)('enforces %s without evicting an original result', async field => {
        const f = fixture({ limits: { [field]: 2 } }), client = f.open(), current = await f.observe(client);
        const one = f.request(current, 'one');
        receipt(await client.invoke(one)); receipt(await client.invoke(f.request(current, 'two')));
        expect(await client.invoke(f.request(current, 'three'))).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
        receipt(await client.readReceipt(one)); expect(f.calls.handler).toBe(2); f.zero();
    });
    it('admits one actual invocation, even while its authorization is pending', async () => {
        const f = fixture(), client = f.open(), current = await f.observe(client);
        const gate = deferred<boolean>(), started = deferred<void>();
        f.controls.authorize = () => { started.resolve(); return gate.promise; };
        const request = f.request(current, 'first'), running = client.invoke(request); await started.promise;
        expect(await client.invoke(f.request(current, 'second'))).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
        expect(f.authority.inspect()).toMatchObject({ activeInvocations: 1, receiptEntries: 1 });
        gate.resolve(true); receipt(await running); receipt(await client.readReceipt(request)); expect(f.calls.handler).toBe(1); f.zero();
    });
    it('bounds independent receipt reads across retained observations', async () => {
        const f = fixture({ limits: { maxReads: 2 } }), client = f.open(), previous = await f.observe(client);
        const old = f.request(previous, 'old'); receipt(await client.invoke(old));
        const current = await f.observe(client), request = f.request(current, 'current'); receipt(await client.invoke(request));
        const gate = deferred<boolean>(), started = deferred<void>(); let running = 0;
        f.controls.read = () => { if (++running === 2) started.resolve(); return gate.promise; };
        const one = client.readReceipt(old), two = client.readReceipt(request); await started.promise;
        expect(code(await client.readReceipt(request))).toBe('RECEIPT_READ_CAPACITY');
        gate.resolve(true); receipt(await one); receipt(await two); f.zero();
    });
    it.each(['maxFingerprintBytes', 'maxMetadataBytes', 'maxWorkBytes', 'maxResultBytes'] as const)('checks %s initial reservation at exact byte boundaries', async field => {
        const probe = fixture(), p = probe.open(), observed = await probe.observe(p), request = probe.request(observed);
        const fingerprintBytes = utf8Size(canonicalJson(request as unknown as JsonValue)); probe.zero();
        const n = field === 'maxFingerprintBytes' ? fingerprintBytes : field === 'maxMetadataBytes' ? HARD.metadata.maxCanonicalBytes
            : field === 'maxWorkBytes' ? 1024 * 1024 + HARD.metadata.maxCanonicalBytes : HARD.receipt.maxCanonicalBytes;
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ limits: { [field]: n + delta } }), client = f.open(), observation = await f.observe(client), result = await client.invoke(f.request(observation));
            if (delta < 0) { expect(result).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' }); expect(f.calls.handler).toBe(0); expect(f.authority.inspect()).toMatchObject({ receiptEntries: 0, invocationBytes: 0 }); }
            else expect(receipt(result).outcome.status).toBe('succeeded'); f.zero();
        }
    });
    it('checks source and total fees independently, atomically rejecting a claimed preflight that cannot acquire its source budget', async () => {
        const probe = fixture(), pc = probe.open(), po = await probe.observe(pc), raw = probe.request(po), sourceBytes = utf8Size(canonicalJson(probe.source as unknown as JsonValue));
        const totalBytes = utf8Size(canonicalJson(raw as unknown as JsonValue)) + 2 * HARD.metadata.maxCanonicalBytes + 1024 * 1024 + HARD.receipt.maxCanonicalBytes + sourceBytes; probe.zero();
        for (const field of ['maxSourceBytes', 'maxTotalBytes'] as const) for (const delta of [-1, 0, 1]) {
            const f = fixture({ limits: { [field]: (field === 'maxSourceBytes' ? sourceBytes : totalBytes) + delta } }), client = f.open(), observation = await f.observe(client);
            const result = receipt(await client.invoke(f.request(observation)));
            expect(result.outcome.status).toBe(delta < 0 ? 'rejected' : 'succeeded'); expect(f.calls.handler).toBe(delta < 0 ? 0 : 1);
            expect(f.authority.inspect()).toMatchObject({ sourceBytes: 0, workBytes: 0, activeInvocations: 0, activeReads: 0, receiptEntries: 1 }); f.zero();
        }
    });
    it('keeps the original invocation source while the next observation is adopted', async () => {
        const f = fixture(), client = f.open(), first = await f.observe(client), gate = deferred<unknown>(), started = deferred<void>();
        f.controls.execute = () => { started.resolve(); return gate.promise; };
        const original = f.request(first, 'one'), running = client.invoke(original); await started.promise;
        const bytes = f.authority.inspect().sourceBytes;
        f.publish({ refs: f.refs({ version: 'S2' }) }); const current = await f.observe(client);
        expect(f.authority.inspect().sourceBytes).toBe(bytes);
        expect(await client.invoke(f.request(current, 'other-source'))).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' });
        gate.resolve(success()); receipt(await running);
        expect(receipt(await client.readReceipt(original)).source?.snapshotId).toBe(f.source.id);
        expect(f.authority.inspect().sourceBytes).toBe(0); expect(f.calls.handler).toBe(1); f.zero();
    });
    it('honors independent Store lease limits without widening them', async () => {
        const f = fixture({ store: { maxActiveLeases: 2 } }), client = f.open(), observation = await f.observe(client);
        expect(receipt(await client.invoke(f.request(observation))).outcome).toMatchObject({ status: 'rejected', code: 'SNAPSHOT_CAPACITY' });
        expect(f.calls.handler).toBe(0); f.zero();
    });
    it('rejects canonical control-character amplification at the new entry without calling business', async () => {
        const f = fixture(), client = f.open(), observation = await f.observe(client);
        expect(await client.invoke(f.request(observation, 'amp', { text: '\u0000'.repeat(24000) }))).toMatchObject({ kind: 'refused', code: 'INVOCATION_INVALID' });
        expect(f.calls.handler).toBe(0); expect(f.authority.inspect().receiptEntries).toBe(0); f.zero();
    });
    it('preserves dedup even when a lowered receipt profile cannot represent a fixed rejection', async () => {
        const f = fixture({ limits: { receipt: { maxCanonicalBytes: 1 }, maxReceiptsPerObservation: 1 } }), client = f.open(), observation = await f.observe(client);
        const raw = { ...f.request(observation), bindingId: 'unknown' };
        expect(code(await client.invoke(raw))).toBe('RESULT_UNAVAILABLE'); expect(code(await client.invoke(raw))).toBe('RESULT_UNAVAILABLE');
        expect(f.authority.inspect()).toMatchObject({ receiptEntries: 1, receiptContents: 0, resultBytes: 0, workBytes: 0, sourceBytes: 0 });
        expect(await client.invoke(f.request(observation, 'another'))).toMatchObject({ kind: 'refused', code: 'INVOCATION_CAPACITY' }); expect(f.calls.handler).toBe(0); f.zero();
    });
    it.each(Object.entries(HARD).flatMap(([key, value]) => typeof value === 'number' ? [[key, value, undefined] as const]
        : Object.entries(value).map(([field, n]) => [key, n, field] as const)))('does not raise or disable the signed %s / %s / %s budget', (key, hard, field) => {
        const f = fixture();
        for (const value of [0, -1, NaN, 1.5, (hard as number) + 1]) expect(() => createAppInteraction(f.store, { ...f.input, namespace: 'bad', now: f.now,
            limits: { [key]: field === undefined ? value : { [field]: value } } })).toThrow('Invalid App interaction configuration'); f.zero();
    });
});

describe('B2-T12: independent depth/node/approximate/canonical profiles', () => {
    type Field = 'maxDepth' | 'maxNodes' | 'maxApproxBytes' | 'maxCanonicalBytes';
    const fields: Field[] = ['maxDepth', 'maxNodes', 'maxApproxBytes', 'maxCanonicalBytes'];
    const sample = { deep: [{ leaf: '汉字\u0000'.repeat(5) }] };
    function measure(value: unknown, field: Field): number {
        if (field === 'maxCanonicalBytes') return utf8Size(canonicalJson(copyJson(value, { maxDepth: 100, maxNodes: 200000, maxApproxBytes: 8 * 1024 * 1024 })));
        let low = 0, high = field === 'maxApproxBytes' ? 8 * 1024 * 1024 : 100000;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            try { copyJson(value, { maxDepth: 100, maxNodes: 200000, maxApproxBytes: 8 * 1024 * 1024, [field]: middle }); high = middle; }
            catch { low = middle + 1; }
        }
        return low;
    }
    it.each(fields)('bounds complete request %s at N-1/N/N+1 before admission', async field => {
        const probe = fixture(), p = probe.open(), po = await probe.observe(p), n = measure(probe.request(po, 'profile', sample), field); probe.zero();
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ limits: { request: { [field]: n + delta } } }), client = f.open(), observed = await f.observe(client), result = await client.invoke(f.request(observed, 'profile', sample));
            if (delta < 0) { expect(result).toMatchObject({ kind: 'refused', code: 'INVOCATION_INVALID' }); expect(f.authority.inspect().receiptEntries).toBe(0); }
            else expect(receipt(result).outcome.status).toBe('succeeded'); expect(f.calls.handler).toBe(delta < 0 ? 0 : 1); f.zero();
        }
    });
    it.each(fields.flatMap(field => ['raw', 'effective'].map(stage => [field, stage] as const)))('bounds ordinary %s at the %s stage', async (field, stage) => {
        const n = measure(sample, field);
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ limits: { ordinaryInput: { [field]: n + delta } } }), client = f.open(), observed = await f.observe(client);
            if (stage === 'effective') f.controls.validate = () => ({ ok: true, value: sample });
            const result = receipt(await client.invoke(f.request(observed, 'profile', stage === 'raw' ? sample : {})));
            expect(result.outcome.status).toBe(delta < 0 ? 'rejected' : 'succeeded');
            if (delta < 0) expect(result.outcome).toMatchObject({ code: 'ACTION_INPUT_INVALID' }); expect(f.calls.handler).toBe(delta < 0 ? 0 : 1); f.zero();
        }
    });
    it.each(fields)('bounds filled metadata %s and never expands beyond its admission reservation', async field => {
        const probe = fixture(), p = probe.open(), po = await probe.observe(p), raw = probe.request(po, 'profile'), got = receipt(await p.invoke(raw));
        const metadata = { ...context, invocationId: raw.invocationId, observationId: raw.observationId, bindingId: raw.bindingId, source: got.source };
        const n = measure(metadata, field); probe.zero();
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ limits: { metadata: { [field]: n + delta } } }), client = f.open(), observation = await f.observe(client), result = receipt(await client.invoke(f.request(observation, 'profile')));
            expect(result.outcome.status).toBe(delta < 0 ? 'rejected' : 'succeeded');
            expect(f.authority.inspect().metadataBytes).toBeLessThanOrEqual(HARD.metadata.maxCanonicalBytes); expect(f.calls.handler).toBe(delta < 0 ? 0 : 1); f.zero();
        }
    });
    it.each(fields)('bounds entered execution fact %s and classifies failed capture as unknown', async field => {
        const n = measure(success(sample), field);
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ limits: { fact: { [field]: n + delta } } }), client = f.open(), observation = await f.observe(client);
            f.controls.execute = () => success(sample); const result = receipt(await client.invoke(f.request(observation)));
            expect(result.outcome.status).toBe(delta < 0 ? 'unknown' : 'succeeded'); expect(result.executionPhase).toBe(delta < 0 ? 'unknown' : 'entered-returned');
            expect(f.calls.handler).toBe(1); f.zero();
        }
    });
    it.each(fields)('bounds complete receipt %s without retaining an oversized special result', async field => {
        const probe = fixture(), p = probe.open(), po = await probe.observe(p); probe.controls.execute = () => success(sample);
        const base = receipt(await p.invoke(probe.request(po))), n = measure(base, field); probe.zero();
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ limits: { receipt: { [field]: n + delta } } }), client = f.open(), observation = await f.observe(client);
            f.controls.execute = () => success(sample); const request = f.request(observation), result = await client.invoke(request);
            if (delta < 0) { expect(code(result)).toBe('RESULT_UNAVAILABLE'); expect(f.authority.inspect()).toMatchObject({ receiptEntries: 1, receiptContents: 0, resultBytes: 0 });
                expect(code(await client.invoke(request))).toBe('RESULT_UNAVAILABLE'); }
            else expect(receipt(result).outcome.status).toBe('succeeded'); expect(f.calls.handler).toBe(1); f.zero();
        }
    });
    it.each(fields)('reuses the bounded B1 source %s profile for B2 reference billing', async field => {
        const probe = fixture(), n = measure(probe.source, field); probe.zero();
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ observationLimits: { source: { [field]: n + delta } } }), client = f.open(), result = await client.observe({ viewIds: ['v0', 'v1'] });
            expect(result.status).toBe(delta < 0 ? 'rejected' : 'observed');
            if (result.status === 'observed') { expect(client.adoptObservation(result.observation.observationId)).toEqual({ status: 'adopted' }); expect(receipt(await client.invoke(f.request(result.observation))).outcome.status).toBe('succeeded'); }
            else expect(f.authority.inspect().receiptEntries).toBe(0); f.zero();
        }
    });

});

describe('B2-Q01: identity replacement before a new projection exists', () => {
    it('rejects stores without required identity capability at construction, preserving the legacy structural type', () => {
        const f = fixture(), { readAppIdentity: _, ...legacy } = f.store;
        expect(() => createAppInteraction(legacy as never, { ...f.input, namespace: 'missing', now: f.now })).toThrow('Invalid observation registry store'); f.zero();
    });
    it.each(['stop-start', 'direct-start'] as const)('revokes an already settled interaction on %s even when the new instance is unready', async how => {
        const f = fixture(), client = f.open(), observation = await f.observe(client);
        receipt(await client.invoke(f.request(observation)));
        if (how === 'stop-start') f.core.lifecycle.stopApp('app', 'run'); f.core.lifecycle.startApp('app', 'run-2');
        expect(f.core.store.readLatest('app')).toEqual({ status: 'unready' });
        expect(code(await client.invoke(f.request(observation)))).toBe('APP_INTERACTION_UNAVAILABLE');
        expect((await client.observe({ viewIds: ['v0'] })).status).toBe('rejected');
        expect(code(await client.invoke(f.request(observation, 'new')))).toBe('APP_INTERACTION_UNAVAILABLE');
        expect(f.calls.handler).toBe(1); expect(f.authority.inspect()).toMatchObject({ receiptEntries: 0, combinedBytes: 0 }); f.zero();
    });
    it.each(['project', 'validate', 'authorize', 'execute', 'read'] as const)('cancels %s on replacement and retains its responsibility until actual settlement', async stage => {
        const f = fixture();
        const client = f.open(), gate = deferred<unknown>(), started = deferred<void>(); let signal: CancellationSignal | undefined;
        if (stage === 'project') {
            f.controls.project = ctx => { signal = ctx.signal; started.resolve(); return gate.promise; };
            const pending = client.observe({ viewIds: ['v0'] }); await started.promise;
            f.core.lifecycle.stopApp('app', 'run'); f.core.lifecycle.startApp('app', 'run-2');
            expect(f.authority.inspect()).toMatchObject({ observations: { reservations: 1, cancelledReservations: 1 } });
            expect(signal!.aborted).toBe(true); gate.resolve(f.grant()); expect((await pending).status).toBe('rejected'); f.zero(); return;
        }
        const observation = await f.observe(client);
        if (stage === 'validate') f.controls.validate = (_, input, s) => { signal = s; started.resolve(); return gate.promise.then(() => ({ ok: true, value: input })); };
        if (stage === 'authorize') f.controls.authorize = ctx => { signal = ctx.signal; started.resolve(); return gate.promise; };
        if (stage === 'execute') f.controls.execute = ctx => { signal = ctx.signal; started.resolve(); return gate.promise; };
        if (stage === 'read') f.controls.read = (_, s) => { signal = s; started.resolve(); return gate.promise; };
        const pending = client.invoke(f.request(observation)); await started.promise;
        f.core.lifecycle.stopApp('app', 'run'); f.core.lifecycle.startApp('app', 'run-2');
        expect(f.authority.inspect().observations.closed).toBe(true); expect(signal!.aborted).toBe(true);
        expect(f.authority.inspect().workBytes).toBeGreaterThan(0);
        expect((await client.observe({ all: true })).status).toBe('rejected');
        gate.resolve(stage === 'execute' ? success() : true);
        expect(code(await pending)).toBe('APP_INTERACTION_UNAVAILABLE');
        expect(f.calls.handler).toBe(stage === 'validate' || stage === 'authorize' ? 0 : 1); f.zero();
    });
    it('revalidates replacement after an already suspended reading policy returns true', async () => {
        const f = fixture(), client = f.open(), observation = await f.observe(client), gate = deferred<boolean>(), started = deferred<void>();
        receipt(await client.invoke(f.request(observation)));
        f.controls.read = () => { started.resolve(); return gate.promise; };
        const pending = client.invoke(f.request(observation)); await started.promise;
        f.core.lifecycle.startApp('app', 'run-2'); gate.resolve(true);
        expect(code(await pending)).toBe('APP_INTERACTION_UNAVAILABLE'); expect(f.calls.handler).toBe(1); f.zero();
    });
    it('allows a new unready instance, ignores stale old stop and works after the new instance publishes', async () => {
        const f = fixture(), old = f.open(), first = await f.observe(old); receipt(await old.invoke(f.request(first)));
        f.core.lifecycle.startApp('app', 'run-2'); expect(code(await old.invoke(f.request(first)))).toBe('APP_INTERACTION_UNAVAILABLE');
        const replacement = createAppInteraction(f.store, { ...f.input, instanceId: 'run-2', namespace: 'replacement', now: f.now });
        expect(code(await replacement.observe({ viewIds: ['v0'] }))).toBe('SNAPSHOT_UNREADY');
        f.core.lifecycle.stopApp('app', 'run'); expect(f.core.store.readAppIdentity('app')).toEqual({ status: 'active', instanceId: 'run-2' });
        const next = createViewOwnedTools('app', 'run-2'), mounted = next.mount('v0', 'File');
        const nextSchema = compileOrdinaryParams({}); if (!nextSchema.ok) throw new Error('Next instance Tool schema must compile');
        next.registerTypeTool({ viewType: 'File', name: 'run', description: 'Synthetic tool', inputSchema: nextSchema.contract.schema }, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: () => async () => ({ phase: 'entered-returned', result: { success: true } }),
        });
        const tool = next.listTools()[0]!;
        f.publish({ instanceId: 'run-2', views: [{ id: 'v0', viewInstanceId: mounted.viewInstanceId, type: 'File', name: 'new', kind: 'state', content: { format: 'markdown-v1', value: 'new' } }],
            refs: {}, tools: { [tool.id]: tool } });
        const observed = await replacement.observe({ viewIds: ['v0'] }); expect(observed.status).toBe('observed'); if (observed.status !== 'observed') return;
        expect(replacement.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
        expect(receipt(await replacement.invoke(f.request(observed.observation, 'new'))).source?.instanceId).toBe('run-2');
        old.close(); replacement.close(); replacement.close(); f.zero();
    });
});


it('refuses an interaction bound to a different or stopped App instance', async () => {
    const f = fixture();
    const wrong = createAppInteraction(f.store, { ...f.input, instanceId: 'wrong-instance', namespace: 'wrong', now: f.now });
    expect(code(await wrong.observe({ all: true }))).toBe('APP_INTERACTION_UNAVAILABLE');
    wrong.close();
    f.core.lifecycle.stopApp('app', 'run');
    expect(code(await f.authority.observe({ all: true }))).toBe('APP_INTERACTION_UNAVAILABLE');
    f.zero();
});
