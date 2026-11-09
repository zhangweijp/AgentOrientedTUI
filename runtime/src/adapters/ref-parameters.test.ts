import { validateCapturedTypeParameters as validateTypeParameters } from '../../tests/fixtures/type-parameters.js';
import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from '../core/snapshot/store.js';
import { refKey } from '../core/snapshot/snapshot-support.js';
import type { JsonValue, PreparedAppSnapshotDraftV3 } from '../core/snapshot/types.js';
import { compileOrdinarySchema } from '../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../core/tool/ordinary-parameter-profile.js';
import { prepareViewTypeParameters } from '../core/tool/snapshot-value-arguments.js';
import { validateVersionedToolRefDeclarations } from '../core/tool/versioned-ref-declarations.js';
import { captureTypeParametersRequest } from './ordinary-invocation-v2.js';

const ref = (value: JsonValue = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false }) =>
    ({ type: 'string', minLength: 1, 'x-aotui-ref-kind': 'Item', 'x-aotui-ref-value': value });

function fixture(optional = false, payload: JsonValue = { label: 'A' }) {
    const c = compileOrdinarySchema({ type: 'object', properties: {
        many: { type: 'array', items: ref(), maxItems: 3 },
        one: ref(), all: ref({ type: 'array', items: { type: 'object' } }),
        ordinary: { type: 'string' },
    }, required: optional ? [] : ['many'], additionalProperties: false }, 'view-type-parameters-v1');
    if (!c.ok) throw Error(JSON.stringify(c.issue));
    const core = createSnapshotCore(); core.lifecycle.startApp('a', 'i');
    const toolId = JSON.stringify(['a', 'Items', 'choose']);
    const own = (id: string, value: JsonValue) => ({ id, ownerViewId: 'items', ownerViewInstanceId: 'mount',
        refType: 'Item', target: { kind: 'snapshot-value' as const, payload: value } });
    const refs = { [refKey('items', 'mount', 'a')]: own('a', payload),
        [refKey('items', 'mount', 'b')]: own('b', { label: 'B' }),
        [refKey('items', 'mount', 'all')]: own('all', [payload, { label: 'B' }]) };
    let sequence = 0;
    const publish = (values: typeof refs = refs) => {
        const seq = ++sequence;
        const draft: PreparedAppSnapshotDraftV3 = { schemaVersion: 3, appId: 'a', instanceId: 'i',
            producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
            views: [{ id: 'items', viewInstanceId: 'mount', type: 'Items', name: 'Items', kind: 'state',
                content: { format: 'markdown-v1', value: 'Choose published Items.' } }],
            refs: values, tools: { [toolId]: { id: toolId, name: 'choose', viewType: 'Items', description: 'Choose Items',
                 inputSchema: ordinaryParameterProfile(c.contract),
                execution: { kind: 'view-type', activationId: 'active' } } } };
        const result = core.committer.accept(draft);
        if (result.status !== 'published' || result.snapshot.schemaVersion !== 3) throw Error(JSON.stringify(result));
        return result.snapshot;
    };
    const source = publish();
    const visible = Object.values(refs).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id }));
    const prepare = (args: unknown, snapshotId = source.id, granted = visible) => prepareViewTypeParameters(core.store,
        { appId: 'a', instanceId: 'i' }, { snapshotId, toolId, execution: { kind: 'view-type', activationId: 'active' }, args }, granted);
    const message = (prepared: Extract<ReturnType<typeof prepare>, { status: 'prepared' }>) => captureTypeParametersRequest({
        type: 'VIEW_TOOL_INVOKE_V4', requestId: 'call', appId: 'a', instanceId: 'i', snapshotId: source.id,
        tool: source.tools[toolId], execution: { kind: 'view-type', activationId: 'active' },
        argumentMode: 'view-type-parameters-v1', rawArgs: prepared.rawArgs,
        effectiveArgs: prepared.effectiveArgs, refSources: prepared.refSources });
    return { core, contract: c.contract, refs, source, publish, prepare, message };
}

