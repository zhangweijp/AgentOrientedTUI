import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppWorkerHost } from './worker-host.js';

describe('Wave 2C: declaration-only contract through real SDK + Worker + V2 Store', () => {
    let temporary: string, workerFile: string, appFile: string, host: AppWorkerHost;
    let sequence = 0;
    const id = (name: string, type = 'FileDetail') => JSON.stringify(['wave2c_real', type, name]);
    const snapshot = () => {
        const read = (host as any).shadowReceiver.core.store.readLatest('wave2c_real');
        if (read.status !== 'ready') throw new Error('Expected real V2 Snapshot');
        return read.snapshot;
    };
    const request = (args: Record<string, unknown> = {}, name = 'inspect_bound') => ({
        snapshotId: snapshot().id, toolId: id(name), viewId: 'fd_A', args,
    });
    async function stats() {
        const result = await host.executeReadOnlyViewTool({ snapshotId: snapshot().id,
            toolId: id('stats', 'Workspace'), viewId: 'workspace', args: {} }, () => true);
        if (!result.success) throw new Error('Fixture stats failed');
        return result.data as any;
    }
    async function update(patch: Record<string, unknown>) {
        await host.sendExternalEvent('workspace' as any, 'update', patch);
        await vi.waitFor(async () => expect((await stats()).state).toMatchObject(patch));
    }
    function direct(tool: any, args: Record<string, unknown> = {}) {
        return (host as any).sendRequest({ type: 'VIEW_TOOL_INVOKE', requestId: 'wave2c-direct-' + ++sequence,
            appId: 'wave2c_real', instanceId: host.appInstanceId, tool,
            target: tool.targets.find((t: any) => t.viewId === 'fd_A'), args });
    }

    beforeAll(async () => {
        temporary = await mkdtemp(join(tmpdir(), 'aotui-wave2c-'));
        const root = resolve(process.cwd());
        workerFile = join(temporary, 'worker.mjs'); appFile = join(temporary, 'app.mjs');
        const modules = join(temporary, 'node_modules'); await mkdir(join(modules, '@aotui'), { recursive: true });
        for (const name of ['preact', 'linkedom']) await symlink(join(root, 'node_modules', name), join(modules, name), 'dir');
        await symlink(root, join(modules, '@aotui/runtime'), 'dir');
        await build({ entryPoints: [join(root, 'src/worker-runtime/index.ts')], outfile: workerFile,
            bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
        const fixture = `
            import { h } from 'preact';
            import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
            import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
            import { View } from './sdk/src/components/View.tsx';
            import { useViewTypeTool } from './sdk/src/hooks/useViewTypeTool.ts';
            import { useDataRef } from './sdk/src/hooks/useRef.ts';
            const calls={A:0,B:0,plain:0};
            function Detail({who,state}) {
                const data=useMemo(()=>({who}),[who]); const file=useDataRef('file',data);
                const def={type:'reference',...(state.bound?{refSource:'snapshot-value-v1'}:{}),
                    ...(who==='B'?{refType:'File'}:state.refType?{refType:state.refType}:{})};
                useViewTypeTool(who==='A'?'inspect_bound':'inspect_other',{
                    description:'Inspect observed file',params:{file:def},isMutating:false
                },async args=>{calls[who]++;return {success:true,data:{who,args}};});
                if(who==='A') useViewTypeTool('plain',{
                    description:'Plain JSON query',params:{file:{type:'reference',refType:'File'},fail:{type:'boolean'}},isMutating:false
                },async args=>{calls.plain++;return args.fail?{success:false,error:{code:'BUSINESS_FAILED',message:'Expected'}}
                    :{success:true,data:{who,args}};});
                return h('p',{},file('File '+who));
            }
            function Content(){
                const [state,set]=useState({bound:true,refType:''});
                useLayoutEffect(()=>{
                    const receive=e=>{if(e.detail?.viewId==='workspace'&&e.detail?.type==='update')
                        set(old=>({...old,...e.detail.data}));};
                    document.body.addEventListener('aotui:external-event',receive);
                    return ()=>document.body.removeEventListener('aotui:external-event',receive);
                },[]);
                useViewTypeTool('stats',{description:'Test counters',params:{},isMutating:false},
                    async()=>({success:true,data:{calls:{...calls},state}}));
                return h('main',{},h(View,{id:'fd_A',type:'FileDetail'},h(Detail,{who:'A',state})),
                    h(View,{id:'fd_B',type:'FileDetail'},h(Detail,{who:'B',state})));
            }
            export default createTUIApp({app_name:'wave2c_fixture',component:()=>h(View,{id:'workspace',type:'Workspace'},h(Content,{}))});
        `;
        await build({ stdin: { contents: fixture, resolveDir: resolve(root, '..'), sourcefile: 'wave2c.tsx', loader: 'tsx' },
            outfile: appFile, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
    });
    beforeEach(async () => {
        host = new AppWorkerHost({ appId: 'wave2c_real' as any, desktopId: 'wave2c' as any,
            appModulePath: appFile, workerScriptPath: workerFile, snapshotShadow: true, experimentalReadOnlyViewTools: true });
        await host.start(); await host.open();
        await vi.waitFor(() => expect(host.getSnapshotShadowReport()).toMatchObject({
            health: 'ready', lastViewCount: 3, lastToolCount: 4,
            producerConsistency: 'unverified', strictEligible: false,
        }));
    });
    afterEach(async () => {
        const worker = (host as any)?.worker; host?.terminate(); await worker?.terminate();
        expect((host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
        vi.restoreAllMocks();
    });
    afterAll(async () => { await rm(temporary, { recursive: true, force: true }); });

    it('preserves approved declaration metadata in a real V2 Snapshot without inventing typed Ref payloads', async () => {
        expect(snapshot().tools[id('inspect_bound')].inputSchema.properties.file).toEqual({ type: 'string',
            'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target' } });
        expect(snapshot().tools[id('inspect_other')].inputSchema.properties.file['x-aotui-ref'].refType).toBe('File');
        expect(Object.values(snapshot().refs).filter((r: any) => r.id === 'file').map((r: any) => r.refType))
            .toEqual(['unknown', 'unknown']);
        expect((await stats()).calls).toEqual({ A: 0, B: 0, plain: 0 });
    });

    it.each([{}, { file: 'file' }, { file: '[File B](file)' }, { file: { who: 'caller' } }])(
        'Host refuses the entire declared Tool before policy or dispatch: %j', async args => {
            const authorize = vi.fn(() => true); const send = vi.spyOn(host as any, 'sendRequest');
            const result = await host.executeReadOnlyViewTool(request(args), authorize);
            expect(result).toMatchObject({ success: false, error: { code: 'REF_CONTRACT_UNSUPPORTED' } });
            expect(authorize).not.toHaveBeenCalled();
            expect(send.mock.calls.filter(([message]: any) => message.type === 'VIEW_TOOL_INVOKE' && message.tool.id === id('inspect_bound'))).toHaveLength(0);
            expect((await stats()).calls).toEqual({ A: 0, B: 0, plain: 0 });
        },
    );

    it('old invocation straight to the Worker is refused by its live registration, without Host policy', async () => {
        const result = await direct(snapshot().tools[id('inspect_bound')], { file: { who: 'caller' } });
        expect(result).toMatchObject({ success: false, error: { code: 'REF_CONTRACT_UNSUPPORTED' } });
        expect((await stats()).calls.A).toBe(0);
    });

    it('stripping the message annotation cannot bypass the current canonical registration', async () => {
        const stripped = structuredClone(snapshot().tools[id('inspect_bound')]);
        delete stripped.inputSchema.properties.file['x-aotui-ref'];
        expect(await direct(stripped, {})).toMatchObject({ success: false, error: { code: 'TOOL_SOURCE_STALE' } });
        expect((await stats()).calls.A).toBe(0);
    });

    it('a re-registered declaration invalidates the old plain source at Host and Worker', async () => {
        await update({ bound: false });
        await vi.waitFor(() => expect(snapshot().tools[id('inspect_bound')].inputSchema.properties.file['x-aotui-ref']).toBeUndefined());
        const oldRequest = request({ file: 'file' }); const oldTool = snapshot().tools[id('inspect_bound')];
        await update({ bound: true });
        await vi.waitFor(() => expect(snapshot().tools[id('inspect_bound')].targets[0].bindingVersion).not.toBe(oldTool.targets[0].bindingVersion));
        expect(await host.executeReadOnlyViewTool(oldRequest, () => true))
            .toMatchObject({ success: false, error: { code: 'TOOL_SOURCE_STALE' } });
        expect(await direct(oldTool)).toMatchObject({ success: false, error: { code: 'TOOL_SOURCE_STALE' } });
        expect(await host.executeReadOnlyViewTool(request(), () => true))
            .toMatchObject({ success: false, error: { code: 'REF_CONTRACT_UNSUPPORTED' } });
        expect((await stats()).calls.A).toBe(0);
    });

    it('changing a valid refType changes the binding and canonical source contract', async () => {
        const old = snapshot().tools[id('inspect_bound')];
        await update({ refType: 'File' });
        await vi.waitFor(() => expect(snapshot().tools[id('inspect_bound')].inputSchema.properties.file['x-aotui-ref']?.refType).toBe('File'));
        expect(snapshot().tools[id('inspect_bound')].targets[0].bindingVersion).not.toBe(old.targets[0].bindingVersion);
        expect(await direct(old)).toMatchObject({ success: false, error: { code: 'TOOL_SOURCE_STALE' } });
        expect((await stats()).calls.A).toBe(0);
    });

    it('unannotated caller JSON, SDK parameter errors and business failure remain unchanged', async () => {
        const literal = { file: '[File B](file)' };
        expect(await host.executeReadOnlyViewTool(request(literal, 'plain'), () => true))
            .toMatchObject({ success: true, data: { who: 'A', args: literal } });
        expect(await host.executeReadOnlyViewTool(request({ fail: true }, 'plain'), () => true))
            .toMatchObject({ success: false, error: { code: 'BUSINESS_FAILED' } });
        expect(await host.executeReadOnlyViewTool(request({ fail: 'wrong' }, 'plain'), () => true))
            .toMatchObject({ success: false, error: { code: 'E_INVALID_ARGS' } });
        expect((await stats()).calls).toEqual({ A: 0, B: 0, plain: 2 });
    });
});
