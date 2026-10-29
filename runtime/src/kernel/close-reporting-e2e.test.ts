import { afterEach, expect, it, vi } from 'vitest';
import { linkArchivedSdkDependencies } from '../../tests/fixtures/archived-sdk-dependencies.mjs';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../facades/facades.js';
import { WorkerSandbox } from '../engine/app/worker-sandbox.js';
import { createNodeStateStorage } from '../adapters/storage/node-state-storage.js';
import { DEFAULT_NODE_STATE_LIMITS } from '../engine/app/state-storage-host.js';
import { fileSystemService } from '../../../demo-apps/aotui-ide/src/core/file-system-service.js';

const repo=resolve(process.cwd(),'..'),url=(file:string)=>pathToFileURL(file).href;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};};
async function capture(file:string,body:string){
    await writeFile(file,body);const root=process.env.AOTUI_W08_C1_FACTS_DIR;
    if(root){const hash=createHash('sha256').update(body).digest('hex'),folder=join(root,'c2-inputs');await mkdir(folder,{recursive:true});await writeFile(join(folder,hash),body);await writeFile(join(folder,hash+'.json'),JSON.stringify({path:file,sha256:hash,capturedBeforeExecution:true}));}
}
async function facts(name:string,value:object){const root=process.env.AOTUI_W08_C1_FACTS_DIR;if(root){await mkdir(root,{recursive:true});await writeFile(join(root,'c2-kernel-'+name+'.json'),JSON.stringify(value,null,2));}}
async function fixture(scenario='normal',sdk=join(repo,'sdk/dist/index.js')){
    const dir=await mkdtemp(join(tmpdir(),'aotui-c2-kernel-')),app=join(dir,'app.mjs'),entered=join(dir,'entered'),release=join(dir,'release');
    const ordinary=scenario==='ordinary';
    const body=`import {writeFile} from 'node:fs/promises';import {existsSync} from 'node:fs';
import {createTUIApp${ordinary?'':',usePersistentState,useAppRuntimeContext'}} from ${JSON.stringify(url(sdk))};
let setter,value,port;function Root(){${ordinary?'':"[value,setter]=usePersistentState('value',0);port=useAppRuntimeContext().persistence;"}return null;}
const factory=createTUIApp({app_name:'close',component:Root,onOperation:async(op,args)=>{${ordinary?'':"if(op==='set')setter(args.value);if(op==='flush')return {success:true,data:await port.flush()};"}return {success:true,data:{value}};}});
${scenario==='async-unmount'||scenario==='failed-unmount'?`const initialize=factory.initializeComponent.bind(factory);factory.initializeComponent=async(...args)=>{const renderer=await initialize(...args);return {...renderer,async unmount(){${scenario==='async-unmount'?`await writeFile(${JSON.stringify(entered)},'entered');while(!existsSync(${JSON.stringify(release)}))await new Promise(resolve=>setTimeout(resolve,5));`:''}renderer.unmount();${scenario==='failed-unmount'?"throw Error('private unmount detail');":''}}};};`:''}
export default factory;`;
    await capture(app,body);return {dir,app,entered,release,data:join(dir,'data'),record:(desktop='d',name='close')=>join(dir,'data/app-state',desktop,name,'value.json')};
}
const makeRuntime=()=>createRuntime({worker:{timeoutMs:4000,pool:{initialSize:0,maxSize:4}}});
function sandbox(runtime:any,id='d',app='app'):any{return (runtime.getDesktop(id) as any).appManager.getWorkerSandbox(app);}
async function install(runtime:any,f:Awaited<ReturnType<typeof fixture>>,id='d',app='app',extra={}){
    if(!(runtime as any).desktopManager.has(id))await runtime.createDesktop(id);
    // Vitest loads the parent from src; the actual Node Worker must consume built JS.
    return runtime.installDynamicWorkerApp(id,url(f.app),{appId:app,workerScriptPath:join(repo,'runtime/dist/worker-runtime/index.js'),config:{AOTUI_DATA_DIR:f.data,AOTUI_APP_NAME:'close'},...extra});
}
async function op(runtime:any,id='d',app='app',name='set',args={value:1}){runtime.acquireLock(id,'test');return runtime.execute(id,{name,context:{appId:app,snapshotId:'fixture'},args},'test');}
function inject(extra:(box:any)=>object){const original=WorkerSandbox.prototype.installDynamic;vi.spyOn(WorkerSandbox.prototype,'installDynamic').mockImplementation(function(this:any){Object.assign(this.config,extra(this));return original.call(this);});}
afterEach(()=>{vi.restoreAllMocks();});

