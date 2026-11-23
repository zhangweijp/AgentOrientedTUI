import { validateCapturedTypeParameters as validateInvocationParameters } from '../../tests/fixtures/type-parameters.js';
import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from '@aotui/core';
import { refKey } from '@aotui/core';
import type { JsonValue, PreparedAppSnapshotDraft } from '@aotui/core';
import { compileToolParameters } from '@aotui/core';
import { parseRefAddress } from '@aotui/core/internal';
import { prepareViewTypeParameters } from '@aotui/core/internal';
import { captureToolInvocation } from './tool-invocation.js';

const ref = (value: JsonValue = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false }) =>
    ({ type: 'string', minLength: 1, 'x-aotui-ref-kind': 'Item', 'x-aotui-ref-value': value });

function fixture(optional = false) {
    const c = compileToolParameters({ type: 'object', properties: {
        many: { type: 'array', items: ref(), maxItems: 3 },
        one: ref(), all: ref({ type: 'array', items: { type: 'object' } }),
        ordinary: { type: 'string' },
    }, required: optional ? [] : ['many'], additionalProperties: false });
    if (!c.ok) throw Error(JSON.stringify(c.issue));
    const core = createSnapshotCore({ appId: 'a', instanceId: 'i' });
    const toolId = JSON.stringify(['a', 'Items', 'choose']);
    const own = (id: string, value: JsonValue) => ({ scope: 'protected', id, ownerViewId: 'items', ownerViewInstanceId: 'mount',
        refType: 'Item', target: { kind: 'snapshot-value' as const, payload: value } });
    const payload = { label: 'A' };
    const refs = { [refKey('items', 'mount', 'a')]: own('a', payload),
        [refKey('items', 'mount', 'b')]: own('b', { label: 'B' }),
        [refKey('items', 'mount', 'all')]: own('all', [payload, { label: 'B' }]) };
    let sequence = 0;
    const publish = (values: typeof refs = refs) => {
        const seq = ++sequence;
        const draft: PreparedAppSnapshotDraft = { schemaVersion: 7, appId: 'a', instanceId: 'i',
            producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
            views: [{ toolBindings: [{toolId,activationId:'active'}], id: 'items', viewInstanceId: 'mount', type: 'Items', name: 'Items', region: 'dynamic',
                content: { format: 'markdown-v1', value: 'Choose published Items.' } }],
            refs: values, tools: { [toolId]: { multiplicity: 'multiple', id: toolId, name: 'choose', viewType: 'Items', nameSharedAcrossViewTypes: false, description: 'Choose Items',
                 inputSchema: c.contract.schema } } };
        const result = core.committer.accept(draft);
        if (result.status !== 'published' || result.snapshot.schemaVersion !== 7) throw Error(JSON.stringify(result));
        return result.snapshot;
    };
    const source = publish();
    const { nameSharedAcrossViewTypes: _sharedName, ...tool } = source.tools[toolId]!;
    const visible = Object.values(refs).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id }));
    const receiver = {viewId:'items',viewInstanceId:'mount',activationId:'active'};
    const prepare = (args: unknown, snapshotId = source.id, granted = visible) => prepareViewTypeParameters(core.store,
        { appId:'a',instanceId:'i',snapshotId,tool:source.tools[toolId]!,receiver }, c.contract, args as any, granted, 'obs');
    const message = (prepared: Extract<ReturnType<typeof prepare>, { status: 'prepared' }>) => captureToolInvocation({
        type: 'VIEW_TOOL_INVOKE', requestId: 'call', appId: 'a', instanceId: 'i', snapshotId: source.id,
        tool, receiver, observationId: 'obs',
        rawArgs: prepared.rawArgs, refSources: prepared.refSources });
    return { core, contract: c.contract, refs, source, publish, prepare, message };
}

