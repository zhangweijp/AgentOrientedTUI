import { describe, expect, it } from 'vitest';
import type { Observation } from '@aotui/core';
import type { AppDiscoveryInfo } from '../spi/runtime/kernel.interface.js';
import { DESKTOP_TOOL_NAMES, projectDesktop, routeNativeInvocation, type PresentedAppWindows } from './index.js';

function appFixture(appId: string) {
    const observation: Observation = {
        observationId: appId + '-observation', source: { appId, instanceId: appId + '-instance', snapshotId: 'snapshot', revision: 1 },
        views: [
            { id: 'a', viewInstanceId: 'mount-a', name: 'A', type: 'File', region: 'static', canClose: true,
                content: { format: 'markdown-v1', value: 'A\r\n<original>' } },
            { id: 'b', viewInstanceId: 'mount-b', name: 'B', type: 'File', region: 'dynamic', canClose: true,
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
        expect(hinted.appSelections).toEqual([{appId:'notes',observationId:'notes-observation',
            windows:{activeViews:[],closeViews:[{viewId:'a',viewInstanceId:'mount-a'},{viewId:'b',viewInstanceId:'mount-b'}]}}]);
        expect(hinted.tools.map(tool => tool.name)).toEqual([
            'system-open_app', 'system-close_app', 'system-collapse_view', 'system-expand_view', 'system-close_view',
        ]);
        expect(hinted.desktop).toContain('view_id: a [open; collapse, close]');
        expect(hinted.desktop).toContain('view_id: b [collapsed; expand, close]');
        expect(routeNativeInvocation(hinted.tools, 'notes-File-write', { view_id: 'a', value: 7 }, 'same')).toMatchObject({
            status: 'rejected', issue: { code: 'TOOL_UNAVAILABLE' },
        });
        const restored = project('body');
        expect(restored.views[0]?.content).toContain('A&#13;\n&lt;original&gt;\n\nAvailable references\n- public $ref.notes.a.number');
        expect(restored.appSelections[0]?.windows.activeViews).toEqual([{ viewId: 'a', viewInstanceId: 'mount-a' }]);
        expect(restored.tools.map(tool => tool.name)).toContain(DESKTOP_TOOL_NAMES.inspectRef);
        expect(routeNativeInvocation(restored.tools, 'notes-File-write', { view_id: 'a', value: '$ref.notes.a.number' }, 'same'))
            .toEqual({ status: 'ready', invocation: { appId: 'notes', instanceId: 'notes-instance',
                observationId: 'notes-observation', toolId: 'write', viewId: 'a', invocationId: 'same',
                input: { value: '$ref.notes.a.number' } } });
        expect(routeNativeInvocation(restored.tools, 'notes-File-write', { value: 7 }, 'bad')).toMatchObject({
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
        expect(checks).toEqual(['visible-File-write', 'system-open_app', 'system-close_app']);
        expect(views.map(view => view.appId)).toEqual(['visible', 'visible']);
        expect(refs.map(ref => ref.source.appId)).toEqual(['visible']);
        expect(appSelections.map(selection => selection.appId)).toEqual(['visible']);
        expect(issues).toEqual([]);
        expect(desktop).not.toContain('hidden');
        expect(tools.map(tool => tool.name)).not.toContain('stale-File-write');
        expect(tools[0]?.inputSchema.properties).toMatchObject({ value: { anyOf: [expect.anything(), expect.anything()] } });
    });
});

it('keeps canonical Schema and original route across Ref shape, scope and receiver changes', () => {
    const { observation, app, windows } = appFixture('notes');
    const variants: Observation[] = [
        { ...observation, refs: [], views: [observation.views[0]!] },
        observation,
        { ...observation, refs: observation.refs.map(ref => ({ ...ref, scope: 'protected', valueSchema: { type: 'string' } })) },
        { ...observation, refs: observation.refs.map(ref => ({ ...ref, scope: 'private', valueSchema: { type: 'array', items: { type: 'integer' } } })) },
    ];
    const results = variants.map(value => projectDesktop({ apps: [{ observation: value }], catalog: [{ app, windows }], capabilities: [] }));
    for (const result of results) {
        expect(result.issues).toEqual([]);
        expect(result.tools.filter(tool => tool.route)).toHaveLength(1);
        expect(result.tools[0]?.name).toBe('notes-File-write');
        expect(result.tools[0]?.inputSchema).toEqual(results[0]?.tools[0]?.inputSchema);
        expect(result.tools[0]?.inputSchema.required).toContain('view_id');
        expect(result.tools[0]?.route?.businessSchema).toBe(observation.tools[0]?.inputSchema);
        expect(result.tools[0]?.route?.toolId).toBe(observation.tools[0]?.id);
    }
});

it('rejects the whole affected App plan, not just the display list, for a standard compiler error', () => {
    const bad = appFixture('bad'), good = appFixture('good');
    const invalid = { ...bad.observation, tools: [...bad.observation.tools, {
        ...bad.observation.tools[0]!, id: 'exact-bad-tool-id', name: 'bad',
        inputSchema: { type: 'object', properties: {
            choice: { type: 'array', items: { type: 'string' }, anyOf: [{ const: ['fast'] }] },
        }, required: ['choice'] },
    }] } satisfies Observation;
    const projection = projectDesktop({ apps: [{ observation: invalid }, { observation: good.observation }],
        catalog: [bad, good], capabilities: ['open', 'close'] });
    expect(projection.issues).toEqual([expect.objectContaining({ appId: 'bad', issue: {
        code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED', toolId: 'exact-bad-tool-id', path: '$.properties.choice.anyOf',
        message: expect.stringContaining('bad-File-bad'),
    } })]);
    expect(projection.appSelections.map(value => value.appId)).toEqual(['good']);
    expect(projection.views.map(value => value.appId)).toEqual(['good', 'good']);
    expect(projection.refs.map(value => value.source.appId)).toEqual(['good']);
    expect(projection.tools.map(value => value.name)).toEqual(['good-File-write', 'system-open_app', 'system-close_app']);
    expect(bad.app.status).toBe('running');
});


it('does not choose a winner when two matching live catalog entries claim one App ID', () => {
    const first = appFixture('collision'), peer = appFixture('healthy');
    const second = { ...first, app: { ...first.app, appInstanceId: 'replacement' }, windows: undefined,
        observation: { ...first.observation, observationId: 'replacement-observation',
            source: { ...first.observation.source, instanceId: 'replacement' } } };
    const result = projectDesktop({ apps: [first, second, peer].map(({ observation }) => ({ observation })), catalog: [first, second, peer], capabilities: ['open', 'close'] });
    expect(result.issues.map(({ appId, issue }) => [appId, issue.code])).toEqual([
        ['collision', 'AOTUI_TOOL_NAME_COLLISION'], ['collision', 'AOTUI_TOOL_NAME_COLLISION'],
    ]);
    expect(result.tools.map(tool => tool.name)).toEqual(['healthy-File-write', 'system-open_app', 'system-close_app']);
    expect(result.appSelections.map(selection => selection.appId)).toEqual(['healthy']);
});


it('keeps only the final original close grants in routes, directory and close-only adoption', () => {
    const yes=appFixture('yes'), no=appFixture('no'), missing=appFixture('missing');
    const denied={...no.observation,views:no.observation.views.map(view=>({...view,canClose:false}))};
    const input={apps:[{observation:yes.observation},{observation:denied}],catalog:[yes,no,missing],
        capabilities:['closeView'] as const,compact:true};
    const projected=projectDesktop(input);
    expect(projected.closeRoutes).toEqual(['a','b'].map(viewId=>({appId:'yes',instanceId:'yes-instance',
        observationId:'yes-observation',viewId,viewInstanceId:'mount-'+viewId})));
    expect(projected.appSelections).toEqual([{appId:'yes',observationId:'yes-observation',windows:{
        activeViews:[],closeViews:[{viewId:'a',viewInstanceId:'mount-a'},{viewId:'b',viewInstanceId:'mount-b'}]}}]);
    expect(projected.desktop.match(/view_id: a \[open; close\]/g)).toHaveLength(1);
    expect(projected.views).toEqual([]);
    const filtered=projectDesktop({...input,checkTool:()=>({code:'TEST_FILTER',message:'filtered'})});
    expect(filtered.closeRoutes).toEqual([]);expect(filtered.appSelections).toEqual([]);
    expect(filtered.desktop).not.toMatch(/\[open; close\]|\[collapsed; close\]/);
    const bad={...yes.observation,tools:yes.observation.tools.map(t=>({...t,name:'bad-tool-name'}))};
    const broken=projectDesktop({...input,apps:[{observation:bad}],compact:false});
    expect(broken.issues).toHaveLength(1);expect(broken.views).toEqual([]);expect(broken.refs).toEqual([]);
    expect(broken.status).toBe('reprepare');
    expect(broken.exclusions).toEqual([{appId:'yes',excludeToolIds:['write']}]);
    expect(broken.closeRoutes).toEqual([]);
    expect(broken.appSelections).toEqual([]);
    const narrowed = projectDesktop({...input,apps:[{observation:{...bad,tools:[]}}],compact:false});
    expect(narrowed.status).toBe('ready');
    expect(narrowed.closeRoutes).toEqual(projected.closeRoutes);
    expect(narrowed.appSelections[0]!.windows.closeViews).toEqual(projected.appSelections[0]!.windows.closeViews);
});

it('B4-T04 required system controls cannot disappear and optional close/inspect removes its exact qualification',()=>{
    const {app,observation,windows}=appFixture('notes');
    const input={apps:[{observation}],catalog:[{app,windows}],capabilities:['open','close','closeView','inspectRef','collapse','readWindowBudget'] as const};
    const normal=projectDesktop(input);
    expect(projectDesktop({...input,strict:true}).tools).toEqual(normal.tools);
    const issue={code:'MODEL_TOOL_SCHEMA_UNSUPPORTED',message:'fixture rejects'};
    const rejected=projectDesktop({...input,checkTool:name=>name==='system-open_app'?issue:undefined});
    expect(rejected.status).toBe('rejected');
    const optional=projectDesktop({...input,checkTool:name=>['system-close_view','system-inspect_ref'].includes(name)?issue:undefined});
    expect(optional.status).toBe('ready');expect(optional.closeRoutes).toEqual([]);
    expect(optional.appSelections[0]!.windows.closeViews).toEqual([]);
    expect(optional.refs).toEqual(normal.refs);expect(optional.views).toEqual(normal.views);
    expect(optional.tools.map(t=>t.name)).not.toContain('system-inspect_ref');
    expect(optional.desktop).not.toMatch(/view_id: [ab] .*close/);
    expect(projectDesktop({...input,requiredCapabilities:['readWindowBudget'],checkTool:name=>name==='system-read_window_budget'?issue:undefined}).status).toBe('rejected');
});
it('B4-T06 rejects actual directory/notes fields, but does not inspect unselected raw body',()=>{
    const {app,observation,windows}=appFixture('notes');
    const input={apps:[{observation}],catalog:[{app,windows}],capabilities:['open','close'] as const};
    expect(()=>projectDesktop({...input,catalog:[{app:{...app,description:'bad\0'}}]}))
        .toThrow(expect.objectContaining({code:'AOTUI_XML_UNSUPPORTED',path:'$.catalog[0].description',appId:'notes'}));
    const invalid={...observation,views:observation.views.map(v=>({...v,content:{...v.content,value:'bad\0'}}))};
    expect(()=>projectDesktop({...input,apps:[{observation:invalid}]})).toThrow(expect.objectContaining({code:'AOTUI_XML_UNSUPPORTED',path:'$.view.content'}));
    const omitted=projectDesktop({...input,apps:[{observation:invalid,windows:new Map(invalid.views.map(v=>[v.viewInstanceId,{kind:'omitted'} as const]))}]});
    expect(omitted.status).toBe('ready');expect(omitted.views).toEqual([]);
    expect(()=>projectDesktop({...input,apps:[{observation,windows:new Map([['mount-a',{kind:'collapsed',note:'bad\0'}]])}]}))
        .toThrow(expect.objectContaining({code:'AOTUI_XML_UNSUPPORTED',path:'$.view.content'}));
});
