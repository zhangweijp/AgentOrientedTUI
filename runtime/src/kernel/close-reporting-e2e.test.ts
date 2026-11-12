import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type RuntimeOptions } from '../facades/facades.js';
import { WorkerSandbox } from '../engine/app/worker-sandbox.js';
import { createNodeStateStorage } from '../adapters/storage/node-state-storage.js';
import { DEFAULT_NODE_STATE_LIMITS } from '../engine/app/state-storage-host.js';

const repo=resolve(process.cwd(),'..'),url=(file:string)=>pathToFileURL(file).href;
const sdkDist=process.env.AOTUI_C03_SDK_DIST??join(repo,'sdk/dist/index.js');
const runtimeDist=process.env.AOTUI_C03_RUNTIME_DIST??join(repo,'runtime/dist');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};
async function capture(file:string,body:string){
    await writeFile(file,body);const root=process.env.AOTUI_W08_C1_FACTS_DIR;
    if(root){const hash=createHash('sha256').update(body).digest('hex'),folder=join(root,'c2-inputs');await mkdir(folder,{recursive:true});await writeFile(join(folder,hash),body);await writeFile(join(folder,hash+'.json'),JSON.stringify({path:file,sha256:hash,capturedBeforeExecution:true}));}
}
async function facts(name:string,value:object){const root=process.env.AOTUI_W08_C1_FACTS_DIR;if(root){await mkdir(root,{recursive:true});await writeFile(join(root,'c2-kernel-'+name+'.json'),JSON.stringify(value,null,2));}}
async function fixture(scenario='normal'){
    const dir=await mkdtemp(join(tmpdir(),'aotui-c2-kernel-')),app=join(dir,'app.mjs'),entered=join(dir,'entered'),release=join(dir,'release');
    await mkdir(join(dir,'node_modules'),{recursive:true});
    await symlink(join(repo,'sdk/node_modules/preact'),join(dir,'node_modules/preact'),'dir');
    await symlink(join(repo,'sdk/node_modules/typebox'),join(dir,'node_modules/typebox'),'dir');
    const body=`import {writeFile} from 'node:fs/promises';import {existsSync} from 'node:fs';
import {h} from 'preact';import {Type} from 'typebox';import {createTUIApp,View,defineViewTypeTool,AppTools, defineToolSet,usePersistentState,useAppRuntimeContext} from ${JSON.stringify(url(sdkDist))};
let setter,value,port;function Detail(){
return h('section',{},h('p',{},String(value)));}

const fixtureTools0 = defineToolSet({
Set: defineViewTypeTool({viewType:'Detail',name:'set',description:'Set persisted value',inputSchema:Type.Object({value:Type.Number()},{additionalProperties:false}),}),
Flush: defineViewTypeTool({viewType:'Detail',name:'flush',description:'Flush persisted state',inputSchema:Type.Object({},{additionalProperties:false}),})
});
function Root(){
[value,setter]=usePersistentState('value',0);port=useAppRuntimeContext().persistence;
return h(AppTools, { definition: fixtureTools0, bindings: {
Set: { execute: async args=>{setter(args.value);return {success:true,data:{value:args.value}};} },
Flush: { execute: async()=>({success:true,data:await port.flush()}) }
} }, h(View,{kind: 'state',id:'detail',type:'Detail'},h(Detail)));}
const factory=createTUIApp({app_name:'close',component:Root});
${scenario==='async-unmount'||scenario==='failed-unmount'?`const initialize=factory.initialize.bind(factory);factory.initialize=async(...args)=>{const renderer=await initialize(...args);return {...renderer,async close(){${scenario==='async-unmount'?`await writeFile(${JSON.stringify(entered)},'entered');while(!existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,5));`:''}renderer.close();${scenario==='failed-unmount'?"throw Error('private unmount detail');":''}}};};`:''}
export default factory;`;
    await capture(app,body);return {dir,app,entered,release,data:join(dir,'data'),record:(desktop='d',name='close')=>join(dir,'data/app-state',desktop,name,'value.json')};
}
const makeRuntime=(options?: RuntimeOptions)=>createRuntime({worker:{timeoutMs:4000,maxWorkers: 4}},options);
function sandbox(runtime:any,id='d',app='app'):any{return (runtime.getDesktop(id) as any).appManager.getWorkerSandbox(app);}
async function install(runtime:any,f:Awaited<ReturnType<typeof fixture>>,id='d',app='app',extra={}){
    if(!(runtime as any).desktopManager.get(id))await runtime.createDesktop(id);
    // Vitest loads the parent from src; the actual Node Worker must consume built JS.
    return runtime.installDynamicWorkerApp(id,url(f.app),{appId:app,workerScriptPath:join(runtimeDist,'worker-runtime/index.js'),config:{AOTUI_DATA_DIR:f.data,AOTUI_APP_KEY:'close'},...extra});
}
async function invoke(runtime:any,id='d',app='app',name='set',input={value:1}){
    const instanceId=runtime.getDesktop(id).getInstalledApps().find((item:any)=>item.appId===app)?.appInstanceId;
    const opened=runtime.getAppInteraction(id,app,instanceId);
    if(opened.status!=='ready')throw new Error(opened.issue.code);const client=opened.interaction;
    let observation:any;
    try{
        await vi.waitFor(async()=>{const result=await client.observe({all:true});expect(result.status).toBe('observed');if(result.status==='observed')observation=result.observation;},{timeout:6000});
        expect(client.adoptObservation(observation.observationId)).toEqual({status:'adopted'});
        const tool=observation.tools.find((item:any)=>item.name===name),binding=observation.bindings.find((item:any)=>item.toolId===tool?.id&&item.execution.kind==='view-type');
        if(!binding)throw new Error('Missing Semantic Tool binding '+name);
        const result=await client.invoke({invocationId:randomUUID(),observationId:observation.observationId,bindingId:binding.bindingId,input});
        if(result.kind!=='receipt'||result.receipt.outcome.status!=='succeeded')return {success:false};
        return result.receipt.outcome.value as any;
    }finally{if(observation)client.releaseObservation(observation.observationId);}
}
function inject(extra:(box:any)=>object){const original=WorkerSandbox.prototype.installDynamic;vi.spyOn(WorkerSandbox.prototype,'installDynamic').mockImplementation(function(this:any){Object.assign(this.config,extra(this));return original.call(this);});}
afterEach(()=>{vi.restoreAllMocks();});

