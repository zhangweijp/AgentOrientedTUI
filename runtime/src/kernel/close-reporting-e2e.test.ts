import { readSqliteState } from '../../tests/fixtures/sqlite-state.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimeOptions } from '../facades/facades.js';
import { createSqliteStateStorage } from '../adapters/storage/sqlite-state-storage.js';
import { DEFAULT_NODE_STATE_LIMITS } from '../engine/app/state-storage-host.js';

const repo=resolve(process.cwd(),'..'),url=(file:string)=>pathToFileURL(file).href;
const sdkDist=process.env.AOTUI_C03_SDK_DIST??join(repo,'sdk/dist/index.js');
const runtimeDist=process.env.AOTUI_C03_RUNTIME_DIST??join(repo,'runtime/dist');
const { createRuntime }: typeof import('../facades/facades.js') = await import(url(join(runtimeDist, 'index.js')));
const resolveSdkDependency = createRequire(sdkDist).resolve;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};
async function capture(file:string,body:string){
    await writeFile(file,body);const root=process.env.AOTUI_W08_C1_FACTS_DIR;
    if(root){const hash=createHash('sha256').update(body).digest('hex'),folder=join(root,'c2-inputs');await mkdir(folder,{recursive:true});await writeFile(join(folder,hash),body);await writeFile(join(folder,hash+'.json'),JSON.stringify({path:file,sha256:hash,capturedBeforeExecution:true}));}
}
async function facts(name:string,value:object){const root=process.env.AOTUI_W08_C1_FACTS_DIR;if(root){await mkdir(root,{recursive:true});await writeFile(join(root,'c2-kernel-'+name+'.json'),JSON.stringify(value,null,2));}}
async function fixture(scenario='normal'){
    const dir=await mkdtemp(join(tmpdir(),'aotui-c2-kernel-')),app=join(dir,'app.mjs'),entered=join(dir,'entered'),release=join(dir,'release');
    await mkdir(join(dir,'node_modules'),{recursive:true});
    await symlink(dirname(resolveSdkDependency('preact/package.json')),join(dir,'node_modules/preact'),'dir');
    await symlink(resolve(dirname(resolveSdkDependency('typebox')), '..'),join(dir,'node_modules/typebox'),'dir');
    const body=`import {writeFile} from 'node:fs/promises';import {existsSync} from 'node:fs';
import {h} from 'preact';import {Type} from 'typebox';import { createTUIApp, useState, useEffect, useAppLifecycle, useAppRuntimeContext, defineViewType, DynamicView } from ${JSON.stringify(url(sdkDist))};
let setter,value,port,draft;function Detail(){
return h('section',{},h('p',{},String(value)));}
const DetailType = defineViewType()({ multiplicity: 'multiple', name: 'Detail', tools: {
    set: {
        description: 'Set persisted value', inputSchema: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
        async execute({ input }) {
            ${scenario==='held-write' ? `await port.save('value',input.value);
            await writeFile(${JSON.stringify(entered)},'saved');
            while(!existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,5));`
            : 'draft=input.value;setter(input.value);'}
            return { success: true, data: { value: input.value } };
        },
    },
    flush: {
        description: 'Flush persisted state', inputSchema: Type.Object({}, { additionalProperties: false }),
        execute: async () => ({ success: true, data: await port.flush() }),
    },
} });
function Root() {
    [value, setter] = useState(0);
    port = useAppRuntimeContext().persistence;
    useEffect(() => { void port.load('value').then(saved => { if (saved !== undefined && draft === undefined) setter(saved); }).catch(() => {}); }, [port]);
    useAppLifecycle({ async close() { if (draft !== undefined) await port.save('value',draft); } });
    return h('div', null, h(DynamicView, { idPrefix: 'detail', type: DetailType, context: {} }, h(Detail)));
}
const factory=createTUIApp({persistence:true,viewTypes:[DetailType], app_name:'close',component:Root});
${scenario==='async-unmount'||scenario==='failed-unmount'?`const initialize=factory.initialize.bind(factory);factory.initialize=async(...args)=>{const renderer=await initialize(...args);return {...renderer,async close(){${scenario==='async-unmount'?`await writeFile(${JSON.stringify(entered)},'entered');while(!existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,5));`:''}renderer.close();${scenario==='failed-unmount'?"throw Error('private unmount detail');":''}}};};`:''}
export default factory;`;
    await capture(app,body);return {dir,app,entered,release,data:join(dir,'data'),read:(desktop='d',name='close')=>readSqliteState(join(dir,'data/app-state'),desktop,name,'value')};
}
const makeRuntime=(options?: RuntimeOptions)=>createRuntime({worker:{timeoutMs:4000,maxWorkers: 4}},options);
function appRecord(runtime: any, desktop: string, installationId: string) {
    return runtime.getDesktop(desktop).listApps().find((item: any) => item.installationId === installationId);
}
function sandbox(runtime:any,id='d',app='app'):any{
    return (runtime.getDesktop(id) as any).appManager.getManagedApp(appRecord(runtime, id, app)?.appId ?? 'close');
}
async function install(runtime:any,f:Awaited<ReturnType<typeof fixture>>,id='d',app='app',extra={}){
    try { runtime.getDesktop(id); }
    catch (error) {
        expect(error).toHaveProperty('code', 'DESKTOP_NOT_FOUND');
        await runtime.createDesktop(id);
    }
    return (await runtime.getDesktop(id).installDynamicWorkerApp(url(f.app),{installationId:app,name:'close',config:{AOTUI_DATA_DIR:f.data,AOTUI_APP_KEY:'close'},...extra})).appId;
}
async function invoke(runtime:any,id='d',app='app',name='set',input={value:1}){
    const current = appRecord(runtime, id, app);
    const desktop=runtime.getDesktop(id), opened=desktop.getRunningApp(current?.appId,current?.appInstanceId);
    if(opened.status!=='ready')throw new Error(opened.issue.code);
    let candidate:any, turn:any;
    try{
        await vi.waitFor(async()=>{const result=await opened.app.observe();expect(result.status).toBe('prepared');if(result.status==='prepared')candidate=result.candidate;},{timeout:6000});
        const adopted=desktop.adoptTurn({apps:[{candidate}]});expect(adopted.status).toBe('adopted');turn=adopted.turn;
        const {observation}=candidate, tool=observation.tools.find((item:any)=>item.name===name);
        if(!tool)throw new Error('Missing View Tool '+name);
        const result=await turn.invoke(opened.app.appId,{invocationId:randomUUID(),observationId:observation.observationId,toolId:tool.id,viewId: 'detail_1', input:{...input}});
        if(result.kind!=='receipt'||result.receipt.outcome.status!=='succeeded')return {success:false};
        return result.receipt.outcome.value as any;
    }finally{turn?.release();candidate?.discard();}
}
afterEach(()=>{vi.restoreAllMocks();});

