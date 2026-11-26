import { expect, it } from 'vitest';
import { createSnapshotCore, createAppInteraction, createTurnCoordinator, projectCompleteViews } from '../host.js';
import { compileToolParameters, refKey, SNAPSHOT_SCHEMA_VERSION, type AppInvocation, type JsonValue, type ObservationCandidate } from '../index.js';

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

function multiViewFixture(coordinator: Coordinator, appId: string, options: {
    views?: ReadonlyArray<{ id: string; refs: ReadonlyArray<{ id: string; scope?: 'public' | 'protected' | 'private'; payload: JsonValue }> }>;
    refreshProjection?: () => Promise<void>;
} = {}) {
    const instanceId = appId + '-instance';
    const core = createSnapshotCore({ appId, instanceId });
    const toolId = JSON.stringify([appId, 'File', 'edit']);
    const contract = compileToolParameters({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });
    if (!contract.ok) throw new Error('Expected fixture schema');
    const toolSchema = contract.contract.schema;
    let sequence = 0;
    const initialViews = options.views ?? [
        { id: 'v_1', refs: [{ id: 'val', scope: 'public', payload: 30 }] },
        { id: 'v_2', refs: [{ id: 'val', scope: 'public', payload: { 'a.b': [10], nested: { leaf: 'ok' } } }] },
    ];
    let releaseHook = () => {};
    const store = {
        ...core.store,
        acquire(id: string) {
            const result = core.store.acquire(id);
            if (result.status === 'rejected') return result;
            return { ...result, hold: { ...result.hold, release() { result.hold.release(); releaseHook(); } } };
        },
    };
    function publish(nextViews = initialViews, remount = false) {
        const seq = ++sequence;
        const suffix = remount ? '-reopened-' + seq : '';
        expect(core.committer.accept({
            appId, instanceId, schemaVersion: SNAPSHOT_SCHEMA_VERSION, sourceEpoch: seq, producerSeq: seq, capturedAt: 0,
            views: nextViews.map(v => ({
                id: v.id, name: v.id, type: 'File', region: 'dynamic', viewInstanceId: 'mount-' + appId + '-' + v.id + suffix,
                content: { format: 'markdown-v1', value: v.id },
                toolBindings: [{ toolId, activationId: 'act-' + v.id + suffix }],
            })),
            refs: Object.fromEntries(nextViews.flatMap(v => v.refs.map(r => {
                const mount = 'mount-' + appId + '-' + v.id + suffix;
                return [refKey(v.id, mount, r.id), {
                    valueSchema: fixtureJsonSchema, id: r.id, ownerViewId: v.id, ownerViewInstanceId: mount,
                    refType: 'Json', scope: r.scope ?? 'public', target: { kind: 'snapshot-value', payload: r.payload },
                }];
            }))),
            tools: nextViews.length ? {
                [toolId]: { id: toolId, name: 'edit', viewType: 'File', description: 'Edit', multiplicity: 'multiple', inputSchema: toolSchema },
            } : {},
        }).status).toBe('published');
    }
    publish();
    const edits: Array<{ viewId: string; text: unknown }> = [];
    const binding = {
        identity: {}, isLive: () => true,
        async execute({ source, effectiveInput }: { source: { receiver: { viewId: string } }; effectiveInput: AppInvocation['input'] }) {
            edits.push({ viewId: source.receiver.viewId, text: effectiveInput.text });
            return { kind: 'tool-result' as const, phase: 'entered-returned' as const, result: { success: true } };
        },
    };
    const client = createAppInteraction(store, {
        namespace: appId, now: Date.now, appId, instanceId,
        ...(options.refreshProjection ? { refreshProjection: options.refreshProjection } : {}),
        policy: { project: projectCompleteViews, authorize: () => true, canReadReceipt: () => true },
        execution: { resolve: () => binding },
    });
    return {
        client, edits, publish, holds: () => core.store.inspect().activeHolds,
        setReleaseHook(fn: () => void) { releaseHook = fn; },
        async prepare() {
            const result = await coordinator.prepareObservation(client, () => true);
            if (result.status !== 'prepared') throw new Error(result.issue.code);
            return result.candidate;
        },
        request(candidate: ObservationCandidate, invocationId: string, viewId: string, text = 'ok') {
            return { observationId: candidate.observation.observationId, invocationId, toolId, viewId, input: { text } };
        },
    };
}

