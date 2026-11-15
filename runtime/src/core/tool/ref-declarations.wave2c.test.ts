import { describe, expect, it, vi } from 'vitest';
import { validatePreparedV4Draft } from '../snapshot/v4-validator.js';
import { compileOrdinarySchema } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';
import { createViewOwnedTools } from './view-owned-tools.js';
const field = (refType = 'File') => ({ type: 'string', minLength: 1, 'x-aotui-ref-kind': refType, 'x-aotui-ref-value': { type: 'object' } });
const input = (refType = 'File') => ({ type: 'object', properties: { file: field(refType) }, required: ['file'], additionalProperties: true });
function schema(refType = 'File'): any {
    const c = compileOrdinarySchema(input(refType)); if (!c.ok) throw Error('fixture'); return ordinaryParameterProfile(c.contract);
}
function draft(inputSchema = schema(), activationId = 'active-1', sequence = 1): any {
    const id = JSON.stringify(['app', 'FileDetail', 'inspect']);
    return { schemaVersion: 4, appId: 'app', instanceId: 'run', producerSeq: sequence, sourceEpoch: sequence, capturedAt: sequence,
        views: [{ toolBindings: [{ toolId: id, activationId }], id: 'fd_A', viewInstanceId: 'mount', type: 'FileDetail', name: 'A', kind: 'state', content: { format: 'markdown-v1', value: 'A' } }], refs: {},
        tools: { [id]: { id, name: 'inspect', viewType: 'FileDetail', description: 'Inspect', inputSchema } } };
}
const setup = () => createViewOwnedTools('app', 'run');
function register(registry: ReturnType<typeof setup>, inputSchema: Readonly<Record<string, unknown>> = input()) {
    registry.defineTools([{ viewType: 'FileDetail', name: 'inspect', description: 'Inspect', inputSchema }]);
}
function publish(registry: ReturnType<typeof setup>) {
    const frame = registry.prepareFrame(['fd_A','fd_B'].map(id => ({
        id, type: 'FileDetail', owner: {},
        bindings: [{ name: 'inspect', enabled: true, execute: () => ({ success: true }) }],
    })));
    frame.accept();
    return frame;
}
describe('shared versioned Ref declaration boundary', () => {
    it.each(['File', 'Todo', ' File '])('preserves explicit refType %s', refType => {
        const s = schema(refType); expect(s.properties.file['x-aotui-ref-kind']).toBe(refType);
        expect(validatePreparedV4Draft(draft(s)).ok).toBe(true);
    });
    it.each(['empty-kind', 'non-string-kind', 'wrong-type', 'missing-value', 'unknown-field'])('rejects malformed declaration %s', kind => {
        const s: any = input(); const f = s.properties.file;
        if (kind === 'empty-kind') f['x-aotui-ref-kind'] = '';
        if (kind === 'non-string-kind') f['x-aotui-ref-kind'] = 2;
        if (kind === 'wrong-type') f.type = 'object';
        if (kind === 'missing-value') delete f['x-aotui-ref-value'];
        if (kind === 'unknown-field') f.extra = true;
        expect(compileOrdinarySchema(s).ok).toBe(false);
    });
    it('rejects declaration accessors without executing them', () => {
        const s = input(); const getter = vi.fn(() => 'File'); Object.defineProperty(s.properties.file, 'x-aotui-ref-kind', { enumerable: true, get: getter });
        expect(compileOrdinarySchema(s).ok).toBe(false); expect(getter).not.toHaveBeenCalled();
    });
    it('normalizes equivalent property order and registers one shared Tool for two Views', () => {
        const a = compileOrdinarySchema({ ...input(), properties: { file: field(), question: { type: 'string' } } });
        const b = compileOrdinarySchema({ ...input(), properties: { question: { type: 'string' }, file: field() } });
        if (!a.ok || !b.ok) throw Error('fixture'); expect(a.contract.schema).toEqual(b.contract.schema);
        const r = setup(); register(r, a.contract.schema);
        const frame = publish(r);
        expect(frame.tools).toHaveLength(1);
        expect(frame.instances.map(view => view.toolBindings[0]!.toolId)).toEqual([frame.tools[0]!.id, frame.tools[0]!.id]);
        expect(frame.instances[0]!.toolBindings[0]!.activationId).not.toBe(frame.instances[1]!.toolBindings[0]!.activationId);
        r.dispose();
    });
    it('admits Ref name arrays through the same Snapshot and registration contract', () => {
        const c = compileOrdinarySchema({ type: 'object', properties: { file: { type: 'array', items: field() } }, required: ['file'], additionalProperties: false });
        if (!c.ok) throw Error('fixture');
        expect(validatePreparedV4Draft(draft(ordinaryParameterProfile(c.contract))).ok).toBe(true);
        const r = setup(); register(r, c.contract.schema);
        expect(publish(r).tools).toHaveLength(1); r.dispose();
    });
    it.each(['root', 'nested', 'nested-items', '$defs', 'allOf', 'legacy-marker'])('rejects unsupported profile location %s', kind => {
        const s: any = JSON.parse(JSON.stringify(schema()));
        if (kind === 'root') s['x-aotui-ref'] = { version: 1 };
        if (kind === 'nested') s.properties.file = { type: 'object', properties: { other: field() } };
        if (kind === 'nested-items') s.properties.file = { type: 'array', items: { type: 'array', items: field() } };
        if (kind === '$defs') s.$defs = { file: field() };
        if (kind === 'allOf') s.allOf = [];
        if (kind === 'legacy-marker') s['x-aotui-parameter-contract'] = 'snapshot-value-params-v1';
        expect(validatePreparedV4Draft(draft(s)).ok).toBe(false);
    });
    it('preserves marker-shaped business default data', () => {
        const payload = { 'x-aotui-ref': { version: 99 } };
        const s = compileOrdinarySchema({ type: 'object', properties: { ordinary: { type: 'object', default: payload } } });
        expect(s.ok).toBe(true); if (!s.ok) throw Error('fixture');
        expect(validatePreparedV4Draft(draft(ordinaryParameterProfile(s.contract))).ok).toBe(true);
    });
    it('admits Ref parameters but rejects old Snapshot versions and metadata', () => {
        expect(validatePreparedV4Draft(draft(schema())).ok).toBe(true);
        expect(validatePreparedV4Draft({ ...draft(), schemaVersion: 1 }).ok).toBe(false);
        const bad = JSON.parse(JSON.stringify(schema())); bad.properties.file['x-aotui-ref'] = { version: 1 };
        expect(validatePreparedV4Draft(draft(bad)).ok).toBe(false);
    });
    it('refuses duplicate owners atomically regardless of equivalent or changed schema', () => {
        const r = setup(); register(r); const before = publish(r);
        for (const kind of ['File', 'Todo']) expect(() => register(r, input(kind))).toThrow(expect.objectContaining({ code: 'TOOL_DUPLICATE' }));
        expect(r.listViews()).toEqual(before.instances.map(({toolBindings: _, ...view}) => view)); r.dispose();
    });
    it('rejects registration getters without publishing a ghost', () => {
        const r = setup(); const getter = vi.fn(() => field()); const s = input();
        Object.defineProperty(s.properties, 'file', { enumerable: true, get: getter });
        expect(() => register(r, s)).toThrow(); expect(getter).not.toHaveBeenCalled(); expect(r.inspect()).toMatchObject({ bindings: 0, views: 0 }); r.dispose();
    });
    it('rejects oversize Ref metadata without truncation', () => {
        const bad = input('x'.repeat(70 * 1024)); expect(compileOrdinarySchema(bad).ok).toBe(false);
        expect(validatePreparedV4Draft(draft({ ...bad, 'x-aotui-parameter-contract': 'view-type-parameters-v1' })).ok).toBe(false);
    });
});
