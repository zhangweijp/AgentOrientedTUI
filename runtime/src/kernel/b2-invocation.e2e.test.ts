import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { IDesktop, RunningApp } from '../index.js';

const { createRuntime }: typeof import('../index.js') = await import(new URL('../../dist/index.js', import.meta.url).href);
const sdk = new URL('../../../sdk/dist/index.js', import.meta.url).href;
const receiptSuccess = {kind:'receipt',receipt:{executionPhase:'entered-returned',outcome:{status:'succeeded'}}};
async function observe(desktop:IDesktop, app:RunningApp, closeOnly=false) {
    const scope=desktop.createCandidateScope();
    try {
        const result=await scope.observe(app);
        if(result.status!=='prepared')throw Error(JSON.stringify(result));
        const {candidate}=result,o=candidate.observation;
        const views=o.views.map(v=>({viewId:v.id,viewInstanceId:v.viewInstanceId}));
        const adopted=desktop.adoptTurn({apps:[{candidate,windows:{activeViews:closeOnly?[]:views,closeViews:views.filter((_,i)=>o.views[i]!.canClose)}}]});
        if(adopted.status!=='adopted')throw Error(JSON.stringify(adopted));
        return {turn:adopted.turn,o,target:{appId:app.appId,instanceId:app.instanceId,...views[0]!}};
    } finally {scope.discard();}
}

it('real SDK/Worker close is bound to the original activation and returns the same genuine Receipt after the mount disappears',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'aotui-b2-close-'));
    const appPath=join(dir,'app.mjs');
    const runtime=createRuntime({worker:{timeoutMs:4000}});
    try {
        await writeFile(appPath,`
import {createApp,createView,defineViewType} from ${JSON.stringify(sdk)};
let calls=0;
const Detail=defineViewType()({name:'Detail',multiplicity:'single',region:'dynamic',tools:{
    change:{description:'Change the target',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},
        execute:({context,input})=>{context.change(input.value);return {success:true};}},
},onClose:{execute:({context})=>{calls++;context.close();return {success:true,data:{calls}};}}});
const page=createView(Detail);
export default createApp({app_name:'b2close',viewTypes:[Detail],initialize(author){
    let key='A',mounted=true;
    const publish=()=>author.publish(()=>mounted?[page.frame({body:key,bindingKey:key,context:{
        change(v){key=v;publish();},close(){mounted=false;publish();}
    }})]:[]);
    publish();
}});
`);
        const desktop=await runtime.createDesktop();
        const app=await desktop.installDynamicWorkerApp(appPath,{name:'b2close',interactionLimits:{maxPendingInvocations:3}});
        const a=await observe(desktop,app);
        const call=(value:string,id:string)=>a.turn.invoke(app.appId,{observationId:a.o.observationId,invocationId:id,toolId:a.o.tools[0]!.id,input:{value}});
        expect(await call('B','switch-b')).toMatchObject(receiptSuccess);
        // B's binding is intentionally different: a new observation is required to change it back.
        const b=await observe(desktop,app);
        expect(await b.turn.invoke(app.appId,{observationId:b.o.observationId,invocationId:'switch-a',toolId:b.o.tools[0]!.id,input:{value:'A'}})).toMatchObject(receiptSuccess);
        expect(await desktop.closeView({turn:a.turn,target:a.target,invocationId:'old-turn'})).toMatchObject({kind:'refused',code:'TURN_NOT_ACTIVE'});
        const stale=await desktop.closeView({turn:b.turn,target:b.target,invocationId:'stale-binding'});
        if(stale.kind==='receipt') expect(stale.receipt).toMatchObject({executionPhase:'not-dispatched',outcome:{status:'rejected',code:'VIEW_CLOSE_SOURCE_STALE'}});
        else expect(stale).toMatchObject({kind:'refused',code:'VIEW_CLOSE_SOURCE_STALE'});
        const current=await observe(desktop,app,true);
        try {
            expect(await current.turn.invoke(app.appId,{observationId:current.o.observationId,invocationId:'not-granted',toolId:current.o.tools[0]!.id,input:{value:'B'}})).toMatchObject({kind:'refused'});
            const request={turn:current.turn,target:current.target,invocationId:'close-once'};
            const first=await desktop.closeView(request);
            expect(first).toMatchObject({...receiptSuccess,locator:{desktopId:desktop.id,appId:app.appId,instanceId:app.instanceId,observationId:current.o.observationId,invocationId:'close-once'},
                receipt:{...receiptSuccess.receipt,operation:{kind:'closeView',viewType:'Detail',receiver:{viewId:current.target.viewId,viewInstanceId:current.target.viewInstanceId}},
                    outcome:{status:'succeeded',value:{success:true,data:{calls:1}}}}});
            if(first.kind!=='receipt')throw Error(JSON.stringify(first));
            expect(await desktop.closeView(request)).toEqual(first);
            expect(await desktop.readReceipt(first.locator)).toEqual(first);
            const gone=await desktop.closeView({...request,invocationId:'new-close'});
            if(gone.kind==='receipt') expect(gone.receipt).toMatchObject({executionPhase:'not-dispatched',outcome:{status:'rejected',code:'VIEW_INSTANCE_REVOKED'}});
            else expect(gone).toMatchObject({kind:'refused',code:'VIEW_INSTANCE_REVOKED'});
        } finally {current.turn.release();}
    }finally {await runtime.beginClose().completion;await rm(dir,{recursive:true,force:true});}
},15000);

