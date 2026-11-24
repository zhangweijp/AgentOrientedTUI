import { expect, it } from 'vitest';
import { createSnapshotCore, createAppInteraction, createTurnCoordinator, projectCompleteViews } from '../host.js';
import { compileToolParameters, refKey, SNAPSHOT_SCHEMA_VERSION, type AppInvocation, type ObservationCandidate } from '../index.js';

const fixtureJsonSchema = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, { type: 'object' }, { type: 'array', items: {} }] };


type Coordinator = ReturnType<typeof createTurnCoordinator>;
function fixture(coordinator: Coordinator, appId: string, copyReads = false) {
    const instanceId = appId + '-instance';
    const core = createSnapshotCore({ appId, instanceId });
    const toolId = JSON.stringify([appId, 'File', 'update']);
    const contract = compileToolParameters({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });
    if (!contract.ok) throw new Error('Expected fixture schema');
    const toolSchema = contract.contract.schema;
    let sequence = 0;
    function publish(mode: 'open' | 'closed' | 'remount' | 'text' | 'narrow' | 'deactivate' = 'open') {
        const mount = (mode === 'remount' ? 'new-mount-' : 'mount-') + appId;
        const value = mode === 'text' ? appId + ' changed' : appId;
        const open = mode !== 'closed';
        const enabled = open && mode !== 'deactivate';
        expect(core.committer.accept({ appId, instanceId, schemaVersion: SNAPSHOT_SCHEMA_VERSION, sourceEpoch: ++sequence,
            producerSeq: sequence, capturedAt: 0,
            views: open ? [{ id: 'file', name: 'File', type: 'File', region: 'dynamic', viewInstanceId: mount,
                content: { format: 'markdown-v1', value }, toolBindings: enabled ? [{ toolId, activationId: mount + '-activation' }] : [] }] : [],
            refs: open ? { [refKey('file', mount, 'text')]: { valueSchema: fixtureJsonSchema, id: 'text', ownerViewId: 'file', ownerViewInstanceId: mount,
                refType: 'String', scope: mode === 'narrow' ? 'private' : 'public', target: { kind: 'snapshot-value', payload: value } } } : {},
            tools: enabled ? { [toolId]: { id: toolId, name: 'update', viewType: 'File', description: 'Record selected text',
                multiplicity: 'single',  inputSchema: toolSchema } } : {},
        }).status).toBe('published');
    }
    publish();
    const control = { read: () => {}, release: () => {}, dispatch: async () => {}, authorize: (): boolean | Promise<boolean> => true };
    const values: unknown[] = [];
    const store = {
        ...core.store,
        readLatest(id: string) {
            control.read();
            const read = core.store.readLatest(id);
            return copyReads && read.status === 'ready'
                ? Object.freeze({ ...read, snapshot: Object.freeze({ ...read.snapshot }) }) : read;
        },
        acquire(id: string) {
            const result = core.store.acquire(id);
            if (result.status === 'rejected') return result;
            return { ...result, hold: { ...result.hold, release() { result.hold.release(); control.release(); } } };
        },
    };
    const binding = { identity: {}, isLive: () => true, async execute({ effectiveInput }: { effectiveInput: AppInvocation['input'] }) {
        values.push(effectiveInput.text);
        await control.dispatch();
        return { kind: 'tool-result' as const, phase: 'entered-returned' as const, result: { success: true } };
    } };
    const client = createAppInteraction(store, { namespace: appId, now: Date.now, appId, instanceId,
        policy: { project: projectCompleteViews, authorize: () => control.authorize(), canReadReceipt: () => true }, execution: { resolve: () => binding } });
    return { client, control, values, publish, holds: () => core.store.inspect().activeHolds,
        async prepare() {
            const result = await coordinator.prepareObservation(client, () => true);
            if (result.status !== 'prepared') throw new Error(result.issue.code);
            return result.candidate;
        },
        request(candidate: ObservationCandidate, invocationId: string, text = appId) {
            return { observationId: candidate.observation.observationId, invocationId, toolId, input: { text } };
        },
    };
}
const selection = (...candidates: ObservationCandidate[]) => ({ apps: candidates.map(candidate => ({ candidate })) });
function adopted(result: ReturnType<Coordinator['adoptTurn']>) {
    if (result.status !== 'adopted') throw new Error(result.issue.code);
    return result;
}
const succeeded = { kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } };

