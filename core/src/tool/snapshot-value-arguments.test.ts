import { expect, it, vi } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { refKey, RAW_TOOL_ARGUMENT_LIMITS, RESOLVED_TOOL_ARGUMENT_LIMITS } from '../snapshot/snapshot-support.js';
import { copyWireJson, checkWireJson, utf8Size } from '../snapshot/json.js';
import type { JsonValue, RefDescriptor } from '../snapshot/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/types.js';
import { compileToolParameters } from './tool-parameters.js';
import { prepareViewTypeParameters } from './snapshot-value-arguments.js';
import type { RefGrant } from '../invocation/observation-types.js';

const body = { email: 'one@example.test', 'display.name': '原值', '0': null };
const item = { type: 'object', properties: { email: { type: 'string' }, 'display.name': { type: 'string' }, '0': { type: 'null' } },
    required: ['email', 'display.name', '0'], additionalProperties: false };
const contact = { 'x-aotui-ref-kind': 'Contact', 'x-aotui-ref-value': item };
const number = { type: 'integer' };
const string = { type: 'string' };
const addr = (path: string) => '$ref.app.list.' + path;
function fixture() {
    const core = createSnapshotCore({ appId: 'app', instanceId: 'run' });
    const schema = compileToolParameters({ type: 'object', properties: {
        ordinary: {}, items: { type: 'array', items: {} }, nominal: contact,
        labels: { type: 'array', items: contact }, text: string, number,
        sealed: { type: 'array', items: false, minItems: 2, prefixItems: [string, number] },
    }, additionalProperties: false });
    if (!schema.ok) throw Error(schema.issue.message);
    const contract = schema.contract;
    const tool = { id: JSON.stringify(['app', 'list', 'take']), name: 'take', viewType: 'list',
        multiplicity: 'single' as const, description: 'Select a value', inputSchema: contract.schema };
    function ref(id: string, payload: JsonValue, valueSchema: JsonValue, extra: Partial<RefDescriptor> = {}): RefDescriptor {
        return { continuity: [1,1,0] as const,  id, ownerViewId: 'list', ownerViewInstanceId: 'm:1', refType: 'Contact', scope: 'protected',
            target: { kind: 'snapshot-value', payload }, valueSchema, ...extra };
    }
    function publish(sequence: number, value: typeof body) {
        const values = [
            ref('people', [value], { type: 'array', items: item }, { array: true }),
            ref('plain', [value], { type: 'array', items: item }),
            ref('number', 42, number), ref('secret', 'restricted', string, { scope: 'private', continuity: [1,0,0] }),
            ref('wideA', '字'.repeat(116_000), string), ref('wideB', '字'.repeat(116_000), string),
        ];
        const result = core.committer.accept({ healthySince: 1,  schemaVersion: SNAPSHOT_SCHEMA_VERSION, appId: 'app', instanceId: 'run',
            producerSeq: sequence, sourceEpoch: sequence, capturedAt: 1,
            views: [{ id: 'list', type: 'list', viewInstanceId: 'm:1', name: 'List', region: 'dynamic',
                content: { format: 'markdown-v1', value: 'Contacts' }, toolBindings: [{ toolId: tool.id, activationId: 'a:1' }] }],
            refs: Object.fromEntries(values.map(ref => [refKey('list', 'm:1', ref.id), ref])),
            tools: { [tool.id]: tool },
        });
        if (result.status === 'rejected') throw Error(result.issue.message);
        return result.snapshot;
    }
    const original = publish(1, body);
    const held = core.store.acquire(original.id);
    if (held.status !== 'acquired') throw Error(held.issue.code);
    const store = { ...core.store, resolveRef: vi.fn(core.store.resolveRef) };
    const grants = Object.values(original.refs).map(ref => ({ refId: ref.id, viewId: 'list', viewInstanceId: 'm:1' }));
    return {
        publish, original, core, store, grants, close() { held.hold.release(); core.lifecycle.dispose(); },
        prepare(input: unknown, visibleRefs: readonly RefGrant[] = grants, viewInstanceId = 'm:1') {
            const owned = copyWireJson(input, RAW_TOOL_ARGUMENT_LIMITS) as Readonly<Record<string, JsonValue>>;
            return prepareViewTypeParameters(store, { appId: 'app', instanceId: 'run', snapshotId: original.id, tool,
                receiver: { viewId: 'list', viewInstanceId, activationId: 'a:1' } }, contract, owned, visibleRefs, 'obs');
        },
    };
}

