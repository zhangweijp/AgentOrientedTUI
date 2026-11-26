import { describe, expect, it } from 'vitest';
import type { Observation } from '@aotui/core';
import type { AppDiscoveryInfo } from '../spi/runtime/kernel.interface.js';
import { DESKTOP_TOOL_NAMES, projectDesktop, routeNativeInvocation, type PresentedAppWindows } from './index.js';

function appFixture(appId: string) {
    const observation: Observation = {
        observationId: appId + '-observation', source: { appId, instanceId: appId + '-instance', snapshotId: 'snapshot', revision: 1 },
        views: [
            { id: 'a', viewInstanceId: 'mount-a', name: 'A', type: 'File', region: 'static',
                content: { format: 'markdown-v1', value: 'A\r\n<original>' } },
            { id: 'b', viewInstanceId: 'mount-b', name: 'B', type: 'File', region: 'dynamic',
                content: { format: 'markdown-v1', value: 'B original' } },
        ],
        tools: [{ id: 'write', name: 'write', description: 'Write a File', viewType: 'File', multiplicity: 'multiple',
            inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } }],
        refs: [{ viewId: 'a', viewInstanceId: 'mount-a', refId: 'number', refType: 'Number', scope: 'public', array: false,
            valueSchema: { type: 'integer' } }],
    };
    const app: AppDiscoveryInfo = { appId: appId as NonNullable<AppDiscoveryInfo['appId']>, appInstanceId: appId + '-instance',
        installationId: appId, name: appId, status: 'running' };
    const windows: PresentedAppWindows = { appId: app.appId!, instanceId: app.appInstanceId!, expanded: true,
        views: observation.views.map(({ id, viewInstanceId, name, type, region }) => ({
            viewId: id, viewInstanceId, name, type, region, expanded: id === 'a', canClose: true,
        })) };
    return { observation, app, windows };
}

describe('shared Desktop projection', () => {
    it('derives bodies, Refs, window controls and adoption for the same layout', () => {
        const { observation, app, windows } = appFixture('notes');
        const capabilities = ['open', 'close', 'collapseView', 'expandView', 'closeView', 'inspectRef'] as const;
        const project = (kind: 'hint' | 'body') => projectDesktop({
            apps: [{ observation, windows: new Map([
                ['mount-a', { kind }],
                ['mount-b', { kind: 'collapsed', note: 'Keep\r&<this>' }],
            ]) }],
            catalog: [{ app, windows }], capabilities,
        });
        const hinted = project('hint');
        expect(hinted.views.map(view => view.kind)).toEqual(['hint', 'collapsed']);
        expect(hinted.views[0]?.content).toContain('region="static"');
        expect(hinted.views[0]?.content).not.toMatch(/original|Available references|input tokens/);
        expect(hinted.views[1]?.content).toContain('Collapsed · Agent note\n\nKeep&#13;&amp;&lt;this&gt;');
        expect(hinted.refs).toEqual([]);
        expect(hinted.appSelections).toEqual([]);
        expect(hinted.tools.map(tool => tool.name)).toEqual([
            'system-open_app', 'system-close_app', 'system-collapse_view', 'system-expand_view', 'system-close_view',
        ]);
        expect(hinted.desktop).toContain('view_id: a [open; collapse, close]');
        expect(hinted.desktop).toContain('view_id: b [collapsed; expand, close]');
        expect(routeNativeInvocation(hinted.tools, 'notes-write', { view_id: 'a', value: 7 }, 'same')).toMatchObject({
            status: 'rejected', issue: { code: 'TOOL_UNAVAILABLE' },
        });
        const restored = project('body');
        expect(restored.views[0]?.content).toContain('A&#13;\n&lt;original&gt;\n\nAvailable references\n- public $ref.notes.a.number');
        expect(restored.appSelections[0]?.windows.activeViews).toEqual([{ viewId: 'a', viewInstanceId: 'mount-a' }]);
        expect(restored.tools.map(tool => tool.name)).toContain(DESKTOP_TOOL_NAMES.inspectRef);
        expect(routeNativeInvocation(restored.tools, 'notes-write', { view_id: 'a', value: '$ref.notes.a.number' }, 'same'))
            .toEqual({ status: 'ready', invocation: { appId: 'notes', instanceId: 'notes-instance',
                observationId: 'notes-observation', toolId: 'write', viewId: 'a', invocationId: 'same',
                input: { value: '$ref.notes.a.number' } } });
        expect(routeNativeInvocation(restored.tools, 'notes-write', { value: 7 }, 'bad')).toMatchObject({
            status: 'rejected', issue: { code: 'TOOL_INVALID_ARGS', path: '$.view_id' },
        });
    });

    it('omits a folded App from adoption while retaining its expand and close controls', () => {
        const { app, observation, windows } = appFixture('notes');
        const folded = projectDesktop({
            apps: [{ observation }], catalog: [{ app, windows: { ...windows, expanded: false }, note: 'resume later' }],
            capabilities: ['open', 'close', 'collapse', 'expand', 'closeView'],
        });
        expect(folded.appSelections).toEqual([]);
        expect(folded.views).toEqual([]);
        expect(folded.desktop).toMatch(/Actions: expand, close[\s\S]+Collapsed · Agent note\n\nresume later/);
        expect(folded.tools.map(tool => tool.name)).toEqual(['system-open_app', 'system-close_app', 'system-expand_app']);
    });

    it('keeps fixed App controls in an empty compact Desktop', () => {
        const projection = projectDesktop({ apps: [], catalog: [], capabilities: ['open', 'close'], compact: true });
        expect(projection.views).toEqual([]);
        expect(projection.instruction).toBeUndefined();
        expect(projection.desktop).toContain('No applications installed.');
        expect(projection.tools.map(tool => tool.name)).toEqual(['system-open_app', 'system-close_app']);
        expect(projection.tools.map(tool => tool.inputSchema.required)).toEqual([['installation_id'], ['app_id']]);
    });

    it('omits filtered and mismatched instances before inspecting their tools or Ref schemas', () => {
        const visible = appFixture('visible');
        const hidden = appFixture('hidden');
        const stale = appFixture('stale');
        const checks: string[] = [];
        const { views, desktop, tools, refs, issues, appSelections } = projectDesktop({
            apps: [{ observation: visible.observation }, { observation: { ...hidden.observation, tools: [{ ...hidden.observation.tools[0]!, name: 'bad-tool-name' }] } }, { observation: stale.observation }],
            catalog: [visible, { ...stale, app: { ...stale.app, appInstanceId: 'replacement' }, windows: undefined }],
            capabilities: ['open', 'close'],
            checkTool: name => { checks.push(name); return undefined; },
        });
        expect(checks).toEqual(['visible-write', 'system-open_app', 'system-close_app']);
        expect(views.map(view => view.appId)).toEqual(['visible', 'visible']);
        expect(refs.map(ref => ref.source.appId)).toEqual(['visible']);
        expect(appSelections.map(selection => selection.appId)).toEqual(['visible']);
        expect(issues).toEqual([]);
        expect(desktop).not.toContain('hidden');
        expect(tools.map(tool => tool.name)).not.toContain('stale-write');
        expect(tools[0]?.inputSchema.properties).toMatchObject({ value: { anyOf: [expect.anything(), expect.anything()] } });
    });
});
