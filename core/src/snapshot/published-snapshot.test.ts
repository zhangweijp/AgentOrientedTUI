import { describe, expect, it } from 'vitest';
import { compileToolParameters } from '../tool/tool-parameters.js';
import { createSnapshotCore } from './store.js';
import { refKey } from './snapshot-support.js';
import { validatePreparedSnapshot } from './validate-snapshot.js';

const fixtureJsonSchema = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, { type: 'object' }, { type: 'array', items: {} }] };


const appId = 'editor', instanceId = 'run-1', viewId = 'file_a', viewInstanceId = 'm:1';
const viewType = 'FileDetail';
const typeId = JSON.stringify([appId, viewType, 'edit_file']);
const refId = JSON.stringify([appId, viewType, 'read_ref']);
const target = { viewId, viewInstanceId, bindingVersion: 4 };
const ordinary = compileToolParameters({ type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false });
const snapshotValue = compileToolParameters({ type: 'object', properties: { file: { 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: false });
if (!ordinary.ok || !snapshotValue.ok) throw new Error('Snapshot fixtures must compile');

function draft() {
    return { healthySince: 1,
        schemaVersion: 9 as const, appId, instanceId, producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
        views: [{ toolBindings:[{toolId:typeId,activationId:"a:1"},{toolId:refId,activationId:"a:2"}], id: viewId, viewInstanceId, type: viewType, name: 'file-a', region: 'dynamic' as const,
            content: { format: 'markdown-v1' as const, value: '# Current file' } }],
        refs: { [refKey(viewId, viewInstanceId, 'file')]: { continuity: [1,1,0] as const,  valueSchema: { type: 'object' }, scope: 'protected', id: 'file', ownerViewId: viewId,
            ownerViewInstanceId: viewInstanceId, refType: 'File', target: { kind: 'snapshot-value' as const, payload: { path: 'a.txt' } } } },
        tools: {
            [typeId]: { multiplicity: 'multiple', id: typeId, name: 'edit_file', viewType,  description: 'Edit an opened FileView',
                inputSchema: ordinary.contract.schema },
            [refId]: { multiplicity: 'multiple', id: refId, name: 'read_ref', viewType,  description: 'Read a captured Ref',
                inputSchema: snapshotValue.contract.schema },
        },
    };
}

describe('Published Snapshot', () => {
    it('accepts a type Tool with activation identity and a Ref parameter with its real View payload owner', () => {
        const result = validatePreparedSnapshot(draft());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.draft.views[0]!.toolBindings).toHaveLength(2);
        expect(result.value.draft.tools[typeId]).not.toHaveProperty('targets');
        expect(result.value.draft.tools[refId]).not.toHaveProperty('execution');
    });

    it('rejects a type Tool while its ViewType is absent and rejects arbitrary ordinary target injection', () => {
        const absent = draft(); absent.views = [];
        delete absent.tools[refId]; absent.refs = {};
        expect(validatePreparedSnapshot(absent)).toMatchObject({ ok: false, issue: { path: expect.stringContaining('tools') } });

        const forged = draft() as any;
        forged.tools[typeId].execution = { kind: 'view-instance', targets: [target] };
        expect(validatePreparedSnapshot(forged)).toMatchObject({ ok: false, issue: { path: expect.stringContaining('execution') } });
    });

    it('rejects stale instance ownership and duplicate activation IDs', () => {
        const stale = draft();
        stale.refs[refKey(viewId, viewInstanceId, 'file')]!.ownerViewInstanceId = 'closed-mount';
        expect(validatePreparedSnapshot(stale)).toMatchObject({ ok: false, issue: { path: expect.stringContaining('refs') } });

        const duplicate = draft();
        duplicate.views[0]!.toolBindings[1]!.activationId = 'a:1';
        expect(validatePreparedSnapshot(duplicate)).toMatchObject({ ok: false, issue: { path: expect.stringContaining('toolBindings') } });
    });

    it.each([
        [{ format: 'semantic-v1', value: { text: 'retired' } }, 'format'],
        [{ format: 'markdown-v1', value: { text: 'invalid' } }, 'value'],
    ])('rejects retired or invalid View content %j', (content, field) => {
        const input = draft();
        expect(validatePreparedSnapshot({ ...input, views: [{ ...input.views[0], content }] }))
            .toMatchObject({ ok: false, issue: { code: 'SNAPSHOT_INVALID', path: `$.views[0].content.${field}` } });
    });

    it('commits only the current Snapshot format and retrieves type-level Tools without an instance target', () => {
        const core = createSnapshotCore({ appId, instanceId });
        const result = core.committer.accept(draft());
        if (result.status === 'rejected') throw new Error(JSON.stringify(result.issue));
        expect(result.status).toBe('published');
        if (result.status !== 'published') return;
        expect(result.snapshot.schemaVersion).toBe(9);
        expect(result.snapshot.id).toContain('aotui-app-snapshot:v9:');
        expect(core.committer.accept({ ...draft(), schemaVersion: 6 })).toMatchObject({ status: 'rejected', issue: { path: '$.schemaVersion' } });
        expect(result.snapshot.tools[typeId]).toMatchObject({ id: typeId, viewType });
        expect(core.committer.accept({ ...draft(), schemaVersion: 4 })).toMatchObject({ status: 'rejected', issue: { path: '$.schemaVersion' } });
        expect(core.committer.accept({ ...draft(), schemaVersion: 2 })).toMatchObject({ status: 'rejected', issue: { path: '$.schemaVersion' } });
        expect(core.committer.accept({ ...draft(), schemaVersion: 1 })).toMatchObject({ status: 'rejected', issue: { path: '$.schemaVersion' } });
        core.lifecycle.dispose();
    });

    it('versions a type Tool activation change even when View content and schema stay the same', () => {
        const core = createSnapshotCore({ appId, instanceId });
        const first = core.committer.accept(draft());
        expect(first.status).toBe('published');
        if (first.status !== 'published') return;
        const held = core.store.acquire(first.snapshot.id); if (held.status !== 'acquired') throw Error('holder');
        const equal = core.committer.accept({ ...draft(), producerSeq: 2, sourceEpoch: 2, capturedAt: 2 });
        expect(equal.status).toBe('unchanged');
        const changed = draft();
        changed.producerSeq = 3; changed.sourceEpoch = 3; changed.capturedAt = 3;
        changed.views[0]!.toolBindings[0]!.activationId = 'a:3';
        const next = core.committer.accept(changed);
        expect(next.status).toBe('published');
        if (next.status === 'published') {
            expect(next.snapshot.revision).toBe(2);
            expect(next.snapshot.contentDigest).not.toBe(first.snapshot.contentDigest);
            expect(core.store.getById(first.snapshot.id)).toMatchObject({ status: 'found',
                snapshot: { tools: { [typeId]: { id: typeId, viewType } } } });
        }
        held.hold.release(); core.lifecycle.dispose();
    });

    it.each([
        ['empty target list', (tool: any) => { tool.execution.targets = []; }],
        ['duplicate target', (tool: any) => { tool.execution.targets.push({ ...tool.execution.targets[0] }); }],
        ['unversioned target', (tool: any) => { tool.execution.targets[0].bindingVersion = 0; }],
        ['wrong View ID', (tool: any) => { tool.execution.targets[0].viewId = 'missing'; }],
        ['wrong View instance', (tool: any) => { tool.execution.targets[0].viewInstanceId = 'closed-mount'; }],
        ['ordinary target field', (tool: any) => { tool.execution.target = { filePath: 'a.txt' }; }],
    ])('rejects malformed instance execution: %s', (_name, mutate) => {
        const value = draft() as any;
        value.tools[refId].execution = { kind: 'view-instance', targets: [{ ...target }] };
        mutate(value.tools[refId]);
        expect(validatePreparedSnapshot(value).ok).toBe(false);
    });

    it('rejects noncanonical Tool IDs and unknown Tool fields before publication', () => {
        const wrongId = draft(); wrongId.tools[typeId]!.id = JSON.stringify(['other-app', 'FileDetail', 'edit_file']);
        expect(validatePreparedSnapshot(wrongId).ok).toBe(false);
        const unknown = draft() as any; unknown.tools[typeId].target = { filePath: 'a.txt' };
        expect(validatePreparedSnapshot(unknown).ok).toBe(false);
    });

    it('allows two ViewTypes to use the same business action name', () => {
        const input = draft(), secondId = JSON.stringify([appId, 'Result', 'edit_file']);
        input.views.push({ ...input.views[0]!, id: 'result', viewInstanceId: 'm:2', type: 'Result',
            toolBindings: [{ toolId: secondId, activationId: 'a:3' }] });
        input.tools[secondId] = { ...input.tools[typeId]!, id: secondId, viewType: 'Result' };
        expect(validatePreparedSnapshot(input).ok).toBe(true);
    });

    it('validates Ref valueSchema declarations and payloads at snapshot acceptance', () => {
        const key = refKey(viewId, viewInstanceId, 'count');
        const withSchema = (valueSchema: unknown, payload: unknown) => {
            const input = draft();
            input.refs = {
                [key]: { continuity: [1,1,0] as const,  valueSchema: fixtureJsonSchema,
                    scope: 'protected', id: 'count', ownerViewId: viewId, ownerViewInstanceId: viewInstanceId,
                    refType: 'Number', target: { kind: 'snapshot-value', payload: payload as any },
                    ...(valueSchema === undefined ? {} : { valueSchema: valueSchema as any }),
                },
            };
            return validatePreparedSnapshot(input);
        };
        expect(withSchema({}, 42)).toMatchObject({ ok: false, issue: { path: expect.stringContaining('valueSchema') } });
        expect(withSchema({ anyOf: [{ type: 'object' }, {}] }, 42)).toMatchObject({
            ok: false, issue: { code: 'SNAPSHOT_INVALID', path: expect.stringMatching(/\.valueSchema\.anyOf\[1\]$/) },
        });
        expect(withSchema({ type: 'number' }, 'text')).toMatchObject({ ok: false, issue: { path: expect.stringContaining('target.payload') } });
        expect(withSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] }, null).ok).toBe(true);
        expect(withSchema(undefined, 'anything').ok).toBe(true);
        expect(withSchema({ type: 'number' }, 42).ok).toBe(true);
    });
});