it.each([false, true])('adopts standalone and request-level observations with copyReads=%s', async copyReads => {
    const coordinator = createTurnCoordinator(), app = fixture(coordinator, 'a', copyReads);
    const observed = await app.client.observe();
    if (observed.status !== 'observed') throw new Error(observed.issue.code);
    const { observationId, tools } = observed.observation;
    expect(app.client.adoptObservation(observationId)).toEqual({ status: 'adopted' });
    const request = { observationId, toolId: tools[0]!.id, invocationId: 'standalone', input: { text: 'once' } };
    const receipt = await app.client.invoke(request);
    expect(receipt).toMatchObject(succeeded);
    app.client.releaseObservation(observationId);
    const candidate = await app.prepare();
    const turn = adopted(coordinator.adoptTurn(selection(candidate))).turn;
    expect(await turn.inspectRef('$ref.a.file.text', 'value')).toEqual({ status: 'ready', value: 'a' });
    expect(await app.client.readReceipt({ observationId, invocationId: request.invocationId })).toEqual(receipt);
    expect(app.values).toEqual(['once']);
    turn.release();
    expect(app.holds()).toBe(0);
});

it('switches the whole set only on success and gives reused candidates to the new turn', async () => {
    const coordinator = createTurnCoordinator();
    const a = fixture(coordinator, 'a'), b = fixture(coordinator, 'b'), c = fixture(coordinator, 'c');
    const [aa, bb, cc] = await Promise.all([a.prepare(), b.prepare(), c.prepare()]);
    const old = adopted(coordinator.adoptTurn(selection(aa, bb, cc))).turn;
    const [nextA, invalidB] = await Promise.all([a.prepare(), b.prepare()]);
    expect(coordinator.adoptTurn(selection(nextA, bb, aa))).toMatchObject({ status: 'rejected', issue: { code: 'TURN_SELECTION_INVALID' } });
    expect(old.isCurrent).toBe(true);
    expect(await old.inspectRef('$ref.c.file.text', 'value')).toEqual({ status: 'ready', value: 'c' });
    invalidB.discard();
    expect(coordinator.adoptTurn(selection(nextA, invalidB))).toMatchObject({ status: 'rejected' });
    expect(old.isCurrent).toBe(true);
    expect(await old.invoke('c', c.request(cc, 'held'))).toMatchObject(succeeded);

    const next = adopted(coordinator.adoptTurn(selection(nextA, bb))).turn;
    expect(old.release()).toEqual([]);
    expect(await old.inspectRef('$ref.b.file.text', 'value')).toMatchObject({ status: 'rejected', issue: { code: 'TURN_NOT_ACTIVE' } });
    expect(await old.invoke('b', b.request(bb, 'late'))).toMatchObject({ kind: 'refused', code: 'TURN_NOT_ACTIVE' });
    expect(await next.invoke('c', c.request(cc, 'omitted'))).toMatchObject({ kind: 'refused' });
    expect(await next.inspectRef('$ref.c.file.text', 'value')).toMatchObject({ status: 'rejected' });
    expect(c.holds()).toBe(0);
    expect(await next.inspectRef('$ref.b.file.text', 'value')).toEqual({ status: 'ready', value: 'b' });
    expect(await next.invoke('b', b.request(bb, 'shared', '$ref.a.file.text'))).toMatchObject(succeeded);
    expect(b.values).toEqual(['a']);
    next.release();
    expect([a.holds(), b.holds(), c.holds()]).toEqual([0, 0, 0]);
});

it.each(['discard', 'close'])('rechecks A after B verification can %s it', async action => {
    const coordinator = createTurnCoordinator(), a = fixture(coordinator, 'a'), b = fixture(coordinator, 'b');
    const [aa, bb] = await Promise.all([a.prepare(), b.prepare()]);
    const old = adopted(coordinator.adoptTurn(selection(aa, bb))).turn;
    const [nextA, nextB] = await Promise.all([a.prepare(), b.prepare()]);
    b.control.read = () => {
        b.control.read = () => {};
        if (action === 'discard') nextA.discard(); else a.client.close();
    };
    expect(coordinator.adoptTurn(selection(nextA, nextB))).toMatchObject({ status: 'rejected' });
    expect(old.isCurrent).toBe(true);
    expect(await old.invoke('b', b.request(bb, 'still-live'))).toMatchObject(succeeded);
    if (action === 'close') expect(await old.inspectRef('$ref.a.file.text', 'value')).toMatchObject({ status: 'rejected' });
    nextB.discard(); old.release();
    expect([a.holds(), b.holds()]).toEqual([0, 0]);
});

