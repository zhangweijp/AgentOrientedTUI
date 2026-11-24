import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { readDOMAppViews } from './dom-app.js';
import { createSnapshotCore } from '@aotui/core/host';
import { SemanticProjectionCoordinator } from '@aotui/core/producer';
import type { JsonValue } from '@aotui/core';
import { refKey } from '@aotui/core';
import { compileToolParameters } from '@aotui/core';
function documentWithView(id = 'workspace') {
    const { document } = parseHTML('<html><body><div id="root"><div data-view-id="' +
        id + '" data-aotui-view="Workspace"></div></div></body></html>');
    return document.querySelector('#root')!;
}

describe('DOM producer preserves Ref payloads as snapshot data', () => {
    const setup = (refs: Record<string, JsonValue>) => {
        const root = documentWithView();
        const node = root.querySelector('[data-view-id]')!;
        const toolId = JSON.stringify(['task_app', 'Workspace', 'replace_file']);
        const compiled = compileToolParameters({ type: 'object', properties: { file: { 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: false });
        if (!compiled.ok) throw Error('Ref Schema fixture');
        const owner = { viewId: 'workspace', viewInstanceId: 'vi:v1:["logical-run",1]', viewType: 'Workspace' };
        const projection = new SemanticProjectionCoordinator({ identity: () => ({ appId: 'task_app', instanceId: 'logical-run' }) });
        const prepare = () => {
            const local = Object.entries(refs).map(([id, value]) => ({ id, scope: 'protected' as const, valueSchema: { type: 'object' }, value }));
            const views = readDOMAppViews(root, current => current === node
                ? { id: owner.viewId, name: owner.viewId, region: 'dynamic', type: owner.viewType, owner, bindings: [], refs: local } : undefined, 1);
            expect(projection.commit(() => ({
                views: views.map(({ owner: _owner, bindings: _bindings, refs: _refs, ...view }) => ({
                    ...view, viewInstanceId: owner.viewInstanceId, toolBindings: [{ toolId, activationId: 'active-1' }],
                })),
                refs: views.flatMap(view => view.refs.map(ref => ({ ...ref, viewId: view.id, viewInstanceId: owner.viewInstanceId }))),
                tools: [{ multiplicity: 'multiple', id: toolId, viewType: 'Workspace', name: 'replace_file',
                     description: 'Replace file with a version guard', inputSchema: compiled.contract.schema }],
            }))).toMatchObject({ status: 'prepared' });
            const publication = projection.nextPublication();
            if (!('draft' in publication)) throw new Error(publication.failure.issue.message);
            return publication.draft;
        };
        return { toolId, capture: prepare };
    };

    it('does not interpret entity-looking payload data as an execution target', () => {
        const { capture, toolId } = setup({
            'file': {
                $aotuiEntityRefV1: {
                    entityType: 'File', entityId: '/workspace/src/App.tsx', entityVersion: 'v1',
                },
            },
            'selected': { id: 'other data' },
        });
        const draft = capture();
        const instanceId = draft.views[0].viewInstanceId;
        expect(draft.refs[refKey('workspace', instanceId, 'file')].target).toEqual({ kind: 'snapshot-value', payload: {
            $aotuiEntityRefV1: { entityType: 'File', entityId: '/workspace/src/App.tsx', entityVersion: 'v1' },
        } });
        expect(draft.refs[refKey('workspace', instanceId, 'selected')].target)
            .toEqual({ kind: 'snapshot-value', payload: { id: 'other data' } });
        expect(draft.views[0]!.toolBindings).toEqual([{ toolId, activationId: 'active-1' }]);

        const core = createSnapshotCore({ appId: draft.appId, instanceId: draft.instanceId });
        expect(core.committer.accept(draft).status).toBe('published');
    });

});