describe('shared Ref selections through Core and Worker parameter grammar', () => {
    it('parses a complete Ref name and a bounded sequence of distinct keys and indices', () => {
        expect(parseRefAddress('$3App.2View.待办[0]["0"].email["name.with.dots"]')).toEqual({
            appId: '3App', viewId: '2View', refId: '待办', path: [0, '0', 'email', 'name.with.dots'],
        });
        expect(parseRefAddress('$a.v["items[0]"]')).toEqual({ appId: 'a', viewId: 'v', refId: 'items[0]', path: [] });
        expect(parseRefAddress('$a.v["__proto__"]')).toEqual({ appId: 'a', viewId: 'v', refId: '__proto__', path: [] });
        for (const input of ['$a.v.r?.[0]', '$a.v.r[01]', '$a.v.r[1e1]', '$a.v.r[-1]', '$a.v.r[other]', '$a.v.r[1+2]',
            '$a.v.r[9007199254740992]', "$a.v['ref']", '$a.v.r[0]/*note*/', '$a.v.r[ 0 ]', '$a.v.r()',
            '$a.v.r\n', '$123.v.r', '$a.v["' + '写'.repeat(1400) + '"]', '$a.v.r' + '.k'.repeat(45)]) {
            expect(parseRefAddress(input), input).toBeUndefined();
        }
    });
    it('preserves array order and duplicates alongside a scalar, whole array and ordinary string', () => {
        const f = fixture(), p = f.prepare({ many: ['$a.items.b', '$a.items.a', '$a.items.b'],
            one: '$a.items.a', all: '$a.items.all', ordinary: 'Item:literal' });
        expect(p.status).toBe('prepared'); if (p.status !== 'prepared') throw Error('prepare');
        try {
            expect(p.effectiveArgs).toEqual({ many: [{ label: 'B' }, { label: 'A' }, { label: 'B' }],
                one: { label: 'A' }, all: [{ label: 'A' }, { label: 'B' }], ordinary: 'Item:literal' });
            expect(p.refSources.map(s => [s.param, s.refId])).toEqual([
                ['all', 'all'], ['many', 'b'], ['many', 'a'], ['many', 'b'], ['one', 'a'],
            ]);
            expect(Object.isFrozen(p.effectiveArgs.many)).toBe(true);
            expect(Object.isFrozen((p.effectiveArgs.many as readonly JsonValue[])[0])).toBe(true);
            expect(validateInvocationParameters(f.message(p))).toMatchObject({ status: 'prepared' });
            expect(f.contract.hasRefs).toBe(true);
        } finally { f.core.lifecycle.dispose(); }
        expect(f.core.store.inspect().activeHolds).toBe(0);
    });
    it('distinguishes omitted optional selection from an empty selection and never inserts defaults', () => {
        const f = fixture(true);
        for (const [raw, expected] of [[{}, {}], [{ many: [] }, { many: [] }]]) {
            const p = f.prepare(raw); expect(p.status).toBe('prepared'); if (p.status !== 'prepared') throw Error('prepare');
            expect(p.effectiveArgs).toEqual(expected); expect(p.refSources).toEqual([]);
            expect(validateInvocationParameters(f.message(p)).status).toBe('prepared');
        }
        f.core.lifecycle.dispose();
    });
    it.each([{}, { many: null }, { many: 'a' }, { many: [''] }, { many: [null] },
        { many: [{ label: 'A' }] }, { many: ['$a.items.a', '$a.items.b', '$a.items.a', '$a.items.b'] }])('rejects invalid model selections %j', args => {
        const f = fixture();
        expect(f.prepare(args)).toMatchObject({ status: 'rejected', issue: { code: 'TOOL_INVALID_ARGS' } });
        expect(f.core.store.inspect().activeHolds).toBe(0); f.core.lifecycle.dispose();
    });
    it.each(['missing', 'ambiguous', 'type', 'payload'] as const)('rejects one invalid member atomically: %s', kind => {
        const f = fixture(), args = { many: ['$a.items.a', kind === 'missing' ? '$a.items.missing' : '$a.items.b'] };
        let id = f.source.id, visible = Object.values(f.refs).map(r => ({ refId: r.id, viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId }));
        if (kind === 'ambiguous') visible = [...visible, visible[1]!];
        if (kind === 'type' || kind === 'payload') {
            const key = refKey('items', 'mount', 'b'), original = f.refs[key]!;
            id = f.publish({ ...f.refs, [key]: { ...original,
                ...(kind === 'type' ? { refType: 'Other' } : { target: { kind: 'snapshot-value', payload: { label: 3 } } }),
            } }).id;
        }
        const code = { missing: 'REF_NOT_VISIBLE', ambiguous: 'REF_TARGET_UNSUPPORTED', type: 'REF_TYPE_MISMATCH', payload: 'REF_VALUE_UNSUPPORTED' }[kind];
        expect(f.prepare(args, id, visible)).toMatchObject({ status: 'rejected', issue: { code } });
        expect(f.core.store.inspect().activeHolds).toBe(0); f.core.lifecycle.dispose();
    });
    it('captures array entries without running getters or accepting sparse arrays', () => {
        const f = fixture(); let reads = 0;
        const many = Object.defineProperty([], '0', { enumerable: true, get() { reads++; return 'a'; } });
        for (const value of [many, new Array(1)]) {
            expect(f.prepare({ many: value })).toMatchObject({ status: 'rejected', issue: { code: 'TOOL_INVALID_ARGS' } });
        }
        expect(reads).toBe(0); expect(f.core.store.inspect().activeHolds).toBe(0); f.core.lifecycle.dispose();
    });
    it.each(['order', 'missing', 'param', 'snapshot', 'extra', 'ordinary'] as const)('Worker rejects altered provenance or ordinary data: %s', kind => {
        const f = fixture(), p = f.prepare({ many: ['$a.items.a', '$a.items.b'], ordinary: 'keep' });
        if (p.status !== 'prepared') throw Error('prepare');
        try {
            const m = f.message(p);
            const refSources = kind === 'order' ? [...m.refSources].reverse() : kind === 'missing' ? m.refSources.slice(1)
                : m.refSources.map((s, index) => index ? s : { ...s, ...(kind === 'param' ? { param: 'other' }
                    : kind === 'snapshot' ? { snapshotId: 'other' } : kind === 'extra' ? { index: 1 } : {}) });
            const changed = { ...m, refSources };
            if (kind === 'ordinary') expect(() => captureToolInvocation({ ...changed, effectiveArgs: { ordinary: 'changed' } })).toThrow();
            else expect(validateInvocationParameters(captureToolInvocation(changed)).status).toBe('rejected');
        } finally { f.core.lifecycle.dispose(); }
    });
});
