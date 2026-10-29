import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { DomSnapshotShadowProducer, paramsToJsonSchema } from './dom-snapshot-producer.js';
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

function fakeKernel(refs: Record<string, unknown> = { 'workspace:selected': { id: 'a' } }) {
    return {
        exportRefsToIndexMap: () => refs,
        getAllTypeTools: () => new Map([['Workspace', [{
            id: 'task_app-Workspace-complete', name: 'complete', viewType: 'Workspace',
            description: 'Complete a task', params: {
                task: { type: 'reference', required: true, refType: 'Task' },
                priorities: { type: 'array', itemType: 'string' },
                mode: { type: 'enum', options: ['now', 'later'] },
            },
        }]]]),
    };
}

describe('M2 DOM SnapshotProducer adapter', () => {
    it('maps legacy DOM + RefRegistry + ViewTypeTools to one Core-verifiable Draft', () => {
        const root = documentWithView();
        const producer = new DomSnapshotShadowProducer();
        const snapshot = producer.capture({
            appId: 'task_app', instanceId: 'logical-instance', producerSeq: 1,
            sourceEpoch: 1, capturedAt: 1, container: root, fragments: [fragment('workspace')],
            kernel: fakeKernel(),
        });
        expect(snapshot.views[0].type).toBe('Workspace');
        const gen = snapshot.views[0].generation;
        expect(snapshot.refs[refKey('workspace', gen, 'selected')].target).toMatchObject({
            kind: 'snapshot-value', payload: { id: 'a' },
        });
        const tool = snapshot.tools['task_app-Workspace-complete'];
        expect(tool.visible).toBe(true);
        expect(tool.isMutating).toBe(true);
        expect(tool.inputSchema).toMatchObject({
            type: 'object',
            properties: {
                task: { type: 'string' },
                priorities: { type: 'array', items: { type: 'string' } },
                mode: { type: 'string', enum: ['now', 'later'] },
            },
            required: ['task'],
        });
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'logical-instance');
        const result = core.committer.accept(snapshot);
        expect(result.status).toBe('published');
    });

    it('keeps generation for same DOM node but changes generation on remount with same View ID', () => {
        const producer = new DomSnapshotShadowProducer();
        const root = documentWithView();
        const make = (seq: number) => producer.capture({
            appId: 'task_app', instanceId: 'instance', producerSeq: seq,
            sourceEpoch: seq, capturedAt: seq, container: root, fragments: [fragment('workspace')],
            kernel: fakeKernel(),
        });
        const a = make(1);
        const b = make(2);
        expect(a.views[0].generation).toBe(b.views[0].generation);
        const old = root.querySelector('[data-view-id]')!;
        old.remove();
        const replacement = root.ownerDocument.createElement('div');
        replacement.setAttribute('data-view-id', 'workspace');
        root.appendChild(replacement);
        const c = make(3);
        expect(c.views[0].generation).not.toBe(a.views[0].generation);
        expect(c.refs[refKey('workspace', c.views[0].generation, 'selected')]).toBeDefined();
        producer.reset();
        const d = make(1);
        expect(d.views[0].generation).toBe('dom_mount_1');
    });

    it('marks targetless ViewTypeTool not-visible, without making up a target View', () => {
        const producer = new DomSnapshotShadowProducer();
        const result = producer.capture({
            appId: 'task_app', instanceId: 'instance', producerSeq: 1,
            sourceEpoch: 1, capturedAt: 1, container: documentWithView(), fragments: [fragment('workspace')],
            kernel: {
                exportRefsToIndexMap: () => ({}),
                getAllTypeTools: () => new Map([['FileDetail', [{
                    id: 'file_lsp', name: 'hover', viewType: 'FileDetail', description: 'Hover', params: {},
                }]]]),
            },
        });
        expect(result.tools.file_lsp.visible).toBe(false);
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance');
        expect(core.committer.accept(result).status).toBe('published');
    });

    it('does not guess Ref from malformed keys and lets Core reject a ghost View owner', () => {
        const producer = new DomSnapshotShadowProducer();
        const base = {
            appId: 'task_app', instanceId: 'instance', producerSeq: 1, sourceEpoch: 1,
            capturedAt: 1, container: documentWithView(), fragments: [fragment('workspace')],
        };
        expect(() => producer.capture({
            ...base, kernel: fakeKernel({ 'ref-without-scope': { id: 1 } }),
        })).toThrow(/Malformed/);
        const invalid = producer.capture({
            ...base, kernel: fakeKernel({ 'missing:selected': { id: 1 } }),
        });
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance');
        const result = core.committer.accept(invalid);
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.issue.path).toContain('refs');
    });

    it('rejects unknown parameter types or malformed enum rather than silently inventing schema', () => {
        expect(() => paramsToJsonSchema({ task: { type: 'unsupported' } })).toThrow(/Unsupported/);
        expect(() => paramsToJsonSchema({ status: { type: 'enum', options: [] } })).toThrow(/enum/);
        expect(() => paramsToJsonSchema({ jobs: { type: 'array', itemType: 'reference' } })).toThrow(/array/);
    });
});

describe('M3 stable SDK View owner generation', () => {
    it('prefers the explicit SDK View generation even if a renderer reuses the same DOM node', () => {
        const root = documentWithView();
        const node = root.querySelector('[data-view-id]')!;
        const producer = new DomSnapshotShadowProducer();
        const capture = (seq: number) => producer.capture({
            appId: 'task_app', instanceId: 'instance',
            producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
            container: root, fragments: [fragment('workspace')],
            kernel: fakeKernel(),
        });
        node.setAttribute('data-view-generation', 'sdk_mount_A');
        const first = capture(1);
        expect(first.views[0].generation).toBe('sdk_mount_A');
        node.setAttribute('data-view-generation', 'sdk_mount_B');
        const second = capture(2);
        expect(second.views[0].generation).toBe('sdk_mount_B');
        expect(second.refs[refKey('workspace', 'sdk_mount_B', 'selected')]).toBeDefined();
        expect(second.refs[refKey('workspace', 'sdk_mount_A', 'selected')]).toBeUndefined();
    });
});