it('suspends both tool and Ref eligibility for omitted views under activeViews and restores on re-adoption', async () => {
    const coordinator = createTurnCoordinator(), a = multiViewFixture(coordinator, 'a');
    const cand1 = await a.prepare();
    const v1 = { viewId: cand1.observation.views[0]!.id, viewInstanceId: cand1.observation.views[0]!.viewInstanceId };
    const v2 = { viewId: cand1.observation.views[1]!.id, viewInstanceId: cand1.observation.views[1]!.viewInstanceId };

    const turn1 = adopted(coordinator.adoptTurn({ apps: [{ candidate: cand1, windows: { activeViews: [v2] } }] })).turn;
    expect(await turn1.invoke('a', a.request(cand1, 'call-v1', 'v_1'))).toMatchObject({
        kind: 'receipt', receipt: { executionPhase: 'not-dispatched', outcome: { status: 'rejected', code: 'TOOL_UNAVAILABLE' } },
    });
    expect(await turn1.invoke('a', a.request(cand1, 'call-v2', 'v_2', 'body-only'))).toMatchObject(succeeded);
    expect(await turn1.inspectRef('$ref.a.v_1.val', 'value')).toMatchObject({ status: 'rejected', issue: { code: 'REF_NOT_VISIBLE' } });
    expect(await turn1.readPublicRefs(['$ref.a.v_1.val'])).toMatchObject({ status: 'rejected', issue: { code: 'REF_NOT_VISIBLE' } });
    expect(await turn1.readPublicRefs()).toEqual({
        status: 'ready',
        refs: [{ appId: 'a', viewId: 'v_2', refId: 'val', path: [], value: { 'a.b': [10], nested: { leaf: 'ok' } } }],
    });
    expect(a.edits).toEqual([{ viewId: 'v_2', text: 'body-only' }]);

    const cand2 = await a.prepare();
    const turn2 = adopted(coordinator.adoptTurn({ apps: [{ candidate: cand2, windows: { activeViews: [v1, v2] } }] })).turn;
    expect(await turn2.invoke('a', a.request(cand2, 'call-v1-restored', 'v_1', 'restored'))).toMatchObject(succeeded);
    expect(await turn2.readPublicRefs(['$ref.a.v_1.val'])).toEqual({
        status: 'ready',
        refs: [{ appId: 'a', viewId: 'v_1', refId: 'val', path: [], value: 30 }],
    });
    expect(a.edits).toEqual([{ viewId: 'v_2', text: 'body-only' }, { viewId: 'v_1', text: 'restored' }]);
    turn2.release();
    expect(a.holds()).toBe(0);
});

it('rejects sparse/getter apps arrays in adoptTurn without invoking element getters', async () => {
    const coordinator = createTurnCoordinator(), a = fixture(coordinator, 'a');
    const cand = await a.prepare();
    let reads = 0;
    const getterApps: unknown[] = [];
    Object.defineProperty(getterApps, '0', { enumerable: true, get() { reads++; return { candidate: cand }; } });
    expect(coordinator.adoptTurn({ apps: getterApps as never })).toMatchObject({ status: 'rejected', issue: { code: 'TURN_SELECTION_INVALID' } });
    expect(coordinator.adoptTurn({ apps: new Array(1) as never })).toMatchObject({ status: 'rejected', issue: { code: 'TURN_SELECTION_INVALID' } });
    expect(reads).toBe(0);
    cand.discard();
    expect(a.holds()).toBe(0);
});

