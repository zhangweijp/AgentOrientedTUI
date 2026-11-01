import { describe, expect, it, vi } from 'vitest';
import { createViewOwnedTools } from './view-owned-tools.js';
import { compileSnapshotValueParams } from './snapshot-value-parameter-contract.js';
import { ORDINARY_PARAMETER_MARKER } from './ordinary-parameter-profile.js';
import { validatePreparedV2Draft, createSnapshotCore } from '../snapshot/index.js';
import { acquireToolSource } from './source-binding.js';

const metadata = (refType?: string) => ({ version: 1, kind: 'snapshot-value', owner: 'tool-target',
    ...(refType === undefined ? {} : { refType }) });
const schema = (refType?: string): any => ({ type: 'object', properties: {
    file: { type: 'string', 'x-aotui-ref': metadata(refType) },
}, required: ['file'], additionalProperties: true,
    [ORDINARY_PARAMETER_MARKER]: 'snapshot-value-params-v1' });
function compileRefSchema(params: unknown): any {
    const compiled = compileSnapshotValueParams(params);
    if (!compiled.ok) throw Object.assign(new Error(compiled.issue.message), { code: compiled.issue.code });
    return compiled.contract.schema;
}
const spec = (inputSchema = schema(), isMutating = false) => ({
    name: 'inspect', description: 'Inspect', inputSchema, isMutating,
});
function expectCode(run: () => unknown, code: string) {
    let caught: unknown;
    try { run(); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code });
}
function setup() {
    const registry = createViewOwnedTools('app', 'run');
    const a = registry.mount('fd_A', 'FileDetail');
    const b = registry.mount('fd_B', 'FileDetail');
    return { registry, a, b };
}
function draft(inputSchema = schema(), isMutating = false): any {
    const id = JSON.stringify(['app', 'FileDetail', 'inspect']);
    return { schemaVersion: 2, appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
        views: [{ id: 'fd_A', viewInstanceId: 'mount', type: 'FileDetail', name: 'A', kind: 'state',
            content: { format: 'markdown-v1', value: 'A' } }], refs: {}, tools: {
            [id]: { id, name: 'inspect', viewType: 'FileDetail', description: 'Inspect', inputSchema, isMutating,
                targets: [{ viewId: 'fd_A', viewInstanceId: 'mount', bindingVersion: 1 }] },
        } };
}

describe('Wave 2C: authoritative declaration projection', () => {
    it.each([undefined, 'File', 'Todo'])('preserves opt-in and optional refType %s', refType => {
        const params = { file: { type: 'reference', required: true, refSource: 'snapshot-value-v1',
            ...(refType === undefined ? {} : { refType }) } };
        expect(compileRefSchema(params)).toEqual(schema(refType));
        expect(validatePreparedV2Draft(draft(compileRefSchema(params))).ok).toBe(true);
    });

    it.each([
        ['future', { refSource: 'snapshot-value-v2' }, 'PARAMETER_DECLARATION_UNSUPPORTED'],
        ['non-string version', { refSource: 1 }, 'PARAMETER_DECLARATION_INVALID'],
        ['wrong type', { type: 'string' }, 'PARAMETER_DECLARATION_INVALID'],
        ['required', { required: 'yes' }, 'PARAMETER_DECLARATION_INVALID'],
        ['description', { desc: 12 }, 'PARAMETER_DECLARATION_INVALID'],
        ['empty refType', { refType: ' ' }, 'PARAMETER_DECLARATION_INVALID'],
        ['non-string refType', { refType: 2 }, 'PARAMETER_DECLARATION_INVALID'],
        ['constraints', { constraints: {} }, 'PARAMETER_DECLARATION_INVALID'],
        ['default', { default: {} }, 'PARAMETER_DECLARATION_INVALID'],
        ['array itemType', { itemType: 'reference' }, 'PARAMETER_DECLARATION_INVALID'],
        ['options', { options: ['x'] }, 'PARAMETER_DECLARATION_INVALID'],
        ['unknown field', { extra: true }, 'PARAMETER_DECLARATION_INVALID'],
    ])('rejects parameter declaration %s', (_name, change, code) => {
        expectCode(() => compileRefSchema({ file: { type: 'reference', refSource: 'snapshot-value-v1', ...change } }), code);
    });

    it('does not execute accessors before validating a new declaration', () => {
        const getter = vi.fn(() => 'snapshot-value-v1');
        const field = { type: 'reference' };
        Object.defineProperty(field, 'refSource', { get: getter, enumerable: true });
        expectCode(() => compileRefSchema({ file: field }), 'PARAMETER_DECLARATION_INVALID');
        expect(getter).not.toHaveBeenCalled();
    });

    it('equivalent opt-in parameter key order keeps required and aggregation canonical', () => {
        const file = { type: 'reference', required: true, refSource: 'snapshot-value-v1' };
        const question = { type: 'string', required: true };
        const first = compileRefSchema({ file, question });
        const reordered = compileRefSchema({ question, file });
        expect(reordered).toEqual(first);
        const { registry, a, b } = setup();
        registry.registerTool(a.viewInstanceId, spec(first), async () => ({ success: true }));
        registry.registerTool(b.viewInstanceId, spec(reordered), async () => ({ success: true }));
        expect(registry.listTools()[0].targets).toHaveLength(2);
    });
});