it('actual TS installation rejects the three invalid policies before catalog or backend; frozen captured policy applies to the run',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'aotui-b2-config-'));
    const appPath=join(dir,'app.mjs');
    let starts=0;
    const runtime=createRuntime({executionBackends:{guard:{start(){starts++;throw Error('must not start invalid registration');}}},worker:{timeoutMs:4000}});
    const fields=[['maxReceiptBytes',0],['receipt',{}],['maxReceipts',32]] as const;
    try{
        const desktop=await runtime.createDesktop();
        for(const [field,value] of fields) {
            const interactionLimits={[field]:value};
            await expect(desktop.registerPendingApp({installationId:'bad-'+field,name:'bad',backend:'guard',interactionLimits} as never))
                .rejects.toMatchObject({code:'CONFIG_INVALID',context:{path:'options.interactionLimits.'+field}});
            await expect(desktop.installDynamicWorkerApp(appPath,{interactionLimits} as never))
                .rejects.toMatchObject({code:'CONFIG_INVALID',context:{path:'options.interactionLimits.'+field}});
        }
        expect(starts).toBe(0);expect(desktop.listApps()).toEqual([]);
        await writeFile(appPath,`import {createApp,createView,defineViewType} from ${JSON.stringify(sdk)};
const D=defineViewType()({name:'Detail',region:'dynamic',multiplicity:'single',tools:{ping:{description:'Ping',inputSchema:{type:'object',properties:{}},execute:()=>({success:true})}}});
const page=createView(D);
export default createApp({app_name:'config',viewTypes:[D],initialize(a){a.publish(()=>[page.frame({body:'ready',context:{}})]);}});`);
        const limits={maxEntries:1};
        const opening=desktop.installDynamicWorkerApp(appPath,{name:'config',interactionLimits:limits});
        limits.maxEntries=32;
        const app=await opening,o=await observe(desktop,app);
        try{
            const req={observationId:o.o.observationId,invocationId:'first',toolId:o.o.tools[0]!.id,input:{}};
            expect(await o.turn.invoke(app.appId,req)).toMatchObject(receiptSuccess);
            expect(await o.turn.invoke(app.appId,{...req,invocationId:'second'})).toMatchObject({kind:'refused',code:'INVOCATION_CAPACITY',path:'interactionLimits.maxEntries'});
        }finally{o.turn.release();}
    }finally{await runtime.beginClose().completion;await rm(dir,{recursive:true,force:true});}
},15000);

it('real major-2 stdio process rejects old major and invalid Host limits at the same field paths without touching the directory', async()=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../../dist/stdio.js',import.meta.url))],{stdio:['pipe','pipe','pipe']});
    const exited=new Promise<number|null>(resolve=>child.once('exit',resolve));
    const rl=createInterface({input:child.stdout});const pending=new Map<number,(v:Record<string,unknown>)=>void>();
    const stderr:string[]=[];child.stderr.on('data',v=>stderr.push(String(v)));
    rl.on('line',line=>{const response=JSON.parse(line);pending.get(response.id)?.(response);});
    let id=0;
    const request=(method:string,params:Record<string,unknown>={})=>new Promise<Record<string,unknown>>(resolve=>{
        const requestId=++id;pending.set(requestId,resolve);child.stdin.write(JSON.stringify({id:requestId,method,params})+'\n');
    });
    try{
        expect(await request('initialize',{protocol:'aotui-stdio',majorVersion:1})).toMatchObject({error:{code:'PROTOCOL_UNSUPPORTED'}});
        expect(await request('initialize',{protocol:'aotui-stdio',majorVersion:2})).toMatchObject({result:{protocol:'aotui-stdio',majorVersion:2}});
        for(const [field,value] of [['maxReceiptBytes',0],['receipt',{}],['maxReceipts',32]]){
            expect(await request('registerApp',{installationId:'bad-'+field,localPath:'/nonexistent',interactionLimits:{[field as string]:value}}))
                .toMatchObject({error:{code:'CONFIG_INVALID',path:'options.interactionLimits.'+field}});
        }
        expect(await request('listApps')).toMatchObject({result:[]});
        expect(await request('shutdown')).toMatchObject({result:{resourcesReleased:true}});
        child.stdin.end();expect(await exited).toBe(0);
    }finally{rl.close();if(child.exitCode===null){child.kill();await exited;}}
},15000);