it('C2-26 actual default Kernel/SDK saves two Desktop values and closes all physical Workers',async()=>{
    const f=await fixture(),runtime=makeRuntime();
    try{
        await install(runtime,f,'a');await install(runtime,f,'b');const boxes=[sandbox(runtime,'a'),sandbox(runtime,'b')],workers=boxes.map(box=>box.workerHost.worker);
        expect((await invoke(runtime,'a','app','set',{value:11})).success).toBe(true);expect((await invoke(runtime,'b','app','set',{value:22})).success).toBe(true);
        const closing=runtime.beginShutdown(),before=closing.inspect();const report=await closing.completion;await runtime.shutdown();
        expect(report).toMatchObject({state:'settled',ok:true,verification:'managed',apps:{accepted:2,settled:2,pending:0,notVerifiedReleased:0},desktops:{accepted:2,settled:2,pending:0},persistence:{managedApps:2,confirmedFlushes:2,failedFlushes:0},resources:{storageActualIO:0,retainedStorageOwners:0,openingStorageOwners:0},workers:{ownership:'owned',report:{state:'closed',total:0}}});
        expect(workers.map(worker=>worker.threadId)).toEqual([-1,-1]);expect((runtime as any).desktopManager.listDesktopIds()).toEqual([]);
        expect(JSON.parse(await readFile(f.record('a'),'utf8')).value).toBe(11);expect(JSON.parse(await readFile(f.record('b'),'utf8')).value).toBe(22);expect(before.state).toBe('closing');await facts('normal',{before,report,physicalThreadIds:workers.map(worker=>worker.threadId)});
    }finally{await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it('C2-25 Desktop close exits its own Worker and preserves other Desktops in the Runtime',async()=>{
    const f=await fixture(),runtime=makeRuntime();
    try{
        await install(runtime,f,'first');await install(runtime,f,'second');const first=sandbox(runtime,'first'),second=sandbox(runtime,'second'),workers=[first.workerHost.worker,second.workerHost.worker];
        const closed=await runtime.beginDesktopShutdown('first').completion;expect(closed).toMatchObject({ok:true,resourcesReleased:true,workers:{ownership:'not-owned',report:null},apps:{accepted:1,settled:1}});
        expect(first.getCloseReport()).toMatchObject({host:{worker:'exited'}});expect(workers[0].threadId).toBe(-1);expect(workers[1].threadId).toBeGreaterThan(0);
        expect((await invoke(runtime,'second')).success).toBe(true);
        const report=await runtime.beginShutdown().completion;expect(report).toMatchObject({ok:true,apps:{accepted:1,settled:1},desktops:{accepted:1,settled:1},workers:{report:{state:'closed',total:0}}});expect(workers.map(worker=>worker.threadId)).toEqual([-1,-1]);await facts('desktop-close',{closed,report,first:first.getCloseReport(),threadIds:workers.map(worker=>worker.threadId)});
    }finally{await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},15000);

it('C2-25/26 Q02 real SDK async unmount is progress, retaining successful flush and ownership until completion',async()=>{
    const f=await fixture('async-unmount'),runtime=makeRuntime();
    try{
        await install(runtime,f);await invoke(runtime,'d','app','set',{value:31});const box=sandbox(runtime),worker=box.workerHost.worker,closing=runtime.beginShutdown();
        await vi.waitFor(()=>expect(existsSync(f.entered)).toBe(true),{timeout:3000});const before=closing.inspect();
        expect(before).toMatchObject({state:'closing',hasFailures:false,resourcesReleased:false,persistence:{closeReceipts:1,confirmedFlushes:1,failedFlushes:0}});
        expect((await closing.wait({timeoutMs:5})).status).toBe('deadline');expect(worker.threadId).toBeGreaterThan(0);expect(JSON.parse(await readFile(f.record(),'utf8')).value).toBe(31);
        await writeFile(f.release,'go');const report=await closing.completion;expect(report.ok).toBe(true);expect(worker.threadId).toBe(-1);expect(before.state).toBe('closing');expect(before.hasFailures).toBe(false);await facts('async-unmount',{before,report,threadId:worker.threadId});
    }finally{await writeFile(f.release,'go');await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},15000);

it('forces actual Worker exit after a held cleanup outlives the grace period', async () => {
    const f = await fixture('async-unmount');
    const runtime = createRuntime({ worker: { timeoutMs: 1500, maxWorkers: 1 } });
    try {
        await install(runtime, f);
        await invoke(runtime, 'd', 'app', 'set', { value: 32 });
        const box = sandbox(runtime), worker = box.workerHost.worker;
        const closing = runtime.beginShutdown();
        await vi.waitFor(() => expect(existsSync(f.entered)).toBe(true));
        const waiting = await closing.wait({ timeoutMs: 5 });
        expect(waiting).toMatchObject({ status: 'deadline', report: {
            resourcesReleased: false, workers: { report: { state: 'closing', total: 1 } },
        } });
        const final = await closing.completion;
        expect(final).toMatchObject({ hasFailures: true, resourcesReleased: true, appCleanup: { completedApps: 0 },
            persistence: { confirmedFlushes: 1 }, workers: { report: { state: 'closed', total: 0 } } });
        expect(final.failures.flatMap(sample => sample.codes)).toContain('APP_CLOSE_DEADLINE_EXCEEDED');
        expect(worker.threadId).toBe(-1);
        expect(JSON.parse(await readFile(f.record(), 'utf8')).value).toBe(32);
    } finally {
        await writeFile(f.release, 'go');
        await runtime.beginShutdown().completion;
        await rm(f.dir, { recursive: true, force: true });
    }
}, 10000);

it.each(['open','replace'] as const)('C2-27 real Node storage %s crosses a caller deadline while the original Kernel retains the actual owner',async held=>{
    const f=await fixture(),backend=createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS),entered=deferred(),finish=deferred(),runtime=makeRuntime();
    inject(()=>({persistenceBackend:{async open(input:any){const result=await backend.open(input);if(result.status!=='opened')return result;
        if(held==='open'){entered.resolve();await finish.promise;}
        return {status:'opened',storage:{...result.storage,async replace(address:any,text:string){if(held==='replace'){entered.resolve();await finish.promise;}return result.storage.replace(address,text);}}};}}}));
    let installing:Promise<unknown>|undefined;
    try{
        installing=install(runtime,f);const observedInstall=installing.catch(error=>error);
        if(held==='replace'){await installing;await invoke(runtime,'d','app','set',{value:41});}
        else await entered.promise;
        const box=sandbox(runtime),worker=box.workerHost.worker,closing=runtime.beginShutdown();if(held==='replace')await entered.promise;
        const deadline=await closing.wait({timeoutMs:5}),before=deadline.report;expect(deadline.status).toBe('deadline');
        expect(before).toMatchObject({state:'closing',resourcesReleased:false,resources:{storageActualIO:1,retainedStorageOwners:held==='open'?0:1}});expect(backend.getStats().ownerSlots).toBe(1);
        if(held==='open')expect(before.resources.openingStorageOwners).toBe(1);expect(worker.threadId).toBeGreaterThan(0);expect((runtime as any).desktopManager.get('d')).toBeDefined();
        finish.resolve();const report=await closing.completion;const result=await observedInstall;
        expect(report.resourcesReleased).toBe(true);expect(report.state).toBe('settled');expect(worker.threadId).toBe(-1);expect(backend.getStats().ownerSlots).toBe(0);expect(before.resources.storageActualIO).toBe(1);
        if(held==='replace'){expect(report.ok).toBe(true);expect(JSON.parse(await readFile(f.record(),'utf8')).value).toBe(41);}else{
            // SDK OPEN may already have acknowledged before hydration requests this open.
            // If admission is still pending it must fail safely; either outcome leaves no owner.
            if(result instanceof Error){expect((result as any).code).toBe('INSTALL_FAILED');expect(report.hasFailures).toBe(true);}else expect(result).toBe('app');
            expect((runtime as any).desktopManager.get('d')).toBeUndefined();
        }
        await facts('held-storage-'+held,{before,report,backend:backend.getStats(),physicalThreadId:worker.threadId,installOutcome:result instanceof Error?(result as any).code:result,barrier:'controlled adapter around real Node backend'});
    }finally{finish.resolve();await installing?.catch(()=>{});await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it('C2-28 two Runtime capacity owners / two Desktop IDs / two script paths are isolated',async()=>{
    const f=await fixture(),alternate=join(f.dir,'alternate-worker.mjs');await capture(alternate,`import ${JSON.stringify(url(join(runtimeDist,'worker-runtime/index.js')))};`);
    const a=makeRuntime(),b=makeRuntime();
    try{
        for(const runtime of [a,b]){await install(runtime,f,'one','app',{config:{AOTUI_DATA_DIR:join(f.dir,runtime===a?'a':'b'),AOTUI_APP_KEY:'close'}});await install(runtime,f,'two','app',{workerScriptPath:alternate,config:{AOTUI_DATA_DIR:join(f.dir,runtime===a?'a':'b'),AOTUI_APP_KEY:'close'}});}
        const aWorkers=['one','two'].map(id=>sandbox(a,id).workerHost.worker),bWorkers=['one','two'].map(id=>sandbox(b,id).workerHost.worker);expect(new Set([...aWorkers,...bWorkers]).size).toBe(4);
        const aReport=await a.beginShutdown().completion;expect(aReport.ok).toBe(true);expect(aWorkers.every(worker=>worker.threadId===-1)).toBe(true);expect(bWorkers.every(worker=>worker.threadId>0)).toBe(true);
        for(const id of ['one','two'])expect((await invoke(b,id,'app','set',{value:52})).success).toBe(true);
        const bReport=await b.beginShutdown().completion;expect(bReport.ok).toBe(true);expect(bWorkers.every(worker=>worker.threadId===-1)).toBe(true);await facts('isolation',{aReport,bReport,threadIds:[...aWorkers,...bWorkers].map(worker=>worker.threadId)});
    }finally{await Promise.all([a.beginShutdown().completion,b.beginShutdown().completion]);await rm(f.dir,{recursive:true,force:true});}
},30000);

it.each(['failed','unknown','unmount'] as const)('C2-25/27 actual Kernel preserves %s failure after real resource release and keeps its old void wrapper rejected',async mode=>{
    const f=await fixture(mode==='unmount'?'failed-unmount':'normal'),backend=createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS),runtime=makeRuntime();
    if(mode!=='unmount')inject(()=>({persistenceBackend:{async open(input:any){const result=await backend.open(input);return result.status!=='opened'?result:{status:'opened',storage:{...result.storage,async replace(address:any,text:string){if(mode==='unknown'){await result.storage.replace(address,text);return {status:'unknown',issue:{code:'UNKNOWN_OUTCOME'}};}return {status:'failed',effects:'none',issue:{code:'IO_FAILED'}};}}};}}}));
    try{
        await install(runtime,f);await invoke(runtime,'d','app','set',{value:63});const box=sandbox(runtime),worker=box.workerHost.worker,promise=runtime.shutdown();
        await expect(promise).rejects.toHaveProperty('code','RUNTIME_CLOSE_FAILED');expect(runtime.shutdown()).toBe(promise);await expect(runtime.shutdown()).rejects.toHaveProperty('code','RUNTIME_CLOSE_FAILED');
        const report=await runtime.beginShutdown().completion;expect(report).toMatchObject({state:'settled',hasFailures:true,resourcesReleased:true,persistence:{managedApps:1},workers:{report:{state:'closed',total:0}}});expect(worker.threadId).toBe(-1);
        if(mode==='unmount'){expect(report.persistence.confirmedFlushes).toBe(1);expect(report.persistence.failedFlushes).toBe(0);expect(report.failures.flatMap(item=>item.codes)).toContain('APP_UNMOUNT_FAILED');}
        else{expect(report.persistence.failedFlushes).toBe(1);expect(report.persistence.unsavedKeys).toBe(1);
            expect(box.getCloseReport().host.storage.uncertain).toBe(mode==='unknown');expect(report.persistence.unknownApps).toBe(mode==='unknown'?1:0);expect(backend.getStats().ownerSlots).toBe(0);}
        if(mode==='unknown')expect(JSON.parse(await readFile(f.record(),'utf8')).value).toBe(63);expect(JSON.stringify(report)).not.toContain('private unmount detail');await facts('failure-'+mode,{report,threadId:worker.threadId,backend:backend.getStats(),fault:'controlled receipt failure around actual Node storage'});
    }finally{await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it.each(['app', 'desktop'] as const)('releases the original storage owner through the public %s close path', async path => {
    const f = await fixture(), backend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS);
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
        const box = sandbox(runtime), worker = box.workerHost.worker;
        worker.on('message', (message: any) => {
            if (message.appCleanup?.state === 'completed') completedCleanups++;
        });
        expect((await invoke(runtime, 'd', 'app', 'set', { value: 73 })).success).toBe(true);
        const closeApp = () => desktop.closeApp('app', box.appInstanceId).catch(error => error.report);
        const initial = path === 'app' ? await closeApp() : await runtime.beginShutdown().completion;
        expect(initial).toMatchObject({ state: 'settled', hasFailures: true, resourcesReleased: false,
            resources: { retainedStorageOwners: 1 }, appCleanup: { completedApps: 1 } });
        expect(worker.threadId).toBe(-1);
        expect(backend.getStats().ownerSlots).toBe(1);
        expect([releases, writes, completedCleanups]).toEqual([1, 1, 1]);
        expect(runtime.getAppInteraction('d', 'app', box.appInstanceId).status).toBe('rejected');
        expect(JSON.parse(await readFile(f.record(), 'utf8')).value).toBe(73);

        let retry: Promise<unknown>;
        if (path === 'app') {
            retry = Promise.all([closeApp(), closeApp()]).then(([first, second]) => {
                expect(first).toEqual(second);
                return first;
            });
        } else {
            const handle = runtime.beginDesktopShutdown('d');
            expect(runtime.beginDesktopShutdown('d')).toBe(handle);
            retry = handle.completion;
        }
        await retryEntered.promise;
        expect([releases, writes, completedCleanups]).toEqual([2, 1, 1]);
        expect(backend.getStats().ownerSlots).toBe(1);
        finishRetry.resolve();
        expect(await retry).toMatchObject({ hasFailures: true, resourcesReleased: true,
            resources: { retainedStorageOwners: 0 }, appCleanup: { completedApps: 1 } });
        expect(initial.resourcesReleased).toBe(false);
        expect(Object.isFrozen(initial)).toBe(true);
        expect(backend.getStats().ownerSlots).toBe(0);
        if (path === 'app') await desktop.closeApp('app');
        else expect(await runtime.beginDesktopShutdown('d').completion).toMatchObject({ found: false });
        expect([releases, writes, completedCleanups]).toEqual([2, 1, 1]);
        if (path === 'app') {
            await desktop.openApp('app');
            const instance = desktop.getInstalledApps().find(app => app.appId === 'app')?.appInstanceId;
            expect(instance).toBeTruthy();
            expect(instance).not.toBe(box.appInstanceId);
            const reopened = runtime.getAppInteraction('d', 'app', instance!);
            if (reopened.status !== 'ready') throw Error(reopened.issue.code);
            await vi.waitFor(async () => {
                const preview = await reopened.interaction.preview();
                expect(preview).toMatchObject({ status: 'previewed', views: [
                    { id: 'detail', content: { value: expect.stringContaining('73') } },
                ] });
            });
        }
    } finally {
        finishRetry.resolve();
        await runtime.beginShutdown().completion;
        await runtime.beginDesktopShutdown('d').completion;
        await rm(f.dir, { recursive: true, force: true });
    }
}, 15000);

it('C2-29 emitted createRuntime + real SDK naturally exits a fresh Node child',async()=>{
    const f=await fixture(),driver=join(f.dir,'driver.mjs');
    const script = [
        "import assert from 'node:assert/strict';",
        "import {readFile} from 'node:fs/promises';",
        `import {createRuntime} from ${JSON.stringify(url(join(runtimeDist,'index.js')))};`,
        "const runtime=createRuntime({worker:{timeoutMs:4000,maxWorkers: 1}});",
        "await runtime.createDesktop('d');",
        `await runtime.installDynamicWorkerApp('d',${JSON.stringify(url(f.app))},{appId:'app',workerScriptPath:${JSON.stringify(join(runtimeDist,'worker-runtime/index.js'))},config:{AOTUI_DATA_DIR:${JSON.stringify(f.data)},AOTUI_APP_KEY:'close'}});`,
        "const desktop=runtime.getDesktop('d'),box=desktop.appManager.getWorkerSandbox('app'),worker=box.workerHost.worker;",
        "const opened=runtime.getAppInteraction('d','app',box.appInstanceId);",
        "assert.equal(opened.status,'ready');",
        "const observed=await opened.interaction.observe({all:true});assert.equal(observed.status,'observed');",
        "assert.equal(opened.interaction.adoptObservation(observed.observation.observationId).status,'adopted');",
        "const observation=observed.observation,tool=observation.tools.find(item=>item.name==='set'),binding=observation.bindings.find(item=>item.toolId===tool.id&&item.execution.kind==='view-type');assert.ok(binding);",
        "const result=await opened.interaction.invoke({invocationId:'child-call',observationId:observation.observationId,bindingId:binding.bindingId,input:{value:74}});",
        "assert.equal(result.kind,'receipt');assert.equal(result.receipt.outcome.status,'succeeded');opened.interaction.releaseObservation(observation.observationId);",
        "await runtime.shutdown();const report=await runtime.beginShutdown().completion;",
        "assert.equal(report.ok,true);assert.equal(report.workers.report.total,0);assert.equal(worker.threadId,-1);",
        `assert.equal(JSON.parse(await readFile(${JSON.stringify(f.record())},'utf8')).value,74);`,
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
        expect(guardUsed).toBe(false);expect(result).toMatchObject({code:0,signal:null});const line=result.stdout.split('\n').find(line=>line.startsWith('C2_NATURAL_END '));expect(line).toBeDefined();
        const final=JSON.parse(line!.slice('C2_NATURAL_END '.length));expect(final).toMatchObject({threadId:-1,value:74,report:{ok:true,workers:{report:{state:'closed',total:0}}}});await facts('natural-child',{...result,guardUsed,naturalExit:true});
    }finally{await rm(f.dir,{recursive:true,force:true});}
},20000);