it('rejects malformed adoptTurn input/selection boundaries without invoking getters and keeps windows: undefined valid', async () => {
    const coordinator = createTurnCoordinator();
    const a = multiViewFixture(coordinator, 'a');
    const b = multiViewFixture(coordinator, 'b', { views: [{ id: 'v_1', refs: [{ id: 'val', scope: 'public', payload: 1 }] }] });
    const [candA, candB] = await Promise.all([a.prepare(), b.prepare()]);

    let getterCalls = 0;
    const getterWindows = Object.defineProperty({ candidate: candA }, 'windows', {
        enumerable: true, get() { getterCalls++; return { activeViews: [] }; },
    });
    const nonEnumWindows = Object.defineProperty({ candidate: candA }, 'windows', {
        enumerable: false, value: { activeViews: [] },
    });
    const symbolSelection = { candidate: candA, [Symbol('extra')]: true };
    const nonPlainSelection = new (class { constructor(readonly candidate: ObservationCandidate) {} })(candA);
    const getterInput = Object.defineProperty({}, 'apps', {
        enumerable: true, get() { getterCalls++; return [{ candidate: candA }]; },
    });
    const nonEnumInput = Object.defineProperty({}, 'apps', {
        enumerable: false, value: [{ candidate: candA }],
    });
    const nonEnumArray: unknown[] = [];
    Object.defineProperty(nonEnumArray, '0', { enumerable: false, value: { candidate: candA } });
    const symbolInput = { apps: [{ candidate: candA }], [Symbol('extra')]: true };
    const nonPlainInput = new (class { constructor(readonly apps: unknown[]) {} })([{ candidate: candA }]);

    const malformedInputs: unknown[] = [
        { apps: [getterWindows] },
        { apps: [nonEnumWindows] },
        { apps: [{ candidate: candA, window: { activeViews: [] } }] },
        { apps: [{ candidate: candA, receiverViews: [] }] },
        { apps: [{ candidate: candA, refViews: [] }] },
        { apps: [symbolSelection] },
        { apps: [nonPlainSelection] },
        { apps: [{ candidate: candA }, getterWindows] },
        { apps: [{ candidate: candA }], extra: true },
        getterInput,
        nonEnumInput,
        { apps: nonEnumArray },
        symbolInput,
        nonPlainInput,
        {},
    ];

    for (const bad of malformedInputs) {
        expect(coordinator.adoptTurn(bad as never)).toMatchObject({ status: 'rejected', issue: { code: 'TURN_SELECTION_INVALID' } });
    }
    expect(getterCalls).toBe(0);
    // Neither candA nor candB was adopted: re-adopting candA with activeViews: [] succeeds (not previously locked to all views).
    const emptyTurn = adopted(coordinator.adoptTurn({ apps: [{ candidate: candA, windows: { activeViews: [] } }] })).turn;
    expect(await emptyTurn.readPublicRefs()).toEqual({ status: 'ready', refs: [] });

    // Malformed adoption while a turn is active leaves the existing turn untouched.
    expect(coordinator.adoptTurn({ apps: [getterWindows as never] })).toMatchObject({
        status: 'rejected', issue: { code: 'TURN_SELECTION_INVALID' },
    });
    expect(getterCalls).toBe(0);
    expect(emptyTurn.isCurrent).toBe(true);
    expect(await emptyTurn.readPublicRefs()).toEqual({ status: 'ready', refs: [] });

    // Explicit own enumerable data property { candidate, windows: undefined } activates all mounted views.
    const candA2 = await a.prepare();
    const allTurn = adopted(coordinator.adoptTurn({ apps: [{ candidate: candA2, windows: undefined }, { candidate: candB }] })).turn;
    expect(await allTurn.invoke('a', a.request(candA2, 'call-v1', 'v_1', 'one'))).toMatchObject(succeeded);
    expect(await allTurn.invoke('a', a.request(candA2, 'call-v2', 'v_2', 'two'))).toMatchObject(succeeded);
    expect(await allTurn.readPublicRefs(['$ref.a.v_1.val', '$ref.b.v_1.val'])).toEqual({
        status: 'ready',
        refs: [
            { appId: 'a', viewId: 'v_1', refId: 'val', path: [], value: 30 },
            { appId: 'b', viewId: 'v_1', refId: 'val', path: [], value: 1 },
        ],
    });
    expect(a.edits).toEqual([{ viewId: 'v_1', text: 'one' }, { viewId: 'v_2', text: 'two' }]);

    allTurn.release();
    expect([a.holds(), b.holds()]).toEqual([0, 0]);
});

