import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { captureDOMViews } from './dom-snapshot-producer.js';
import { createSnapshotCore, SemanticProjectionCoordinator } from '../core/index.js';
import { refKey } from '../core/snapshot/snapshot-support.js';
import { compileOrdinarySchema } from '../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../core/tool/ordinary-parameter-profile.js';
import type { WorkerRuntimeViewFragment } from './view-fragment-extractor.js';

const fragment = (id: string, type = 'Workspace', markup = '<view>Tasks</view>'): WorkerRuntimeViewFragment => ({
    viewId: id as any, viewType: type, viewName: id,
    markup, kind: 'state',
});

function documentWithView(id = 'workspace') {
    const { document } = parseHTML('<html><body><div id="root"><div data-view-id="' +
        id + '" data-view-type="Workspace" data-view-kind="state"></div></div></body></html>');
    return document.querySelector('#root')!;
}

describe('DOM producer preserves Ref payloads as snapshot data', () => {
    const setup = (refs: Record<string, unknown>) => {
        const root = documentWithView();
        const node = root.querySelector('[data-view-id]')!;
        node.setAttribute('data-view-instance-id', 'vi:v1:["logical-run",1]');
        const toolId = JSON.stringify(['task_app', 'Workspace', 'replace_file']);
        const compiled = compileOrdinarySchema({ type: 'object', properties: { file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: false }, 'view-type-parameters-v1');
        if (!compiled.ok) throw Error('Ref Schema fixture');
        const owner = { viewId: 'workspace', viewInstanceId: 'vi:v1:["logical-run",1]', viewType: 'Workspace' };
        const projection = new SemanticProjectionCoordinator({
            identity: () => ({ appId: 'task_app', instanceId: 'logical-run' }),
            readFrame: () => ({
                views: captureDOMViews(root, [fragment('workspace')], [owner]),
                tools: [{ id: toolId, viewType: 'Workspace', name: 'replace_file',
                    description: 'Replace file with a version guard', inputSchema: ordinaryParameterProfile(compiled.contract),
                    execution: { kind: 'view-type', activationId: 'active-1' } }],
            }),
        });
        const prepare = () => {
            expect(projection.commit(() => {
                for (const [id, value] of Object.entries(refs)) projection.registerRef(owner, id, value as object);
            })).toBe('prepared');
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
        expect(draft.tools[toolId].execution).toMatchObject({ kind: 'view-type', activationId: 'active-1' });

        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'logical-run');
        expect(core.committer.accept(draft).status).toBe('published');
    });

});
