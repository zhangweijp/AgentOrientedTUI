import { APP_LIFECYCLE_PROTOCOL, DEFAULT_PROJECTION_LIMITS, type PreparedAppSnapshotDraft } from '@aotui/core';
import { WORKER_PROTOCOL } from '../spi/worker-protocol/types.js';
import { expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('isolates module handles across real Workers and revokes A→B→A Tool, close and Ref witnesses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-b1-identity-'));
    const workers: Worker[] = [];
    try {
        const sdk = new URL('../../../sdk/dist/index.js', import.meta.url).href;
        const app = join(dir, 'app.mjs');
        await writeFile(app, `
            import { createApp, createView, defineViewType, ref } from ${JSON.stringify(sdk)};
            import { parentPort } from 'node:worker_threads';
            const File = defineViewType()({name:'File', multiplicity:'multiple', region:'dynamic',
                tools:{read:{description:'Read current target and supplied text',
                    inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},
                    execute:({context,input}) => { context.enter(); return {success:true,data:{target:context.target,text:input.text}}; }}},
                onClose:{execute:({context}) => {context.close(); return {success:true};}}});
            const first = createView(File,{idPrefix:'first'}), second = createView(File,{idPrefix:'second'});
            export default createApp({app_name:'identity',viewTypes:[File],initialize(author) {
                let key='A', scope='public', entered=0, closed=0;
                const prefix=author.launchConfig.prefix;
                const frame=() => [first.frame({body:prefix+key,bindingKey:key,context:{target:prefix+key,enter:()=>entered++,close:()=>closed++},
                    refs:[ref('text',prefix+key,{scope,schema:{type:'string'}})]}),
                    second.frame({body:prefix+'stable',context:{target:prefix+'stable',enter:()=>entered++,close:()=>closed++}})];
                const receive=m=>{
                    if(m.type!=='TEST_CHANGE')return;
                    let result;
                    if(m.candidate) result=author.publish(()=>{throw Error('candidate');},{mode:'candidate'});
                    else { if(m.key) key=m.key; if(m.scope) scope=m.scope; result=author.publish(frame); }
                    parentPort.postMessage({type:'TEST_CHANGED',requestId:m.requestId,ok:result.ok,state:result.state,entered,closed});
                };
                parentPort.on('message',receive);
                author.registerLifecycle({close(){parentPort.off('message',receive);}});
                author.publish(frame);
            }});
        `);
        async function start(prefix: string) {
            const worker = new Worker(new URL('../../dist/worker-runtime/index.js', import.meta.url));
            workers.push(worker);
            const messages: any[] = [], errors: Error[] = [];
            worker.on('message', m=>messages.push(m)); worker.on('error', e=>errors.push(e));
            let n=0;
            const identity={appId:'identity',instanceId:'instance-'+prefix};
            async function request(message: Record<string,unknown>, type?: string) {
                const requestId=prefix+'-'+(++n);
                worker.postMessage({...message,requestId});
                return vi.waitFor(()=>{
                    expect(errors).toEqual([]);
                    const response=messages.find(m=>m.requestId===requestId&&(type ? m.type===type : !['SNAPSHOT_PREPARED','SNAPSHOT_PREPARE_FAILED'].includes(m.type)));
                    expect(response).toBeDefined();
                    return response;
                },{timeout:3000,interval:5});
            }
            expect(await request({type:'INIT',appId:identity.appId,desktopId:'desk',appInstanceId:identity.instanceId,appName:'identity',
                appModulePath:new URL('file://'+app).href,protocol:WORKER_PROTOCOL,toolsEnabled:true,
                config:{prefix},projectionLimits:DEFAULT_PROJECTION_LIMITS,appLifecycle:{protocol:APP_LIFECYCLE_PROTOCOL,instanceId:identity.instanceId}})).toMatchObject({success:true});
            expect(await request({type:'APP_OPEN'})).toMatchObject({success:true});
            const snapshot=async()=>(await request({type:'FLUSH_PROJECTION'},'SNAPSHOT_PREPARED')).draft as PreparedAppSnapshotDraft;
            const call=async(draft:PreparedAppSnapshotDraft,index:number,text:string,localRefs:unknown[]=[])=>{
                const view=draft.views[index]!, binding=view.toolBindings[0]!, tool=draft.tools[binding.toolId]!;
                return request({type:'VIEW_TOOL_INVOKE',...identity,tool:{id:tool.id,name:tool.name,viewType:tool.viewType},
                    receiver:{viewId:view.id,viewInstanceId:view.viewInstanceId,activationId:binding.activationId},effectiveArgs:{text},localRefs});
            };
            const close=async(draft:PreparedAppSnapshotDraft,index:number)=>{
                const view=draft.views[index]!;
                return request({type:'VIEW_CLOSE',...identity,viewId:view.id,viewInstanceId:view.viewInstanceId,closeActivationId:view.closeActivationId});
            };
            return {snapshot,call,close,change:(fields:Record<string,unknown>)=>request({type:'TEST_CHANGE',...fields})};
        }
        const a=await start('one'), b=await start('two');
        const first=await a.snapshot(), other=await b.snapshot();
        expect(first.views[0]!.content.value).toBe('oneA');
        expect(other.views[0]!.content.value).toBe('twoA');
        expect(await a.change({candidate:true})).toMatchObject({ok:false,state:'preserved'});
        expect((await a.snapshot()).sourceEpoch).toBe(first.sourceEpoch);
        expect(await b.call(other,0,'seed')).toMatchObject({terminal:{phase:'entered-returned',result:{data:{target:'twoA'}}}});
        await a.change({key:'B',scope:'protected'});
        const middle=await a.snapshot();
        await a.change({key:'A',scope:'public'});
        const last=await a.snapshot();
        expect(last.views.map(v=>[v.id,v.viewInstanceId])).toEqual(first.views.map(v=>[v.id,v.viewInstanceId]));
        expect(last.views[0]!.toolBindings[0]!.activationId).not.toBe(first.views[0]!.toolBindings[0]!.activationId);
        expect(last.views[0]!.closeActivationId).not.toBe(first.views[0]!.closeActivationId);
        expect(last.views[1]!.toolBindings).toEqual(first.views[1]!.toolBindings);
        expect(last.views[1]!.closeActivationId).toBe(first.views[1]!.closeActivationId);
        const r=Object.values(first.refs)[0]!, narrowed=Object.values(middle.refs)[0]!, restored=Object.values(last.refs)[0]!;
        expect(narrowed.continuity).toEqual([r.continuity[0],r.continuity[1],0]);
        expect(restored.continuity).toEqual([r.continuity[0],r.continuity[1],last.sourceEpoch]);
        expect(await a.call(first,0,'old')).toMatchObject({terminal:{phase:'not-entered'}});
        expect(await a.close(first,0)).toMatchObject({terminal:{phase:'not-entered'}});
        const witness={param:'text',viewId:r.ownerViewId,viewInstanceId:r.ownerViewInstanceId,refId:r.id,since:r.continuity[1]};
        expect(await a.call(first,1,'old-value',[witness])).toMatchObject({terminal:{phase:'entered-returned',result:{data:{target:'onestable',text:'old-value'}}}});
        await a.change({scope:'private'});
        await a.change({scope:'public'});
        expect(await a.call(first,1,'old-value',[witness])).toMatchObject({terminal:{phase:'not-entered',result:{error:{code:'REF_NOT_VISIBLE'}}}});
        expect(await a.change({candidate:true})).toMatchObject({entered:1,closed:0});
        expect(await a.close(await a.snapshot(),0)).toMatchObject({terminal:{phase:'entered-returned'}});
        expect(await a.change({candidate:true})).toMatchObject({entered:1,closed:1});
        expect(await b.change({candidate:true})).toMatchObject({entered:1,closed:0});
    } finally {
        await Promise.all(workers.map(w=>w.terminate()));
        await rm(dir,{recursive:true,force:true});
    }
},15000);