describe('Wave 2C: pure Registry/Snapshot semantic boundary', () => {
    const invalid = [
        ['version', { version: 2 }, 'REF_CONTRACT_UNSUPPORTED'],
        ['version type', { version: '1' }, 'REF_DECLARATION_INVALID'],
        ['kind', { kind: 'entity' }, 'REF_CONTRACT_UNSUPPORTED'],
        ['owner', { owner: 'other-view' }, 'REF_CONTRACT_UNSUPPORTED'],
        ['refType', { refType: '' }, 'REF_DECLARATION_INVALID'],
        ['extra', { extra: true }, 'REF_DECLARATION_INVALID'],
    ] as const;
    it.each(invalid)('rejects malformed reserved declaration %s at both boundaries', (_name, change, code) => {
        const s = schema(); s.properties.file['x-aotui-ref'] = { ...metadata(), ...change };
        const { registry, a } = setup();
        expectCode(() => registry.registerTool(a.viewInstanceId, spec(s), async () => ({ success: true })), code);
        expect(registry.listTools()).toEqual([]);
        expect(validatePreparedV2Draft(draft(s))).toMatchObject({ ok: false, issue: { code } });
    });

    it.each([
        ['root', { type: 'object', 'x-aotui-ref': metadata() }, 'REF_DECLARATION_INVALID'],
        ['nested', { type: 'object', properties: { wrapper: { type: 'object', properties: schema().properties } } }, 'REF_DECLARATION_INVALID'],
        ['items', { type: 'object', properties: { files: { type: 'array', items: schema().properties.file } } }, 'REF_DECLARATION_INVALID'],
        ['$defs', { type: 'object', $defs: { file: schema().properties.file } }, 'REF_DECLARATION_INVALID'],
        ['allOf', { type: 'object', allOf: [schema()] }, 'REF_DECLARATION_INVALID'],
        ['combined root', { ...schema(), allOf: [] }, 'REF_CONTRACT_UNSUPPORTED'],
        ['property sibling', { type: 'object', properties: { file: { ...schema().properties.file, default: 'file' } } }, 'REF_DECLARATION_INVALID'],
        ['wrong property type', { type: 'object', properties: { file: { ...schema().properties.file, type: 'object' } } }, 'REF_DECLARATION_INVALID'],
    ])('rejects unsupported location/combination %s', (_name, s, code) => {
        const { registry, a } = setup();
        expectCode(() => registry.registerTool(a.viewInstanceId, spec(s), async () => ({ success: true })), code);
        expect(validatePreparedV2Draft(draft(s))).toMatchObject({ ok: false, issue: { code } });
    });

    it('rejects mutating declarations and Snapshot V1 descriptors', () => {
        const { registry, a } = setup();
        expectCode(() => registry.registerTool(a.viewInstanceId, spec(schema(), true), async () => ({ success: true })), 'REF_DECLARATION_INVALID');
        expect(validatePreparedV2Draft(draft(schema(), true))).toMatchObject({ ok: false, issue: { code: 'REF_DECLARATION_INVALID' } });
        const v1 = { ...draft(), schemaVersion: 1 };
        expect(validatePreparedV2Draft(v1)).toMatchObject({ ok: false, issue: { code: 'SNAPSHOT_INVALID', path: '$.schemaVersion' } });
    });

    it('preserves unannotated schemas and literal data with a reserved-looking key', async () => {
        const { registry, a } = setup();
        const handler = vi.fn(async () => ({ success: false, error: { code: 'BUSINESS', message: 'Failed' } }));
        const s = { type: 'object', allOf: [], description: 'x-aotui-ref is plain text', properties: {
            'x-aotui-ref': { type: 'string' }, ordinary: { type: 'object', default: { 'x-aotui-ref': { version: 99 } } },
        } };
        registry.registerTool(a.viewInstanceId, spec(s), handler);
        const tool = registry.listTools()[0];
        expect(tool.inputSchema).toEqual(s);
        expect((await registry.invokeOrdinaryParameters(tool, tool.targets[0], { ordinary: { 'x-aotui-ref': 'caller JSON' } })))
            .toMatchObject({ phase: 'not-entered', result: { success: false, error: { code: 'TOOL_EXECUTION_UNAVAILABLE' } } });
        expect(handler).not.toHaveBeenCalled();
    });

    it('canonical conflicts are atomic; equivalent key order aggregates without a partial registration', () => {
        const { registry, a, b } = setup();
        registry.registerTool(a.viewInstanceId, spec(schema('File')), async () => ({ success: true }));
        const before = registry.listTools();
        for (const different of [schema('Todo'), schema(), { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }]) {
            expectCode(() => registry.registerTool(b.viewInstanceId, spec(different), async () => ({ success: true })), 'TOOL_SCHEMA_CONFLICT');
            expect(registry.listTools()).toEqual(before);
        }
        const reordered = schema('File');
        reordered.properties.file['x-aotui-ref'] = { refType: 'File', owner: 'tool-target', kind: 'snapshot-value', version: 1 };
        registry.registerTool(b.viewInstanceId, spec(reordered), async () => ({ success: true }));
        expect(registry.listTools()[0].targets.map(t => t.viewId)).toEqual(['fd_A', 'fd_B']);
    });

    it('rejects a public metadata getter before Registry or Snapshot evaluation', () => {
        const getter = vi.fn(() => 1); const s = schema();
        Object.defineProperty(s.properties.file['x-aotui-ref'], 'version', { get: getter, enumerable: true });
        const { registry, a } = setup();
        expectCode(() => registry.registerTool(a.viewInstanceId, spec(s), async () => ({ success: true })), 'SNAPSHOT_SERIALIZATION_ERROR');
        expect(validatePreparedV2Draft(draft(s))).toMatchObject({ ok: false, issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR' } });
        expect(getter).not.toHaveBeenCalled();
        expect(registry.listTools()).toEqual([]);
    });

    it('a valid Ref profile stays non-executable without a safe V2 callable', async () => {
        const { registry, a } = setup(); const handler = vi.fn(async () => ({ success: true }));
        registry.registerTool(a.viewInstanceId, spec(schema()), handler);
        const tool = registry.listTools()[0];
        for (const args of [{}, { file: 'file' }, { file: '[File](file)' }, { file: { value: 'caller' } }]) {
            expect(await registry.invokeSnapshotValueParameters(tool, tool.targets[0], args)).toMatchObject({
                phase: 'not-entered', result: { success: false, error: { code: 'REF_EXECUTION_UNAVAILABLE' } },
            });
        }
        expect(handler).not.toHaveBeenCalled();
    });

    it('current binding and canonical checks reject stripped annotations and obsolete registrations', async () => {
        const { registry, a } = setup(); const handler = vi.fn(async () => ({ success: true }));
        const release = registry.registerTool(a.viewInstanceId, spec(schema('File')), handler);
        const old = registry.listTools()[0];
        const stripped = { ...old, inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } };
        expect(await registry.invokeSnapshotValueParameters(stripped, old.targets[0], {})).toMatchObject({ phase: 'not-entered', result: { success: false, error: { code: 'TOOL_SOURCE_STALE' } } });
        release(); registry.registerTool(a.viewInstanceId, spec(schema('Todo')), handler);
        const current = registry.listTools()[0];
        expect(current.targets[0].bindingVersion).not.toBe(old.targets[0].bindingVersion);
        expect(await registry.invokeSnapshotValueParameters(old, old.targets[0], {})).toMatchObject({ phase: 'not-entered', result: { success: false, error: { code: 'TOOL_SOURCE_STALE' } } });
        expect(handler).not.toHaveBeenCalled();
    });

    it('old plain source does not acquire new declaration semantics after re-registration', () => {
        const core = createSnapshotCore(); core.lifecycle.startApp('app', 'run');
        const first = draft({ type: 'object', properties: { file: { type: 'string' } }, required: ['file'] });
        const committed = core.committer.accept(first);
        if (committed.status !== 'published') throw new Error('Expected first source');
        const next = draft(); next.producerSeq = 2; next.sourceEpoch = 2;
        next.tools[Object.keys(next.tools)[0]].targets[0].bindingVersion = 2;
        expect(core.committer.accept(next).status).toBe('published');
        expect(acquireToolSource(core.store, { snapshotId: committed.snapshot.id, appId: 'app', instanceId: 'run',
            toolId: Object.keys(first.tools)[0], viewId: 'fd_A' }))
            .toMatchObject({ status: 'rejected', issue: { code: 'TOOL_SOURCE_STALE' } });
    });

    it('new metadata consumes existing Schema/Registry budgets without truncation', () => {
        const s = schema('x'.repeat(70 * 1024));
        expect(validatePreparedV2Draft(draft(s))).toMatchObject({ ok: false, issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR' } });
        const { registry, a } = setup();
        expectCode(() => registry.registerTool(a.viewInstanceId, spec(schema('x'.repeat(140 * 1024))), async () => ({ success: true })), 'SNAPSHOT_SERIALIZATION_ERROR');
        expectCode(() => compileRefSchema({ file: { type: 'reference', refSource: 'snapshot-value-v1', refType: 'x'.repeat(70 * 1024) } }), 'PARAMETER_DECLARATION_INVALID');
        expect(registry.listTools()).toEqual([]);
    });
});