describe('shared Ref selections through Core and Worker parameter grammar', () => {
    it('preserves array order and duplicates alongside a scalar, whole array and ordinary string', () => {
        const f = fixture(), p = f.prepare({ many: ['items.b', 'items.a', 'items.b'],
            one: 'items.a', all: 'items.all', ordinary: 'Item:literal' });
        expect(p.status).toBe('prepared'); if (p.status !== 'prepared') throw Error('prepare');
        try {
            expect(p.effectiveArgs).toEqual({ many: [{ label: 'B' }, { label: 'A' }, { label: 'B' }],
                one: { label: 'A' }, all: [{ label: 'A' }, { label: 'B' }], ordinary: 'Item:literal' });
            expect(p.refSources.map(s => [s.param, s.refId])).toEqual([
                ['all', 'all'], ['many', 'b'], ['many', 'a'], ['many', 'b'], ['one', 'a'],
            ]);
            expect(Object.isFrozen(p.effectiveArgs.many)).toBe(true);
            expect(Object.isFrozen((p.effectiveArgs.many as readonly JsonValue[])[0])).toBe(true);
            expect(validateTypeParameters(f.message(p))).toEqual({ success: true });
            expect(validateVersionedToolRefDeclarations(ordinaryParameterProfile(f.contract))).toBe(true);
        } finally { p.release(); f.core.lifecycle.dispose(); }
        expect(f.core.store.inspect().activeLeases).toBe(0);
    });
    it('distinguishes omitted optional selection from an empty selection and never inserts defaults', () => {
        const f = fixture(true);
        for (const [raw, expected] of [[{}, {}], [{ many: [] }, { many: [] }]]) {
            const p = f.prepare(raw); expect(p.status).toBe('prepared'); if (p.status !== 'prepared') throw Error('prepare');
            expect(p.effectiveArgs).toEqual(expected); expect(p.refSources).toEqual([]);
            expect(validateTypeParameters(f.message(p)).success).toBe(true); p.release();
        }
        f.core.lifecycle.dispose();
    });
    it.each([{}, { many: null }, { many: 'a' }, { many: [''] }, { many: [null] },
        { many: [{ label: 'A' }] }, { many: ['items.a', 'items.b', 'items.a', 'items.b'] }])('rejects invalid model selections %j', args => {
        const f = fixture();
        expect(f.prepare(args)).toMatchObject({ status: 'rejected', issue: { code: 'TOOL_INVALID_ARGS' } });
        expect(f.core.store.inspect().activeLeases).toBe(0); f.core.lifecycle.dispose();
    });
    it.each(['missing', 'ambiguous', 'type', 'payload'] as const)('rejects one invalid member atomically: %s', kind => {
        const f = fixture(), args = { many: ['items.a', kind === 'missing' ? 'items.missing' : 'items.b'] };
        let id = f.source.id, visible = Object.values(f.refs).map(r => ({ refId: r.id, viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId }));
        if (kind === 'ambiguous') visible = [...visible, visible[1]!];
        if (kind === 'type' || kind === 'payload') {
            const key = refKey('items', 'mount', 'b'), original = f.refs[key]!;
            id = f.publish({ ...f.refs, [key]: { ...original,
                ...(kind === 'type' ? { refType: 'Other' } : { target: { kind: 'snapshot-value', payload: { label: 3 } } }),
            } }).id;
        }
        const code = { missing: 'REF_NOT_VISIBLE', ambiguous: 'REF_TARGET_UNSUPPORTED', type: 'REF_TYPE_MISMATCH', payload: 'TOOL_INVALID_ARGS' }[kind];
        expect(f.prepare(args, id, visible)).toMatchObject({ status: 'rejected', issue: { code } });
        expect(f.core.store.inspect().activeLeases).toBe(0); f.core.lifecycle.dispose();
    });
    it('budgets the complete repeated payload and releases the source on rejection', () => {
        for (const [size, status] of [[59_000, 'prepared'], [66_000, 'rejected']] as const) {
            const f = fixture(false, { label: 'x'.repeat(size) }), p = f.prepare({ many: ['items.a', 'items.a'] });
            expect(p.status).toBe(status);
            if (p.status === 'prepared') p.release();
            else expect(p.issue.code).toBe('REF_ARGUMENT_BUDGET_EXCEEDED');
            expect(f.core.store.inspect().activeLeases).toBe(0); f.core.lifecycle.dispose();
        }
    });
    it('captures array entries without running getters or accepting sparse arrays', () => {
        const f = fixture(); let reads = 0;
        const many = Object.defineProperty([], '0', { enumerable: true, get() { reads++; return 'a'; } });
        for (const value of [many, new Array(1)]) {
            expect(f.prepare({ many: value })).toMatchObject({ status: 'rejected', issue: { code: 'TOOL_INVALID_ARGS' } });
        }
        expect(reads).toBe(0); expect(f.core.store.inspect().activeLeases).toBe(0); f.core.lifecycle.dispose();
    });
    it.each(['order', 'missing', 'param', 'snapshot', 'extra', 'ordinary'] as const)('Worker rejects altered provenance or ordinary data: %s', kind => {
        const f = fixture(), p = f.prepare({ many: ['items.a', 'items.b'], ordinary: 'keep' });
        if (p.status !== 'prepared') throw Error('prepare');
        try {
            const m = f.message(p);
            const refSources = kind === 'order' ? [...m.refSources].reverse() : kind === 'missing' ? m.refSources.slice(1)
                : m.refSources.map((s, index) => index ? s : { ...s, ...(kind === 'param' ? { param: 'other' }
                    : kind === 'snapshot' ? { snapshotId: 'other' } : kind === 'extra' ? { index: 0 } : {}) });
            const changed = { ...m, refSources, ...(kind === 'ordinary' ? { effectiveArgs: { ...m.effectiveArgs, ordinary: 'changed' } } : {}) };
            expect(validateTypeParameters(captureTypeParametersRequest(changed)).success).toBe(false);
        } finally { p.release(); f.core.lifecycle.dispose(); }
    });
});
