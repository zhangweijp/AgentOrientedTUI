import { describe, expect, it, vi } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { validatePreparedV3Draft } from '../snapshot/v3-validator.js';
import { acquireToolSource } from './source-binding.js';
import { compileOrdinarySchema } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';
import { createViewOwnedTools } from './view-owned-tools.js';
const field = (refType = 'File') => ({ type: 'string', minLength: 1, 'x-aotui-ref-kind': refType, 'x-aotui-ref-value': { type: 'object' } });
const input = (refType = 'File') => ({ type: 'object', properties: { file: field(refType) }, required: ['file'], additionalProperties: true });
function schema(refType = 'File'): any {
    const c = compileOrdinarySchema(input(refType), 'view-type-parameters-v1'); if (!c.ok) throw Error('fixture'); return ordinaryParameterProfile(c.contract);
}
function draft(inputSchema = schema(), activationId = 'active-1', sequence = 1): any {
    const id = JSON.stringify(['app', 'FileDetail', 'inspect']);
    return { schemaVersion: 3, appId: 'app', instanceId: 'run', producerSeq: sequence, sourceEpoch: sequence, capturedAt: sequence,
        views: [{ id: 'fd_A', viewInstanceId: 'mount', type: 'FileDetail', name: 'A', kind: 'state', content: { format: 'markdown-v1', value: 'A' } }], refs: {},
        tools: { [id]: { id, name: 'inspect', viewType: 'FileDetail', description: 'Inspect', inputSchema, 
            execution: { kind: 'view-type', activationId } } } };
}
function setup() { const registry = createViewOwnedTools('app', 'run'); registry.mount('fd_A', 'FileDetail'); registry.mount('fd_B', 'FileDetail'); return registry; }
function register(registry: ReturnType<typeof setup>, inputSchema: any = input()) {
    return registry.registerTypeTool({ viewType: 'FileDetail', name: 'inspect', description: 'Inspect', inputSchema }, {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: () => async () => ({ phase: 'entered-returned', result: { success: true } }),
    });
}
describe('shared versioned Ref declaration boundary', () => {
    it.each(['File', 'Todo', ' File '])('preserves explicit refType %s', refType => {
        const s = schema(refType); expect(s.properties.file['x-aotui-ref-kind']).toBe(refType);
        expect(validatePreparedV3Draft(draft(s)).ok).toBe(true);
    });
    it.each(['empty-kind', 'non-string-kind', 'wrong-type', 'missing-value', 'unknown-field'])('rejects malformed declaration %s', kind => {
        const s: any = input(); const f = s.properties.file;
        if (kind === 'empty-kind') f['x-aotui-ref-kind'] = '';
        if (kind === 'non-string-kind') f['x-aotui-ref-kind'] = 2;
        if (kind === 'wrong-type') f.type = 'object';
        if (kind === 'missing-value') delete f['x-aotui-ref-value'];
        if (kind === 'unknown-field') f.extra = true;
        expect(compileOrdinarySchema(s, 'view-type-parameters-v1').ok).toBe(false);
    });
    it('rejects declaration accessors without executing them', () => {
        const s = input(); const getter = vi.fn(() => 'File'); Object.defineProperty(s.properties.file, 'x-aotui-ref-kind', { enumerable: true, get: getter });
        expect(compileOrdinarySchema(s, 'view-type-parameters-v1').ok).toBe(false); expect(getter).not.toHaveBeenCalled();
    });
    it('normalizes equivalent property order and registers one shared Tool for two Views', () => {
        const a = compileOrdinarySchema({ ...input(), properties: { file: field(), question: { type: 'string' } } }, 'view-type-parameters-v1');
        const b = compileOrdinarySchema({ ...input(), properties: { question: { type: 'string' }, file: field() } }, 'view-type-parameters-v1');
        if (!a.ok || !b.ok) throw Error('fixture'); expect(a.contract.fingerprint).toBe(b.contract.fingerprint);
        const r = setup(); register(r, a.contract.schema); expect(r.listTools()).toHaveLength(1);
        expect(r.listTools()[0]!.execution.kind).toBe('view-type'); expect(r.listViews()).toHaveLength(2); r.dispose();
    });
    it('admits Ref name arrays through the same Snapshot and registration contract', () => {
        const c = compileOrdinarySchema({ type: 'object', properties: { file: { type: 'array', items: field() } }, required: ['file'], additionalProperties: false }, 'view-type-parameters-v1');
        if (!c.ok) throw Error('fixture');
        expect(validatePreparedV3Draft(draft(ordinaryParameterProfile(c.contract))).ok).toBe(true);
        const r = setup(); const release = register(r, c.contract.schema);
        expect(r.listTools()).toHaveLength(1); release(); r.dispose();
    });
    it.each(['root', 'nested', 'nested-items', '$defs', 'allOf', 'legacy-marker'])('rejects unsupported profile location %s', kind => {
        const s: any = JSON.parse(JSON.stringify(schema()));
        if (kind === 'root') s['x-aotui-ref'] = { version: 1 };
        if (kind === 'nested') s.properties.file = { type: 'object', properties: { other: field() } };
        if (kind === 'nested-items') s.properties.file = { type: 'array', items: { type: 'array', items: field() } };
        if (kind === '$defs') s.$defs = { file: field() };
        if (kind === 'allOf') s.allOf = [];
        if (kind === 'legacy-marker') s['x-aotui-parameter-contract'] = 'snapshot-value-params-v1';
        expect(validatePreparedV3Draft(draft(s)).ok).toBe(false);
    });
    it('preserves marker-shaped business default data', () => {
        const payload = { 'x-aotui-ref': { version: 99 } };
        const s = compileOrdinarySchema({ type: 'object', properties: { ordinary: { type: 'object', default: payload } } });
        expect(s.ok).toBe(true); if (!s.ok) throw Error('fixture');
        expect(validatePreparedV3Draft(draft(ordinaryParameterProfile(s.contract))).ok).toBe(true);
    });
    it('admits Ref parameters but rejects old Snapshot versions and metadata', () => {
        expect(validatePreparedV3Draft(draft(schema())).ok).toBe(true);
        expect(validatePreparedV3Draft({ ...draft(), schemaVersion: 1 }).ok).toBe(false);
        const bad = JSON.parse(JSON.stringify(schema())); bad.properties.file['x-aotui-ref'] = { version: 1 };
        expect(validatePreparedV3Draft(draft(bad)).ok).toBe(false);
    });
    it('refuses duplicate owners atomically regardless of equivalent or changed schema', () => {
        const r = setup(); register(r); const before = r.listTools();
        for (const kind of ['File', 'Todo']) expect(() => register(r, input(kind))).toThrow(expect.objectContaining({ code: 'TOOL_DUPLICATE' }));
        expect(r.listTools()).toEqual(before); r.dispose();
    });
    it('rejects registration getters without publishing a ghost', () => {
        const r = setup(); const getter = vi.fn(() => field()); const s = input();
        Object.defineProperty(s.properties, 'file', { enumerable: true, get: getter });
        expect(() => register(r, s)).toThrow(); expect(getter).not.toHaveBeenCalled(); expect(r.listTools()).toEqual([]); r.dispose();
    });
    it('does not convert old ordinary observations into Ref calls after a contract change', () => {
        const c = createSnapshotCore(); c.lifecycle.startApp('app', 'run');
        const plain = compileOrdinarySchema({ type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }); if (!plain.ok) throw Error('fixture');
        const old = c.committer.accept(draft(ordinaryParameterProfile(plain.contract))); if (old.status !== 'published') throw Error('fixture');
        const held = c.store.acquire(old.snapshot.id, { lifetime: 'owner' }); if (held.status !== 'acquired') throw Error('holder');
        expect(c.committer.accept(draft(schema(), 'active-2', 2)).status).toBe('published');
        expect(acquireToolSource(c.store, { snapshotId: old.snapshot.id, appId: 'app', instanceId: 'run', toolId: Object.keys(old.snapshot.tools)[0]!,
            execution: { kind: 'view-type', activationId: 'active-1' } })).toMatchObject({ status: 'rejected', issue: { code: 'TOOL_SOURCE_STALE' } }); held.lease.release(); c.lifecycle.dispose();
    });
    it('rejects oversize Ref metadata without truncation', () => {
        const bad = input('x'.repeat(70 * 1024)); expect(compileOrdinarySchema(bad, 'view-type-parameters-v1').ok).toBe(false);
        expect(validatePreparedV3Draft(draft({ ...bad, 'x-aotui-parameter-contract': 'view-type-parameters-v1' })).ok).toBe(false);
    });
});
