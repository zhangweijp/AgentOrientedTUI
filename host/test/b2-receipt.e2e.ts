/** Real Topic and IM storage, actual Driver, Source, Console child and SDK Worker. */
import assert from 'node:assert/strict';
import { watch, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { createRuntime, type DesktopID, type IDesktop } from '@aotui/runtime';
import type { AgentDriverV2, AgentDriverV2Config, LLMConfig, ToolResult } from '@aotui/agent-driver-v2';
import type { PendingAppReceipt } from '@aotui/agent-driver-adapter';
import type { DesktopManager } from '../src/core/desktop-manager.js';
import { fixtureProvider } from '../../tests/fixtures/batch-two-support.mjs';

const folder = await mkdtemp(join(tmpdir(), 'aotui-b2-host-'));
process.env.DB_PATH = join(folder, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(folder, 'state');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const db = await import('../src/db/index.js');
const { Config } = await import('../src/config/config.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const { PendingAppReceipts } = await import('../src/core/pending-app-receipts.js');
const provider = await fixtureProvider();
const runtime = createRuntime({ worker: { timeoutMs: 10000 } });
const app = join(folder, 'app.mjs');
const sdk = new URL('../../sdk/dist/index.js', import.meta.url).href;
const kinds = ['native', 'console', 'close'] as const;
const topicId = 'b2-topic', imId = 'agent:b2:local:direct:b2-peer';
const config = mock.method(Config, 'get', async () => ({
    agents: { list: [{ id: 'b2', prompt: 'Use the presented app.', enabledApps: ['b2receipt'], enabledMCPs: [], enabledSkills: [] }] },
    im: { enabled: true }, experimental: { contextCompaction: { enabled: false } },
}));
const host = new HostManagerV2(topicId, {} as ConstructorParameters<typeof HostManagerV2>[1]);
const llm: LLMConfig = { model: 'receipt-local', provider: { id: 'receipt-fixture', baseURL: provider.url }, apiKey: 'test-only' };
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async () => llm);
mock.method(host.getLLMConfigService(), 'withModelInputBudget', (settings: LLMConfig) => settings);
const appFolders = new Map<string, string>();
const appDesktops = new Map<string, IDesktop>();
const remembered = new Map<string, { locator: PendingAppReceipt; result: Readonly<ToolResult>; subcallId?: string }>();
const remember = PendingAppReceipts.prototype.remember;
const capture = mock.method(PendingAppReceipts.prototype, 'remember', function (this: PendingAppReceipts, locator: PendingAppReceipt, result: Readonly<ToolResult>, subcallId?: string) {
    remembered.set(result.toolCallId, { locator, result, subcallId });
    return remember.call(this, locator, result, subcallId);
});
function marker(path: string) {
    const done = Promise.withResolvers<void>();
    const watcher = watch(join(path, '..'), () => { if (existsSync(path)) done.resolve(); });
    if (existsSync(path)) done.resolve();
    const timer = setTimeout(() => done.reject(Error('Worker entry not observed: ' + path)), 5000);
    return done.promise.finally(() => { watcher.close(); clearTimeout(timer); });
}
function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([promise, new Promise<never>((_,reject) => { timer = setTimeout(() => reject(Error(label)), 5000); })])
        .finally(() => clearTimeout(timer!));
}
try {
    await writeFile(app, `
import {createApp,createView,defineViewType} from ${JSON.stringify(sdk)};
import {watch,existsSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const Work=defineViewType()({name:'Work',multiplicity:'single',region:'dynamic',onClose:{execute:({context})=>context.close()},tools:{
    write:{description:'Write once',inputSchema:{type:'object',properties:{name:{enum:['native','console']}},required:['name']},
        execute:({context,input})=>context.once(input.name)}
}});
const Aux=defineViewType()({name:'Aux',multiplicity:'single',region:'dynamic',onClose:{execute:({context})=>context.short()},tools:{
    probe:{description:'Ordinary tool not allowed by close-only selection',inputSchema:{type:'object',properties:{}},execute:()=>{throw Error('must not enter from a close-only turn')}}
}});
const page=createView(Work),aux=createView(Aux);
export default createApp({app_name:'b2receipt',viewTypes:[Work,Aux],initialize(a){
    const folder=a.launchConfig.folder;
    async function once(name) {
        const entered=join(folder,'entered-'+name),release=join(folder,'release-'+name);
        appendFileSync(join(folder,'calls'),name+'\\n');
        await new Promise(resolve=>{
            const done=()=>{if(existsSync(release)){w.close();resolve();}};
            const w=watch(folder,done);writeFileSync(entered,'entered');done();
        });
        return {success:true,data:{written:name}};
    }
    let shortCalls=0;
    a.publish(()=>[page.frame({body:'ready',context:{once,async close(){const value=await once('close');a.publish(()=>[]);return value;}}}),
        aux.frame({body:'independent close',context:{short(){return {success:true,data:{calls:++shortCalls}};}}})]);
}});
`);
    await db.initDatabase();
    const now=Date.now();
    db.createTopic({id:topicId,agentId:'b2',title:'B2 receipt',createdAt:now,updatedAt:now,status:'hot',
        sourceControls:{apps:{enabled:true,disabledItems:[]},skill:{enabled:false,disabledItems:[]},mcp:{enabled:false,disabledItems:[],allowedServers:[]}}});
    const desktops={
        async createDesktop(id:DesktopID){
            const desktop=await runtime.createDesktop(id);appDesktops.set(id,desktop);
            const data=join(folder,'app-'+appFolders.size);await mkdir(data);appFolders.set(id,data);
            await desktop.installDynamicWorkerApp(app,{name:'b2receipt',config:{folder:data}});
            return desktop;
        },
        async getAppsConfig(){return {b2receipt:{}};},
    } as unknown as DesktopManager;
    await host.initAgentDriver(desktops);
    await host.ensureSessionForTopic(topicId);
    await host.sendIMMessage({sessionKey:imId,agentId:'b2',channel:'local',chatType:'direct',peerId:'b2-peer',
        body:'B2 receipts',messageId:'b2-initial',senderId:'b2-peer',chatId:'test-chat',timestamp:Date.now(),triggerAgent:false});
    const topic=host.getSessionManager()!.getSession(topicId)!;
    const im=host['imSessionManager']!.getSession(imId)!;
    assert.ok(topic && im);
    for (const [sessionId,driver] of [[topicId,topic.agentDriver],[imId,im.agentDriver]] as const) {
        const data=appFolders.get(sessionId)!; assert.ok(data);
        // Only the real Host's save callback is wrapped with a barrier. Driver,
        // Source and receipt storage retain their production implementations.
        const driverConfig=(driver as unknown as {config:AgentDriverV2Config}).config;
        const originalSave=driverConfig.onToolResult!;
        for(const kind of kinds){
            const id=sessionId+'-'+kind;
            const saveEntered=Promise.withResolvers<readonly ToolResult[]>(),allowSave=Promise.withResolvers<void>();
            let saved=false,closed=false;
            driverConfig.onToolResult=async(message,results)=>{
                saveEntered.resolve(results);
                await allowSave.promise;
                await originalSave(message,results);
                saved=true;
            };
            try {
                const name=kind==='native'?'b2receipt-Work-write':kind==='console'?'run_code':'system-close_view';
                const args=kind==='native'?{name:kind}:kind==='console'?{code:'await tools["b2receipt-Work-write"]({name:"console"});'}:{app_id:'b2receipt',view_id:'Work'};
                const entered=marker(join(data,'entered-'+kind));
                provider.replyNext({label:id,calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
                driver.start();driver.resume();
                await driver.trigger();
                await entered;
                const closing=driver.closeToolTurn().then(()=>{closed=true;});
                const results=await within(saveEntered.promise,'Driver did not enter actual save callback');
                const record=remembered.get(id);assert.ok(record);
                assert.equal(results.length,1);assert.equal(results[0],record.result);
                assert.equal(saved,false);assert.equal(closed,false);
                assert.equal(record.locator.desktopId,sessionId);
                assert.equal(record.locator.appId,'b2receipt');
                if(kind==='console')assert.equal(record.subcallId,record.locator.invocationId);
                else assert.equal(record.locator.invocationId,id);
                // Schedule one trusted close-only operation only after the original
                // model consumption and actual save boundary have both completed.
                let shortStarted=false;
                const short=kind==='native' ? closing.then(async()=>{
                    shortStarted=true;
                    await (driver as unknown as {runInFlight?:Promise<void>}).runInFlight;
                    const desktop=appDesktops.get(sessionId)!;
                    const entry=desktop.listApps().find(app=>app.appId==='b2receipt')!;
                    const access=desktop.getRunningApp(entry.appId!,entry.appInstanceId!);assert.equal(access.status,'ready');
                    if(access.status!=='ready')throw Error(access.issue.code);
                    const scope=desktop.createCandidateScope();
                    try{
                        const prepared=await scope.observe(access.app);assert.equal(prepared.status,'prepared');
                        if(prepared.status!=='prepared')throw Error(prepared.issue.code);
                        const {candidate}=prepared,observation=candidate.observation;
                        const aux=observation.views.find(v=>v.type==='Aux')!;assert.equal(aux.canClose,true);
                        const target={appId:entry.appId!,instanceId:entry.appInstanceId!,viewId:aux.id,viewInstanceId:aux.viewInstanceId};
                        const selected=desktop.adoptTurn({apps:[{candidate,windows:{activeViews:[],closeViews:[{viewId:aux.id,viewInstanceId:aux.viewInstanceId}]}}]});
                        assert.equal(selected.status,'adopted');if(selected.status!=='adopted')throw Error(selected.issue.code);
                        try{
                            const probe=observation.tools.find(t=>t.name==='probe')!;
                            const denied=await selected.turn.invoke(entry.appId!,{observationId:observation.observationId,toolId:probe.id,invocationId:sessionId+'-not-granted',input:{}});
                            assert.equal(denied.kind,'refused');
                            const request={turn:selected.turn,target,invocationId:sessionId+'-short-close'};
                            const one=await desktop.closeView(request);assert.equal(one.kind,'receipt');
                            if(one.kind!=='receipt')throw Error(JSON.stringify(one));
                            assert.equal(one.receipt.outcome.status,'succeeded');
                            assert.deepEqual(JSON.parse(JSON.stringify(one.receipt.outcome.value)),{success:true,data:{calls:1}});
                            assert.equal(one.locator.observationId,observation.observationId);
                            assert.deepEqual(await desktop.closeView(request),one);
                            const preview=await access.app.preview();assert.equal(preview.status,'previewed');
                            if(preview.status==='previewed')assert.ok(preview.views.some(v=>v.viewInstanceId===aux.viewInstanceId));
                            assert.deepEqual(await desktop.readReceipt(one.locator),one);
                        }finally{assert.deepEqual(selected.turn.release(),[]);}
                    }finally{assert.deepEqual(scope.discard(),[]);}
                    console.log('PASS',sessionId,'short close-only after actual save; original locator; callback once; mount remains');
                }):undefined;
                await Promise.resolve();assert.equal(shortStarted,false);
                allowSave.resolve();await within(closing,'closeToolTurn did not await real save');
                assert.equal(saved,true);
                await (driver as unknown as {runInFlight?:Promise<void>}).runInFlight;
                const messages=sessionId===topicId?host.getMessages(topicId):host.getIMMessages(imId);
                const message=messages.find(m=>m.role==='tool' && Array.isArray(m.content) && m.content.some(part=>part.type==='tool-result' && part.toolCallId===id));
                assert.ok(message && 'id' in message && typeof message.id==='string', JSON.stringify(messages));
                const query={messageId:message.id,toolCallId:id,...(record.subcallId?{subcallId:record.subcallId}:{})};
                const read=()=>sessionId===topicId?host.getSessionManager()!.readAppReceipt(topicId,query,5000):host.readIMAppReceipt(imId,query,5000);
                await writeFile(join(data,'release-'+kind),'release');
                const receipt=await read();
                await short;
                assert.equal(receipt.kind,'receipt',JSON.stringify(receipt));
                assert.equal(receipt.receipt.executionPhase,'entered-returned');
                assert.equal(receipt.receipt.outcome.status,'succeeded');
                assert.deepEqual(JSON.parse(JSON.stringify(receipt.receipt.outcome.value)),{success:true,data:{written:kind}});
                assert.equal(receipt.locator.invocationId,record.locator.invocationId);
                console.log('PASS',sessionId,kind,'actual result identity, save barrier, stored message, original late Receipt');
            } finally {allowSave.resolve();driverConfig.onToolResult=originalSave;await writeFile(join(data,'release-'+kind),'release');}
        }
        assert.equal(await readFile(join(data,'calls'),'utf8'),'native\nconsole\nclose\n');
    }
    assert.deepEqual(provider.failures,[]);
    assert.equal(provider.requests.length,6);
} finally {
    for(const data of appFolders.values())for(const kind of kinds)await writeFile(join(data,'release-'+kind),'release');
    capture.mock.restore();config.mock.restore();
    await host.dispose();const shutdown=await runtime.beginClose().completion;
    await provider.close();db.closeDatabase();await rm(folder,{recursive:true,force:true});
    assert.equal(shutdown.resourcesReleased,true);
}
console.log('PASS B2 real Topic/IM three action kinds; no replay; all resources released');
