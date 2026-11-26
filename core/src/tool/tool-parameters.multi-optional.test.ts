import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, compileToolParameters, refKey, utf8Size } from '../index.js';
import {
    createAppInteraction, createSnapshotCore, prepareViewTypeParameters, REF_VALUE_LIMITS,
    RESOLVED_TOOL_ARGUMENT_LIMITS as ARGS,
} from '../host.js';
import { createViewOwnedTools } from '../producer.js';

const ref = (kind = 'Note', payload: any = { type: 'object' }) => ({
    'x-aotui-ref-kind': kind, 'x-aotui-ref-value': payload });
const list = () => ref('Note[]', { type: 'array', items: { type: 'object' } });
const notes = [{ id: 'n1', title: 'First', meta: { rank: 1 } }, { id: 'n2', title: 'Second', meta: { rank: 2 } }];
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function frozen(value: any): void {
    if (value !== null && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true);
        for (const child of Object.values(value)) frozen(child);
    }
}
function fixture(fields: Record<string, any> = { a: ref(), b: ref() }, required = Object.keys(fields),
    values: Record<string, any> = { a: notes[0], b: notes[1] }, kinds: Record<string, string> = {}) {
    const schema = { type: 'object', properties: { ...fields, ordinary: { type: 'string', enum: ['keep'], default: 'keep' } },
        required, additionalProperties: false };
    const compiled = compileToolParameters(schema);
    if (!compiled.ok) throw Error(JSON.stringify(compiled.issue));
    const core = createSnapshotCore({ appId: 'app', instanceId: 'run' }), registry = createViewOwnedTools('app', 'run');
    cleanup.push(() => { registry.dispose(); core.lifecycle.dispose(); });
    const entries: any[] = [], dispatches: any[] = [];
    registry.defineViewTypes([{ name: "NoteView", multiplicity: 'multiple', tools: [{ name:'inspect', description:'Inspect refs', inputSchema:schema }] }]);
    const plan=registry.prepareFrame([{idPrefix: 'aa',type:'NoteView',owner:{},bindings:[{name:'inspect',enabled:true,execute:args=>{
        frozen(args); entries.push(args);
        return {success:true,data:{message:'Recorded.'}};
    }}]}]);
    plan.accept();
    const [view] = plan.instances, [tool] = plan.tools;
    const receiver = {viewId:view.viewId,viewInstanceId:view.viewInstanceId,activationId:view.toolBindings[0].activationId};
    let seq = 0;
    const visible = Object.keys(values).map(id => ({ refId: id, viewId: view.viewId, viewInstanceId: view.viewInstanceId }));
    function publish(next = values) {
        const n = ++seq;
        const result = core.committer.accept({ schemaVersion: 8, appId: 'app', instanceId: 'run', producerSeq: n, sourceEpoch: n, capturedAt: n,
            views: [{ toolBindings: view.toolBindings, id: view.viewId, type: view.viewType, viewInstanceId: view.viewInstanceId, name: 'Notes', region: 'dynamic', content: { format: 'markdown-v1', value: 'Current notes ' + n } }],
            refs: Object.fromEntries(Object.entries(next).map(([id, payload]) => [refKey(view.viewId, view.viewInstanceId, id), { scope: 'protected',
                id, ownerViewId: view.viewId, ownerViewInstanceId: view.viewInstanceId, valueSchema: Array.isArray(payload) ? { type: 'array', items: {} } : { type: 'object' },
                refType: kinds[id] ?? fields[id]?.['x-aotui-ref-kind'] ?? 'Note', target: { kind: 'snapshot-value', payload },
            }])), tools: { [tool.id]: tool } });
        expect(result.status, JSON.stringify(result)).toBe('published');
        if (result.status !== 'published') throw Error('Publication failed'); return result.snapshot;
    }
    const original = publish();
    const bindings = new WeakMap<object, any>();
    const client = createAppInteraction(core.store, { namespace: 'multi-optional', now: () => 0, appId: 'app', instanceId: 'run', policy: {
        project: ({ source }) => ({
            refs: Object.values(source.refs).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
            toolIds: Object.keys(source.tools) }),
        authorize: () => true, canReadReceipt: () => true,
    }, execution: { resolve: source => {
        if (bindings.has(source)) return bindings.get(source);
        const binding = { identity: source,
        isLive: () => registry.validateTypeToolBinding(source.tool, source.receiver).success,
        execute: async context => { dispatches.push(context); const terminal = await registry.invokeTypeTool(source.tool, source.receiver, context.effectiveInput);
            return { kind: 'tool-result', phase: terminal.phase, result: terminal.result }; },
    }; bindings.set(source, binding); return binding; } } });
    cleanup.push(async () => {
        client.close(); await client.whenClosed(); registry.dispose(); core.lifecycle.dispose();
        expect(client.inspect()).toMatchObject({ closed: true });
        expect(registry.inspect()).toMatchObject({ state: 'disposed', views: 0, bindings: 0 });
        expect(core.store.inspect().activeHolds).toBe(0);
    });
    function prepare(args: any) {
        return prepareViewTypeParameters(core.store,{appId:'app',instanceId:'run',snapshotId:original.id,tool,receiver},
            compiled.contract,args,visible,'obs');
    }
    function prepared(args: any) {
        const p = prepare(args); expect(p.status, JSON.stringify(p)).toBe('prepared');
        if (p.status !== 'prepared') throw Error(p.issue.code); return p;
    }
    return { core, tool, receiver, view, original, publish, entries, dispatches, prepare, prepared, client };
}