it('C2-26 actual default Kernel/SDK saves two Desktop values, closes all physical Workers and clears snapshot TTLs',async()=>{
    const f=await fixture(),runtime=makeRuntime();
    try{
        await install(runtime,f,'a');await install(runtime,f,'b');const boxes=[sandbox(runtime,'a'),sandbox(runtime,'b')],workers=boxes.map(box=>box.lease.worker);
        expect((await op(runtime,'a','app','set',{value:11})).success).toBe(true);expect((await op(runtime,'b','app','set',{value:22})).success).toBe(true);
        await runtime.acquireSnapshot('a',300000);await runtime.acquireSnapshot('b',300000);
        const closing=runtime.beginShutdown(),before=closing.inspect();const report=await closing.completion;await runtime.shutdown();
        expect(report).toMatchObject({state:'settled',ok:true,verification:'managed',apps:{accepted:2,settled:2,pending:0,notVerifiedReleased:0},desktops:{accepted:2,settled:2,pending:0},persistence:{managedApps:2,confirmedFlushes:2,failedFlushes:0},resources:{storageActualIO:0,retainedStorageOwners:0,openingStorageOwners:0},pool:{ownership:'owned',report:{state:'closed',total:0}},cleanup:{registry:'done'}});
        expect(workers.map(worker=>worker.threadId)).toEqual([-1,-1]);expect((runtime as any).snapshotRegistry.snapshots.size).toBe(0);expect((runtime as any).desktopManager.listDesktopIds()).toEqual([]);
        expect(JSON.parse(await readFile(f.record('a'),'utf8')).value).toBe(11);expect(JSON.parse(await readFile(f.record('b'),'utf8')).value).toBe(22);expect(before.state).toBe('closing');await facts('normal',{before,report,physicalThreadIds:workers.map(worker=>worker.threadId)});
    }finally{await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it('C2-25 Desktop close safely transfers a lease without claiming its borrowed Runtime pool physically exited',async()=>{
    const f=await fixture(),runtime=makeRuntime();
    try{
        await install(runtime,f,'first');await install(runtime,f,'second');const first=sandbox(runtime,'first'),second=sandbox(runtime,'second'),workers=[first.lease.worker,second.lease.worker];
        const closed=await runtime.beginDesktopShutdown('first').completion;expect(closed).toMatchObject({ok:true,resourcesReleased:true,pool:{ownership:'not-owned',report:null},apps:{accepted:1,settled:1}});
        expect(first.getCloseReport()).toMatchObject({host:{worker:'transferred'},lease:{disposition:'pooled'}});expect(workers.every(worker=>worker.threadId>0)).toBe(true);
        expect((runtime as any).desktopManager.getWorkerPoolReport()).toMatchObject({state:'open',total:2,idle:1,leased:1});expect((await op(runtime,'second')).success).toBe(true);
        const report=await runtime.beginShutdown().completion;expect(report).toMatchObject({ok:true,apps:{accepted:1,settled:1},desktops:{accepted:1,settled:1},pool:{report:{state:'closed',total:0}}});expect(workers.map(worker=>worker.threadId)).toEqual([-1,-1]);await facts('desktop-transfer',{closed,report,first:first.getCloseReport(),threadIds:workers.map(worker=>worker.threadId)});
    }finally{await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},15000);

it('C2-25/26 Q02 real SDK async unmount is progress, retaining successful flush and ownership until completion',async()=>{
    const f=await fixture('async-unmount'),runtime=makeRuntime();
    try{
        await install(runtime,f);await op(runtime,'d','app','set',{value:31});const box=sandbox(runtime),worker=box.lease.worker,closing=runtime.beginShutdown();
        await vi.waitFor(()=>expect(existsSync(f.entered)).toBe(true),{timeout:3000});const before=closing.inspect();
        expect(before).toMatchObject({state:'closing',hasFailures:false,resourcesReleased:false,persistence:{closeReceipts:1,confirmedFlushes:1,failedFlushes:0}});
        expect((await closing.wait({timeoutMs:5})).status).toBe('deadline');expect(worker.threadId).toBeGreaterThan(0);expect(JSON.parse(await readFile(f.record(),'utf8')).value).toBe(31);
        await writeFile(f.release,'go');const report=await closing.completion;expect(report.ok).toBe(true);expect(worker.threadId).toBe(-1);expect(before.state).toBe('closing');expect(before.hasFailures).toBe(false);await facts('async-unmount',{before,report,threadId:worker.threadId});
    }finally{await writeFile(f.release,'go');await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},15000);

it.each(['open','replace'] as const)('C2-27 real Node storage %s crosses a caller deadline while the original Kernel retains the actual owner',async held=>{
    const f=await fixture(),backend=createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS),entered=deferred(),finish=deferred(),runtime=makeRuntime();
    inject(()=>({persistenceBackend:{async open(input:any){const result=await backend.open(input);if(result.status!=='opened')return result;
        if(held==='open'){entered.resolve();await finish.promise;}
        return {status:'opened',storage:{...result.storage,async replace(address:any,text:string){if(held==='replace'){entered.resolve();await finish.promise;}return result.storage.replace(address,text);}}};}}}));
    let installing:Promise<unknown>|undefined;
    try{
        installing=install(runtime,f);const observedInstall=installing.catch(error=>error);
        if(held==='replace'){await installing;await op(runtime,'d','app','set',{value:41});}
        else await entered.promise;
        const box=sandbox(runtime),worker=box.lease.worker,closing=runtime.beginShutdown();if(held==='replace')await entered.promise;
        const deadline=await closing.wait({timeoutMs:5}),before=deadline.report;expect(deadline.status).toBe('deadline');
        expect(before).toMatchObject({state:'closing',resourcesReleased:false,resources:{storageActualIO:1,retainedStorageOwners:held==='open'?0:1}});expect(backend.getStats().ownerSlots).toBe(1);
        if(held==='open')expect(before.resources.openingStorageOwners).toBe(1);expect(worker.threadId).toBeGreaterThan(0);expect((runtime as any).desktopManager.has('d')).toBe(true);
        finish.resolve();const report=await closing.completion;const result=await observedInstall;
        expect(report.resourcesReleased).toBe(true);expect(report.state).toBe('settled');expect(worker.threadId).toBe(-1);expect(backend.getStats().ownerSlots).toBe(0);expect(before.resources.storageActualIO).toBe(1);
        if(held==='replace'){expect(report.ok).toBe(true);expect(JSON.parse(await readFile(f.record(),'utf8')).value).toBe(41);}else{
            // SDK OPEN may already have acknowledged before hydration requests this open.
            // If admission is still pending it must fail safely; either outcome leaves no owner.
            if(result instanceof Error){expect((result as any).code).toBe('INSTALL_FAILED');expect(report.hasFailures).toBe(true);}else expect(result).toBe('app');
            expect((runtime as any).desktopManager.has('d')).toBe(false);
        }
        await facts('held-storage-'+held,{before,report,backend:backend.getStats(),physicalThreadId:worker.threadId,installOutcome:result instanceof Error?(result as any).code:result,barrier:'controlled adapter around real Node backend'});
    }finally{finish.resolve();await installing?.catch(()=>{});await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it('C2-27 actual versioned file CAS continues after a Kernel observer deadline and is supervised until disk completion',async()=>{
    const f=await fixture(),file=join(f.dir,'file.txt');await writeFile(file,'before\n');const source=await fileSystemService.readVersionedFile(f.dir,file),entered=deferred(),finish=deferred(),runtime=makeRuntime();
    await capture(f.app,`import {h} from ${JSON.stringify(url(join(repo,'runtime/node_modules/preact/dist/preact.module.js')))};import {createTUIApp,View,useEntityRef,useViewTypeTool} from ${JSON.stringify(url(join(repo,'sdk/dist/index.js')))};
function Detail(){const ref=useEntityRef('file',{entityType:'File',entityId:${JSON.stringify(file)},entityVersion:${JSON.stringify(source.version)}});useViewTypeTool('replace_file',{description:'replace',params:{},isMutating:true},async()=>({success:false}));return h('p',{},ref('file'));}export default createTUIApp({app_name:'cas',component:()=>h(View,{id:'detail',type:'Detail'},h(Detail,{}))});`);
    inject(()=>({snapshotShadow:true,experimentalVersionedMutations:true}));
    try{
        await install(runtime,f);const box=sandbox(runtime),host=box.workerHost,worker=box.lease.worker;await vi.waitFor(()=>expect(host.getSnapshotShadowReport()).toMatchObject({health:'ready',lastToolCount:1}));
        const request={snapshotId:host.getSnapshotShadowReport().snapshotId,toolId:JSON.stringify(['app','Detail','replace_file']),viewId:'detail',refId:'file',newContent:'after\n'};
        const writing=host.executeVersionedFileReplace(request,()=>true,async(input:any)=>{entered.resolve();await finish.promise;return fileSystemService.replaceFileIfVersion(f.dir,input.filePath,input.expectedVersion,input.newContent);});
        await entered.promise;const closing=runtime.beginShutdown(),deadline=await closing.wait({timeoutMs:5});expect(deadline.status).toBe('deadline');expect(deadline.report.resources.activeFileReplacements).toBe(1);expect(worker.threadId).toBeGreaterThan(0);
        finish.resolve();expect(await writing).toMatchObject({success:true,data:{filePath:file}});const report=await closing.completion;expect(report.ok).toBe(true);expect(worker.threadId).toBe(-1);expect(await readFile(file,'utf8')).toBe('after\n');expect(deadline.report.resources.activeFileReplacements).toBe(1);await facts('held-file-cas',{before:deadline.report,report,threadId:worker.threadId,realFileCAS:true});
    }finally{finish.resolve();await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it.each([false,true])('C2-28 two Runtime pools / two Desktop IDs / two script paths are isolated, Shadow=%s',async snapshotShadow=>{
    const f=await fixture(),alternate=join(f.dir,'alternate-worker.mjs');await capture(alternate,`import ${JSON.stringify(url(join(repo,'runtime/dist/worker-runtime/index.js')))};`);
    inject(()=>({snapshotShadow}));const a=makeRuntime(),b=makeRuntime();
    try{
        for(const runtime of [a,b]){await install(runtime,f,'one','app',{config:{AOTUI_DATA_DIR:join(f.dir,runtime===a?'a':'b'),AOTUI_APP_NAME:'close'}});await install(runtime,f,'two','app',{workerScriptPath:alternate,config:{AOTUI_DATA_DIR:join(f.dir,runtime===a?'a':'b'),AOTUI_APP_NAME:'close'}});}
        const aWorkers=['one','two'].map(id=>sandbox(a,id).lease.worker),bWorkers=['one','two'].map(id=>sandbox(b,id).lease.worker);expect(new Set([...aWorkers,...bWorkers]).size).toBe(4);
        const aReport=await a.beginShutdown().completion;expect(aReport.ok).toBe(true);expect(aWorkers.every(worker=>worker.threadId===-1)).toBe(true);expect(bWorkers.every(worker=>worker.threadId>0)).toBe(true);
        for(const id of ['one','two'])expect((await op(b,id,'app','set',{value:52})).success).toBe(true);
        const bReport=await b.beginShutdown().completion;expect(bReport.ok).toBe(true);expect(bWorkers.every(worker=>worker.threadId===-1)).toBe(true);await facts('isolation-'+snapshotShadow,{aReport,bReport,threadIds:[...aWorkers,...bWorkers].map(worker=>worker.threadId),snapshotShadow});
    }finally{await Promise.all([a.beginShutdown().completion,b.beginShutdown().completion]);await rm(f.dir,{recursive:true,force:true});}
},30000);

it.each(['failed','unknown','unmount'] as const)('C2-25/27 actual Kernel preserves %s failure after real resource release and keeps its old void wrapper rejected',async mode=>{
    const f=await fixture(mode==='unmount'?'failed-unmount':'normal'),backend=createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS),runtime=makeRuntime();
    if(mode!=='unmount')inject(()=>({persistenceBackend:{async open(input:any){const result=await backend.open(input);return result.status!=='opened'?result:{status:'opened',storage:{...result.storage,async replace(address:any,text:string){if(mode==='unknown')await result.storage.replace(address,text);return {status:mode,issue:{code:mode==='unknown'?'OUTCOME_UNKNOWN':'IO_FAILED'}};}}};}}}));
    try{
        await install(runtime,f);await op(runtime,'d','app','set',{value:63});const box=sandbox(runtime),worker=box.lease.worker,promise=runtime.shutdown();
        await expect(promise).rejects.toHaveProperty('code','RUNTIME_CLOSE_FAILED');expect(runtime.shutdown()).toBe(promise);await expect(runtime.shutdown()).rejects.toHaveProperty('code','RUNTIME_CLOSE_FAILED');
        const report=await runtime.beginShutdown().completion;expect(report).toMatchObject({state:'settled',hasFailures:true,resourcesReleased:true,persistence:{managedApps:1},pool:{report:{state:'closed',total:0}}});expect(worker.threadId).toBe(-1);
        if(mode==='unmount'){expect(report.persistence.confirmedFlushes).toBe(1);expect(report.persistence.failedFlushes).toBe(0);expect(report.failures.flatMap(item=>item.codes)).toContain('APP_UNMOUNT_FAILED');}
        else{expect(report.persistence.failedFlushes).toBe(1);expect(report.persistence.unsavedKeys).toBe(1);
            // C1 also marks storage uncertain when the unhealthy Worker is retired.
            expect(box.getCloseReport().host.storage.uncertain).toBe(true);expect(report.persistence.unknownApps).toBe(1);expect(backend.getStats().ownerSlots).toBe(0);}
        if(mode==='unknown')expect(JSON.parse(await readFile(f.record(),'utf8')).value).toBe(63);expect(JSON.stringify(report)).not.toContain('private unmount detail');await facts('failure-'+mode,{report,threadId:worker.threadId,backend:backend.getStats(),fault:'controlled receipt failure around actual Node storage'});
    }finally{await runtime.beginShutdown().completion;await rm(f.dir,{recursive:true,force:true});}
},20000);

it('C2-30 archived old SDK / archived old Worker remain legacy-unverified under the actual Kernel',async()=>{
    const packet=process.env.AOTUI_W08_B2_BASELINE??join(repo,'rfcs/sdk-runtime-delivery/w08-b1-20261026T054703Z'),dir=await mkdtemp(join(tmpdir(),'aotui-c2-legacy-'));
    for(const pkg of ['sdk','runtime']){await mkdir(join(dir,pkg));await cp(join(packet,'artifacts',pkg,'dist'),join(dir,pkg,'dist'),{recursive:true});await writeFile(join(dir,pkg,'package.json'),'{"type":"module"}');if(pkg==='sdk')await linkArchivedSdkDependencies(repo,join(dir,pkg));else await symlink(join(repo,pkg,'node_modules'),join(dir,pkg,'node_modules'));}
    const old=await fixture('ordinary',join(dir,'sdk/dist/index.js')),ordinary=await fixture('ordinary'),runtime=makeRuntime();
    try{
        await install(runtime,old,'old-sdk');await install(runtime,ordinary,'old-worker','app',{workerScriptPath:join(dir,'runtime/dist/worker-runtime/index.js')});
        const workers=['old-sdk','old-worker'].map(id=>sandbox(runtime,id).lease.worker),report=await runtime.beginShutdown().completion;
        expect(report).toMatchObject({ok:false,hasFailures:false,resourcesReleased:true,verification:'mixed',unverifiedParticipants:0,persistence:{managedApps:0,legacyUnverifiedApps:2,missingCloseReceipts:0,absentFlushes:0},apps:{notVerifiedReleased:0}});await runtime.shutdown();expect(workers.every(worker=>worker.threadId===-1)).toBe(true);await facts('legacy',{report,packet,physicalThreadIds:workers.map(worker=>worker.threadId)});
    }finally{await runtime.beginShutdown().completion;await Promise.all([old.dir,ordinary.dir,dir].map(path=>rm(path,{recursive:true,force:true})));}
},20000);

it('C2-29 emitted createRuntime + real SDK + outstanding snapshot TTL naturally exits a fresh Node child',async()=>{
    const f=await fixture(),driver=join(f.dir,'driver.mjs');
    await capture(driver,`import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createRuntime} from ${JSON.stringify(url(join(repo,'runtime/dist/index.js')))};
const runtime=createRuntime({worker:{timeoutMs:4000,pool:{initialSize:0,maxSize:1}}});await runtime.createDesktop('d');await runtime.installDynamicWorkerApp('d',${JSON.stringify(url(f.app))},{appId:'app',config:{AOTUI_DATA_DIR:${JSON.stringify(f.data)},AOTUI_APP_NAME:'close'}});
const desktop=runtime.getDesktop('d'),box=desktop.appManager.getWorkerSandbox('app'),worker=box.lease.worker;runtime.acquireLock('d','child');const result=await runtime.execute('d',{name:'set',context:{appId:'app',snapshotId:'s'},args:{value:74}},'child');assert.equal(result.success,true);await runtime.acquireSnapshot('d',300000);
await runtime.shutdown();const report=await runtime.beginShutdown().completion;assert.equal(report.ok,true);assert.equal(report.pool.report.total,0);assert.equal(worker.threadId,-1);assert.equal(JSON.parse(await readFile(${JSON.stringify(f.record())},'utf8')).value,74);assert.equal(runtime.snapshotRegistry.snapshots.size,0);console.log('C2_NATURAL_END '+JSON.stringify({report,threadId:worker.threadId,value:74}));`);
    let guardUsed=false;
    try{
        const result=await new Promise<{code:number|null;signal:string|null;stdout:string;stderr:string}>((resolve,reject)=>{
            const child=spawn(process.execPath,[driver],{env:process.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
            const guard=setTimeout(()=>{guardUsed=true;child.kill('SIGKILL');reject(Error('NATURAL_EXIT_GUARD_USED'));},15000);
            child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});child.on('error',error=>{clearTimeout(guard);reject(error);});child.on('exit',(code,signal)=>{clearTimeout(guard);resolve({code,signal,stdout,stderr});});
        });
        expect(guardUsed).toBe(false);expect(result).toMatchObject({code:0,signal:null});const line=result.stdout.split('\n').find(line=>line.startsWith('C2_NATURAL_END '));expect(line).toBeDefined();
        const final=JSON.parse(line!.slice('C2_NATURAL_END '.length));expect(final).toMatchObject({threadId:-1,value:74,report:{ok:true,pool:{report:{state:'closed',total:0}}}});await facts('natural-child',{...result,guardUsed,naturalExit:true});
    }finally{await rm(f.dir,{recursive:true,force:true});}
},20000);