it('C2-26 actual default Kernel/SDK saves two Desktop values and closes all physical Workers',async()=>{
    const f=await fixture(),runtime=makeRuntime();
    try{
        await install(runtime,f,'a');await install(runtime,f,'b');const boxes=[sandbox(runtime,'a'),sandbox(runtime,'b')],workers=boxes.map(box=>box.host.worker);
        expect((await invoke(runtime,'a','app','set',{value:11})).success).toBe(true);expect((await invoke(runtime,'b','app','set',{value:22})).success).toBe(true);
        const closing=runtime.beginClose(),before=closing.inspect();const report=await closing.completion;await runtime.beginClose().completion;
        expect(report).toMatchObject({state:'settled',ok:true,verification:'managed',apps:{accepted:2,settled:2,pending:0,notVerifiedReleased:0},desktops:{accepted:2,settled:2,pending:0},persistence:{managedApps:2,confirmedFlushes:2,failedFlushes:0},resources:{pendingOperations:0,retainedOwners:0},workers:{ownership:'owned',report:{state:'closed',total:0}}});
        expect(workers.map(worker=>worker.threadId)).toEqual([-1,-1]);
        for (const id of ['a', 'b']) expect(() => runtime.getDesktop(id)).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
        expect(JSON.parse(f.read('a')!).value).toBe(11);expect(JSON.parse(f.read('b')!).value).toBe(22);expect(before.state).toBe('closing');await facts('normal',{before,report,physicalThreadIds:workers.map(worker=>worker.threadId)});
    }finally{await runtime.beginClose().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it('C2-25 Desktop close exits its own Worker and preserves other Desktops in the Runtime',async()=>{
    const f=await fixture(),runtime=makeRuntime();
    try{
        await install(runtime,f,'first');await install(runtime,f,'second');const first=sandbox(runtime,'first'),second=sandbox(runtime,'second'),workers=[first.host.worker,second.host.worker];
        const closed=await runtime.getDesktop('first').beginClose().completion;expect(closed).toMatchObject({ok:true,resourcesReleased:true,workers:{ownership:'not-owned',report:null},apps:{accepted:1,settled:1}});
        expect(first.host.getResourceReport()).toMatchObject({worker:'exited'});expect(workers[0].threadId).toBe(-1);expect(workers[1].threadId).toBeGreaterThan(0);
        expect((await invoke(runtime,'second')).success).toBe(true);
        const report=await runtime.beginClose().completion;expect(report).toMatchObject({ok:true,apps:{accepted:1,settled:1},desktops:{accepted:1,settled:1},workers:{report:{state:'closed',total:0}}});expect(workers.map(worker=>worker.threadId)).toEqual([-1,-1]);await facts('desktop-close',{closed,report,first:first.host.getResourceReport(),threadIds:workers.map(worker=>worker.threadId)});
    }finally{await runtime.beginClose().completion;await rm(f.dir,{recursive:true,force:true});}
},15000);

it('C2-25/26 Q02 real SDK async unmount keeps ownership before the terminal flush',async()=>{
    const f=await fixture('async-unmount'),runtime=makeRuntime();
    try{
        await install(runtime,f);await invoke(runtime,'d','app','set',{value:31});const box=sandbox(runtime),worker=box.host.worker,closing=runtime.beginClose();
        await vi.waitFor(()=>expect(existsSync(f.entered)).toBe(true),{timeout:3000});const before=closing.inspect();
        expect(before).toMatchObject({state:'closing',hasFailures:false,resourcesReleased:false,persistence:{closeReceipts:0,confirmedFlushes:0,failedFlushes:0}});
        expect((await closing.wait({timeoutMs:5})).status).toBe('deadline');expect(worker.threadId).toBeGreaterThan(0);expect(f.read()).toBeUndefined();
        await writeFile(f.release,'go');const report=await closing.completion;expect(report.ok).toBe(true);expect(worker.threadId).toBe(-1);expect(JSON.parse(f.read()!).value).toBe(31);expect(before.state).toBe('closing');expect(before.hasFailures).toBe(false);await facts('async-unmount',{before,report,threadId:worker.threadId});
    }finally{await writeFile(f.release,'go');await runtime.beginClose().completion;await rm(f.dir,{recursive:true,force:true});}
},15000);

it('forces actual Worker exit after a held cleanup outlives the grace period', async () => {
    const f = await fixture('async-unmount');
    const runtime = createRuntime({ worker: { timeoutMs: 1500, maxWorkers: 1 } });
    try {
        await install(runtime, f);
        await invoke(runtime, 'd', 'app', 'set', { value: 32 });
        const box = sandbox(runtime), worker = box.host.worker;
        const closing = runtime.beginClose();
        await vi.waitFor(() => expect(existsSync(f.entered)).toBe(true));
        const waiting = await closing.wait({ timeoutMs: 5 });
        expect(waiting).toMatchObject({ status: 'deadline', report: {
            resourcesReleased: false, workers: { report: { state: 'closing', total: 1 } },
        } });
        const final = await closing.completion;
        expect(final).toMatchObject({ hasFailures: true, resourcesReleased: true, appCleanup: { completedApps: 0 },
            persistence: { confirmedFlushes: 0, missingCloseReceipts: 1 }, workers: { report: { state: 'closed', total: 0 } } });
        expect(final.failures.flatMap(sample => sample.codes)).toContain('APP_CLOSE_DEADLINE_EXCEEDED');
        expect(worker.threadId).toBe(-1);
        expect(f.read()).toBeUndefined();
    } finally {
        await writeFile(f.release, 'go');
        await runtime.beginClose().completion;
        await rm(f.dir, { recursive: true, force: true });
    }
}, 10000);

it.each(['confirmed', 'unknown'] as const)('reports the %s outcome of the final dispatched write on the App close handle', async mode => {
    const f = await fixture('held-write');
    const runtime = createRuntime({ worker: { timeoutMs: 1500, maxWorkers: 1 } });
    try {
        await install(runtime, f);
        const desktop = runtime.getDesktop('d'), record = appRecord(runtime, 'd', 'app');
        const opened = desktop.getRunningApp(record.appId, record.appInstanceId);
        if (opened.status !== 'ready') throw Error(opened.issue.code);
        const observed = await opened.app.observe();
        if (observed.status !== 'prepared') throw Error(observed.issue.code);
        const { candidate } = observed, adopted = desktop.adoptTurn({ apps: [{ candidate }] });
        if (adopted.status !== 'adopted') throw Error(adopted.issue.code);
        const { observationId, tools } = candidate.observation, invocationId = 'last-write';
        const pending = adopted.turn.invoke(opened.app.appId, { observationId, invocationId,
            toolId: tools.find(tool => tool.name === 'set')!.id, viewId: 'detail_1', input: { value: 84 } });
        await vi.waitFor(() => expect(existsSync(f.entered)).toBe(true));
        const worker = sandbox(runtime).host.worker, handle = opened.app.beginClose();
        if (mode === 'confirmed') await writeFile(f.release, 'go');
        const report = await handle.completion;
        await pending;
        expect(report).toMatchObject({ resourcesReleased: true, worker: 'exited', ok: mode === 'confirmed',
            closingInvocation: { observationId, invocationId, executionPhase: mode === 'confirmed' ? 'entered-returned' : 'unknown',
                status: mode === 'confirmed' ? 'succeeded' : 'unknown' } });
        expect(worker.threadId).toBe(-1);
        expect(JSON.parse(f.read()!).value).toBe(84);
        await facts('last-write-' + mode, { report, threadId: worker.threadId, saved: 84 });
    } finally {
        await writeFile(f.release, 'go');
        await runtime.beginClose().completion;
        await rm(f.dir, { recursive: true, force: true });
    }
}, 10000);

it.each(['open','replace'] as const)('C2-27 real Node storage %s crosses a caller deadline while the original Kernel retains the actual owner',async held=>{
    const f=await fixture(),backend=createSqliteStateStorage(DEFAULT_NODE_STATE_LIMITS),entered=deferred(),finish=deferred();
    const runtime=makeRuntime({storageBackend:{async open(input:any){const result=await backend.open(input);if(result.status!=='opened')return result;
        if(held==='open'){entered.resolve();await finish.promise;}
        return {status:'opened',storage:{...result.storage,async replace(address:any,text:string){if(held==='replace'){entered.resolve();await finish.promise;}return result.storage.replace(address,text);}}};}}});
    let installing:Promise<unknown>|undefined;
    try{
        installing=install(runtime,f);const observedInstall=installing.catch(error=>error);
        if(held==='replace'){await installing;await invoke(runtime,'d','app','set',{value:41});}
        else await entered.promise;
        const box=sandbox(runtime),worker=box.host.worker,closing=runtime.beginClose();if(held==='replace')await entered.promise;
        const deadline=await closing.wait({timeoutMs:5}),before=deadline.report;expect(deadline.status).toBe('deadline');
        expect(before).toMatchObject({state:'closing',resourcesReleased:false,resources:{pendingOperations:1,retainedOwners:held==='open'?0:1}});expect(backend.getStats().ownerSlots).toBe(1);
        if(held==='open')expect(box.host.getPersistenceReport().opening).toBe(true);expect(worker.threadId).toBeGreaterThan(0);expect(runtime.getDesktop('d')).toBeDefined();
        finish.resolve();const report=await closing.completion;const result=await observedInstall;
        expect(report.resourcesReleased).toBe(true);expect(report.state).toBe('settled');expect(worker.threadId).toBe(-1);expect(backend.getStats().ownerSlots).toBe(0);expect(before.resources.pendingOperations).toBe(1);
        if(held==='replace'){expect(report.ok).toBe(true);expect(JSON.parse(f.read()!).value).toBe(41);}else{
            // SDK OPEN may already have acknowledged before hydration requests this open.
            // If admission is still pending it must fail safely; either outcome leaves no owner.
            if(result instanceof Error){expect((result as any).code).toBe('INSTALL_FAILED');}else expect(result).toBe('close');
            expect(() => runtime.getDesktop('d')).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
        }
        await facts('held-storage-'+held,{before,report,backend:backend.getStats(),physicalThreadId:worker.threadId,installOutcome:result instanceof Error?(result as any).code:result,barrier:'controlled adapter around real Node backend'});
    }finally{finish.resolve();await installing?.catch(()=>{});await runtime.beginClose().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it('C2-28 two Runtime capacity owners / two Desktop IDs are isolated',async()=>{
    const f=await fixture();
    const a=makeRuntime(),b=makeRuntime();
    try{
        for(const runtime of [a,b]){await install(runtime,f,'one','app',{config:{AOTUI_DATA_DIR:join(f.dir,runtime===a?'a':'b'),AOTUI_APP_KEY:'close'}});await install(runtime,f,'two','app',{config:{AOTUI_DATA_DIR:join(f.dir,runtime===a?'a':'b'),AOTUI_APP_KEY:'close'}});}
        const aWorkers=['one','two'].map(id=>sandbox(a,id).host.worker),bWorkers=['one','two'].map(id=>sandbox(b,id).host.worker);expect(new Set([...aWorkers,...bWorkers]).size).toBe(4);
        const aReport=await a.beginClose().completion;expect(aReport.ok).toBe(true);expect(aWorkers.every(worker=>worker.threadId===-1)).toBe(true);expect(bWorkers.every(worker=>worker.threadId>0)).toBe(true);
        for(const id of ['one','two'])expect((await invoke(b,id,'app','set',{value:52})).success).toBe(true);
        const bReport=await b.beginClose().completion;expect(bReport.ok).toBe(true);expect(bWorkers.every(worker=>worker.threadId===-1)).toBe(true);await facts('isolation',{aReport,bReport,threadIds:[...aWorkers,...bWorkers].map(worker=>worker.threadId)});
    }finally{await Promise.all([a.beginClose().completion,b.beginClose().completion]);await rm(f.dir,{recursive:true,force:true});}
},30000);

it.each(['failed','unknown','unmount'] as const)('C2-25/27 actual Kernel preserves %s failure after real resource release',async mode=>{
    const f=await fixture(mode==='unmount'?'failed-unmount':'normal'),backend=createSqliteStateStorage(DEFAULT_NODE_STATE_LIMITS);
    const storageBackend = mode === 'unmount' ? undefined : {async open(input:any){const result=await backend.open(input);return result.status!=='opened'?result:{status:'opened',storage:{...result.storage,async replace(address:any,text:string){if(mode==='unknown'){await result.storage.replace(address,text);return {status:'unknown',issue:{code:'UNKNOWN_OUTCOME'}};}return {status:'failed',effects:'none',issue:{code:'IO_FAILED'}};}}};}} satisfies RuntimeOptions['storageBackend'];
    const runtime = makeRuntime({ storageBackend });
    try{
        await install(runtime,f);await invoke(runtime,'d','app','set',{value:63});const box=sandbox(runtime),worker=box.host.worker,promise=runtime.beginClose().completion;
        expect(runtime.beginClose().completion).toBe(promise);
        const report=await runtime.beginClose().completion;expect(report).toMatchObject({state:'settled',hasFailures:true,resourcesReleased:true,persistence:{managedApps:1},workers:{report:{state:'closed',total:0}}});expect(worker.threadId).toBe(-1);
        if(mode==='unmount'){
            expect(report.persistence).toMatchObject({ confirmedFlushes: 1, failedFlushes: 0, unknownApps: 0, unsavedKeys: 0 });
            expect(report.failures.flatMap(item=>item.codes)).toContain('APP_UNMOUNT_FAILED');
            expect(report.failures.some(item=>item.stage==='persistence')).toBe(false);
            expect(JSON.parse(f.read()!).value).toBe(63);
        }
        else{expect(report.persistence?.failedFlushes).toBe(1);expect(report.persistence?.unsavedKeys).toBe(1);
            expect(box.host.getPersistenceReport().uncertain).toBe(mode==='unknown');expect(report.persistence?.unknownApps).toBe(mode==='unknown'?1:0);expect(backend.getStats().ownerSlots).toBe(0);}
        if(mode==='unknown')expect(JSON.parse(f.read()!).value).toBe(63);expect(JSON.stringify(report)).not.toContain('private unmount detail');await facts('failure-'+mode,{report,threadId:worker.threadId,backend:backend.getStats(),fault:'controlled receipt failure around actual Node storage'});
    }finally{await runtime.beginClose().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it.each(['app', 'desktop', 'runtime'] as const)('releases the original storage owner through the public %s close path', async path => {
    const f = await fixture(), backend = createSqliteStateStorage(DEFAULT_NODE_STATE_LIMITS);
    const retryEntered = deferred(), finishRetry = deferred();
    let releases = 0, writes = 0, completedCleanups = 0;
    const runtime = makeRuntime({ storageBackend: { async open(input: Parameters<typeof backend.open>[0]) {
        const opened = await backend.open(input);
        if (opened.status !== 'opened') return opened;
        return { status: 'opened' as const, storage: {
            ...opened.storage,
            async replace(address: Parameters<typeof opened.storage.replace>[0], value: string) {
                writes++;
                return opened.storage.replace(address, value);
            },
            async release() {
                releases++;
                if (releases === 1) return { status: 'failed' as const, issue: { code: 'PERMISSION_DENIED' } };
                retryEntered.resolve();
                await finishRetry.promise;
                return opened.storage.release();
            },
        } };
    } } });
    try {
        await install(runtime, f);
        const desktop = runtime.getDesktop('d')!;
        const box = sandbox(runtime), worker = box.host.worker;
        worker.on('message', (message: any) => {
            if (message.appCleanup?.state === 'completed') completedCleanups++;
        });
        expect((await invoke(runtime, 'd', 'app', 'set', { value: 73 })).success).toBe(true);
        const opened = desktop.getRunningApp(box.appId, box.appInstanceId);
        if (opened.status !== 'ready') throw Error(opened.issue.code);
        const close = path === 'app' ? opened.app.beginClose
            : path === 'desktop' ? () => desktop.beginClose() : () => runtime.beginClose();
        const initialHandle = close();
        const initial = await initialHandle.completion;
        expect(initial).toMatchObject({ state: 'settled', hasFailures: true, resourcesReleased: false,
            resources: { retainedOwners: 1 }, persistence: { confirmedFlushes: 1 }, appCleanup: { completedApps: 1 } });
        expect(worker.threadId).toBe(-1);
        expect(backend.getStats().ownerSlots).toBe(1);
        expect([releases, writes, completedCleanups]).toEqual([1, 1, 1]);
        expect(desktop.getRunningApp(box.appId, box.appInstanceId).status).toBe('rejected');
        expect(JSON.parse(f.read()!).value).toBe(73);
        if (path === 'desktop') {
            await expect(runtime.createDesktop('d')).rejects.toHaveProperty('code', 'DESKTOP_ALREADY_EXISTS');
        }
        const handle = close();
        expect(close()).toBe(handle);
        expect(handle).not.toBe(initialHandle);
        const retry = handle.completion;
        await retryEntered.promise;
        expect([releases, writes, completedCleanups]).toEqual([2, 1, 1]);
        expect(backend.getStats().ownerSlots).toBe(1);
        finishRetry.resolve();
        expect(await retry).toMatchObject({ hasFailures: true, resourcesReleased: true,
            resources: { retainedOwners: 0 }, persistence: { confirmedFlushes: 1 }, appCleanup: { completedApps: 1 } });
        expect(initial.resourcesReleased).toBe(false);
        expect(Object.isFrozen(initial)).toBe(true);
        expect(backend.getStats().ownerSlots).toBe(0);
        if (path !== 'app') expect(() => runtime.getDesktop('d')).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
        if (path === 'desktop') {
            await runtime.createDesktop('d');
            expect(runtime.getDesktop('d')).not.toBe(desktop);
        }
        expect(await initialHandle.completion).toEqual(initial);
        expect(await close().completion).toMatchObject({ resourcesReleased: true });
        await facts(path + '-release-retry', { initial, retry: await retry, releases, writes, completedCleanups,
            physicalThreadId: worker.threadId, saved: JSON.parse(f.read()!).value });
        expect([releases, writes, completedCleanups]).toEqual([2, 1, 1]);
        if (path === 'app') {
            const appId = (await desktop.openApp('app')).appId;
            const instance = desktop.listApps().find(app => app.appId === appId)?.appInstanceId;
            expect(instance).toBeTruthy();
            expect(instance).not.toBe(box.appInstanceId);
            const reopened = desktop.getRunningApp(appId, instance!);
            if (reopened.status !== 'ready') throw Error(reopened.issue.code);
            await vi.waitFor(async () => {
                const preview = await reopened.app.preview();
                expect(preview).toMatchObject({ status: 'previewed', views: [
                    { id: 'detail_1', content: { value: expect.stringContaining('73') } },
                ] });
            });
        }
    } finally {
        finishRetry.resolve();
        await runtime.beginClose().completion;
        await rm(f.dir, { recursive: true, force: true });
    }
}, 15000);

it('C2-29 emitted createRuntime + real SDK naturally exits a fresh Node child',async()=>{
    const f=await fixture(),driver=join(f.dir,'driver.mjs');
    const script = [
        "import assert from 'node:assert/strict';",
        `import {createRuntime} from ${JSON.stringify(url(join(runtimeDist,'index.js')))};`,
        "const runtime=createRuntime({worker:{timeoutMs:4000,maxWorkers: 1}});",
        "const desktop=await runtime.createDesktop('d');",
        `await desktop.installDynamicWorkerApp(${JSON.stringify(url(f.app))},{installationId:'app',name:'close',config:{AOTUI_DATA_DIR:${JSON.stringify(f.data)},AOTUI_APP_KEY:'close'}});`,
        "const box=desktop.appManager.getManagedApp('close'),worker=box.host.worker;",
        "const opened=desktop.getRunningApp('close',box.appInstanceId);",
        "assert.equal(opened.status,'ready');",
        "const observed=await opened.app.observe();assert.equal(observed.status,'prepared');",
        "const adopted=desktop.adoptTurn({apps:[{candidate:observed.candidate}]});assert.equal(adopted.status,'adopted');",
        "const observation=observed.candidate.observation,tool=observation.tools.find(item=>item.name==='set');assert.ok(tool);",
        "const result=await adopted.turn.invoke(opened.app.appId,{invocationId:'child-call',observationId:observation.observationId,toolId:tool.id,viewId:'detail_1',input:{value:74}});",
        "assert.equal(result.kind,'receipt');assert.equal(result.receipt.outcome.status,'succeeded');adopted.turn.release();",
        "await runtime.beginClose().completion;const report=await runtime.beginClose().completion;",
        "assert.equal(report.ok,true);assert.equal(report.workers.report.total,0);assert.equal(worker.threadId,-1);",
        "console.log('C2_NATURAL_END '+JSON.stringify({report,threadId:worker.threadId,value:74}));",
    ].join('\n');
    await capture(driver,script);
    let guardUsed=false;
    try{
        const result=await new Promise<{code:number|null;signal:string|null;stdout:string;stderr:string}>((resolve,reject)=>{
            const child=spawn(process.execPath,[driver],{env:process.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
            const guard=setTimeout(()=>{guardUsed=true;child.kill('SIGKILL');reject(Error('NATURAL_EXIT_GUARD_USED'));},15000);
            child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});child.on('error',error=>{clearTimeout(guard);reject(error);});child.on('exit',(code,signal)=>{clearTimeout(guard);resolve({code,signal,stdout,stderr});});
        });
        expect(JSON.parse(f.read()!).value).toBe(74);expect(guardUsed).toBe(false);expect(result).toMatchObject({code:0,signal:null});const line=result.stdout.split('\n').find(line=>line.startsWith('C2_NATURAL_END '));expect(line).toBeDefined();
        const final=JSON.parse(line!.slice('C2_NATURAL_END '.length));expect(final).toMatchObject({threadId:-1,value:74,report:{ok:true,workers:{report:{state:'closed',total:0}}}});await facts('natural-child',{...result,guardUsed,naturalExit:true});
    }finally{await rm(f.dir,{recursive:true,force:true});}
},20000);
