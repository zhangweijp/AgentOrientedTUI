import { expect, it } from 'vitest';
import { watch, existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@aotui/runtime';
import type { ToolResult } from '@aotui/agent-driver-v2';
import type { PendingAppReceipt } from './semantic-aotui-driven-source.js';
import { PendingAppReceipts } from '../../host/src/core/pending-app-receipts.js';

// Exercise the emitted Adapter, the actual SDK/Worker, the real isolated Console
// child, Presenter close selection, and the owning Host's receipt table.
const {SemanticAOTUIDrivenSource}:typeof import('./semantic-aotui-driven-source.js')=await import(new URL('../dist/semantic-aotui-driven-source.js',import.meta.url).href);
const sdk=new URL('../../sdk/dist/index.js',import.meta.url).href;
it('associates the exact cancelled Native result and Console outer result with their genuine admitted locators',async()=>{
    const root=await mkdtemp(join(tmpdir(),'aotui-b2-receipt-')),appPath=join(root,'app.mjs');
    const runtime=createRuntime({worker:{timeoutMs:4000}});
    let source:InstanceType<typeof SemanticAOTUIDrivenSource>|undefined;
    const entered=new Map<string,ReturnType<typeof Promise.withResolvers<void>>>();
    for(const name of ['native','console','close'])entered.set(name,Promise.withResolvers<void>());
    const watcher=watch(root,()=>{for(const [name,latch] of entered)if(existsSync(join(root,'entered-'+name)))latch.resolve();});
    try {
        await writeFile(appPath,`
import {createApp,createView,defineViewType} from ${JSON.stringify(sdk)};
import {watch,existsSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const folder=${JSON.stringify(root)};
async function once(name) {
    const marker=join(folder,'entered-'+name),release=join(folder,'release-'+name);
    appendFileSync(join(folder,'calls'),name+'\\n');
    await new Promise(resolve=>{
        const done=()=>{if(existsSync(release)){w.close();resolve();}};
        const w=watch(folder,done);writeFileSync(marker,'entered');done();
    });
    return {success:true,data:{written:name}};
}
const Work=defineViewType()({name:'Work',multiplicity:'single',region:'dynamic',onClose:{execute:({context})=>context.close()},tools:{
    write:{description:'Write once',inputSchema:{type:'object',properties:{name:{enum:['native','console','close']}},required:['name']},
        execute:({input})=>once(input.name)}
}});
const page=createView(Work);
export default createApp({app_name:'b2receipt',viewTypes:[Work],initialize(a){a.publish(()=>[page.frame({body:'ready',context:{async close(){const value=await once('close');a.publish(()=>[]);return value;}}})]);}});
`);
        const desktop=await runtime.createDesktop(),app=await desktop.installDynamicWorkerApp(appPath,{name:'b2receipt'});
        const pending=new PendingAppReceipts();
        const remembered:{locator:PendingAppReceipt;result:Readonly<ToolResult>;subcallId?:string}[]=[];
        source=new SemanticAOTUIDrivenSource(desktop,{onReceiptPending(locator,result,subcallId){
            remembered.push({locator,result,subcallId});pending.remember(locator,result,subcallId);
        }});
        const ctx=await source.getContext();await ctx.adopt!();
        const name=Object.keys(ctx.tools).find(n=>!n.startsWith('system-')&&n!=='run_code');
        if(!name)throw Error('Missing actual Tool');
        const session={desktop,isCurrent:()=>true,isAppEnabled:()=>true};
        try{
            for(const kind of ['native','console','close'] as const){
                const controller=new AbortController(),id='model-'+kind;
                const args=kind==='native'?{name:kind}:kind==='close'?{app_id:app.appId,view_id:'Work'}:{code:`await tools[${JSON.stringify(name)}]({name:"console"});`};
                const action=ctx.executeTool!(kind==='native'?name:kind==='close'?'system-close_view':'run_code',args,id,undefined,controller.signal);
                await entered.get(kind)!.promise;controller.abort();
                const result=await action;
                expect(result).toBeDefined();
                const saved=remembered.at(-1)!;
                expect(saved.result).toBe(result);
                expect(saved.locator).toMatchObject({desktopId:desktop.id,appId:app.appId,appInstanceId:app.instanceId});
                if(kind!=='console'){
                    expect(result).toMatchObject({outcomeStatus:'unknown',error:{code:'INVOCATION_WAIT_CANCELLED'}});
                    expect(saved.locator.invocationId).toBe(id);expect(saved.subcallId).toBeUndefined();
                } else {
                    expect(saved.subcallId).toBe(saved.locator.invocationId);
                    expect(saved.subcallId).toMatch(/^console:/);
                    expect(result).toMatchObject({result:{subcalls:expect.arrayContaining([expect.objectContaining({
                        invocationId:saved.subcallId,phase:'unknown',status:'unknown',
                    })])}});
                }
                const messageId='saved-'+kind;pending.associate(messageId,[result!]);
                await writeFile(join(root,'release-'+kind),'released');
                expect(await pending.read({messageId,toolCallId:id,...(saved.subcallId?{subcallId:saved.subcallId}:{})},session,4000))
                    .toMatchObject({kind:'receipt',receipt:{executionPhase:'entered-returned',outcome:{status:'succeeded',value:{data:{written:kind}}}}});
            }
            expect(await readFile(join(root,'calls'),'utf8')).toBe('native\nconsole\nclose\n');
            expect((await app.preview()).status).toBe('previewed');
            expect(desktop.getAppWindows(app.appId,app.instanceId)?.views).toEqual([]);
        }finally{await ctx.release?.();}
    }finally{
        watcher.close();for(const n of ['native','console','close'])await writeFile(join(root,'release-'+n),'released');
        await source?.dispose();await runtime.beginClose().completion;await rm(root,{recursive:true,force:true});
    }
},20000);
