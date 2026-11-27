import { expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

it('B4-T01/03/04/08 actual stdio v2 narrow preparation, fixed schemas and short close-only ownership',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'b4-stdio-'));
    const sdk=pathToFileURL(resolve('sdk/dist/index.js')).href;
    await writeFile(join(dir,'app.mjs'),`
import {createApp,createView,defineViewType,ref} from ${JSON.stringify(sdk)};
const D=defineViewType()({name:'Detail',multiplicity:'single',region:'dynamic',tools:{
 read:{description:'Read',inputSchema:{type:'object',properties:{}},execute:()=>({success:true})},
 bad:{description:'Unsupported',inputSchema:{type:'object',properties:{choice:{type:'array',items:{type:'string'},anyOf:[{const:['fast']}]}},required:['choice']},execute:()=>{throw Error('not granted')}}
},onClose:{execute:({context})=>({success:true,data:{calls:context.close()}})}});
const page=createView(D,{id:'detail',region:'dynamic'});
export default createApp({app_name:'narrow',viewTypes:[D],initialize({publish}){
 let calls=0;publish(()=>[page.frame({body:'Original body',context:{close:()=>++calls},refs:[ref('data','value',{scope:'public',refType:'Text',schema:{type:'string'}})]})]);
}});
`);
    await writeFile(join(dir,'aoapp.json'),JSON.stringify({app_name:'narrow',version:'1',toolAuthoringProtocol:'view-type-tools-v9',appLifecycleSupport:'app-lifecycle-v3',entry:{main:'./app.mjs'}}));
    const child=spawn(process.execPath,[resolve('runtime/dist/stdio.js')],{stdio:['pipe','pipe','pipe']});
    const exited=new Promise<number|null>(done=>child.once('exit',done));
    const waiting=new Map<number,(reply:Record<string,unknown>)=>void>();let id=0;
    const stderr:string[]=[];child.stderr.on('data',v=>stderr.push(String(v)));
    createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);waiting.get(r.id)?.(r);waiting.delete(r.id);});
    const request=(method:string,params:Record<string,unknown>={})=>new Promise<any>(done=>{
        const requestId=++id;waiting.set(requestId,done);child.stdin.write(JSON.stringify({id:requestId,method,params})+'\n');
    });
    const call=async(method:string,params:Record<string,unknown>={})=>{const r=await request(method,params);if(r.error)throw Error(JSON.stringify(r.error));return r.result;};
    try{
        await call('initialize',{protocol:'aotui-stdio',majorVersion:2});
        // Real Node OPEN failures traverse the same public stdio mapping. This is
        // an independent Node probe, not the A3 raw/TS/stdio joint acceptance.
        for (const [index, path, message] of [[0, 'open.resource', '界'.repeat(2049)], [1, 'a'.repeat(513), 'short message']] as const) {
            const badFolder=join(dir,'startup-'+index);await mkdir(badFolder);
            await writeFile(join(badFolder,'app.mjs'),`
import {createApp} from ${JSON.stringify(sdk)};
export default createApp({app_name:'startup',viewTypes:[],initialize({registerLifecycle}){
 registerLifecycle({close(){throw Error('cleanup failed')}});
 throw Object.assign(Error(${JSON.stringify(message)}),{code:'PROTOCOL_UNSUPPORTED',path:${JSON.stringify(path)}});
}});
`);
            await writeFile(join(badFolder,'aoapp.json'),JSON.stringify({app_name:'startup',version:'1',toolAuthoringProtocol:'view-type-tools-v9',appLifecycleSupport:'app-lifecycle-v3',entry:{main:'./app.mjs'}}));
            const installationId='startup-'+index;
            await call('registerApp',{installationId,localPath:badFolder});
            const failed=await request('openApp',{installationId});
            expect(failed).not.toHaveProperty('result');
            expect(failed.error).toMatchObject({code:'INSTALL_FAILED',startup:{phase:'OPEN',code:'PROTOCOL_UNSUPPORTED',truncated:true},
                closeReport:{state:'settled',worker:'exited',resourcesReleased:true,hasFailures:true,appCleanupReport:{state:'failed',issues:['APP_CLEANUP_FAILED']}}});
            if(index===0) {
                expect(failed.error.startup.path).toBe(path);
                expect(failed.error.startup.message).toBe(message.slice(0,2048));
            } else {
                expect(failed.error.startup).not.toHaveProperty('path');
                expect(failed.error.startup.message).toBe(message);
            }
            expect(Buffer.byteLength(JSON.stringify({startup:failed.error.startup,closeReport:failed.error.closeReport,
                ...(failed.error.cleanupIssue?{cleanupIssue:failed.error.cleanupIssue}:{})}))).toBeLessThanOrEqual(16*1024);
        }
        await call('registerApp',{installationId:'narrow',localPath:dir});
        const app=await call('openApp',{installationId:'narrow'});
        const begin=async()=>(await call('beginCandidateScope')).scopeId;
        const observe=(scopeId:string,options?:unknown)=>call('observe',{scopeId,app:app.app,...(options===undefined?{}:{options})});
        const discard=(scopeId:string)=>call('discardScope',{scopeId});
        let scopeId=await begin();
        expect(await observe(scopeId,{excludeToolIds:[42]})).toMatchObject({status:'rejected',issue:{code:'OBSERVATION_INVALID',path:'$.excludeToolIds[0]'}});
        const first=await observe(scopeId);
        expect(first.status).toBe('prepared');
        const bad=first.observation.tools.find(t=>t.name==='bad').id;
        const plan=(candidate:any,compact=false,strict=false,closeMounts?:string[])=>({scopeId,
            apps:[{candidate:candidate.candidate,views:candidate.observation.views.map(v=>({viewInstanceId:v.viewInstanceId,kind:compact?'omitted':'body'})),
                ...(closeMounts?{closeMounts}:{})}],catalog:['narrow'],capabilities:['open','close','closeView','inspectRef','collapse'],compact,strict});
        const rejected=await call('presentTurn',plan(first));
        expect(rejected).toMatchObject({status:'reprepare',exclusions:[{appId:app.appId,excludeToolIds:[bad]}]});
        expect(rejected).not.toHaveProperty('presentation');
        expect(await request('adoptTurn',{scopeId,presentation:1})).toMatchObject({error:{code:'PRESENTATION_UNAVAILABLE'}});
        expect(await discard(scopeId)).toEqual({cleanupIssues:[]});
        scopeId=await begin();const narrowed=await observe(scopeId,{excludeToolIds:[bad,JSON.stringify(['narrow','Detail','absent'])]});
        expect(narrowed.observation.tools.map(t=>t.name)).toEqual(['read']);
        expect(narrowed.observation.refs).toEqual(first.observation.refs);
        const strict=await call('presentTurn',plan(narrowed,false,true)),normal=await call('presentTurn',plan(narrowed));
        expect(strict.tools).toEqual(normal.tools);
        const adopted=await call('adoptTurn',{scopeId,presentation:normal.presentation});expect(adopted.status).toBe('adopted');
        await discard(scopeId);
        expect(await call('invokeNative',{turn:adopted.turn,name:'narrow-Detail-bad',invocationId:'bad',input:{choice:['fast']}})).toMatchObject({kind:'refused',code:'TOOL_UNAVAILABLE'});
        expect(await call('inspectRef',{turn:adopted.turn,address:'$ref.narrow.detail.data',mode:'value'})).toMatchObject({status:'ready',value:'value'});
        for(const input of [{address:'bad',mode:'value'},{address:'$ref.narrow.detail.data',mode:'value',extra:true},{address:'$ref.narrow.detail.data',mode:null}])
            expect(await request('inspectRef',{turn:adopted.turn,...input})).toMatchObject({error:{code:'INVALID_SYSTEM_INPUT'}});
        await call('releaseTurn',{turn:adopted.turn});
        scopeId=await begin();const close=await observe(scopeId);
        const mount=close.observation.views[0];
        const compact=await call('presentTurn',plan(close,true,false,[mount.viewInstanceId]));
        expect(compact.status).toBe('ready');expect(compact.views).toEqual([]);
        expect(compact.apps[0].windows).toEqual({activeViews:[],closeViews:[{viewId:mount.id,viewInstanceId:mount.viewInstanceId}]});
        const short=await call('adoptTurn',{scopeId,presentation:compact.presentation});
        await discard(scopeId);
        const target={appId:app.appId,instanceId:app.instanceId,viewId:mount.id,viewInstanceId:mount.viewInstanceId};
        const input={turn:short.turn,target,invocationId:'short-close'};
        try{
            const result=await call('closeView',input);
            expect(result).toMatchObject({kind:'receipt',receipt:{outcome:{status:'succeeded',value:{success:true,data:{calls:1}}}},locator:{observationId:close.observation.observationId}});
            expect(await call('closeView',input)).toEqual(result);
            expect(await call('preview',{app:app.app})).toMatchObject({status:'previewed',views:[{id:mount.id,viewInstanceId:mount.viewInstanceId}]});
            expect(await call('inspectRef',{turn:short.turn,address:'$ref.narrow.detail.data',mode:'value'})).toMatchObject({status:'rejected'});
        }finally{await call('releaseTurn',{turn:short.turn});}
        expect(await request('closeApp',{app:app.app,appId:app.appId,instanceId:app.instanceId})).toMatchObject({error:{code:'INVALID_REQUEST'}});
        expect(await call('closeApp',{appId:app.appId,instanceId:app.instanceId})).toMatchObject({resourcesReleased:true});
        const replacement=await call('openApp',{installationId:'narrow'});
        expect(replacement.instanceId).not.toBe(app.instanceId);
        expect(await request('closeApp',{appId:app.appId,instanceId:app.instanceId})).toMatchObject({error:{code:'APP_INSTANCE_MISMATCH'}});
        expect(await call('preview',{app:replacement.app})).toMatchObject({status:'previewed'});
        expect(await call('shutdown')).toMatchObject({resourcesReleased:true});
        expect(await exited).toBe(0);
    }finally{child.stdin.end();if(child.exitCode===null)child.kill();await exited;await rm(dir,{recursive:true,force:true});}
},15000);
