import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import type { ScopePolicy, ScopeClient } from '../../core/invocation/scoped-interaction-types.js';

let directory: string, workerPath: string, appPath: string;
const hosts: AppWorkerHost[] = [];
const policy: ScopePolicy = {
    project: ({ source }) => ({ views: source.views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
        refs: Object.values(source.refs).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        toolBindings: Object.values(source.tools).map(t => ({ toolId: t.id, execution: t.execution })),
        content: source.views.map(v => ({ view: { viewId: v.id, viewInstanceId: v.viewInstanceId }, decision: 'retain' })) }),
    authorize: () => true, canReadReceipt: () => true,
};

beforeAll(async () => {
    const runtime = process.cwd();
    directory = await mkdtemp(join(tmpdir(), 'aotui-refresh-worker-'));
    const modules = join(directory, 'node_modules'); await mkdir(join(modules, '@aotui'), { recursive: true });
    for (const [name, target] of [['preact', join(runtime, 'node_modules/preact')],
        ['linkedom', join(runtime, 'node_modules/linkedom')], ['typebox', resolve(runtime, '../sdk/node_modules/typebox')],
        ['@aotui/runtime', runtime]]) await symlink(target, join(modules, name), 'dir');
    workerPath = join(directory, 'worker.mjs'); appPath = join(directory, 'app.mjs');
    await build({ entryPoints: [join(runtime, 'src/worker-runtime/index.ts')], outfile: workerPath,
        platform: 'node', format: 'esm', bundle: true, packages: 'external', logLevel: 'silent' });
    await build({ stdin: { resolveDir: runtime, sourcefile: 'refresh-app.tsx', loader: 'tsx', contents: `
        import { h, options } from 'preact';
        import { useState, useLayoutEffect, useMemo } from 'preact/hooks';
        import Type from 'typebox';
        import { createTUIApp, View, AppTools, defineToolSet, defineViewTypeTool, useDataRef, refParam } from '@aotui/sdk';
        const queued = []; options.debounceRendering = cb => queued.push(cb);
        let calls = 0;
        const tools = defineToolSet({ change: defineViewTypeTool({viewType:'Workspace',name:'change',description:'Change the fixture',
            inputSchema: Type.Object({value:Type.Number(),invalid:Type.Optional(Type.Boolean())},{additionalProperties:false})}),
            stats: defineViewTypeTool({viewType:'Workspace',name:'stats',description:'Read operation count',inputSchema:Type.Object({})}),
            edit: defineViewTypeTool({viewType:'File',name:'edit',description:'Edit the current file',inputSchema:Type.Object({})}),
            read: defineViewTypeTool({viewType:'File',name:'read',description:'Read observed data',inputSchema:Type.Object({record:refParam('Record',Type.Object({value:Type.Number()}))})}) });
        function File({state}) {
            const data=useMemo(()=>state.invalid ? {value:()=>state.value} : {value:state.value},[state.value,state.invalid]);
            const ref=useDataRef('selected',data,{refType:'Record'}); return h('p',{},'file:'+state.value+ref('Selection'));
        }
        function App() {
            const [state,set]=useState({value:0,invalid:false});
            useLayoutEffect(()=>{
                const event=e=>{ if(e.detail.type==='release') {while(queued.length)queued.shift()();}
                    if(e.detail.type==='repair')set(s=>({...s,invalid:false})); };
                document.addEventListener('aotui:external-event',event);
                return ()=>document.removeEventListener('aotui:external-event',event);
            },[]);
            return h(AppTools,{definition:tools,bindings:{
                change:{execute:args=>{calls++;set({value:args.value,invalid:args.invalid??false});return {success:true,data:{calls}};}},
                stats:{execute:()=>({success:true,data:{calls}})},edit:{enabled:state.value>0,execute:()=>({success:true})},
                read:{execute:({record})=>({success:true,data:{value:record.value}})}
            }},[h(View,{kind: 'state',id:'workspace',type:'Workspace',key:'root'},h('p',{},'workspace:'+state.value)),
                state.value>0?h(View,{kind: 'state',id:'file',type:'File',key:'file'},h(File,{state})):null]);
        }
        export default createTUIApp({app_name:'refresh_fixture',component:App,signalPolicy:'never'});
    ` }, outfile: appPath, platform: 'node', format: 'esm', bundle: true, packages: 'external',
        alias: { '@aotui/sdk': resolve(runtime, '../sdk/src/index.ts') }, logLevel: 'silent' });
});
afterEach(async () => {
    for (const host of hosts.splice(0)) { try { await host.close(); } finally { host.terminate(); await host.waitForResourceRelease(); } }
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function start() {
    const host = new AppWorkerHost({ appId: 'refresh_app' as any, desktopId: 'desktop' as any,
        appModulePath: appPath, workerScriptPath: workerPath, existingWorker: new Worker(workerPath),
        config: { AOTUI_DATA_DIR: directory }, interactionModes: ['view-type-parameters-v1'] });
    hosts.push(host); host.onUpdateRequest = vi.fn(); await host.start(); await host.open();
    const opened = host.createInteractionScope(policy); if (opened.status !== 'opened') throw new Error(opened.issue.code);
    return { host, client: opened.client };
}
async function observe(client: ScopeClient) {
    const observed = await client.observe({ all: true });
    if (observed.status !== 'observed') throw new Error(observed.issue.code);
    expect(client.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
    return observed.observation;
}
let invocation = 0;
function invoke(client: ScopeClient, observed: Awaited<ReturnType<typeof observe>>, name: string, input: Record<string, unknown>) {
    const tool = observed.tools.find(t => t.name === name)!; const binding = observed.bindings.find(b => b.toolId === tool.id)!;
    return client.invoke({ invocationId: 'refresh-' + ++invocation, observationId: observed.observationId, bindingId: binding.bindingId, input });
}

describe('real SDK Worker observation refresh', () => {
    it('adopts a new observation without retargeting old Refs or releasing another Scope holder', async () => {
        const { host, client } = await start(); const initial = await observe(client);
        await invoke(client, initial, 'change', { value: 1 });
        const waiting = observe(client); await host.sendExternalEvent('workspace' as any, 'release'); const first = await waiting;
        const other = host.createInteractionScope(policy); if (other.status !== 'opened') throw Error(other.issue.code);
        try {
            const shared = await observe(other.client);
            expect(shared.source.snapshotId).toBe(first.source.snapshotId);
            await invoke(client, first, 'change', { value: 2 });
            const preparing = client.observe({ all: true }); await host.sendExternalEvent('workspace' as any, 'release');
            const next = await preparing; if (next.status !== 'observed') throw Error(next.issue.code);
            expect(await invoke(client, next.observation, 'read', { record: 'file.selected' }))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { code: 'OBSERVATION_NOT_ADOPTED' } } });
            expect(await invoke(client, first, 'read', { record: 'file.selected' }))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { value: 1 } } } } });
            expect(client.adoptObservation(next.observation.observationId)).toEqual({ status: 'adopted' });
            expect(await invoke(client, first, 'read', { record: 'file.selected' }))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { code: 'OBSERVATION_UNAVAILABLE' } } });
            expect(await invoke(client, next.observation, 'read', { record: 'file.selected' }))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { value: 2 } } } } });
            expect(await invoke(other.client, shared, 'read', { record: 'file.selected' }))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { value: 1 } } } } });
            const store = (host as any).snapshotReceiver.core.store;
            expect(store.getById(first.source.snapshotId).status).toBe('found');
            other.client.close();
            expect(store.getById(first.source.snapshotId).status).toBe('rejected');
            expect(store.inspect()).toMatchObject({ historicalSnapshots: 0, historicalBytes: 0 });
            expect(store.getById(next.observation.source.snapshotId).status).toBe('found');
        } finally { other.client.close(); client.close(); }
        expect(host.getInteractionReport()!.core).toMatchObject({ scopes: 0, combinedBytes: 0 });
    });
    it('observes queued commits and compatible View/Ref/Tool without a prior notification or fixed sleep', async () => {
        const { host, client } = await start(); const initial = await observe(client);
        const business = await invoke(client, initial, 'change', { value: 1 });
        expect(business).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
        const observing = observe(client);
        await host.sendExternalEvent('workspace' as any, 'release');
        const next = await observing;
        expect(JSON.stringify(next)).toContain('file:1'); expect(next.tools.map(t => t.name)).toContain('edit');
        const snapshot = (host as any).snapshotReceiver.core.store.readLatest(host.appId).snapshot;
        expect(snapshot.views.map((v: any) => v.content.value).join(' ')).toContain('workspace:1');
        expect(Object.values(snapshot.refs)).toMatchObject([{ target: { payload: { value: 1 } } }]);
        expect(host.onUpdateRequest).not.toHaveBeenCalled();
        client.close(); expect(host.getInteractionReport()!.core).toMatchObject({ scopes: 0, combinedBytes: 0 });
    });

    it('reuses confirmed content when nothing changes', async () => {
        const { host, client } = await start(); await observe(client); const id = host.getSemanticSnapshotReport()!.snapshotId;
        await observe(client); expect(host.getSemanticSnapshotReport()!.snapshotId).toBe(id);
        expect(host.onUpdateRequest).not.toHaveBeenCalled(); client.close();
    });

    it('keeps the known business result on projection failure and recovers by observing, without repeating the operation', async () => {
        const { host, client } = await start(); const initial = await observe(client);
        const receipt = await invoke(client, initial, 'change', { value: 1, invalid: true });
        expect(receipt).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
        const failed = client.observe({ all: true }); await host.sendExternalEvent('workspace' as any, 'release');
        expect(await failed).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR' } });
        expect(host.getSemanticSnapshotReport()!.health).toBe('degraded');
        await host.sendExternalEvent('workspace' as any, 'repair'); await host.sendExternalEvent('workspace' as any, 'release');
        const recovered = await observe(client);
        expect(await invoke(client, recovered, 'stats', {})).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
        expect(receipt).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } }); client.close();
    });

    it('closes the pending render/Worker/Scope wait and releases resources without running the scheduler', async () => {
        const { host, client } = await start(); const initial = await observe(client);
        await invoke(client, initial, 'change', { value: 1 });
        const pending = client.observe({ all: true });
        await host.close(); expect((await pending).status).toBe('rejected');
        host.terminate(); const resources = await host.waitForResourceRelease(); expect(resources.resourcesReleased).toBe(true);
        expect((host as any).pendingRequests.size).toBe(0); expect((host as any).projectionRefresh).toBeUndefined();
    });
});