const windowChanges = ['closed', 'remount', 'revoke', 'narrow', 'deactivate', 'text'] as const;
const windowCases = windowChanges.flatMap(change => [false, true].map(copyReads => ({ change, copyReads })));
it.each(windowCases)('checks the selected mount when B verification publishes $change (copyReads=$copyReads)', async ({ change, copyReads }) => {
    const coordinator = createTurnCoordinator(), a = fixture(coordinator, 'a', copyReads), b = fixture(coordinator, 'b', copyReads);
    const [firstA, firstB] = await Promise.all([a.prepare(), b.prepare()]);
    const old = adopted(coordinator.adoptTurn(selection(firstA, firstB))).turn;
    const [nextA, nextB] = await Promise.all([a.prepare(), b.prepare()]);
    const verifyOrder: string[] = [];
    a.control.read = () => { verifyOrder.push('a'); };
    b.control.read = () => {
        b.control.read = () => {};
        verifyOrder.push('b');
        if (change === 'revoke')
            expect(coordinator.revokeWindowAccess(old, a.client, { viewId: 'file', viewInstanceId: 'mount-a' })).toBeUndefined();
        else a.publish(change);
    };
    const outcome = coordinator.adoptTurn(selection(nextA, nextB));
    expect(verifyOrder).toEqual(['a', 'b']);
    if (change === 'text') {
        const next = adopted(outcome).turn;
        expect(old.isCurrent).toBe(false);
        expect(await next.inspectRef('$ref.a.file.text', 'value')).toEqual({ status: 'ready', value: 'a' });
        next.release();
    } else {
        expect(outcome).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_WINDOW_CHANGED' } });
        expect(old.isCurrent).toBe(true);
        if (change === 'deactivate') {
            expect(await old.inspectRef('$ref.a.file.text', 'value')).toEqual({ status: 'ready', value: 'a' });
            expect(await old.invoke('a', a.request(firstA, 'cannot-dispatch'))).toMatchObject({ kind: 'receipt', receipt: {
                executionPhase: 'not-dispatched', outcome: { code: 'TOOL_SOURCE_STALE' },
            } });
        } else expect(await old.inspectRef('$ref.a.file.text', 'value')).toMatchObject({ status: 'rejected' });
        expect(await old.inspectRef('$ref.b.file.text', 'value')).toEqual({ status: 'ready', value: 'b' });
        expect(await old.invoke('b', b.request(firstB, 'still-current'))).toMatchObject(succeeded);
        nextA.discard(); nextB.discard(); old.release();
    }
    expect([a.holds(), b.holds()]).toEqual([0, 0]);
});

it('retires every obsolete source when one cleanup throws and keeps a dispatched receipt', async () => {
    const coordinator = createTurnCoordinator();
    const a = fixture(coordinator, 'a'), b = fixture(coordinator, 'b'), c = fixture(coordinator, 'c');
    const [aa, bb, cc] = await Promise.all([a.prepare(), b.prepare(), c.prepare()]);
    const old = adopted(coordinator.adoptTurn(selection(aa, bb, cc))).turn;
    const [nextA, nextB] = await Promise.all([a.prepare(), b.prepare()]);
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const done = new Promise<void>(resolve => { finish = resolve; });
    b.control.dispatch = () => { entered(); return done; };
    const request = b.request(bb, 'in-flight', '$ref.a.file.text');
    const pending = old.invoke('b', request);
    await started;
    a.control.release = () => { a.control.release = () => {}; throw new Error('fixture release failure'); };
    let oldBReleases = 0;
    b.control.release = () => { oldBReleases++; };
    const next = adopted(coordinator.adoptTurn(selection(nextA, nextB)));
    expect(next.cleanupIssues).toEqual([expect.objectContaining({ code: 'OBSERVATION_RELEASE_FAILED' })]);
    expect(oldBReleases).toBe(1);
    expect(c.holds()).toBe(0);
    expect(old.release()).toEqual([]);
    finish();
    const receipt = await pending;
    expect(receipt).toMatchObject(succeeded);
    expect(await b.client.readReceipt({ observationId: request.observationId, invocationId: request.invocationId })).toEqual(receipt);
    expect(b.values).toEqual(['a']);
    next.turn.release();
    expect([a.holds(), b.holds(), c.holds()]).toEqual([0, 0, 0]);
});

it('rejects an old awaiting authorization when its original candidate is reused', async () => {
    const coordinator = createTurnCoordinator(), a = fixture(coordinator, 'a'), b = fixture(coordinator, 'b');
    const [firstA, firstB] = await Promise.all([a.prepare(), b.prepare()]);
    const old = adopted(coordinator.adoptTurn(selection(firstA, firstB))).turn;
    let allow!: (allowed: boolean) => void, started!: () => void;
    const decision = new Promise<boolean>(resolve => { allow = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    b.control.authorize = () => { started(); return decision; };
    const pending = old.invoke('b', b.request(firstB, 'held-by-policy', '$ref.a.file.text'));
    await entered;
    try {
        const nextA = await a.prepare();
        const next = adopted(coordinator.adoptTurn(selection(nextA, firstB))).turn;
        old.release();
        expect(await next.inspectRef('$ref.b.file.text', 'value')).toEqual({ status: 'ready', value: 'b' });
        allow(true);
        expect(await pending).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'not-dispatched',
            outcome: { status: 'rejected', code: 'TURN_NOT_ACTIVE' } } });
        expect(b.values).toEqual([]);
        expect(await next.invoke('b', b.request(firstB, 'current-call', '$ref.a.file.text'))).toMatchObject(succeeded);
        expect(b.values).toEqual(['a']);
        next.release();
        expect([a.holds(), b.holds()]).toEqual([0, 0]);
    } finally { allow(false); coordinator.close(); }
});
