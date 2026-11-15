import { describe, expect, it } from 'vitest';
import { ordinaryParameterProfile } from '../tool/ordinary-parameter-profile.js';
import { compileOrdinarySchema } from '../tool/ordinary-parameter-contract.js';
import { createSnapshotCore } from './store.js';
import { refKey } from './snapshot-support.js';
import { validatePreparedV4Draft } from './v4-validator.js';

const appId = 'editor', instanceId = 'run-1', viewId = 'file-a', viewInstanceId = 'mount-1';
const viewType = 'FileDetail';
const typeId = JSON.stringify([appId, viewType, 'edit_file']);
const refId = JSON.stringify([appId, viewType, 'read_ref']);
const target = { viewId, viewInstanceId, bindingVersion: 4 };
const ordinary = compileOrdinarySchema({ type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false });
const snapshotValue = compileOrdinarySchema({ type: 'object', properties: { file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: false });
if (!ordinary.ok || !snapshotValue.ok) throw new Error('V4 fixtures must compile');

function draft() {
    return {
        schemaVersion: 4 as const, appId, instanceId, producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
        views: [{ toolBindings:[{toolId:typeId,activationId:"activation-1"},{toolId:refId,activationId:"activation-2"}], id: viewId, viewInstanceId, type: viewType, name: 'file-a', kind: 'state' as const,
            content: { format: 'markdown-v1' as const, value: '# Current file' } }],
        refs: { [refKey(viewId, viewInstanceId, 'file')]: { id: 'file', ownerViewId: viewId,
            ownerViewInstanceId: viewInstanceId, refType: 'File', target: { kind: 'snapshot-value' as const, payload: { path: 'a.txt' } } } },
        tools: {
            [typeId]: { id: typeId, name: 'edit_file', viewType, description: 'Edit an opened FileView',
                inputSchema: ordinaryParameterProfile(ordinary.contract) },
            [refId]: { id: refId, name: 'read_ref', viewType, description: 'Read a captured Ref',
                inputSchema: ordinaryParameterProfile(snapshotValue.contract) },
        },
    };
}

describe('Semantic Snapshot V4', () => {
    it('accepts a type Tool with activation identity and a Ref parameter with its real View payload owner', () => {
        const result = validatePreparedV4Draft(draft());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.draft.views[0]!.toolBindings).toHaveLength(2);
        expect(result.value.draft.tools[typeId]).not.toHaveProperty('targets');
        expect(result.value.draft.tools[refId]).not.toHaveProperty('execution');
    });

    it('rejects a type Tool while its ViewType is absent and rejects arbitrary ordinary target injection', () => {
        const absent = draft(); absent.views = [];
        delete absent.tools[refId]; absent.refs = {};
        expect(validatePreparedV4Draft(absent)).toMatchObject({ ok: false, issue: { path: expect.stringContaining('tools') } });

        const forged = draft() as any;
        forged.tools[typeId].execution = { kind: 'view-instance', targets: [target] };
        expect(validatePreparedV4Draft(forged)).toMatchObject({ ok: false, issue: { path: expect.stringContaining('execution') } });
    });

    it('rejects stale instance ownership and duplicate activation IDs', () => {
        const stale = draft();
        stale.refs[refKey(viewId, viewInstanceId, 'file')]!.ownerViewInstanceId = 'closed-mount';
        expect(validatePreparedV4Draft(stale)).toMatchObject({ ok: false, issue: { path: expect.stringContaining('refs') } });

        const duplicate = draft();
        duplicate.views[0]!.toolBindings[1]!.activationId = 'activation-1';
        expect(validatePreparedV4Draft(duplicate)).toMatchObject({ ok: false, issue: { path: expect.stringContaining('toolBindings') } });
    });

    it.each([
        [{ format: 'semantic-v1', value: { text: 'retired' } }, 'format'],
        [{ format: 'markdown-v1', value: { text: 'invalid' } }, 'value'],
    ])('rejects retired or invalid View content %j', (content, field) => {
        const input = draft();
        expect(validatePreparedV4Draft({ ...input, views: [{ ...input.views[0], content }] }))
            .toMatchObject({ ok: false, issue: { code: 'SNAPSHOT_INVALID', path: `$.views[0].content.${field}` } });
    });

    it('commits only V4 snapshots and retrieves type-level Tools without an instance target', () => {
        const core = createSnapshotCore(); core.lifecycle.startApp(appId, instanceId);
        const result = core.committer.accept(draft());
        if (result.status === 'rejected') throw new Error(JSON.stringify(result.issue));
        expect(result.status).toBe('published');
        if (result.status !== 'published') return;
        expect(result.snapshot.schemaVersion).toBe(4);
        expect(result.snapshot.id).toContain('aotui-app-snapshot:v4:');
        expect(core.store.getTool({ snapshotId: result.snapshot.id, appId, instanceId, toolId: typeId }))
            .toMatchObject({ status: 'found', tool: { id: typeId, viewType } });
        expect(core.committer.accept({ ...draft(), schemaVersion: 2 })).toMatchObject({ status: 'rejected', issue: { path: '$.schemaVersion' } });
        expect(core.committer.accept({ ...draft(), schemaVersion: 1 })).toMatchObject({ status: 'rejected', issue: { path: '$.schemaVersion' } });
        core.lifecycle.dispose();
    });

    it('versions a type Tool activation change even when View content and schema stay the same', () => {
        const core = createSnapshotCore(); core.lifecycle.startApp(appId, instanceId);
        const first = core.committer.accept(draft());
        expect(first.status).toBe('published');
        if (first.status !== 'published') return;
        const held = core.store.acquire(first.snapshot.id, { lifetime: 'owner' }); if (held.status !== 'acquired') throw Error('holder');
        const equal = core.committer.accept({ ...draft(), producerSeq: 2, sourceEpoch: 2, capturedAt: 2 });
        expect(equal.status).toBe('unchanged');
        const changed = draft();
        changed.producerSeq = 3; changed.sourceEpoch = 3; changed.capturedAt = 3;
        changed.views[0]!.toolBindings[0]!.activationId = 'activation-new';
        const next = core.committer.accept(changed);
        expect(next.status).toBe('published');
        if (next.status === 'published') {
            expect(next.snapshot.revision).toBe(2);
            expect(next.snapshot.contentDigest).not.toBe(first.snapshot.contentDigest);
            expect(core.store.getTool({ snapshotId: first.snapshot.id, appId, instanceId, toolId: typeId }))
                .toMatchObject({ status: 'found', tool: { id: typeId, viewType } });
        }
        held.lease.release(); core.lifecycle.dispose();
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
        expect(validatePreparedV4Draft(value).ok).toBe(false);
    });

    it('rejects noncanonical Tool IDs and unknown Tool fields before publication', () => {
        const wrongId = draft(); wrongId.tools[typeId]!.id = JSON.stringify(['other-app', 'FileDetail', 'edit_file']);
        expect(validatePreparedV4Draft(wrongId).ok).toBe(false);
        const unknown = draft() as any; unknown.tools[typeId].target = { filePath: 'a.txt' };
        expect(validatePreparedV4Draft(unknown).ok).toBe(false);
    });
});