describe('serial observation adoption with object and array Refs', () => {
    it('a candidate has no invocation eligibility and read-only preview leaves it intact', async () => {
        const f = fixture();
        const original = await f.client.observe(); if (original.status !== 'observed') throw Error('original');
        f.publish({ a: notes[1], b: notes[0] });
        expect(await f.client.preview()).toMatchObject({ status: 'previewed' });
        expect((await f.client.observe()).status).toBe('rejected');
        const observation = original.observation;
        expect(await f.client.invoke({ invocationId: 'not-adopted', observationId: observation.observationId,
            toolId: observation.tools[0]!.id, viewId: 'aa_1', input: {  a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b' } }))
            .toMatchObject({ kind: 'refused', code: 'OBSERVATION_NOT_ADOPTED' });
        expect(f.entries).toHaveLength(0);
    });
    it('keeps publication and preview independent, then revokes the old binding without rebinding its names', async () => {
        const f = fixture({ a: ref(), b: list() }, ['a', 'b'], { a: notes[0], b: notes });
        const first = await f.client.observe(); if (first.status !== 'observed') throw Error('first');
        const request = (id: string) => ({ invocationId: id, observationId: first.observation.observationId,
            toolId: first.observation.tools[0]!.id, viewId: 'aa_1', input: {  a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b' } });
        expect(f.client.adoptObservation(first.observation.observationId)).toEqual({ status: 'adopted' });
        f.publish({ a: notes[1], b: [notes[1]] });
        const next = await f.client.observe(); if (next.status !== 'observed') throw Error('next');
        expect(await f.client.invoke({ invocationId: 'preview-not-adopted', observationId: next.observation.observationId,
            toolId: next.observation.tools[0]!.id, viewId: 'aa_1', input: {  a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b' } }))
            .toMatchObject({ kind: 'refused', code: 'OBSERVATION_NOT_ADOPTED' });
        expect(await f.client.invoke(request('before-adopt'))).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.entries[0]).toMatchObject({ a: notes[0], b: notes });
        expect(f.client.adoptObservation(next.observation.observationId)).toEqual({ status: 'adopted' });
        expect(await f.client.invoke(request('stale'))).toMatchObject({ kind: 'refused', code: 'OBSERVATION_UNAVAILABLE' });
        expect(f.entries).toHaveLength(1);
        expect(await f.client.readReceipt({ observationId: first.observation.observationId, invocationId: 'before-adopt' }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.entries).toHaveLength(1); // A receipt remains readable; it does not execute again.
        expect(await f.client.invoke({ invocationId: 'current', observationId: next.observation.observationId,
            toolId: next.observation.tools[0]!.id, viewId: 'aa_1', input: {  a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b' } }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.entries[1]).toMatchObject({ a: notes[1], b: [notes[1]] });
        expect(f.client.adoptObservation(first.observation.observationId)).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_UNAVAILABLE' } });
        expect(f.core.store.getById(f.original.id).status).toBe('rejected');
        expect(f.core.store.inspect()).toMatchObject({ heldSnapshots: 0, heldSnapshotBytes: 0 });
    });

    it('preserves an independent holder and current data while releasing only the superseded source', async () => {
        const f = fixture();
        const first = await f.client.observe(); if (first.status !== 'observed') throw Error('first');
        const shared = f.core.store.acquire(f.original.id); if (shared.status !== 'acquired') throw Error('shared holder');
        try {
            f.client.adoptObservation(first.observation.observationId);
            const current = f.publish({ a: notes[1], b: notes[0] });
            const next = await f.client.observe(); if (next.status !== 'observed') throw Error('next');
            expect(f.client.adoptObservation(next.observation.observationId)).toEqual({ status: 'adopted' });
            expect(f.core.store.getById(f.original.id).status).toBe('found');
            expect(f.core.store.getById(current.id).status).toBe('found');
            shared.hold.release(); shared.hold.release();
            expect(f.core.store.getById(f.original.id).status).toBe('rejected');
            expect(f.core.store.getById(current.id).status).toBe('found');
        } finally { shared.hold.release(); }
    });

    it('failed preparation and released previews do not replace the adopted observation', async () => {
        const f = fixture();
        const first = await f.client.observe(); if (first.status !== 'observed') throw Error('first');
        f.client.adoptObservation(first.observation.observationId);
        f.publish({ a: notes[1], b: notes[0] });
        const preview = await f.client.observe(); if (preview.status !== 'observed') throw Error('preview');
        expect(await f.client.observe()).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY' } });
        f.client.releaseObservation(preview.observation.observationId);
        expect(f.client.adoptObservation(preview.observation.observationId)).toMatchObject({ status: 'rejected' });
        expect(await f.client.invoke({ invocationId: 'still-original', observationId: first.observation.observationId,
            toolId: first.observation.tools[0]!.id, viewId: 'aa_1', input: {  a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b' } }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.entries[0]).toMatchObject({ a: notes[0], b: notes[1] });
        f.client.close();
        expect(f.client.adoptObservation(first.observation.observationId)).toMatchObject({ status: 'rejected', issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
        expect(f.core.store.inspect()).toMatchObject({ heldSnapshots: 0, heldSnapshotBytes: 0, activeHolds: 0 });
    });
});

describe('multi/optional: actual registration, original source, and instance invocation', () => {
    it.each([
        ['objects', { a: ref(), b: ref() }, { a: notes[0], b: notes[1] }],
        ['object/list', { a: ref(), b: list() }, { a: notes[0], b: notes }],
        ['lists', { a: list(), b: list() }, { a: notes, b: [] }],
    ])('resolves all %s from the original observation and preserves ordinary input', async (_label, fields, values) => {
        const f = fixture(fields as any, ['a', 'b'], values as any);
        const observed = await f.client.observe(); if (observed.status !== 'observed') throw Error('Observe');
        expect(f.client.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
        f.publish({ b: [], a: { changed: true } });
        const result = await f.client.invoke({ invocationId: 'original', observationId: observed.observation.observationId,
            toolId: observed.observation.tools[0]!.id, viewId: 'aa_1', input: {  b: '$ref.app.aa_1.b', a: '$ref.app.aa_1.a', ordinary: 'keep' } });
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.entries).toEqual([{ ...values as any, ordinary: 'keep' }]); expect(f.dispatches).toHaveLength(1);
        expect(f.dispatches[0].rawInput).toEqual({ a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b', ordinary: 'keep' });
        expect(f.dispatches[0].refSources).toEqual(['b', 'a'].map(param => expect.objectContaining({ param, refId: param,
            refType: (fields as any)[param]['x-aotui-ref-kind'], snapshotId: f.original.id, viewId: f.view.viewId, viewInstanceId: f.view.viewInstanceId })));
        frozen(f.entries[0]); f.client.releaseObservation(observed.observation.observationId);
        expect(await f.client.invoke({ invocationId: 'released', observationId: observed.observation.observationId,
            toolId: observed.observation.tools[0]!.id, viewId: 'aa_1', input: {  a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b' } }))
            .toMatchObject({ kind: 'refused', code: 'OBSERVATION_UNAVAILABLE' });
        expect(f.entries).toHaveLength(1);
    });
    it.each([['optional object', { a: ref() }], ['optional list', { a: list() }],
        ['all optional', { a: ref(), b: list() }]])('leaves %s absent without defaulting', (_label, fields) => {
        const f = fixture(fields as any, [], {}); const p = f.prepared({});
        expect(p.effectiveArgs).toEqual({}); expect(p.refSources).toEqual([]); frozen(p.effectiveArgs);
    });
    it('resolves a present optional list while keeping the absent optional object absent', () => {
        const f = fixture({ a: ref(), b: list(), c: ref() }, ['a'], { a: notes[0], b: notes });
        const p = f.prepared({ a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b' }); expect(p.effectiveArgs).toEqual({ a: notes[0], b: notes });
        expect(Object.hasOwn(p.effectiveArgs, 'c')).toBe(false); expect(p.refSources.map(s => s.param)).toEqual(['a', 'b']); frozen(p.effectiveArgs);
    });
    it('permits the same Ref in compatible fields without acquiring another source lease', () => {
        const f = fixture(); const p = f.prepared({ a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.a' }); expect(p.effectiveArgs).toEqual({ a: notes[0], b: notes[0] });
        expect(p.effectiveArgs.a).toBe(p.effectiveArgs.b); expect(p.refSources.map(s => s.refId)).toEqual(['a', 'a']);
        expect(f.core.store.inspect().activeHolds).toBe(0);
    });
    it.each([['missing', {}, 'TOOL_INVALID_ARGS'], ['ungranted', { b: '$ref.app.aa_1.missing' }, 'REF_NOT_VISIBLE'],
        ['wrong type', { b: '$ref.app.aa_1.b' }, 'REF_TYPE_MISMATCH'], ['invalid ordinary', { b: '$ref.app.aa_1.b', ordinary: 'changed' }, 'TOOL_INVALID_ARGS']])
        ('rejects second Ref %s before dispatch or business', async (kind, input, code) => {
            const f = fixture(undefined, undefined, undefined, kind === 'wrong type' ? { b: 'Task' } : {});
            const o = await f.client.observe(); if (o.status !== 'observed') throw Error('Observe');
            expect(f.client.adoptObservation(o.observation.observationId)).toEqual({ status: 'adopted' });
            const result = await f.client.invoke({ invocationId: 'denied', observationId: o.observation.observationId,
                toolId: o.observation.tools[0]!.id, viewId: 'aa_1', input: {  a: '$ref.app.aa_1.a', ...input as any } });
            expect(result).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'rejected', code } } });
            expect(f.dispatches).toEqual([]); expect(f.entries).toEqual([]); f.client.releaseObservation(o.observation.observationId);
            expect(f.core.store.inspect().activeHolds).toBe(0);
        });
    it.each([undefined, null, '', [], {}, 0, false])('rejects present invalid optional value %j rather than skipping it', b => {
        const f = fixture({ a: ref(), b: ref() }, ['a']);
        expect(f.prepare({ a: '$ref.app.aa_1.a', b })).toMatchObject({ status: 'rejected', issue: { code: 'REF_TYPE_MISMATCH' } });
        expect(f.core.store.inspect().activeHolds).toBe(0);
    });
});

// Independent arithmetic is used to place combined values on the existing limits.
function measure(value: any) {
    let nodes = 0, depth = 0;
    const walk = (v: any, d: number) => { nodes++; depth = Math.max(depth, d);
        if (Array.isArray(v)) v.forEach(x => walk(x, d + 1));
        else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, d + 1);
    }; walk(value, 0); return { nodes, depth, canonical: utf8Size(canonicalJson(value)) };
}
function nested(n: number): any { let x = {}; while (n--) x = { next: x }; return x; }
function escapeBytes(n: number) { return '\0'.repeat(Math.floor(n / 6)) + 'x'.repeat(n % 6); }
function budgetResult(f: ReturnType<typeof fixture>, args: any, over: boolean) {
    const p = f.prepare(args);
    if (over) expect(p).toMatchObject({ status: 'rejected', issue: { code: 'REF_ARGUMENT_BUDGET_EXCEEDED' } });
    else expect(p.status, JSON.stringify(p)).toBe('prepared');
    expect(f.core.store.inspect().activeHolds).toBe(0);
}
describe('multi/optional: complete arguments and envelope retain cumulative limits', () => {
    const max = ARGS.maxCanonicalBytes;
    for (const largeFirst of [true, false]) it.each([max - 1, max, max + 1])(`final budget is order independent (largeFirst=${largeFirst}, bytes=%i)`, bytes => {
        const longName = 'x'.repeat(128), smaller = { text: 'x'.repeat(256 * 1024) };
        const large = { text: 'x'.repeat(bytes - measure({ a: { text: '' }, b: smaller }).canonical) };
        const expected = largeFirst ? { a: large, b: smaller } : { a: smaller, b: large };
        expect(measure(expected).canonical).toBe(bytes);
        const f = fixture(undefined, undefined, { a: expected.a, [longName]: expected.b });
        const raw = { a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.' + longName };
        const p = f.prepare(raw);
        if (bytes > max) expect(p).toMatchObject({ status: 'rejected', issue: { code: 'REF_ARGUMENT_BUDGET_EXCEEDED' } });
        else {
            expect(p.status, JSON.stringify(p)).toBe('prepared');
            if (p.status !== 'prepared') throw Error(p.issue.code);
            expect(p.effectiveArgs).toEqual(expected);
            expect(p.refSources.map(source => source.refId)).toEqual(['a', longName]);
            frozen(p.effectiveArgs);
        }
        expect(f.core.store.inspect().activeHolds).toBe(0);
    });

    it.each([ARGS.maxNodes - 1, ARGS.maxNodes, ARGS.maxNodes + 1])('counts %i nodes across both Ref payloads', nodes => {
        const values = { a: { data: Array(5997).fill(null) }, b: { data: Array(nodes - 6002).fill(null) } };
        expect(measure(values).nodes).toBe(nodes);
        expect(measure(values.a).nodes).toBeLessThan(REF_VALUE_LIMITS.maxNodes);
        expect(measure(values.b).nodes).toBeLessThan(REF_VALUE_LIMITS.maxNodes);
        budgetResult(fixture(undefined, undefined, values), { a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b' }, nodes > ARGS.maxNodes);
    });
    it.each([23, 25, REF_VALUE_LIMITS.maxDepth + 1])('accepts a valid Ref at depth %i from the complete args root', depth => {
        const values = { a: notes[0], b: nested(depth - 1) }; expect(measure(values).depth).toBe(depth);
        budgetResult(fixture(undefined, undefined, values), { a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b' }, false);
    });
    it.each([max - 1, max, max + 1])('combines escaped bytes %i', bytes => {
        const base = { a: { text: 'x'.repeat(300 * 1024) }, b: { text: '' } };
        const remaining = bytes - measure(base).canonical; base.b.text = escapeBytes(remaining);
        expect(measure(base).canonical).toBe(bytes);
        expect(measure(base.a).canonical).toBeLessThan(REF_VALUE_LIMITS.maxCanonicalBytes);
        expect(measure(base.b).canonical).toBeLessThan(REF_VALUE_LIMITS.maxCanonicalBytes);
        budgetResult(fixture(undefined, undefined, base), { a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.b' }, bytes > max);
    });
    it('counts the same Ref payload twice when two parameters select it', () => {
        const f = fixture(undefined, undefined, { a: { text: 'x'.repeat(max / 2) } });
        budgetResult(f, { a: '$ref.app.aa_1.a', b: '$ref.app.aa_1.a' }, true);
    });
});
