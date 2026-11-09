import { validateCapturedTypeParameters as validateTypeParameters } from '../../../tests/fixtures/type-parameters.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { canonicalJson, utf8Size } from '../snapshot/json.js';
import { createScopedInteraction } from '../invocation/scoped-interaction.js';
import { createViewOwnedTools } from './view-owned-tools.js';
import { compileOrdinarySchema } from './ordinary-parameter-contract.js';
import { prepareViewTypeParameters } from './snapshot-value-arguments.js';
import { captureTypeParametersRequest } from '../../adapters/ordinary-invocation-v2.js';

const ref = (kind = 'Note', payload: any = { type: 'object' }) => ({ type: 'string', minLength: 1,
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
    const compiled = compileOrdinarySchema(schema, 'view-type-parameters-v1');
    if (!compiled.ok) throw Error(JSON.stringify(compiled.issue));
    const core = createSnapshotCore(), registry = createViewOwnedTools('app', 'run');
    cleanup.push(() => { registry.dispose(); core.lifecycle.dispose(); });
    core.lifecycle.startApp('app', 'run'); const view = registry.mount('aa', 'NoteView');
    const entries: any[] = [], dispatches: any[] = [];
    const release = registry.registerTypeTool({ viewType: 'NoteView', name: 'inspect', description: 'Inspect refs',
        inputSchema: schema }, { safeOrdinaryParametersInvocationMode: 'ordinary-v2',
        createSafeOrdinaryParametersInvoker: contract => async args => {
            const valid = contract.validateResolvedInput!(args);
            if (!valid.ok) return { phase: 'not-entered', result: { success: false, error: { code: 'E_INVALID_ARGS', message: 'Invalid' } } };
            frozen(valid.value); entries.push(valid.value);
            return { phase: 'entered-returned', result: { success: true, data: { message: 'Recorded.' } } };
        } });
    const tool = registry.listTools()[0]!; let seq = 0;
    const visible = Object.keys(values).map(id => ({ refId: id, viewId: view.viewId, viewInstanceId: view.viewInstanceId }));
    function publish(next = values) {
        const n = ++seq;
        const result = core.committer.accept({ schemaVersion: 3, appId: 'app', instanceId: 'run', producerSeq: n, sourceEpoch: n, capturedAt: n,
            views: [{ id: view.viewId, type: view.viewType, viewInstanceId: view.viewInstanceId, name: 'Notes', kind: 'state', content: { format: 'markdown-v1', value: 'Current notes ' + n } }],
            refs: Object.fromEntries(Object.entries(next).map(([id, payload]) => [refKey(view.viewId, view.viewInstanceId, id), {
                id, ownerViewId: view.viewId, ownerViewInstanceId: view.viewInstanceId,
                refType: kinds[id] ?? fields[id]?.['x-aotui-ref-kind'] ?? 'Note', target: { kind: 'snapshot-value', payload },
            }])), tools: { [tool.id]: tool } });
        expect(result.status, JSON.stringify(result)).toBe('published');
        if (result.status !== 'published') throw Error('Publication failed'); return result.snapshot;
    }
    const original = publish();
    const authority = createScopedInteraction(core.store, { namespace: 'multi-optional', now: () => 0 });
    const bindings = new WeakMap<object, any>();
    const opened = authority.createScope({ appId: 'app', instanceId: 'run', policy: {
        project: ({ source }) => ({ views: source.views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
            refs: Object.values(source.refs).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
            toolBindings: Object.values(source.tools).map(t => ({ toolId: t.id, execution: t.execution })), content: [] }),
        authorize: () => true, canReadReceipt: () => true,
    }, execution: { resolve: source => {
        if (bindings.has(source)) return bindings.get(source);
        const binding = { identity: source, mode: 'view-type-parameters-v1',
        isLive: () => ({ ok: registry.validateTypeToolBinding(source.tool, source.execution).success }),
        validateInput: (_source, input) => { const r = compiled.contract.validateResolvedInput!(input); return r.ok ? { ok: true, value: r.value } : { ok: false }; },
        execute: async context => { dispatches.push(context); const terminal = await registry.invokeTypeTool(source.tool, source.execution, context.effectiveInput);
            return { kind: 'tool-result', phase: terminal.phase, result: terminal.result }; },
    }; bindings.set(source, binding); return binding; } } });
    if (opened.status !== 'opened') throw Error('Scope failed');
    cleanup.push(async () => {
        authority.close(); await authority.whenClosed(); release(); registry.dispose(); core.lifecycle.dispose();
        expect(authority.inspect()).toMatchObject({ closed: true, scopes: 0, combinedBytes: 0 });
        expect(registry.inspect()).toMatchObject({ state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
        expect(core.store.inspect().activeLeases).toBe(0);
    });
    const request = (args: any) => ({ snapshotId: original.id, toolId: tool.id, execution: tool.execution, args });
    function prepare(args: any) { return prepareViewTypeParameters(core.store, { appId: 'app', instanceId: 'run' }, request(args), visible); }
    function prepared(args: any) {
        const p = prepare(args); expect(p.status, JSON.stringify(p)).toBe('prepared');
        if (p.status !== 'prepared') throw Error(p.issue.code); cleanup.push(p.release); return p;
    }
    return { core, tool, view, original, publish, entries, dispatches, prepare, prepared, client: opened.client };
}

describe('serial observation adoption with object and array Refs', () => {
    it('preparation alone grants neither original nor preview Ref invocation eligibility', async () => {
        const f = fixture();
        const original = await f.client.observe({ all: true }); if (original.status !== 'observed') throw Error('original');
        f.publish({ a: notes[1], b: notes[0] });
        const preview = await f.client.observe({ all: true }); if (preview.status !== 'observed') throw Error('preview');
        const results = [];
        for (const observation of [original.observation, preview.observation]) results.push(await f.client.invoke({
            invocationId: observation.observationId, observationId: observation.observationId,
            bindingId: observation.bindings[0]!.bindingId, input: { a: 'aa.a', b: 'aa.b' },
        }));
        for (const result of results) expect(result).toMatchObject({ kind: 'receipt', receipt: {
            executionPhase: 'not-dispatched', outcome: { status: 'rejected', code: 'OBSERVATION_NOT_ADOPTED' },
        } });
        expect(f.entries).toHaveLength(0);
    });
    it('keeps publication and preview independent, then revokes the old binding without rebinding its names', async () => {
        const f = fixture({ a: ref(), b: list() }, ['a', 'b'], { a: notes[0], b: notes });
        const first = await f.client.observe({ all: true }); if (first.status !== 'observed') throw Error('first');
        const request = (id: string) => ({ invocationId: id, observationId: first.observation.observationId,
            bindingId: first.observation.bindings[0]!.bindingId, input: { a: 'aa.a', b: 'aa.b' } });
        expect(f.client.adoptObservation(first.observation.observationId)).toEqual({ status: 'adopted' });
        f.publish({ a: notes[1], b: [notes[1]] });
        const next = await f.client.observe({ all: true }); if (next.status !== 'observed') throw Error('next');
        expect(await f.client.invoke({ invocationId: 'preview-not-adopted', observationId: next.observation.observationId,
            bindingId: next.observation.bindings[0]!.bindingId, input: { a: 'aa.a', b: 'aa.b' } }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'rejected', code: 'OBSERVATION_NOT_ADOPTED' } } });
        expect(await f.client.invoke(request('before-adopt'))).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.entries[0]).toMatchObject({ a: notes[0], b: notes });
        expect(f.client.adoptObservation(next.observation.observationId)).toEqual({ status: 'adopted' });
        expect(await f.client.invoke(request('stale'))).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'rejected', code: 'OBSERVATION_UNAVAILABLE' } } });
        expect(f.entries).toHaveLength(1);
        expect(await f.client.invoke(request('before-adopt'))).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.entries).toHaveLength(1); // A receipt remains readable; it does not execute again.
        expect(await f.client.invoke({ invocationId: 'current', observationId: next.observation.observationId,
            bindingId: next.observation.bindings[0]!.bindingId, input: { a: 'aa.a', b: 'aa.b' } }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.entries[1]).toMatchObject({ a: notes[1], b: [notes[1]] });
        expect(f.client.adoptObservation(first.observation.observationId)).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_UNAVAILABLE' } });
        expect(f.core.store.getById(f.original.id).status).toBe('rejected');
        expect(f.core.store.inspect()).toMatchObject({ historicalSnapshots: 0, historicalBytes: 0 });
    });

    it('preserves an independent holder and current data while releasing only the superseded source', async () => {
        const f = fixture();
        const first = await f.client.observe({ all: true }); if (first.status !== 'observed') throw Error('first');
        const shared = f.core.store.acquire(f.original.id, { lifetime: 'owner' }); if (shared.status !== 'acquired') throw Error('shared holder');
        try {
            f.client.adoptObservation(first.observation.observationId);
            const current = f.publish({ a: notes[1], b: notes[0] });
            const next = await f.client.observe({ all: true }); if (next.status !== 'observed') throw Error('next');
            expect(f.client.adoptObservation(next.observation.observationId)).toEqual({ status: 'adopted' });
            expect(f.core.store.getById(f.original.id).status).toBe('found');
            expect(f.core.store.getById(current.id).status).toBe('found');
            shared.lease.release(); shared.lease.release();
            expect(f.core.store.getById(f.original.id).status).toBe('rejected');
            expect(f.core.store.getById(current.id).status).toBe('found');
        } finally { shared.lease.release(); }
    });

    it('failed preparation and released previews do not replace the adopted observation', async () => {
        const f = fixture();
        const first = await f.client.observe({ all: true }); if (first.status !== 'observed') throw Error('first');
        f.client.adoptObservation(first.observation.observationId);
        expect(await f.client.observe({ viewIds: ['missing'] })).toMatchObject({ status: 'rejected' });
        f.publish({ a: notes[1], b: notes[0] });
        const preview = await f.client.observe({ all: true }); if (preview.status !== 'observed') throw Error('preview');
        f.client.releaseObservation(preview.observation.observationId);
        expect(f.client.adoptObservation(preview.observation.observationId)).toMatchObject({ status: 'rejected' });
        expect(await f.client.invoke({ invocationId: 'still-original', observationId: first.observation.observationId,
            bindingId: first.observation.bindings[0]!.bindingId, input: { a: 'aa.a', b: 'aa.b' } }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.entries[0]).toMatchObject({ a: notes[0], b: notes[1] });
        f.client.close();
        expect(f.client.adoptObservation(first.observation.observationId)).toMatchObject({ status: 'rejected', issue: { code: 'SCOPE_UNAVAILABLE' } });
        expect(f.core.store.inspect()).toMatchObject({ historicalSnapshots: 0, historicalBytes: 0, activeLeases: 0 });
    });
});