it('readPublicRefs handles undefined, [], paths, exact dedup, parent+child without hiding invalid child, and boundary validation', async () => {
    const coordinator = createTurnCoordinator();
    const a = multiViewFixture(coordinator, 'a', {
        views: [
            { id: 'v_1', refs: [
                { id: 'pub', scope: 'public', payload: { 'a.b': [10, 20], nested: { leaf: 'ok' } } },
                { id: 'priv', scope: 'private', payload: 'secret-priv' },
                { id: 'prot', scope: 'protected', payload: 'secret-prot' },
            ] },
        ],
    });
    const cand = await a.prepare();
    const turn = adopted(coordinator.adoptTurn(selection(cand))).turn;

    expect(await turn.readPublicRefs([])).toEqual({ status: 'ready', refs: [] });
    expect(await turn.readPublicRefs()).toEqual({
        status: 'ready',
        refs: [{ appId: 'a', viewId: 'v_1', refId: 'pub', path: [], value: { 'a.b': [10, 20], nested: { leaf: 'ok' } } }],
    });
    expect(await turn.readPublicRefs([
        '$ref.a.v_1.pub',
        '$ref.a.v_1.pub["a.b"][1]',
        '$ref.a.v_1.pub',
        '$ref.a.v_1.pub.nested',
    ])).toEqual({
        status: 'ready',
        refs: [
            { appId: 'a', viewId: 'v_1', refId: 'pub', path: [], value: { 'a.b': [10, 20], nested: { leaf: 'ok' } } },
            { appId: 'a', viewId: 'v_1', refId: 'pub', path: ['a.b', 1], value: 20 },
            { appId: 'a', viewId: 'v_1', refId: 'pub', path: ['nested'], value: { leaf: 'ok' } },
        ],
    });

    // Valid parent path MUST NOT mask invalid child path.
    expect(await turn.readPublicRefs(['$ref.a.v_1.pub', '$ref.a.v_1.pub.missing'])).toMatchObject({
        status: 'rejected', issue: { code: 'REF_NOT_VISIBLE' },
    });

    // Non-array, sparse, getter, non-string, and invalid address syntax checks.
    let getterReads = 0;
    const getterAddresses = [] as unknown as string[];
    Object.defineProperty(getterAddresses, '0', { enumerable: true, get() { getterReads++; return '$ref.a.v_1.pub'; } });
    expect(await turn.readPublicRefs('not-an-array' as never)).toMatchObject({
        status: 'rejected', issue: { code: 'REF_INSPECTION_INVALID' },
    });
    expect(await turn.readPublicRefs(getterAddresses)).toMatchObject({
        status: 'rejected', issue: { code: 'REF_INSPECTION_INVALID', path: '$.addresses[0]' },
    });
    expect(await turn.readPublicRefs(new Array(1) as never)).toMatchObject({
        status: 'rejected', issue: { code: 'REF_INSPECTION_INVALID', path: '$.addresses[0]' },
    });
    expect(await turn.readPublicRefs(['$ref.a.v_1.pub', 'not-a-ref'])).toMatchObject({
        status: 'rejected', issue: { code: 'REF_INSPECTION_INVALID', path: '$.addresses[1]' },
    });
    expect(getterReads).toBe(0);

    turn.release();
    expect(a.holds()).toBe(0);
});

it('readPublicRefs captures the array length once and reports unreadable input as an issue', async () => {
    const coordinator = createTurnCoordinator();
    const a = multiViewFixture(coordinator, 'a');
    const turn = adopted(coordinator.adoptTurn(selection(await a.prepare()))).turn;
    const address = '$ref.a.v_1.val';
    let lengthReads = 0;
    const changingLength = new Proxy(Array<string>(257).fill(address), {
        get(target, key) {
            if (key === 'length' && ++lengthReads === 1) return 256;
            return Reflect.get(target, key);
        },
    });
    const unreadable = new Proxy([address], {
        getOwnPropertyDescriptor(target, key) {
            if (key === '0') throw new Error('unreadable slot');
            return Reflect.getOwnPropertyDescriptor(target, key);
        },
    });
    try {
        expect(await turn.readPublicRefs(changingLength)).toMatchObject({
            status: 'rejected', issue: { code: 'REF_READ_CAPACITY' },
        });
        expect(lengthReads).toBe(0);
        expect(await turn.readPublicRefs(unreadable)).toMatchObject({
            status: 'rejected', issue: { code: 'REF_INSPECTION_INVALID', path: '$.addresses[0]' },
        });
        expect(a.holds()).toBe(1);
    } finally { turn.release(); }
});