it('keeps the whole slot and direct elements on the original Snapshot after an update', () => {
    const f = fixture();
    try {
        f.publish(2, { ...body, email: 'new@example.test' });
        const result = f.prepare({ items: [addr('people[0].email'), 'literal', addr('people[0]["display.name"]'), addr('people[0]["0"]')],
            nominal: addr('people[0]'), labels: [addr('people[0]')], sealed: [addr('people[0].email'), addr('number')] });
        expect(result).toMatchObject({ status: 'prepared', effectiveArgs: {
            items: [body.email, 'literal', body['display.name'], null], nominal: body, labels: [body], sealed: [body.email, 42],
        } });
        if (result.status !== 'prepared') throw Error(result.issue.code);
        expect(result.refSources.map(source => [source.param, source.index])).toEqual([
            ['items', 0], ['items', 2], ['items', 3], ['nominal', undefined], ['labels', 0], ['sealed', 0], ['sealed', 1],
        ]);
        expect(result.refSources.every(source => source.snapshotId === f.original.id)).toBe(true);
        expect(Object.isFrozen(result.effectiveArgs.nominal)).toBe(true);
        expect(Object.isFrozen(result.effectiveArgs.items)).toBe(true);
        expect(f.core.store.inspect().activeHolds).toBe(1);
    } finally { f.close(); }
});
it('recognizes only the reserved complete prefix and decodes literal selection once', () => {
    const f = fixture();
    try {
        const literals = ['$HOME', '$100', '$$HOME', '$.items[0].name', '$.ajax(opts)', 'body ' + addr('secret')];
        const nested = { $ref: '#/defs/User', list: [addr('secret'), '$' + addr('secret')] };
        const result = f.prepare({ ordinary: nested, items: [...literals, '$$ref.x', '$$$ref.x', '$$$$ref.x', [addr('secret')]],
            text: '$$$ref.x' });
        expect(result).toMatchObject({ status: 'prepared', refSources: [], effectiveArgs: {
            ordinary: nested, items: [...literals, '$ref.x', '$$ref.x', '$$$ref.x', [addr('secret')]], text: '$$ref.x',
        } });
        expect(f.store.resolveRef).not.toHaveBeenCalled();
    } finally { f.close(); }
});
it.each([
    [{ nominal: body }, 'REF_TYPE_MISMATCH'],
    [{ nominal: addr('plain[0]') }, 'REF_TYPE_MISMATCH'],
    [{ nominal: addr('people[0].email') }, 'REF_TYPE_MISMATCH'],
    [{ labels: [addr('plain[0]')] }, 'REF_TYPE_MISMATCH'],
    [{ labels: addr('plain') }, 'TOOL_INVALID_ARGS'],
    [{ labels: addr('people') }, 'TOOL_INVALID_ARGS'],
    [{ text: addr('people[0]') }, 'REF_VALUE_UNSUPPORTED'],
    [{ text: addr('people[2].email') }, 'REF_TARGET_UNSUPPORTED'],
    [{ text: addr('people[0][0]') }, 'REF_TARGET_UNSUPPORTED'],
    [{ text: '$ref.not-an-address' }, 'TOOL_INVALID_ARGS'],
    [{ text: addr('unlisted') }, 'REF_NOT_VISIBLE'],
    [{ ordinary: addr('wideA'), items: [addr('wideB')] }, 'REF_ARGUMENT_BUDGET_EXCEEDED'],
] as const)('rejects unavailable or invalid parameters before dispatch %#', (input, code) => {
    const f = fixture();
    try { expect(f.prepare(input)).toMatchObject({ status: 'rejected', issue: { code } }); }
    finally { f.close(); }
});
it('checks exact receiver identities for a private Ref and a Host allowlist', () => {
    const f = fixture();
    try {
        expect(f.prepare({ text: addr('secret') })).toMatchObject({ status: 'prepared', effectiveArgs: { text: 'restricted' } });
        expect(f.prepare({ text: addr('secret') }, f.grants, 'another-mount')).toMatchObject({
            status: 'rejected', issue: { code: 'TOOL_PERMISSION_DENIED' },
        });
        const grant = { ...f.grants.find(ref => ref.refId === 'secret')!, consumers: [{
            appId: 'app', instanceId: 'new-run', viewId: 'list', viewInstanceId: 'm:1',
        }] };
        expect(f.prepare({ text: addr('secret') }, [grant])).toMatchObject({ status: 'rejected', issue: { code: 'REF_NOT_VISIBLE' } });

    } finally { f.close(); }
});
it('measures the original and expanded boundaries with actual UTF-8 JSON lengths', () => {
    const raw = { '中文': '\\\"汉字\n'.repeat(500) + '\uD800' };
    const bytes = utf8Size(JSON.stringify(raw));
    const captured = copyWireJson(raw, { ...RAW_TOOL_ARGUMENT_LIMITS, maxCanonicalBytes: bytes });
    expect(captured).toEqual(raw);
    expect(captured).not.toBe(raw);
    expect(() => copyWireJson(raw, { ...RAW_TOOL_ARGUMENT_LIMITS, maxCanonicalBytes: bytes - 1 })).toThrow(/Encoded JSON/);
    expect(() => checkWireJson(captured, { ...RESOLVED_TOOL_ARGUMENT_LIMITS, maxCanonicalBytes: bytes })).not.toThrow();
    expect(() => checkWireJson(captured, { ...RESOLVED_TOOL_ARGUMENT_LIMITS, maxCanonicalBytes: bytes - 1 })).toThrow(/Encoded JSON/);
});