describe('multi/optional: actual registration, original source, and scoped invocation', () => {
    it.each([
        ['objects', { a: ref(), b: ref() }, { a: notes[0], b: notes[1] }],
        ['object/list', { a: ref(), b: list() }, { a: notes[0], b: notes }],
        ['lists', { a: list(), b: list() }, { a: notes, b: [] }],
    ])('resolves all %s from the original observation and preserves ordinary input', async (_label, fields, values) => {
        const f = fixture(fields as any, ['a', 'b'], values as any);
        const observed = await f.client.observe({ viewIds: ['aa'] }); if (observed.status !== 'observed') throw Error('Observe');
        expect(f.client.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
        f.publish({ b: [], a: { changed: true } });
        const result = await f.client.invoke({ invocationId: 'original', observationId: observed.observation.observationId,
            bindingId: observed.observation.bindings[0]!.bindingId, input: { b: 'aa.b', a: 'aa.a', ordinary: 'keep' } });
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
        expect(f.entries).toEqual([{ ...values as any, ordinary: 'keep' }]); expect(f.dispatches).toHaveLength(1);
        expect(f.dispatches[0].rawInput).toEqual({ a: 'aa.a', b: 'aa.b', ordinary: 'keep' });
        expect(f.dispatches[0].refSources).toEqual(['a', 'b'].map(param => ({ param, refId: param, kind: 'snapshot-value',
            refType: (fields as any)[param]['x-aotui-ref-kind'], snapshotId: f.original.id, viewId: f.view.viewId, viewInstanceId: f.view.viewInstanceId })));
        frozen(f.entries[0]); f.client.releaseObservation(observed.observation.observationId);
        expect(await f.client.invoke({ invocationId: 'released', observationId: observed.observation.observationId,
            bindingId: observed.observation.bindings[0]!.bindingId, input: { a: 'aa.a', b: 'aa.b' } }))
            .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'rejected', code: 'OBSERVATION_UNAVAILABLE' } } });
        expect(f.entries).toHaveLength(1);
    });
    it.each([['optional object', { a: ref() }], ['optional list', { a: list() }],
        ['all optional', { a: ref(), b: list() }]])('leaves %s absent without defaulting', (_label, fields) => {
        const f = fixture(fields as any, [], {}); const p = f.prepared({});
        expect(p.effectiveArgs).toEqual({}); expect(p.refSources).toEqual([]); frozen(p.effectiveArgs);
    });
    it('resolves a present optional list while keeping the absent optional object absent', () => {
        const f = fixture({ a: ref(), b: list(), c: ref() }, ['a'], { a: notes[0], b: notes });
        const p = f.prepared({ a: 'aa.a', b: 'aa.b' }); expect(p.effectiveArgs).toEqual({ a: notes[0], b: notes });
        expect(Object.hasOwn(p.effectiveArgs, 'c')).toBe(false); expect(p.refSources.map(s => s.param)).toEqual(['a', 'b']); frozen(p.effectiveArgs);
    });
    it('permits the same Ref in compatible fields and releases its single source lease idempotently', () => {
        const f = fixture(); const p = f.prepared({ a: 'aa.a', b: 'aa.a' }); expect(p.effectiveArgs).toEqual({ a: notes[0], b: notes[0] });
        expect(p.effectiveArgs.a).not.toBe(p.effectiveArgs.b); expect(p.refSources.map(s => s.refId)).toEqual(['a', 'a']);
        expect(f.core.store.inspect().activeLeases).toBe(1); p.release(); p.release(); expect(f.core.store.inspect().activeLeases).toBe(0);
    });
    it.each([['missing', {}, 'TOOL_INVALID_ARGS'], ['ungranted', { b: 'missing' }, 'REF_NOT_VISIBLE'],
        ['wrong type', { b: 'aa.b' }, 'REF_TYPE_MISMATCH'], ['invalid ordinary', { b: 'aa.b', ordinary: 'changed' }, 'TOOL_INVALID_ARGS']])
        ('rejects second Ref %s before dispatch or business', async (kind, input, code) => {
            const f = fixture(undefined, undefined, undefined, kind === 'wrong type' ? { b: 'Task' } : {});
            const o = await f.client.observe({ viewIds: ['aa'] }); if (o.status !== 'observed') throw Error('Observe');
            expect(f.client.adoptObservation(o.observation.observationId)).toEqual({ status: 'adopted' });
            const result = await f.client.invoke({ invocationId: 'denied', observationId: o.observation.observationId,
                bindingId: o.observation.bindings[0]!.bindingId, input: { a: 'aa.a', ...input as any } });
            expect(result).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'rejected', code } } });
            expect(f.dispatches).toEqual([]); expect(f.entries).toEqual([]); f.client.releaseObservation(o.observation.observationId);
            expect(f.core.store.inspect().activeLeases).toBe(0);
        });
    it.each([undefined, null, '', [], {}, 0, false])('rejects present invalid optional value %j rather than skipping it', b => {
        const f = fixture({ a: ref(), b: ref() }, ['a']);
        expect(f.prepare({ a: 'aa.a', b })).toMatchObject({ status: 'rejected', issue: { code: 'TOOL_INVALID_ARGS' } });
        expect(f.core.store.inspect().activeLeases).toBe(0);
    });
});