it('readPublicRefs preserves snapshot isolation (30 vs background 35) and rejects whole batch if any ref turns private or closes', async () => {
    const coordinator = createTurnCoordinator();
    const a = multiViewFixture(coordinator, 'a', { views: [{ id: 'v_1', refs: [{ id: 'counter', scope: 'public', payload: 30 }] }] });
    let onRefreshB = async () => {};
    const b = multiViewFixture(coordinator, 'b', {
        views: [{ id: 'v_1', refs: [{ id: 'counter', scope: 'public', payload: 100 }] }],
        refreshProjection: () => onRefreshB(),
    });
    const [candA, candB] = await Promise.all([a.prepare(), b.prepare()]);
    const turn = adopted(coordinator.adoptTurn(selection(candA, candB))).turn;

    // Background update to 35 while still public: original snapshot value 30 is returned.
    a.publish([{ id: 'v_1', refs: [{ id: 'counter', scope: 'public', payload: 35 }] }]);
    expect(await turn.readPublicRefs(['$ref.a.v_1.counter'])).toEqual({
        status: 'ready',
        refs: [{ appId: 'a', viewId: 'v_1', refId: 'counter', path: [], value: 30 }],
    });

    // During batch read [A, B], B turns private during refresh -> whole batch rejected (no partial A result).
    let resumeB!: () => void;
    onRefreshB = () => new Promise<void>(resolve => { resumeB = resolve; });
    const pending = turn.readPublicRefs(['$ref.a.v_1.counter', '$ref.b.v_1.counter']);
    expect([a.holds(), b.holds()]).toEqual([2, 2]);
    b.publish([{ id: 'v_1', refs: [{ id: 'counter', scope: 'private', payload: 100 }] }]);
    resumeB();
    const result = await pending;
    expect(result).toMatchObject({
        status: 'rejected', issue: { code: 'REF_VALUE_PRIVATE' },
    });
    expect(result).not.toHaveProperty('refs');

    // Restore B public, then close/remount B during refresh -> whole batch rejected with REF_NOT_VISIBLE.
    b.publish([{ id: 'v_1', refs: [{ id: 'counter', scope: 'public', payload: 100 }] }]);
    const candB2 = await b.prepare();
    const candA2 = await a.prepare();
    const turn2 = adopted(coordinator.adoptTurn(selection(candA2, candB2))).turn;
    onRefreshB = async () => { b.publish([], false); };
    expect(await turn2.readPublicRefs(['$ref.a.v_1.counter', '$ref.b.v_1.counter'])).toMatchObject({
        status: 'rejected', issue: { code: 'REF_NOT_VISIBLE' },
    });

    turn2.release();
    expect([a.holds(), b.holds()]).toEqual([0, 0]);
});

it('readPublicRefs rejects a batch when a store reread narrows a previously checked App', async () => {
    const coordinator = createTurnCoordinator();
    const a = fixture(coordinator, 'a'), b = fixture(coordinator, 'b');
    const [candA, candB] = await Promise.all([a.prepare(), b.prepare()]);
    const turn = adopted(coordinator.adoptTurn(selection(candA, candB))).turn;
    let bReads = 0;
    b.control.read = () => {
        if (++bReads === 2) a.publish('narrow');
    };
    try {
        const result = await turn.readPublicRefs(['$ref.a.file.text', '$ref.b.file.text']);
        expect(bReads).toBe(2);
        expect(await turn.inspectRef('$ref.a.file.text', 'value')).toMatchObject({
            status: 'rejected', issue: { code: 'REF_VALUE_PRIVATE' },
        });
        expect(result).toMatchObject({ status: 'rejected', issue: { code: 'REF_VALUE_PRIVATE' } });
        expect(result).not.toHaveProperty('refs');
    } finally { turn.release(); }
    expect([a.holds(), b.holds()]).toEqual([0, 0]);
});

it('readPublicRefs refreshes distinct Apps concurrently, releases all holds safely, and returns TURN_NOT_ACTIVE if released mid-refresh', async () => {
    const coordinator = createTurnCoordinator();
    const entered: string[] = [];
    let releaseA!: () => void, releaseB!: () => void;
    let refreshesA = 0, refreshesB = 0;
    const a = multiViewFixture(coordinator, 'a', {
        views: [{ id: 'v_1', refs: [{ id: 'r1', scope: 'public', payload: 1 }, { id: 'r2', scope: 'public', payload: 2 }] }],
        refreshProjection: () => {
            refreshesA++;
            entered.push('a');
            return new Promise<void>(resolve => { releaseA = resolve; });
        },
    });
    const b = multiViewFixture(coordinator, 'b', {
        views: [{ id: 'v_1', refs: [{ id: 'r1', scope: 'public', payload: 3 }] }],
        refreshProjection: () => {
            refreshesB++;
            entered.push('b');
            return new Promise<void>(resolve => { releaseB = resolve; });
        },
    });
    const [candA, candB] = await Promise.all([a.prepare(), b.prepare()]);
    const turn = adopted(coordinator.adoptTurn(selection(candA, candB))).turn;

    // Throw during A's hold release to verify B's hold is still released cleanly.
    a.setReleaseHook(() => { a.setReleaseHook(() => {}); throw new Error('release-a-failure'); });
    const pending = turn.readPublicRefs(['$ref.a.v_1.r1', '$ref.a.v_1.r2', '$ref.b.v_1.r1']);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(entered).toEqual(['a', 'b']);
    expect(refreshesA).toBe(1);
    expect(refreshesB).toBe(1);
    releaseA(); releaseB();
    expect(await pending).toEqual({
        status: 'ready',
        refs: [
            { appId: 'a', viewId: 'v_1', refId: 'r1', path: [], value: 1 },
            { appId: 'a', viewId: 'v_1', refId: 'r2', path: [], value: 2 },
            { appId: 'b', viewId: 'v_1', refId: 'r1', path: [], value: 3 },
        ],
    });
    expect([a.holds(), b.holds()]).toEqual([1, 1]);

    // Turn released while refresh is pending -> TURN_NOT_ACTIVE and all holds cleaned up.
    const pendingLate = turn.readPublicRefs(['$ref.a.v_1.r1']);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    turn.release();
    releaseA();
    expect(await pendingLate).toMatchObject({ status: 'rejected', issue: { code: 'TURN_NOT_ACTIVE' } });
    expect(await turn.readPublicRefs()).toMatchObject({ status: 'rejected', issue: { code: 'TURN_NOT_ACTIVE' } });
    expect([a.holds(), b.holds()]).toEqual([0, 0]);
});