it('actual Node Worker keeps the dispatched head after wait cancellation and executes queued close and Tool exactly once',async()=>{
    const {watch,existsSync}=await import('node:fs');
    const dir=await mkdtemp(join(tmpdir(),'aotui-b2-fifo-'));
    const appPath=join(dir,'app.mjs'),enteredPath=join(dir,'entered'),releasePath=join(dir,'release');
    const runtime=createRuntime({worker:{timeoutMs:4000}});
    const entered=Promise.withResolvers<void>();
    const watcher=watch(dir,()=>{if(existsSync(enteredPath))entered.resolve();});
    try {
        await writeFile(appPath,`
import {createApp,createView,defineViewType} from ${JSON.stringify(sdk)};
import {watch,existsSync,writeFileSync} from 'node:fs';
const log=[];
const Detail=defineViewType()({name:'Detail',multiplicity:'single',region:'dynamic',tools:{
    work:{description:'Do work',inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name']},
        execute:async({input})=>{log.push(input.name);if(input.name==='A'){
            await new Promise(resolve=>{
                const done=()=>{if(existsSync(${JSON.stringify(releasePath)})){w.close();resolve();}};
                const w=watch(${JSON.stringify(dir)},done);
                writeFileSync(${JSON.stringify(enteredPath)},'entered');done();
            });
        }return {success:true,data:{order:[...log]}};}},
},onClose:{execute:()=>{log.push('B');return {success:true,data:{order:[...log]}};}}});
const page=createView(Detail);
export default createApp({app_name:'b2fifo',viewTypes:[Detail],initialize(author){author.publish(()=>[page.frame({body:'ready',context:{}})]);}});
`);
        const desktop=await runtime.createDesktop(),app=await desktop.installDynamicWorkerApp(appPath,{name:'b2fifo',interactionLimits:{maxPendingInvocations:3}});
        const o=await observe(desktop,app);
        const firstAbort=new AbortController(),duplicateAbort=new AbortController();
        const call=(name:string,signal?:AbortSignal)=>o.turn.invoke(app.appId,{observationId:o.o.observationId,invocationId:name,toolId:o.o.tools[0]!.id,input:{name}},undefined,signal);
        try{
            const a=call('A',firstAbort.signal);await entered.promise;
            const request={turn:o.turn,target:o.target,invocationId:'B'};
            const b=desktop.closeView(request),c=call('C');
            const duplicate=desktop.closeView(request,{signal:duplicateAbort.signal});
            duplicateAbort.abort();
            expect(await duplicate).toMatchObject({kind:'unavailable',code:'INVOCATION_WAIT_CANCELLED',locator:{invocationId:'B'}});
            firstAbort.abort();
            const cancelled=await a;
            expect(cancelled).toMatchObject({kind:'unavailable',code:'INVOCATION_WAIT_CANCELLED',locator:{invocationId:'A'}});
            expect(await call('D')).toMatchObject({kind:'refused',code:'INVOCATION_CAPACITY',path:'interactionLimits.maxPendingInvocations'});
            await writeFile(releasePath,'release');
            expect(await b).toMatchObject({kind:'receipt',receipt:{operation:{kind:'closeView'},outcome:{status:'succeeded',value:{data:{order:['A','B']}}}}});
            expect(await c).toMatchObject({kind:'receipt',receipt:{outcome:{status:'succeeded',value:{data:{order:['A','B','C']}}}}});
            expect(await desktop.closeView(request)).toEqual(await b);
            if(cancelled.kind==='refused'||!cancelled.locator)throw Error('No actual admitted locator');
            expect(await desktop.readReceipt(cancelled.locator)).toMatchObject({kind:'receipt',receipt:{outcome:{status:'succeeded',value:{data:{order:['A']}}}}});
        }finally{o.turn.release();}
    }finally {watcher.close();await writeFile(releasePath,'release');await runtime.beginClose().completion;await rm(dir,{recursive:true,force:true});}
},15000);