// Independent arithmetic is used to place combined values on the existing limits.
function measure(value: any) {
    let nodes = 0, depth = 0, approx = 0;
    const walk = (v: any, d: number) => { nodes++; depth = Math.max(depth, d); approx += 2;
        if (typeof v === 'string') approx += utf8Size(v);
        else if (typeof v === 'number') approx += 24;
        else if (Array.isArray(v)) v.forEach(x => walk(x, d + 1));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { approx += utf8Size(k) + 4; walk(x, d + 1); }
    }; walk(value, 0); return { nodes, depth, approx, canonical: utf8Size(canonicalJson(value)) };
}
function nested(n: number): any { let x = {}; while (n--) x = { next: x }; return x; }
function escapeBytes(n: number) { return '\0'.repeat(Math.floor(n / 6)) + 'x'.repeat(n % 6); }
function budgetResult(f: ReturnType<typeof fixture>, args: any, over: boolean) {
    const p = f.prepare(args);
    if (over) expect(p).toMatchObject({ status: 'rejected', issue: { code: 'REF_ARGUMENT_BUDGET_EXCEEDED' } });
    else { expect(p.status, JSON.stringify(p)).toBe('prepared'); if (p.status === 'prepared') p.release(); }
    expect(f.core.store.inspect().activeLeases).toBe(0);
}
describe('multi/optional: complete arguments and envelope retain cumulative limits', () => {
    for (const largeFirst of [true, false]) it.each([131071, 131072, 131073])(`final budget is order independent (largeFirst=${largeFirst}, bytes=%i)`, bytes => {
        const longName = 'x'.repeat(128), empty = { a: { text: '' }, b: {} };
        const large = { text: 'x'.repeat(bytes - measure(empty).approx) };
        const expected = largeFirst ? { a: large, b: {} } : { a: {}, b: large };
        expect(measure(expected).approx).toBe(bytes);
        expect(measure(expected).canonical).toBeLessThanOrEqual(131072);
        const f = fixture(undefined, undefined, largeFirst ? { a: large, [longName]: {} } : { a: {}, [longName]: large });
        const raw = { a: 'aa.a', b: 'aa.' + longName };
        if (largeFirst) expect(measure({ a: large, b: 'aa.' + longName }).approx).toBeGreaterThan(131072);
        const p = f.prepare(raw);
        if (bytes > 131072) expect(p).toMatchObject({ status: 'rejected', issue: { code: 'REF_ARGUMENT_BUDGET_EXCEEDED' } });
        else {
            expect(p.status, JSON.stringify(p)).toBe('prepared');
            if (p.status !== 'prepared') throw Error(p.issue.code);
            try { expect(p.effectiveArgs).toEqual(expected); expect(p.rawArgs).toEqual(raw);
                expect(p.refSources.map(source => source.refId)).toEqual(['a', longName]); frozen(p.effectiveArgs); }
            finally { p.release(); }
        }
        expect(f.core.store.inspect().activeLeases).toBe(0);
    });

    it.each([9999, 10000, 10001])('counts %i nodes across both Ref payloads', nodes => {
        const values = { a: { data: Array(4997).fill(null) }, b: { data: Array(nodes - 5002).fill(null) } };
        expect(measure(values).nodes).toBe(nodes); expect(measure(values.a).nodes).toBeLessThan(10000); expect(measure(values.b).nodes).toBeLessThan(10000);
        budgetResult(fixture(undefined, undefined, values), { a: 'aa.a', b: 'aa.b' }, nodes > 10000);
    });
    it.each([23, 24, 25])('computes depth %i from the complete args root', depth => {
        const values = { a: notes[0], b: nested(depth - 1) }; expect(measure(values).depth).toBe(depth);
        budgetResult(fixture(undefined, undefined, values), { a: 'aa.a', b: 'aa.b' }, depth > 24);
    });
    for (const metric of ['approx', 'canonical'] as const) it.each([131071, 131072, 131073])(`combines ${metric} bytes %i`, bytes => {
        const base = { a: { text: 'x'.repeat(60000) }, b: { text: '' } };
        const remaining = bytes - measure(base)[metric]; base.b.text = metric === 'canonical' ? escapeBytes(remaining) : 'x'.repeat(remaining);
        expect(measure(base)[metric]).toBe(bytes); expect(measure(base.a)[metric]).toBeLessThan(131072); expect(measure(base.b)[metric]).toBeLessThan(131072);
        budgetResult(fixture(undefined, undefined, base), { a: 'aa.a', b: 'aa.b' }, bytes > 131072);
    });
    it('counts the same Ref payload twice when two parameters select it', () => {
        const f = fixture(undefined, undefined, { a: { text: 'x'.repeat(65536) } });
        budgetResult(f, { a: 'aa.a', b: 'aa.a' }, true);
    });
    it.each([10999, 11000, 11001])('counts %i envelope nodes including every provenance item', nodes => {
        const fields = Object.fromEntries(Array.from({ length: 128 }, (_, n) => ['p' + String(n).padStart(3, '0'), ref()]));
        const values: any = Object.fromEntries(Object.keys(fields).map(k => [k, {}]));
        // envelope = args nodes + source object/5 values + root + sources array/128*(object+7 values).
        const argsNodes = nodes - (8 + 128 * 8);
        values.p000 = { data: Array(argsNodes - 130).fill(null) };
        expect(measure(values).nodes).toBe(argsNodes); expect(argsNodes).toBeLessThanOrEqual(10000);
        budgetResult(fixture(fields, Object.keys(fields), values), Object.fromEntries(Object.keys(fields).map(k => [k, 'aa.' + k])), nodes > 11000);
    });
});