it('readPublicRefs enforces 256 count and wire JSON depth/nodes/byte limits with REF_READ_CAPACITY', async () => {
    const coordinator = createTurnCoordinator();
    const manyRefs = Array.from({ length: 257 }, (_, i) => ({ id: 'r' + i, scope: 'public' as const, payload: i }));
    const deep = (depth: number): JsonValue => depth === 0 ? 1 : { next: deep(depth - 1) };
    const halfNodes = Array.from({ length: 6_000 }, () => 1);
    const bigString = '中'.repeat(44 * 1024); // 132 KiB encoded, with fewer than 128 KiB UTF-16 code units.
    const a = multiViewFixture(coordinator, 'a', {
        views: [
            { id: 'v_many', refs: manyRefs },
            { id: 'v_limits', refs: [
                { id: 'deep', scope: 'public', payload: deep(38) },
                { id: 'nodesA', scope: 'public', payload: halfNodes },
                { id: 'nodesB', scope: 'public', payload: halfNodes },
                { id: 'bytes', scope: 'public', payload: bigString },
            ] },
        ],
    });
    const cand = await a.prepare();
    const vLimits = { viewId: cand.observation.views[1]!.id, viewInstanceId: cand.observation.views[1]!.viewInstanceId };
    const turnAll = adopted(coordinator.adoptTurn(selection(cand))).turn;

    // 257 public refs with undefined addresses -> REF_READ_CAPACITY
    const overUndefined = await turnAll.readPublicRefs();
    expect(overUndefined).toMatchObject({ status: 'rejected', issue: { code: 'REF_READ_CAPACITY' } });
    expect(JSON.stringify(overUndefined)).not.toContain('CONSOLE_');

    // 257 explicit addresses -> REF_READ_CAPACITY
    const addresses257 = Array.from({ length: 257 }, () => '$ref.a.v_many.r0');
    expect(await turnAll.readPublicRefs(addresses257)).toMatchObject({ status: 'rejected', issue: { code: 'REF_READ_CAPACITY' } });

    // 256 explicit addresses -> succeeds
    const addresses256 = Array.from({ length: 256 }, () => '$ref.a.v_many.r0');
    expect(await turnAll.readPublicRefs(addresses256)).toEqual({
        status: 'ready',
        refs: [{ appId: 'a', viewId: 'v_many', refId: 'r0', path: [], value: 0 }],
    });

    // Wire JSON depth (root=0, refs=1, item=2, value=3 + 38 > 40), nodes (> 12_000 across batch), bytes (> 128 KiB) -> REF_READ_CAPACITY
    const candLimits = await a.prepare();
    const turnLimits = adopted(coordinator.adoptTurn({ apps: [{ candidate: candLimits, windows: { activeViews: [vLimits] } }] })).turn;
    for (const batch of [
        ['$ref.a.v_limits.deep'],
        ['$ref.a.v_limits.nodesA', '$ref.a.v_limits.nodesB'],
        ['$ref.a.v_limits.bytes'],
    ]) {
        expect(await turnLimits.readPublicRefs(batch)).toMatchObject({
            status: 'rejected', issue: { code: 'REF_READ_CAPACITY' },
        });
    }
    turnLimits.release();
    expect(a.holds()).toBe(0);
});
