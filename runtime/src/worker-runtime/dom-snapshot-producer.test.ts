import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { captureDOMSnapshot } from './dom-snapshot-producer.js';
import { createSnapshotCore, refKey } from '../core/snapshot/index.js';
import type { WorkerRuntimeViewFragment } from './view-fragment-extractor.js';

const fragment = (id: string, type = 'Workspace', markup = '<view>Tasks</view>'): WorkerRuntimeViewFragment => ({
    viewId: id as any, viewType: type, viewName: id,
    markup, kind: 'view-state', timestamp: 1,
});

function documentWithView(id = 'workspace') {
    const { document } = parseHTML('<html><body><div id="root"><div data-view-id="' +
        id + '" data-view-type="Workspace"></div></div></body></html>');
    return document.querySelector('#root')!;
}

describe('DOM producer preserves Ref payloads as snapshot data', () => {
    const setup = (refs: Record<string, unknown>) => {
        const root = documentWithView();
        const node = root.querySelector('[data-view-id]')!;
        node.setAttribute('data-view-instance-id', 'vi:v1:["logical-run",1]');
        const toolId = JSON.stringify(['task_app', 'Workspace', 'replace_file']);
        const kernel = {
            getViewRefs: () => Object.entries(refs).map(([key, value]) => ({
                viewId: key.slice(0, key.indexOf(':')), refId: key.slice(key.indexOf(':') + 1), value,
            })),
            getViewOwnedViewInstances: () => [{
                viewId: 'workspace', viewInstanceId: 'vi:v1:["logical-run",1]', viewType: 'Workspace',
            }],
            getViewOwnedToolDefinitions: () => [{
                id: toolId, appId: 'task_app', appInstanceId: 'logical-run',
                viewType: 'Workspace', name: 'replace_file',
                description: 'Replace file with a version guard',
                inputSchema: { type: 'object' }, isMutating: true,
                targets: [{
                    viewId: 'workspace',
                    viewInstanceId: 'vi:v1:["logical-run",1]', bindingVersion: 1,
                }],
            }],
        };
        return {
            toolId,
            capture: () => captureDOMSnapshot({
                appId: 'task_app', instanceId: 'logical-run',
                producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
                container: root, fragments: [fragment('workspace')], kernel,
            }),
        };
    };

    it('does not interpret entity-looking payload data as an execution target', () => {
        const { capture, toolId } = setup({
            'workspace:file': {
                $aotuiEntityRefV1: {
                    entityType: 'File', entityId: '/workspace/src/App.tsx', entityVersion: 'v1',
                },
            },
            'workspace:selected': { id: 'other data' },
        });
        const draft = capture();
        const instanceId = draft.views[0].viewInstanceId;
        expect(draft.refs[refKey('workspace', instanceId, 'file')].target).toEqual({ kind: 'snapshot-value', payload: {
            $aotuiEntityRefV1: { entityType: 'File', entityId: '/workspace/src/App.tsx', entityVersion: 'v1' },
        } });
        expect(draft.refs[refKey('workspace', instanceId, 'selected')].target)
            .toEqual({ kind: 'snapshot-value', payload: { id: 'other data' } });
        expect(draft.tools[toolId].targets[0].viewInstanceId).toBe(instanceId);

        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'logical-run');
        expect(core.committer.accept(draft).status).toBe('published');
    });

});