function message(f: ReturnType<typeof fixture>, raw: any) {
    const p = f.prepared(raw);
    return JSON.parse(JSON.stringify({ type: 'VIEW_TOOL_INVOKE_V4', requestId: 'test', appId: 'app', instanceId: 'run',
        argumentMode: 'view-type-parameters-v1', snapshotId: f.original.id, tool: f.tool, execution: f.tool.execution,
        rawArgs: p.rawArgs, effectiveArgs: p.effectiveArgs, refSources: p.refSources }));
}
describe('multi/optional: V4 checks actual present slots and transport consistency', () => {
    it.each([{}, { a: 'aa.a' }, { b: 'aa.b' }, { a: 'aa.a', b: 'aa.b', ordinary: 'keep' }])('accepts exact present Ref slots %j', raw => {
        const f = fixture({ a: ref(), b: list() }, [], { a: notes[0], b: notes });
        const m = captureTypeParametersRequest(message(f, raw)); expect(validateTypeParameters(m)).toEqual({ success: true });
        expect(m.refSources.map(s => s.param)).toEqual(Object.keys(raw).filter(k => k !== 'ordinary').sort());
    });
    it.each(['missing source', 'extra source', 'reversed sources', 'parameter', 'raw ref', 'ref type', 'snapshot', 'kind', 'empty view', 'wrong view', 'numeric ref', 'empty mount', 'ordinary', 'invalid payload'])
        ('rejects inconsistent %s', kind => {
            const f = fixture(); const m = message(f, { a: 'aa.a', b: 'aa.b', ordinary: 'keep' });
            if (kind === 'missing source') m.refSources.pop();
            if (kind === 'extra source') m.refSources.push(m.refSources[0]);
            if (kind === 'reversed sources') m.refSources.reverse();
            if (kind === 'parameter') m.refSources[1].param = 'a';
            if (kind === 'raw ref') m.refSources[1].refId = 'a';
            if (kind === 'ref type') m.refSources[1].refType = 'Task';
            if (kind === 'snapshot') m.refSources[1].snapshotId = 'other';
            if (kind === 'kind') m.refSources[1].kind = 'entity';
            if (kind === 'empty view') m.refSources[1].viewId = '';
            if (kind === 'wrong view') m.refSources[1].viewId = 'unverified-view';
            if (kind === 'numeric ref') { m.rawArgs.b = 'aa.1'; m.refSources[1].refId = 1; }
            if (kind === 'empty mount') m.refSources[1].viewInstanceId = '';
            if (kind === 'ordinary') delete m.effectiveArgs.ordinary;
            if (kind === 'invalid payload') m.effectiveArgs.b = [];
            expect(validateTypeParameters(captureTypeParametersRequest(m))).toMatchObject({ success: false, error: { code: 'E_INVALID_ARGS' } });
        });
    it.each(['value only', 'source and value'])('rejects absent optional injection: %s', kind => {
        const f = fixture({ a: ref(), b: ref() }, ['a']); const m = message(f, { a: 'aa.a' }); m.effectiveArgs.b = notes[1];
        if (kind === 'source and value') m.refSources.push({ ...m.refSources[0], param: 'b', refId: 'b' });
        expect(validateTypeParameters(captureTypeParametersRequest(m))).toMatchObject({ success: false, error: { code: 'E_INVALID_ARGS' } });
    });
    it.each(['same-shape payload', 'nonempty mount', 'coherent ref name'])('documents the existing trusted-transport boundary: %s', kind => {
        const f = fixture(); const m = message(f, { a: 'aa.a', b: 'aa.b' });
        if (kind === 'same-shape payload') m.effectiveArgs.b = { changed: true };
        if (kind === 'nonempty mount') m.refSources[1].viewInstanceId = 'unverified-mount';
        if (kind === 'coherent ref name') { m.rawArgs.b = 'aa.unverified-ref'; m.refSources[1].refId = 'unverified-ref'; }
        expect(validateTypeParameters(captureTypeParametersRequest(m))).toEqual({ success: true });
    });
});
