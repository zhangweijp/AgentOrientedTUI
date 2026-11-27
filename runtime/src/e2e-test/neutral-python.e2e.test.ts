import { expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { TransportEvents } from '../adapters/execution-transport.js';
const {externalAppProtocol}:typeof import('../adapters/external-app-protocol.js')=await import(new URL('../../dist/adapters/external-app-protocol.js',import.meta.url).href);
const {startupControl}:typeof import('../adapters/execution-transport.js')=await import(new URL('../../dist/adapters/execution-transport.js',import.meta.url).href);
const {readRuntimeProtocolIssue}:typeof import('../adapters/initialization-error.js')=await import(new URL('../../dist/adapters/initialization-error.js',import.meta.url).href);
import type { AppExecutionBackend } from '../spi/runtime/execution-backend.js';
import type { IDesktop, RunningApp } from '../index.js';

const { createRuntime }: typeof import('../index.js') = await import(new URL('../../dist/index.js', import.meta.url).href);
const program = fileURLToPath(new URL('../../examples/python-files.py', import.meta.url));
const succeeded = {kind:'receipt', receipt:{executionPhase:'entered-returned',outcome:{status:'succeeded'}}};
async function observe(desktop: IDesktop, app: RunningApp) {
    const scope = desktop.createCandidateScope();
    try {
        const result = await scope.observe(app);
        if (result.status !== 'prepared') throw Error(JSON.stringify(result));
        const {candidate}=result, o=candidate.observation;
        const views=o.views.map(v=>({viewId:v.id,viewInstanceId:v.viewInstanceId}));
        const adopted=desktop.adoptTurn({apps:[{candidate,windows:{activeViews:views,closeViews:views.filter((_,i)=>o.views[i]!.canClose)}}]});
        if(adopted.status!=='adopted')throw Error(JSON.stringify(adopted));
        return {o,turn:adopted.turn};
    } finally {scope.discard();}
}
function call(app:RunningApp, state:Awaited<ReturnType<typeof observe>>, name:string, input:Record<string,string>, invocationId:string, viewId?:string) {
    const tool=state.o.tools.find(t=>t.name===name);
    if(!tool)throw Error('Missing '+name);
    return state.turn.invoke(app.appId,{observationId:state.o.observationId,invocationId,toolId:tool.id,input,...(viewId?{viewId}:{})});
}
async function folder() {
    const dir=await mkdtemp(join(tmpdir(),'aotui-neutral-py-'));
    await writeFile(join(dir,'A.txt'),'original A');
    await writeFile(join(dir,'B.txt'),'original B');
    return dir;
}

it('real raw Python uses the same original Ref and close Receipt authority as Node',async()=>{
    const dir=await folder(),runtime=createRuntime({worker:{timeoutMs:3000}});
    try{
        const desktop=await runtime.createDesktop();
        await desktop.registerPendingApp({installationId:'python',name:'files',command:['python3','-u',program],config:{folder:dir}});
        const app=await desktop.openApp('python');
        let state=await observe(desktop,app);
        expect(await call(app,state,'open_file',{name:'A.txt'},'open-a')).toMatchObject(succeeded);
        state=await observe(desktop,app);
        expect(await call(app,state,'open_file',{name:'B.txt'},'open-b')).toMatchObject(succeeded);
        state=await observe(desktop,app);
        const a=state.o.views.find(v=>v.name==='A.txt')!, b=state.o.views.find(v=>v.name==='B.txt')!;
        const ref='$ref.'+app.appId+'.'+a.id+'.content';
        const edited=await call(app,state,'edit',{text:ref},'edit-b',b.id);
        expect(edited).toMatchObject(succeeded);
        if(edited.kind!=='receipt')throw Error(JSON.stringify(edited));
        expect(edited.locator).toMatchObject({appId:app.appId,instanceId:app.instanceId,observationId:state.o.observationId,invocationId:'edit-b'});
        expect(await readFile(join(dir,'B.txt'),'utf8')).toBe('original A');
        expect(await desktop.readReceipt(edited.locator)).toEqual(edited);
        const closed=await desktop.closeView({turn:state.turn,invocationId:'close-b',target:{appId:app.appId,instanceId:app.instanceId,viewId:b.id,viewInstanceId:b.viewInstanceId}});
        expect(closed).toMatchObject({...succeeded,receipt:{...succeeded.receipt,operation:{kind:'closeView'}}});
        if(closed.kind!=='receipt')throw Error(JSON.stringify(closed));
        expect(await desktop.readReceipt(closed.locator)).toEqual(closed);
        state.turn.release();
        expect((await app.beginClose().completion).resourcesReleased).toBe(true);
    }finally{await runtime.beginClose().completion;await rm(dir,{recursive:true,force:true});}
},15000);

it('real Python handles old sample, business guard and STOP while the original candidate ACK is held',async()=>{
    const dir=await folder();
    const held=Promise.withResolvers<Record<string,any>>();
    let hold=false, ack:Record<string,any>|undefined, write!:(packet:object)=>void;
    const packets:Record<string,any>[]=[], sent:Record<string,any>[]=[];
    let child:ReturnType<typeof spawn>|undefined;
    const backend:AppExecutionBackend={start(launch,emit){
        child=spawn('python3',['-u',program],{stdio:['pipe','pipe','inherit']});
        write=packet=>child!.stdin!.write(JSON.stringify(packet)+'\n');
        const protocol=externalAppProtocol(launch,packet=>{
            const p=packet as Record<string,any>;sent.push(p);
            if(hold && p.type==='publishResult' && p.status==='accepted'){ack=p;held.resolve(p);return;}
            write(p);
        },emit as TransportEvents);
        const lines=createInterface({input:child.stdout!});
        lines.on('line',line=>{const packet=JSON.parse(line);packets.push(packet);protocol.receive(packet);});
        child.once('close',()=>{emit({kind:'channelEnded'});emit({kind:'exited'});});
        return {send:protocol.send,[startupControl]:protocol,terminate(){child!.kill();}};
    }};
    const runtime=createRuntime({executionBackends:{raw:backend},worker:{timeoutMs:5000,maxWorkers:1}});
    try{
        const desktop=await runtime.createDesktop();
        await desktop.registerPendingApp({installationId:'python',name:'files',backend:'raw',config:{folder:dir}});
        const app=await desktop.openApp('python'),state=await observe(desktop,app);
        const old=packets.find(p=>p.type==='reply'&&p.publication)?.publication;
        expect(old).toBeDefined();
        hold=true;
        const invoking=call(app,state,'open_file',{name:'A.txt'},'candidate');
        void invoking.catch(()=>{});
        await held.promise;
        expect(ack!.publication.sourceEpoch).toBeGreaterThan(old.sourceEpoch);
        // Deliberately exercise the Producer's independent ingress guard. These
        // packets do not claim to be Controller-owned requests.
        write({type:'observe',id:'probe-observe',known:old});
        write({type:'invoke',id:'probe-invoke',appId:app.appId,instanceId:app.instanceId,tool:{viewType:'directory',name:'open_file'},receiver:{viewId:'directory',viewInstanceId:'m:1',activationId:'a:1'},input:{name:'B.txt'},localRefs:[]});
        await expect.poll(()=>packets.find(p=>p.id==='probe-observe')).toMatchObject({type:'projectionCurrent',publication:old});
        await expect.poll(()=>packets.find(p=>p.id==='probe-invoke')).toMatchObject({status:'tool',terminal:{phase:'not-entered'}});
        expect((await app.preview()).status).toBe('rejected');
        const closing=app.beginClose();
        await expect.poll(()=>packets.some(p=>p.status==='done'&&p.cleanup?.state==='stopped')).toBe(true);
        expect(sent.some(p=>p.type==='close')).toBe(false);
        hold=false;write(ack!);
        expect((await closing.completion).resourcesReleased).toBe(true);
        const id=sent.find(p=>p.type==='invoke')!.id;
        expect(packets.find(p=>p.id===id)).toMatchObject({status:'tool',terminal:{phase:'entered-returned',result:{success:false,error:{code:'APP_STOPPED'}}}});
        expect(sent.filter(p=>p.type==='stop')).toHaveLength(1);
        expect(sent.filter(p=>p.type==='close')).toHaveLength(1);
        state.turn.release();
    }finally{
        if(ack&&hold){hold=false;write(ack);}
        await runtime.beginClose().completion;child?.kill();await rm(dir,{recursive:true,force:true});
    }
},15000);

const rawProbe=fileURLToPath(new URL('./fixtures/neutral-raw.py',import.meta.url));

it.each(['wrong-protocol','init-failed','long-message','long-path','forged'] as const)('real raw startup %s preserves cause separately from cleanup',async mode=>{
    const runtime=createRuntime({worker:{timeoutMs:3000}});
    try{
        const desktop=await runtime.createDesktop();
        await desktop.registerPendingApp({installationId:'probe',name:'probe',command:['python3','-u',rawProbe,mode]});
        const error=await desktop.openApp('probe').catch(e=>e);
        expect(error).toMatchObject({code:'INSTALL_FAILED',closeReport:{resourcesReleased:true}});
        if(mode==='wrong-protocol'){
            expect(readRuntimeProtocolIssue(error)).toMatchObject({code:'PROTOCOL_UNSUPPORTED'});
        }else{
            expect(readRuntimeProtocolIssue(error)).toBeUndefined();
            expect(error.cause).toMatchObject({code:mode==='forged'?'PROTOCOL_UNSUPPORTED':'APP_INIT_PROBE'});
            expect(error.closeReport).toMatchObject({worker:'exited'});
            const d=error.cause.cause;
            if(mode==='long-message'){expect(d).toMatchObject({message:'x'.repeat(2047),path:'$.probe',truncated:true});}
            if(mode==='long-path'){expect(d).toMatchObject({message:'original init failure',truncated:true});expect(d.path).toBeUndefined();}
        }
    }finally{await runtime.beginClose().completion;}
},15000);

it.each(['late-hello','init-held','open-held'] as const)('real raw %s closes the original execution without reviving startup',async mode=>{
    const sent:Record<string,any>[]=[],received:Record<string,any>[]=[];
    let child:ReturnType<typeof spawn>|undefined;
    let write!:(p:object)=>void;
    const attempted=Promise.withResolvers<void>();
    const terminated=Promise.withResolvers<void>();
    const backend:AppExecutionBackend={start(launch,emit){
        child=spawn('python3',['-u',rawProbe,mode],{stdio:['pipe','pipe','inherit']});
        write=p=>child!.stdin!.write(JSON.stringify(p)+'\n');
        const protocol=externalAppProtocol(launch,p=>{
            const packet=p as Record<string,any>;
            sent.push(packet);write(packet);
            if(packet.type===({'late-hello':'hello','init-held':'initialize','open-held':'open'}[mode]))attempted.resolve();
        },emit as TransportEvents);
        createInterface({input:child.stdout!}).on('line',line=>{
            const p=JSON.parse(line);received.push(p);protocol.receive(p);
        });
        child.once('close',()=>{emit({kind:'channelEnded'});emit({kind:'exited'});});
        return {send:protocol.send,[startupControl]:protocol,terminate(){
            terminated.resolve();
            // Keep the real process alive until a late hello is observed.
            if(mode!=='late-hello')child!.kill();
        }};
    }};
    const runtime=createRuntime({executionBackends:{probe:backend},worker:{maxWorkers:1,timeoutMs:3000}});
    try{
        const desktop=await runtime.createDesktop();
        await desktop.registerPendingApp({installationId:'probe',name:'probe',backend:'probe'});
        const opening=desktop.openApp('probe').catch(e=>e);
        await attempted.promise;
        const closing=runtime.beginClose();
        if(mode==='late-hello'){
            await terminated.promise;
            write({type:'release-hello'});
            await expect.poll(()=>received.some(p=>p.type==='hello')).toBe(true);
            expect(sent.map(p=>p.type)).toEqual(['hello']);
            expect(closing.inspect().resourcesReleased).toBe(false);
            child!.kill();
        }
        expect(await opening).toMatchObject({code:'INSTALL_FAILED'});
        expect(await closing.completion).toMatchObject({resourcesReleased:true});
        if(mode!=='late-hello'){
            expect(sent.map(p=>p.type)).toEqual(mode==='init-held'?['hello','initialize','stop','close']:['hello','initialize','open','stop','close']);
            expect(received.some(p=>p.cleanup?.state==='completed')).toBe(true);
        }
    }finally{child?.kill();await runtime.beginClose().completion;}
},15000);

it('production E2 Receiver-only rejection then E3 candidate recovery preserves the three Producer Ref lanes',async()=>{
    const dir=await folder(),runtime=createRuntime({worker:{timeoutMs:3000}});
    const probe=fileURLToPath(new URL('./fixtures/neutral-continuity.py',import.meta.url));
    try{
        const desktop=await runtime.createDesktop();
        await desktop.registerPendingApp({installationId:'python',name:'files',command:['python3','-u',probe,program],config:{folder:dir},projectionLimits:{maxViews:3}});
        const app=await desktop.openApp('python');
        let state=await observe(desktop,app);
        expect(await call(app,state,'open_file',{name:'A.txt'},'open-a')).toMatchObject(succeeded);
        state=await observe(desktop,app);
        expect(await call(app,state,'open_file',{name:'B.txt'},'open-b')).toMatchObject(succeeded);
        const original=await observe(desktop,app);
        const a=original.o.views.find(v=>v.name==='A.txt')!,b=original.o.views.find(v=>v.name==='B.txt')!;
        const ref='$ref.'+app.appId+'.'+a.id+'.content';
        await writeFile(join(dir,'e2'),'');
        expect(await app.preview()).toMatchObject({status:'rejected',issue:{code:'OBSERVATION_CAPACITY'}});
        await writeFile(join(dir,'e3'),'');
        expect((await app.preview()).status).toBe('previewed');
        const old=await call(app,original,'edit',{text:ref},'old',b.id);
        expect(old).not.toMatchObject(succeeded);
        state=await observe(desktop,app);
        const edit=await call(app,state,'edit',{text:ref},'recovered',b.id);
        expect(edit).toMatchObject(succeeded);
        const lines=async(name:string)=>(await readFile(join(dir,name+'.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
        const frames=(await lines('wire')).filter(p=>p.type==='publish').map(p=>p.frame);
        const bad=frames.find(f=>f.views.length===4),recovered=frames.find(f=>f.sourceEpoch===bad.sourceEpoch+1);
        const before=frames.find(f=>f.sourceEpoch===bad.sourceEpoch-1);
        const lanes=(f:any)=>f.refs.find((r:any)=>r.viewId===a.id).continuity;
        expect(lanes(bad)).toEqual([lanes(before)[0],0,0]);
        expect(lanes(recovered)).toEqual([lanes(before)[0],recovered.sourceEpoch,recovered.sourceEpoch]);
        const entered=(await lines('requests')).filter(r=>r.tool.name==='edit');
        expect(entered).toHaveLength(1);
        expect(entered[0].localRefs).toEqual([{param:'text',viewId:a.id,viewInstanceId:a.viewInstanceId,refId:'content',since:recovered.sourceEpoch}]);
        expect(await readFile(join(dir,'B.txt'),'utf8')).toBe('original A');
        state.turn.release();
    }finally{await runtime.beginClose().completion;await rm(dir,{recursive:true,force:true});}
},15000);

it.each(['stdout-ended-live','exit-tail'] as const)('real command %s distinguishes receipt drain from physical release', async scenario=>{
    const dir=await folder(),runtime=createRuntime({worker:{timeoutMs:3000,maxWorkers:1}});
    const probe=fileURLToPath(new URL('../../../tests/fixtures/external-app-behavior.py',import.meta.url));
    const vectors=fileURLToPath(new URL('../../examples/app-protocol-v2-vectors.json',import.meta.url));
    try{
        const desktop=await runtime.createDesktop();
        await desktop.registerPendingApp({installationId:'probe',name:'files',command:['python3','-u',probe,program,vectors,scenario],config:{folder:dir}});
        await desktop.registerPendingApp({installationId:'next',name:'next',command:['python3','-u',program],config:{folder:dir}});
        const app=await desktop.openApp('probe');
        let state=await observe(desktop,app);
        expect(await call(app,state,'open_file',{name:'B.txt'},'open-b')).toMatchObject(succeeded);
        state=await observe(desktop,app);
        const b=state.o.views.find(v=>v.name==='B.txt')!;
        const result=await call(app,state,'edit',{text:'actual write'},'edit',b.id);
        expect(result).toMatchObject({kind:'receipt',receipt:{outcome:{status:scenario==='exit-tail'?'succeeded':'unknown'}}});
        expect(await readFile(join(dir,'B.txt'),'utf8')).toBe('actual write');
        if(result.kind!=='receipt')throw Error(JSON.stringify(result));
        expect(await desktop.readReceipt(result.locator)).toEqual(result);
        if(scenario==='stdout-ended-live'){
            await expect.poll(()=>desktop.listApps().find(a=>a.appInstanceId===app.instanceId)?.run?.execution.channel).toBe('ended');
            expect(desktop.listApps().find(a=>a.appInstanceId===app.instanceId)?.run).toMatchObject({execution:{resource:'owned'},resourcesReleased:false});
            await expect(desktop.openApp('next')).rejects.toMatchObject({cause:{code:'WORKER_CAPACITY_EXCEEDED'}});
            await writeFile(join(dir,'release'),'');
        }else{
            const vector=JSON.parse(await readFile(vectors,'utf8'));
            expect(result.receipt.outcome).toMatchObject({value:{data:{text:vector.text.repeat(1000)}}});
        }
        await expect.poll(()=>desktop.listApps().find(a=>a.appInstanceId===app.instanceId)?.run?.execution.resource).toBe('exited');
        state.turn.release();
        expect((await app.beginClose().completion).resourcesReleased).toBe(true);
        const successor=await desktop.openApp('next');
        expect(successor.instanceId).not.toBe(app.instanceId);
    }finally{await writeFile(join(dir,'release'),'').catch(()=>{});await runtime.beginClose().completion;await rm(dir,{recursive:true,force:true});}
},15000);

it('joint public stdio directory retains a real Python closing owner and sends its final release notice',async()=>{
    const dir=await folder();
    const bridge=fileURLToPath(new URL('../../dist/stdio.js',import.meta.url));
    const child=spawn(process.execPath,[bridge],{stdio:['pipe','pipe','pipe']});
    const exited=new Promise<number|null>(resolve=>child.once('exit',resolve));
    const replies=new Map<number,(response:any)=>void>(),notices:any[]=[];
    let sequence=0;
    createInterface({input:child.stdout!}).on('line',line=>{
        const packet=JSON.parse(line);
        if(packet.event==='output')notices.push(packet.signal);
        else {replies.get(packet.id)?.(packet);replies.delete(packet.id);}
    });
    const request=(method:string,params:object={})=>new Promise<any>(resolve=>{
        const id=++sequence;replies.set(id,resolve);child.stdin!.write(JSON.stringify({id,method,params})+'\n');
    });
    const call=async(method:string,params:object={})=>{const r=await request(method,params);if(r.error)throw Error(JSON.stringify(r.error));return r.result;};
    try{
        await call('initialize',{protocol:'aotui-stdio',majorVersion:2,capabilities:{required:['command-apps','output-events']}});
        // The same real public wire distinguishes a Runtime handshake rejection
        // from an App-provided identical code and preserves cleanup alongside it.
        for(const mode of ['wrong-protocol','forged'] as const){
            await call('registerApp',{installationId:mode,name:'files',command:['python3','-u',rawProbe,mode],config:{folder:dir}});
            const failed=await request('openApp',{installationId:mode});
            expect(failed.error).toMatchObject({code:mode==='wrong-protocol'?'PROTOCOL_UNSUPPORTED':'INSTALL_FAILED',
                startup:{phase:'INIT',code:'PROTOCOL_UNSUPPORTED'},closeReport:{resourcesReleased:true}});
            if(mode==='forged')expect(failed.error.closeReport).toMatchObject({appCleanupReport:{state:'completed'}});
        }
        // A real raw App is observed and adopted through B's final Host entry.
        await call('registerApp',{installationId:'operations',name:'files',command:['python3','-u',program],config:{folder:dir}});
        const operations=await call('openApp',{installationId:'operations'});
        const scopeId=(await call('beginCandidateScope')).scopeId;
        const observed=await call('observe',{scopeId,app:operations.app});
        expect(observed.status).toBe('prepared');
        const presented=await call('presentTurn',{scopeId,apps:[{candidate:observed.candidate,views:observed.observation.views.map((v:any)=>({viewInstanceId:v.viewInstanceId,kind:'body'}))}],catalog:['operations'],capabilities:['open','close','closeView','inspectRef','collapse']});
        expect(presented.status).toBe('ready');
        const adopted=await call('adoptTurn',{scopeId,presentation:presented.presentation});
        expect(adopted.status).toBe('adopted');
        await call('discardScope',{scopeId});
        const rawResult=await call('invokeNative',{turn:adopted.turn,name:operations.appId+'-directory-open_file',invocationId:'raw-open',input:{name:'A.txt'}});
        expect(rawResult).toMatchObject({kind:'receipt',receipt:{outcome:{status:'succeeded'}},locator:{appId:operations.appId,instanceId:operations.instanceId,observationId:observed.observation.observationId}});
        await call('releaseTurn',{turn:adopted.turn});
        expect(await call('closeApp',{appId:operations.appId,instanceId:operations.instanceId})).toMatchObject({resourcesReleased:true});
        await call('registerApp',{installationId:'held',name:'files',command:['python3','-u',rawProbe,'close-held'],config:{folder:dir}});
        const app=await call('openApp',{installationId:'held'});
        await call('subscribeOutput',{apps:[app.instanceId]});
        const directory=async()=> (await call('listApps')).find((a:any)=>a.appInstanceId===app.instanceId);
        const first=await directory();
        expect(first.run).toMatchObject({phase:'opened',execution:{resource:'owned',channel:'open'},projection:{health:'ready'},resourcesReleased:false});
        const closing=call('closeApp',{appId:app.appId,instanceId:app.instanceId});
        await expect.poll(async()=>!!(await readFile(join(dir,'cleanup-entered')).catch(()=>null))).toBe(true);
        const inFlight=await directory();
        expect(inFlight.run).toMatchObject({phase:'closing',execution:{resource:'owned'},availability:{status:'unavailable'},resourcesReleased:false});
        for(let i=0;i<5;i++)expect(await directory()).toEqual(inFlight);
        expect(notices.some(s=>s.reason==='app_runtime_changed'&&s.instanceId===app.instanceId)).toBe(true);
        await writeFile(join(dir,'release-cleanup'),'');
        expect(await closing).toMatchObject({state:'settled',worker:'exited',resourcesReleased:true});
        expect(await directory()).toBeUndefined();
        const successor=await call('openApp',{installationId:'held'});
        expect(successor.instanceId).not.toBe(app.instanceId);
        expect(await request('closeApp',{appId:successor.appId,instanceId:app.instanceId})).toMatchObject({error:{code:'APP_INSTANCE_MISMATCH'}});
        expect(await call('preview',{app:successor.app})).toMatchObject({status:'previewed'});
        await call('closeApp',{appId:successor.appId,instanceId:successor.instanceId});
        expect(await call('shutdown')).toMatchObject({resourcesReleased:true});
        expect(await exited).toBe(0);
    }finally{await writeFile(join(dir,'release-cleanup'),'').catch(()=>{});child.stdin?.end();if(child.exitCode===null)child.kill();await exited;await rm(dir,{recursive:true,force:true});}
},15000);

it('real candidate rejection preserves the committed page and original receipt authority',async()=>{
    const dir=await folder(),runtime=createRuntime({worker:{timeoutMs:3000}});
    try{
        const desktop=await runtime.createDesktop();
        await desktop.registerPendingApp({installationId:'probe',name:'files',command:['python3','-u',program],config:{folder:dir},projectionLimits:{maxViews:2}});
        const app=await desktop.openApp('probe');
        let state=await observe(desktop,app);
        expect(await call(app,state,'open_file',{name:'A.txt'},'open-a')).toMatchObject(succeeded);
        state=await observe(desktop,app);
        const first=state.o.source;
        expect(await call(app,state,'open_file',{name:'B.txt'},'candidate-rejected')).toMatchObject({kind:'receipt',receipt:{outcome:{status:'failed'}}});
        const next=await observe(desktop,app);
        expect(next.o.source).toEqual(first);
        expect(next.o.views.map(v=>v.name)).not.toContain('B.txt');
        const a=next.o.views.find(v=>v.name==='A.txt')!;
        expect(await call(app,next,'edit',{text:'still owned'},'edit',a.id)).toMatchObject(succeeded);
        expect(await readFile(join(dir,'A.txt'),'utf8')).toBe('still owned');
        next.turn.release();
    }finally{await runtime.beginClose().completion;await rm(dir,{recursive:true,force:true});}
},15000);