describe('M3 ViewTypeTool declaration owner versus execution target', () => {
    it('keeps Root declaration owner separate from the FileDetail target View Type', () => {
        const { document } = parseHTML(
            '<html><body><div id="root">' +
            '<div data-view-id="workspace" data-view-generation="sdk_root_gen" data-view-type="Workspace"></div>' +
            '<div data-view-id="fd_0" data-view-generation="sdk_file_gen" data-view-type="FileDetail"></div>' +
            '</div></body></html>'
        );
        const root = document.querySelector('#root')!;
        const producer = new DomSnapshotShadowProducer();
        const tools = new Map([['FileDetail', [{
            id: 'file_lsp', name: 'lsp_hover', viewType: 'FileDetail',
            declaredByViewId: 'workspace', declaredByViewGeneration: 'sdk_root_gen',
            description: 'Find symbol', params: { line: { type: 'number', required: true } },
        }]]]);
        const input = {
            appId: 'task_app', instanceId: 'instance',
            producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
            container: root,
            fragments: [
                fragment('workspace', 'Workspace'),
                fragment('fd_0', 'FileDetail'),
            ],
            kernel: { exportRefsToIndexMap: () => ({}), getAllTypeTools: () => tools },
        };
        const draft = producer.capture(input);
        expect(draft.tools.file_lsp).toMatchObject({
            id: 'file_lsp', viewType: 'FileDetail',
            declaredByViewId: 'workspace',
            declaredByViewGeneration: 'sdk_root_gen', visible: true,
        });
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance');
        expect(core.committer.accept(draft).status).toBe('published');

        // When only the target FileDetail closes, definition remains at Root
        // but the Tool must cease to be visible.
        root.querySelector('[data-view-id="fd_0"]')?.remove();
        const withoutTarget = producer.capture({
            ...input, producerSeq: 2, sourceEpoch: 2,
            fragments: [fragment('workspace', 'Workspace')],
        });
        expect(withoutTarget.tools.file_lsp.visible).toBe(false);
        expect(core.committer.accept(withoutTarget).status).toBe('published');

        // Root replaced with same View ID but old Tool registration survived:
        // fail before committing a stale declaration owner.
        root.querySelector('[data-view-id="workspace"]')?.setAttribute('data-view-generation', 'sdk_new_root_gen');
        const staleOwner = producer.capture({
            ...input, producerSeq: 3, sourceEpoch: 3,
            fragments: [fragment('workspace', 'Workspace')],
        });
        const rejected = core.committer.accept(staleOwner);
        expect(rejected.status).toBe('rejected');
        if (rejected.status === 'rejected') expect(rejected.issue.code).toBe('SNAPSHOT_INVALID');
    });
});


describe('M4 Stage 5: explicit SDK versioned entity Ref to Snapshot V2', () => {
    const setup = (refs: Record<string, unknown>) => {
        const root = documentWithView();
        const node = root.querySelector('[data-view-id]')!;
        node.setAttribute('data-view-instance-id', 'vi:v1:["logical-run",1]');
        const toolId = JSON.stringify(['task_app', 'Workspace', 'replace_file']);
        const kernel = {
            exportRefsToIndexMap: () => refs,
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
            capture: () => new DomSnapshotShadowProducer().captureV2({
                appId: 'task_app', instanceId: 'logical-run',
                producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
                container: root, fragments: [fragment('workspace')], kernel,
            }),
        };
    };

    it('converts only the explicit SDK entity marker to a versioned, same-instance Ref', () => {
        const originalVersion = 'sha256:' + 'a'.repeat(64);
        const { capture, toolId } = setup({
            'workspace:file': {
                $aotuiEntityRefV1: {
                    entityType: 'File', entityId: '/workspace/src/App.tsx',
                    entityVersion: originalVersion,
                },
            },
            'workspace:selected': { id: 'other data' },
        });
        const draft = capture();
        const instanceId = draft.views[0].viewInstanceId;
        expect(draft.refs[refKey('workspace', instanceId, 'file')].target).toEqual({
            kind: 'entity', entityType: 'File',
            entityId: '/workspace/src/App.tsx', entityVersion: originalVersion,
        });
        expect(draft.refs[refKey('workspace', instanceId, 'selected')].target)
            .toEqual({ kind: 'snapshot-value', payload: { id: 'other data' } });
        expect(draft.tools[toolId].targets[0].viewInstanceId).toBe(instanceId);

        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'logical-run');
        expect(core.committer.accept(draft).status).toBe('published');
    });

    it('rejects an accessor marker without invoking it or publishing a malformed entity target', () => {
        let calls = 0;
        const bad = Object.defineProperty({}, 'entityVersion', {
            enumerable: true,
            get() { calls++; return 'not authorized'; },
        });
        const { capture } = setup({
            'workspace:file': {
                $aotuiEntityRefV1: bad,
            },
        });
        expect(capture).toThrow(/Invalid SDK versioned entity identity/);
        expect(calls).toBe(0);
    });

    it('refuses entity markers with unrelated injected properties', () => {
        const { capture } = setup({
            'workspace:file': {
                $aotuiEntityRefV1: {
                    entityType: 'File', entityId: '/workspace/src/App.tsx',
                    entityVersion: 'sha256:' + 'a'.repeat(64),
                },
                granted: true,
            },
        });
        expect(capture).toThrow(/Invalid SDK entity Ref marker/);
    });
});
