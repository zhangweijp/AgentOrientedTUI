import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { createSnapshotCore } from '../../core/snapshot/index.js';
import { AppWorkerHost } from './worker-host.js';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}

describe('Wave 2A: real SDK + Worker + View-owned read-only contract', () => {
    let temporary: string;
    let workerFile: string;
    let appFile: string;
    let host: AppWorkerHost;
    let clock: number;
    const id = (type: string, name: string) => JSON.stringify(['wave2a_real', type, name]);
    const snapshot = () => {
        const receiver = (host as any).shadowReceiver;
        const read = receiver.core.store.readLatest('wave2a_real');
        if (read.status !== 'ready') throw new Error('Expected ready V2');
        return read.snapshot;
    };
    const request = (viewId = 'fd_A', name = 'inspect', args: Record<string, unknown> = { line: 7 }) => ({
        snapshotId: snapshot().id, toolId: id('FileDetail', name), viewId, args,
    });
    const stats = async () => {
        const result = await host.executeReadOnlyViewTool({
            snapshotId: snapshot().id, toolId: id('Workspace', 'stats'), viewId: 'workspace', args: {},
        }, () => true);
        if (!result.success) throw new Error('Fixture stats unavailable: ' + result.error?.code);
        return result.data as any;
    };
    const update = async (patch: Record<string, unknown>) => {
        await host.sendExternalEvent('workspace' as any, 'update', patch);
        await vi.waitFor(async () => { expect((await stats()).state).toMatchObject(patch); });
    };
    async function open(existingWorker?: Worker) {
        const current = new AppWorkerHost({
            appId: 'wave2a_real' as any, desktopId: 'wave2a' as any,
            appModulePath: appFile, workerScriptPath: workerFile, existingWorker,
            snapshotShadow: true, experimentalReadOnlyViewTools: true,
        });
        // Test-only clock configuration, before INIT or any Draft. The same
        // existing Core factory is used; production Host has no alternate Store.
        const core = createSnapshotCore({ now: () => clock, historyTtlMs: 20, leaseTtlMs: 100 });
        core.lifecycle.startApp('wave2a_real', current.appInstanceId);
        (current as any).shadowReceiver.core = core;
        host = current;
        await current.start(); await current.open();
        await vi.waitFor(() => expect(current.getSnapshotShadowReport()).toMatchObject({
            health: 'ready', lastViewCount: 3, lastToolCount: 3,
            producerConsistency: 'unverified', strictEligible: false,
        }));
        return current;
    }

    beforeAll(async () => {
        temporary = await mkdtemp(join(tmpdir(), 'aotui-wave2a-'));
        const root = resolve(process.cwd());
        workerFile = join(temporary, 'worker.mjs'); appFile = join(temporary, 'app.mjs');
        const modules = join(temporary, 'node_modules');
        await mkdir(join(modules, '@aotui'), { recursive: true });
        await symlink(join(root, 'node_modules/preact'), join(modules, 'preact'), 'dir');
        await symlink(join(root, 'node_modules/linkedom'), join(modules, 'linkedom'), 'dir');
        await symlink(root, join(modules, '@aotui/runtime'), 'dir');
        await build({ entryPoints: [join(root, 'src/worker-runtime/index.ts')], outfile: workerFile,
            bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
        const fixture = `
            import { h } from 'preact';
            import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
            import { createTUIApp } from './sdk/src/app-factory/createTUIApp.ts';
            import { View } from './sdk/src/components/View.tsx';
            import { useDataRef } from './sdk/src/hooks/useRef.ts';
            import { useViewTypeTool } from './sdk/src/hooks/useViewTypeTool.ts';
            let mounts = 0;
            const calls = { A: 0, B: 0, query: 0 };
            const params = { line:{type:'number',required:true}, fail:{type:'boolean'},
                reference:{type:'reference',refType:'File'}, extra:{type:'object'} };
            function Detail({who,enabled,queryType,refValue}) {
                const [identity] = useState(() => who + ':' + (++mounts));
                const data = useMemo(() => ({who,refValue}), [who,refValue]);
                const file = useDataRef('file', data);
                useViewTypeTool('inspect', { description:'Inspect current file',params,isMutating:false }, async args => {
                    calls[who]++;
                    return args.fail ? {success:false,error:{code:'BUSINESS_FAILED',message:'Expected query failure'}}
                        : {success:true,data:{who,identity,args}};
                }, {enabled});
                useViewTypeTool('query', { description:'Query A',params:{value:{type:queryType,required:true}},isMutating:false },
                    async args => { calls.query++; return {success:true,data:{who,identity,args}}; },
                    {enabled:who==='A' && enabled});
                return h('p',{},file('File ' + who));
            }
            function Content() {
                const [state,set] = useState({showA:true,aKey:0,enabledA:true,queryType:'number',display:0,refValue:0});
                useLayoutEffect(() => {
                    const onEvent = event => {
                        if (event.detail?.viewId==='workspace' && event.detail?.type==='update')
                            set(old => ({...old,...event.detail.data}));
                    };
                    document.body.addEventListener('aotui:external-event',onEvent);
                    return () => document.body.removeEventListener('aotui:external-event',onEvent);
                },[]);
                useViewTypeTool('stats',{description:'Fixture observation',params:{},isMutating:false},
                    async () => ({success:true,data:{calls:{...calls},state}}));
                return h('section',{}, h('p',{},'display '+state.display),
                    state.showA && h(View,{id:'fd_A',type:'FileDetail',key:'A'+state.aKey},
                        h(Detail,{who:'A',enabled:state.enabledA,queryType:state.queryType,refValue:state.refValue})),
                    h(View,{id:'fd_B',type:'FileDetail',key:'B'},
                        h(Detail,{who:'B',enabled:true,queryType:'number',refValue:state.refValue})));
            }
            export default createTUIApp({app_name:'wave2a_fixture',component:()=>h(View,{id:'workspace',type:'Workspace'},h(Content,{}))});
        `;
        await build({ stdin: { contents: fixture, resolveDir: resolve(root, '..'), sourcefile: 'wave2a.tsx', loader: 'tsx' },
            outfile: appFile, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
    });
    beforeEach(async () => { clock = 0; await open(); });
    afterEach(async () => {
        const worker = (host as any)?.worker as Worker | undefined;
        host?.terminate(); await worker?.terminate();
        expect((host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
        vi.restoreAllMocks();
    });
    afterAll(async () => { await rm(temporary, { recursive: true, force: true }); });

    it('executes the selected View Handler, keeps SDK validation and preserves business failure through successful IPC', async () => {
        const messages: any[] = [];
        (host as any).worker.on('message', (message: any) => messages.push(message));
        expect(await host.executeReadOnlyViewTool(request(), () => true)).toMatchObject({ success: true, data: { who: 'A' } });
        expect(await host.executeReadOnlyViewTool(request('fd_B'), () => true)).toMatchObject({ success: true, data: { who: 'B' } });
        expect(await host.executeReadOnlyViewTool(request('fd_A', 'inspect', { line: 'bad' }), () => true))
            .toMatchObject({ success: false, error: { code: 'E_INVALID_ARGS' } });
        expect((await stats()).calls).toEqual({ A: 1, B: 1, query: 0 });
        expect(await host.executeReadOnlyViewTool(request('fd_A', 'inspect', { line: 7, fail: true }), () => true))
            .toMatchObject({ success: false, error: { code: 'BUSINESS_FAILED' } });
        expect(messages.some(message => message.type === 'OPERATION_RESPONSE' && message.success === true &&
            message.result?.success === false && message.result.error?.code === 'BUSINESS_FAILED')).toBe(true);
    });

    it('cannot redirect an old A observation to a remounted A or to B', async () => {
        const a = request(); const b = request('fd_B');
        const first = await host.executeReadOnlyViewTool(a, () => true);
        const oldInstance = snapshot().views.find((view: any) => view.id === 'fd_A').viewInstanceId;
        await update({ showA: false });
        await vi.waitFor(() => expect(snapshot().views.some((view: any) => view.id === 'fd_A')).toBe(false));
        const before = (await stats()).calls;
        expect(await host.executeReadOnlyViewTool(a, () => true)).toMatchObject({ success: false, error: { code: 'VIEW_INSTANCE_REVOKED' } });
        await update({ showA: true, aKey: 1 });
        await vi.waitFor(() => {
            const current = snapshot().views.find((view: any) => view.id === 'fd_A');
            expect(current).toBeDefined();
            expect(current.viewInstanceId).not.toBe(oldInstance);
            expect(snapshot().tools[a.toolId]?.targets.find((target: any) => target.viewId === 'fd_A')?.viewInstanceId)
                .toBe(current.viewInstanceId);
        });
        expect(await host.executeReadOnlyViewTool(a, () => true)).toMatchObject({ success: false, error: { code: 'VIEW_INSTANCE_REVOKED' } });
        expect((await stats()).calls).toEqual(before);
        expect(await host.executeReadOnlyViewTool(b, () => true)).toMatchObject({ success: true, data: { who: 'B' } });
        const fresh = await host.executeReadOnlyViewTool(request(), () => true);
        expect(fresh).toMatchObject({ success: true, data: { who: 'A' } });
        expect((fresh.data as any).identity).not.toBe((first.data as any).identity);
    });

    it('keeps original selectors and args while the caller replaces them with another valid Tool during authorization', async () => {
        const input = request('fd_A', 'inspect', { line: 7, extra: { value: 'original' } });
        const original = { ...input }; const started = gate(); const resume = gate();
        const select = vi.spyOn((host as any).shadowReceiver, 'selectToolSource');
        let authorized: any;
        const pending = host.executeReadOnlyViewTool(input, async scope => {
            authorized = scope; started.release(); await resume.promise; return true;
        });
        try {
            await started.promise; await update({ display: 1 });
            input.snapshotId = snapshot().id; input.toolId = id('Workspace', 'stats'); input.viewId = 'workspace'; input.args = {};
        } finally { resume.release(); }
        expect(await pending).toMatchObject({ success: true, data: { who: 'A', args: { line: 7, extra: { value: 'original' } } } });
        const originalChecks = select.mock.calls.filter(([value]: any) => value.toolId === original.toolId);
        expect(originalChecks).toHaveLength(2);
        for (const [value] of originalChecks as any[]) expect(value).toMatchObject({ snapshotId: original.snapshotId, viewId: 'fd_A' });
        expect(Object.isFrozen(authorized)).toBe(true);
        expect(Object.isFrozen(authorized.args.extra)).toBe(true);
    });

    it('refuses an expired pinned source instead of laundering it through a caller replacement snapshot', async () => {
        const input = request(); const oldId = input.snapshotId; const started = gate(); const resume = gate();
        const pending = host.executeReadOnlyViewTool(input, async () => { started.release(); await resume.promise; return true; });
        try {
            await started.promise; clock = 1; await update({ display: 1 });
            await vi.waitFor(() => expect(snapshot().id).not.toBe(oldId));
            input.snapshotId = snapshot().id; input.viewId = 'fd_B'; clock = 22;
            expect((host as any).shadowReceiver.core.store.getById(oldId).status).toBe('found');
        } finally { resume.release(); }
        const result = await pending; const observed = await stats();
        console.log('WAVE2A_TTL_RECHECK=' + JSON.stringify({ success: result.success, code: result.error?.code, calls: observed.calls }));
        expect(result).toMatchObject({ success: false, error: { code: 'SNAPSHOT_EXPIRED' } });
        expect(observed.calls).toEqual({ A: 0, B: 0, query: 0 });
    });

    it('allows display/Ref-only updates and passes reference-shaped JSON literally without latest-Ref fallback', async () => {
        const input = request('fd_A', 'inspect', { line: 7, reference: '[File B](file)' });
        const binding = snapshot().tools[input.toolId].targets.find((target: any) => target.viewId === 'fd_A');
        await update({ display: 2, refValue: 2 });
        await vi.waitFor(() => expect(Object.values(snapshot().refs).some((ref: any) =>
            ref.ownerViewId === 'fd_A' && ref.target.payload?.refValue === 2)).toBe(true));
        expect(snapshot().tools[input.toolId].targets.find((target: any) => target.viewId === 'fd_A')).toEqual(binding);
        expect(await host.executeReadOnlyViewTool(input, () => true)).toMatchObject({
            success: true, data: { who: 'A', args: { reference: '[File B](file)' } },
        });
    });

    const mutations = [
        { action: 'disable', code: 'TOOL_UNAVAILABLE' }, { action: 'reregister', code: 'TOOL_SOURCE_STALE' },
        { action: 'schema', code: 'TOOL_SOURCE_STALE' }, { action: 'remount', code: 'VIEW_INSTANCE_REVOKED' },
    ];
    async function mutate(action: string) {
        if (action === 'disable' || action === 'reregister') await update({ enabledA: false });
        if (action === 'reregister') await update({ enabledA: true });
        if (action === 'schema') await update({ queryType: 'string' });
        if (action === 'remount') { await update({ showA: false }); await update({ showA: true, aKey: 1 }); }
    }
    it.each(mutations)('rechecks unchanged caller source after authorization: $action', async ({ action, code }) => {
        const input = action === 'schema' ? request('fd_A', 'query', { value: 7 }) : request();
        const old = snapshot().tools[input.toolId].targets.find((target: any) => target.viewId === 'fd_A');
        const started = gate(); const resume = gate();
        const pending = host.executeReadOnlyViewTool(input, async () => { started.release(); await resume.promise; return true; });
        try {
            await started.promise; await mutate(action);
            await vi.waitFor(() => {
                const current = snapshot().tools[input.toolId]?.targets.find((target: any) => target.viewId === 'fd_A');
                if (action === 'disable') expect(current).toBeUndefined();
                else {
                    expect(current).toBeDefined();
                    if (action === 'remount') expect(current.viewInstanceId).not.toBe(old.viewInstanceId);
                    else expect(current.bindingVersion).not.toBe(old.bindingVersion);
                }
            });
        } finally { resume.release(); }
        expect(await pending).toMatchObject({ success: false, error: { code } });
        expect((await stats()).calls).toEqual({ A: 0, B: 0, query: 0 });
    });

    it.each(mutations)('Worker live registry rejects $action even if Host misses the newer prepared snapshots', async ({ action, code }) => {
        const input = action === 'schema' ? request('fd_A', 'query', { value: 7 }) : request();
        const drop = vi.spyOn((host as any).shadowReceiver, 'acceptPrepared').mockImplementation(() => {});
        try {
            await mutate(action);
            expect(snapshot().id).toBe(input.snapshotId);
            expect(await host.executeReadOnlyViewTool(input, () => true)).toMatchObject({ success: false, error: { code } });
            expect((await stats()).calls).toEqual({ A: 0, B: 0, query: 0 });
        } finally { drop.mockRestore(); }
    });

    it.each(['close', 'error', 'reset'] as const)('does not dispatch a late authorization after App %s', async terminal => {
        const prior = host; const input = request(); const started = gate(); const resume = gate();
        const dispatch = vi.spyOn(prior as any, 'sendRequest');
        const pending = prior.executeReadOnlyViewTool(input, async () => { started.release(); await resume.promise; return true; });
        try {
            await started.promise;
            if (terminal === 'close') await prior.close();
            if (terminal === 'error') {
                vi.spyOn(console, 'error').mockImplementation(() => {});
                (prior as any).worker.emit('error', new Error('Injected failure while policy awaits'));
            }
            if (terminal === 'reset') {
                const worker = await prior.releaseWorker();
                if (!worker) throw new Error('Expected RESET handoff');
                await open(worker);
                expect(host.appInstanceId).not.toBe(prior.appInstanceId);
                expect(await host.executeReadOnlyViewTool(input, () => true)).toMatchObject({ success: false, error: { code: 'SNAPSHOT_EXPIRED' } });
            }
        } finally { resume.release(); }
        expect(await pending).toMatchObject({ success: false, error: { code: 'APP_STOPPED' } });
        expect(dispatch.mock.calls.filter(([message]: any) => message.type === 'VIEW_TOOL_INVOKE')).toHaveLength(0);
        expect((prior as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
    });
});
