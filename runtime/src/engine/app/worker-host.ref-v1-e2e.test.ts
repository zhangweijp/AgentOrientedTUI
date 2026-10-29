import { Worker } from 'node:worker_threads';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { REF_V1_CAPABILITY } from '../../adapters/ref-invocation-v1.js';

const fixture = `
const calls={safe:0,old:0,plain:0,replacement:0};let boots=0;
const fixture={kernelConfig:{appName:'ref_fixture',name:'Ref fixture',component:{}},
 async initializeComponent(container,ctx){
  const generation=++boots;
  const releases=[];
  for(const [id,safe] of [['v',true],['other',false]]){
   const instance=ctx.viewTools.mount(id,'File');
   const node=container.ownerDocument.createElement('div');
   for(const [key,value] of Object.entries({'data-view-id':id,'data-view-type':'File','data-view-name':id,'data-view-instance-id':instance}))node.setAttribute(key,value);
   node.textContent='Observed file '+id+' generation '+generation;container.appendChild(node);
   ctx.registerView({id,type:'File',name:id,render:()=>id,onMount:async()=>{},onDismount:async()=>{},onOperation:async()=>({success:true})});
   ctx.refExporter.registerRef(id,'file',{text:id+' historical A'});
   const definition={description:'Read file',isMutating:false,params:{file:{type:'reference',required:true,refSource:'snapshot-value-v1'}},
    handler:async()=>{calls[safe?'safe':'old']++;return {success:true};}};
   releases.push(ctx.viewTools.registerTool(instance,'read',definition,...(safe?[{safeRefInvocationMode:'snapshot-value-v1'}]:[])));
   definition.handler=async()=>{calls.replacement++;return {success:true};};
   const plain={description:'Plain query',isMutating:false,params:{fail:{type:'boolean'}},handler:async args=>{
    calls.plain++;return args.fail?{success:false,error:{code:'BUSINESS_FAILED',message:'Expected'}}:{success:true,data:{calls:{...calls},args,generation}};
   }};
   ctx.viewTools.registerTool(instance,'plain',plain);
   plain.handler=async()=>{calls.replacement++;return {success:true};};
  }
  container.ownerDocument.body.addEventListener('aotui:external-event',e=>{if(e.detail?.type==='unregister')releases[0]();});
  return {render(){},unmount(){for(const release of releases)release();}};
 }};
fixture.kernelConfig.component=fixture;export default fixture;
`;
class Wire {
    readonly worker: Worker;
    readonly messages: any[] = [];
    private waiters = new Set<{ predicate: (m: any) => boolean; resolve: (m: any) => void; reject: (e: Error) => void; timer: any }>();
    sequence = 0;
    constructor(path: string) {
        this.worker = new Worker(path);
        this.worker.on('message', m => {
            this.messages.push(m);
            for (const w of this.waiters) if (w.predicate(m)) { clearTimeout(w.timer); this.waiters.delete(w); w.resolve(m); }
        });
        this.worker.on('error', e => { for (const w of this.waiters) { clearTimeout(w.timer); w.reject(e); } this.waiters.clear(); });
    }
    wait(predicate: (m: any) => boolean): Promise<any> {
        const previous = this.messages.find(predicate); if (previous) return Promise.resolve(previous);
        return new Promise((resolve, reject) => {
            const w = { predicate, resolve, reject, timer: undefined as any };
            w.timer = setTimeout(() => { this.waiters.delete(w); reject(new Error('Fixture barrier timed out')); }, 4000);
            this.waiters.add(w);
        });
    }
    send(message: any): Promise<any> {
        const requestId = message.requestId ?? 'wire-' + ++this.sequence;
        const result = this.wait(m => m.requestId === requestId); this.worker.postMessage({ ...message, requestId }); return result;
    }
    async stop() {
        for (const w of this.waiters) { clearTimeout(w.timer); w.reject(new Error('Fixture stopped')); } this.waiters.clear();
        await this.worker.terminate(); this.worker.removeAllListeners();
        expect(this.waiters.size).toBe(0); expect(this.worker.listenerCount('message')).toBe(0);
    }
}

describe('Ref v1 genuine Node Worker transport (compiled runtime)', () => {
    let temporary: string, appFile: string, workerFile: string;
    const wires: Wire[] = []; const hosts: AppWorkerHost[] = [];
    const init = (appModulePath: string, appId = 'app', instanceId = 'i', extra: any = {}) => ({
        type: 'INIT', appId, desktopId: 'd', appModulePath, appInstanceId: instanceId,
        snapshotShadow: true, experimentalReadOnlyViewTools: true, requestedCapabilities: [REF_V1_CAPABILITY], ...extra,
    });
    const wire = () => { const w = new Wire(workerFile); wires.push(w); return w; };
    const refMessage = (draft: any, viewId = 'v', extra: any = {}) => {
        const tool = Object.values(draft.tools).find((t: any) => t.name === 'read') as any;
        const target = tool.targets.find((t: any) => t.viewId === viewId);
        return { type: 'VIEW_TOOL_INVOKE_REF_V1', appId: draft.appId, instanceId: draft.instanceId, snapshotId: 'historical-s1',
            argumentMode: 'snapshot-value-v1', tool, target, rawArgs: { file: 'file', other: 1 },
            effectiveArgs: { file: { text: 'Host historical payload' }, other: 1 }, refSources: [{
                param: 'file', refId: 'file', kind: 'snapshot-value', refType: 'unknown', snapshotId: 'historical-s1',
                viewId, viewInstanceId: target.viewInstanceId }], ...extra };
    };
    const draft = (w: Wire, appId = 'app') => w.wait(m => m.type === 'SNAPSHOT_PREPARED' && m.draft.appId === appId && m.draft.schemaVersion === 2).then(m => m.draft);
    beforeAll(async () => {
        temporary = await mkdtemp(join(tmpdir(), 'aotui-ref-v1-wire-')); appFile = join(temporary, 'app.mjs');
        workerFile = resolve('dist/worker-runtime/index.js'); await writeFile(appFile, fixture);
    });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { const worker = (h as any).worker; h.terminate(); await worker?.terminate(); }
        for (const w of wires.splice(0)) await w.stop();
    });
    afterAll(async () => { await rm(temporary, { recursive: true, force: true }); });

    it('negotiates genuine ACK, checks both bindings and keeps all Ref Handlers at zero', async () => {
        const w = wire(); expect(await w.send(init(appFile))).toMatchObject({ type: 'INIT_RESPONSE', acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: 'i' });
        await w.send({ type: 'APP_OPEN' }); const snapshot = await draft(w);
        for (const viewId of ['v', 'other']) {
            const result = await w.send(refMessage(snapshot, viewId));
            expect(result).toMatchObject({ type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE', success: true,
                terminal: { phase: 'not-entered', result: { success: false, error: { code: 'REF_EXECUTION_UNAVAILABLE' } } } });
        }
        const altered = refMessage(snapshot); altered.effectiveArgs.other = 2;
        expect(await w.send(altered)).toMatchObject({ terminal: { result: { error: { code: 'OPERATION_INVALID_ARGS' } } } });
        const ref = refMessage(snapshot);
        expect(await w.send({ type: 'VIEW_TOOL_INVOKE', appId: 'app', instanceId: 'i', tool: ref.tool, target: ref.target, args: { file: 'file' } }))
            .toMatchObject({ result: { error: { code: 'REF_CONTRACT_UNSUPPORTED' } } });
        const plain = Object.values(snapshot.tools).find((t: any) => t.name === 'plain') as any;
        const run = (args: any) => w.send({ type: 'VIEW_TOOL_INVOKE', appId: 'app', instanceId: 'i', tool: plain,
            target: plain.targets[0], args });
        expect(await run({ fail: true })).toMatchObject({ success: true, result: { success: false, error: { code: 'BUSINESS_FAILED' } } });
        expect(await run({ extra: { a: 1 } })).toMatchObject({ result: { success: true, data: {
            calls: { safe: 0, old: 0, replacement: 0, plain: 2 }, args: { extra: { a: 1 } } } } });
        await w.send({ type: 'EXTERNAL_EVENT', viewId: 'v', eventType: 'unregister', data: {} });
        expect(await w.send(refMessage(snapshot))).toMatchObject({ terminal: { result: { error: { code: 'TOOL_UNAVAILABLE' } } } });
    });
    it('uses the genuine Host + W01 Store preparation + IPC with lease release', async () => {
        const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: appFile,
            workerScriptPath: workerFile, snapshotShadow: true, experimentalReadOnlyViewTools: true, experimentalSnapshotValueRefExecution: true });
        hosts.push(host); await host.start(); expect(host.hasSnapshotValueRefCapability()).toBe(true); await host.open();
        const read = (host as any).shadowReceiver.core.store.readLatest('app'); expect(read.status).toBe('ready');
        const tool: any = Object.values(read.snapshot.tools).find((t: any) => t.name === 'read');
        expect(await host.executeSnapshotValueRefTool({ snapshotId: read.snapshot.id, toolId: tool.id, viewId: 'v', args: { file: 'file' } }, () => true))
            .toMatchObject({ success: false, error: { code: 'REF_EXECUTION_UNAVAILABLE' } });
        expect((host as any).pendingRequests.size).toBe(0);
        expect((host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
    });
    it('bounds new capability fields without imposing Ref budgets on existing launchConfig', async () => {
        const w = wire();
        expect(await w.send(init(appFile, 'app', 'i', { config: { custom: { text: 'x'.repeat(600 * 1024) } } })))
            .toMatchObject({ type: 'INIT_RESPONSE', acceptedCapabilities: [REF_V1_CAPABILITY] });
        await w.send({ type: 'APP_OPEN' }); const snapshot = await draft(w);
        expect(await w.send(refMessage(snapshot))).toMatchObject({ terminal: { phase: 'not-entered', result: {
            error: { code: 'REF_EXECUTION_UNAVAILABLE' } } } });
    });
    it.each([undefined, [], ['view-tool-ref-invoke/v999'], [false], 'malformed'])('does not grant unsupported capability %#, ordinary calls remain usable', async requested => {
        const w = wire(); const ack = await w.send(init(appFile, 'app', 'i', { requestedCapabilities: requested }));
        expect(ack.type).toBe('INIT_RESPONSE'); expect(ack.acceptedCapabilities).toBeUndefined();
        await w.send({ type: 'APP_OPEN' }); const snapshot = await draft(w);
        expect(await w.send(refMessage(snapshot))).toMatchObject({ terminal: { result: { error: { code: 'REF_EXECUTION_UNAVAILABLE' } } } });
        const plain: any = Object.values(snapshot.tools).find((t: any) => t.name === 'plain');
        expect(await w.send({ type: 'VIEW_TOOL_INVOKE', appId: 'app', instanceId: 'i', tool: plain, target: plain.targets[0], args: {} }))
            .toMatchObject({ result: { success: true, data: { calls: { safe: 0, old: 0, replacement: 0 } } } });
    });
    it('accurately ACKs V2-only without granting V1 or upgrading an old Wrapper', async () => {
        const w = wire();const ack = await w.send(init(appFile, 'app', 'i', { requestedCapabilities: ['view-tool-ref-invoke/v2'] }));
        expect(ack.acceptedCapabilities).toEqual(['view-tool-ref-invoke/v2']);await w.send({ type: 'APP_OPEN' });const snapshot = await draft(w);
        expect(await w.send(refMessage(snapshot))).toMatchObject({ terminal: { phase: 'not-entered', result: { error: { code: 'REF_EXECUTION_UNAVAILABLE' } } } });
        expect(await w.send({ ...refMessage(snapshot), type: 'VIEW_TOOL_INVOKE_REF_V2', argumentMode: 'snapshot-value-v2' })).toMatchObject({ terminal: { phase: 'not-entered', result: { error: { code: 'REF_CONTRACT_UNSUPPORTED' } } } });
        const plain: any = Object.values(snapshot.tools).find((t: any) => t.name === 'plain');
        expect(await w.send({ type: 'VIEW_TOOL_INVOKE', appId: 'app', instanceId: 'i', tool: plain, target: plain.targets[0], args: {} })).toMatchObject({ result: { success: true, data: { calls: { safe: 0, old: 0, replacement: 0 } } } });
    });
    it.each([true, false])('rejects a completed duplicate Shadow INIT before rebuilding (read-only opt-in=%s)', async readOnly => {
        const w = wire(); const message = init(appFile, 'app', 'i', { experimentalReadOnlyViewTools: readOnly });
        await w.send(message); await w.send({ type: 'APP_OPEN' }); const original = await draft(w);
        expect(await w.send(message)).toMatchObject({ type: 'ERROR_RESPONSE', error: { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' } });
        expect(w.messages.filter(m => m.type === 'INIT_RESPONSE')).toHaveLength(1);
        if (readOnly) {
            const plain: any = Object.values(original.tools).find((t: any) => t.name === 'plain');
            expect(await w.send({ type: 'VIEW_TOOL_INVOKE', appId: 'app', instanceId: 'i', tool: plain, target: plain.targets[0], args: {} }))
                .toMatchObject({ result: { success: true, data: { generation: 1, calls: { safe: 0, old: 0, replacement: 0 } } } });
            expect(await w.send(refMessage(original))).toMatchObject({ terminal: { result: { error: {
                code: 'REF_EXECUTION_UNAVAILABLE', message: 'Current Tool binding has no safe Ref wrapper' } } } });
        }
    });
    it('rejects a duplicate pending Shadow identity without invalidating its first import/ACK', async () => {
        const delayed = join(temporary, 'duplicate-pending.mjs');
        await writeFile(delayed, `import {parentPort} from 'node:worker_threads';parentPort.postMessage({type:'TEST_IMPORT_WAITING'});
            await new Promise(resolve=>{const receive=m=>{if(m.type==='TEST_RELEASE_IMPORT'){parentPort.off('message',receive);resolve();}};parentPort.on('message',receive);});${fixture}`);
        const w = wire(); const first = w.send(init(delayed)); await w.wait(m => m.type === 'TEST_IMPORT_WAITING');
        expect(await w.send(init(appFile))).toMatchObject({ type: 'ERROR_RESPONSE', error: { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' } });
        w.worker.postMessage({ type: 'TEST_RELEASE_IMPORT' });
        expect(await first).toMatchObject({ type: 'INIT_RESPONSE', acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: 'i' });
        await w.send({ type: 'APP_OPEN' }); const snapshot = await draft(w);
        expect(await w.send(refMessage(snapshot))).toMatchObject({ terminal: { result: { error: { message: 'Current Tool binding has no safe Ref wrapper' } } } });
        expect(w.messages.filter(m => m.type === 'INIT_RESPONSE')).toHaveLength(1);
    });
    it('retains the most recent failed Shadow identity across RESET and permits a new identity', async () => {
        const w = wire();
        expect(await w.send(init(join(temporary, 'missing-module.mjs'), 'app', 'failed'))).toMatchObject({ type: 'ERROR_RESPONSE', error: { code: 'E_INIT_FAILED' } });
        expect(await w.send(init(appFile, 'app', 'failed'))).toMatchObject({ type: 'ERROR_RESPONSE', error: { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' } });
        await w.send({ type: 'RESET' });
        expect(await w.send(init(appFile, 'app', 'failed'))).toMatchObject({ type: 'ERROR_RESPONSE', error: { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' } });
        expect(await w.send(init(appFile, 'app', 'fresh'))).toMatchObject({ type: 'INIT_RESPONSE', acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: 'fresh' });
        await w.send({ type: 'APP_OPEN' }); const snapshot = await draft(w);
        expect(await w.send(refMessage(snapshot))).toMatchObject({ terminal: { result: { error: { message: 'Current Tool binding has no safe Ref wrapper' } } } });
    });
    it('keeps the last Shadow identity through RESET and mixed non-Shadow INITs', async () => {
        const w = wire(); await w.send(init(appFile)); await w.send({ type: 'APP_OPEN' }); const old = await draft(w);
        await w.send({ type: 'RESET' });
        expect(await w.send(init(appFile))).toMatchObject({ type: 'ERROR_RESPONSE', error: { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' } });
        for (let n = 0; n < 2; n++) expect(await w.send(init(appFile, 'app', 'i', { snapshotShadow: false })))
            .toMatchObject({ type: 'INIT_RESPONSE', success: true });
        expect(await w.send(init(appFile))).toMatchObject({ type: 'ERROR_RESPONSE', error: { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' } });
        await w.send(init(appFile, 'app', 'new')); await w.send({ type: 'APP_OPEN' });
        const current = await w.wait(m => m.type === 'SNAPSHOT_PREPARED' && m.draft.instanceId === 'new').then(m => m.draft);
        expect(await w.send(refMessage(old))).toMatchObject({ terminal: { result: { error: { code: 'APP_INSTANCE_MISMATCH' } } } });
        expect(await w.send(refMessage(current))).toMatchObject({ terminal: { result: { error: { message: 'Current Tool binding has no safe Ref wrapper' } } } });
    });
    it('keeps generation 1 after a rejected restart, then isolates a fresh Host on the same real Worker', async () => {
        const create = (existingWorker?: Worker) => {
            const h = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: appFile,
                workerScriptPath: workerFile, snapshotShadow: true, experimentalReadOnlyViewTools: true,
                experimentalSnapshotValueRefExecution: true, ...(existingWorker ? { existingWorker } : {}) });
            hosts.push(h); return h;
        };
        const first = create(); await first.start(); await first.open(); const physical = (first as any).worker as Worker;
        const s1 = (first as any).shadowReceiver.core.store.readLatest('app').snapshot;
        const request = (snapshot: any, name: string) => ({ snapshotId: snapshot.id,
            toolId: (Object.values(snapshot.tools).find((t: any) => t.name === name) as any).id, viewId: 'v', args: name === 'read' ? { file: 'file' } : {} });
        const sent: string[] = []; const post = physical.postMessage.bind(physical);
        physical.postMessage = message => { sent.push(message.type); return post(message); };
        expect(await first.executeReadOnlyViewTool(request(s1, 'plain'), () => true)).toMatchObject({ data: { generation: 1 } });
        await expect(first.start()).rejects.toThrow('APP_INSTANCE_REUSE_UNSUPPORTED');
        expect(sent.filter(type => type === 'INIT')).toHaveLength(0);
        expect(first.hasSnapshotValueRefCapability()).toBe(true);
        expect((first as any).shadowReceiver.core.store.readLatest('app').snapshot.id).toBe(s1.id);
        expect(first.getSnapshotShadowReport()?.lastIssueCode).toBeUndefined();
        expect(await first.executeReadOnlyViewTool(request(s1, 'plain'), () => true)).toMatchObject({ data: { generation: 1 } });
        const oldTool: any = Object.values(s1.tools).find((t: any) => t.name === 'plain');
        const pooled = await first.releaseWorker(); expect(pooled).toBe(physical); expect(physical.listenerCount('message')).toBe(0);
        const second = create(pooled!); await second.start();
        const drafts: any[] = []; const observe = (m: any) => { if (m.type === 'SNAPSHOT_PREPARED') drafts.push(m.draft); };
        physical.on('message', observe); await second.open(); physical.off('message', observe);
        const s2 = (second as any).shadowReceiver.core.store.readLatest('app').snapshot;
        expect((second as any).worker).toBe(physical); expect(second.appInstanceId).not.toBe(first.appInstanceId);
        expect(drafts.find(d => d.instanceId === second.appInstanceId)?.producerSeq).toBe(1);
        expect(s2.views[0].viewInstanceId).not.toBe(s1.views[0].viewInstanceId);
        expect(await second.executeSnapshotValueRefTool(request(s1, 'read'), () => true)).toMatchObject({ error: { code: 'SNAPSHOT_EXPIRED' } });
        expect(await second.executeReadOnlyViewTool(request(s1, 'plain'), () => true)).toMatchObject({ error: { code: 'SNAPSHOT_EXPIRED' } });
        expect(await (second as any).sendRequest({ type: 'VIEW_TOOL_INVOKE', requestId: 'old-binding', appId: 'app',
            instanceId: first.appInstanceId, tool: oldTool, target: oldTool.targets[0], args: {} }))
            .toMatchObject({ error: { code: 'APP_INSTANCE_MISMATCH' } });
        expect(await second.executeSnapshotValueRefTool(request(s2, 'read'), () => true)).toMatchObject({ error: {
            code: 'REF_EXECUTION_UNAVAILABLE', message: 'Current Tool binding has no safe Ref wrapper' } });
        expect(await second.executeReadOnlyViewTool(request(s2, 'plain'), () => true)).toMatchObject({ data: {
            generation: 2, calls: { safe: 0, old: 0, replacement: 0 } } });
        for (const h of [first, second]) {
            expect((h as any).pendingRequests.size).toBe(0); expect((h as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
        }
        expect(second.getSnapshotShadowReport()).toMatchObject({ health: 'ready', published: 1, rejected: 0 });
        expect(physical.listenerCount('message')).toBe(1);
    });
    it('old INIT completion after RESET/new INIT cannot replace the new AppKernel', async () => {
        const delayed = join(temporary, 'delayed-import.mjs');
        await writeFile(delayed, `import {parentPort} from 'node:worker_threads';parentPort.postMessage({type:'TEST_IMPORT_WAITING'});
            await new Promise(resolve=>{const receive=m=>{if(m.type==='TEST_RELEASE_IMPORT'){parentPort.off('message',receive);resolve();}};parentPort.on('message',receive);});
            ${fixture}`);
        const w = wire(); const old = w.send(init(delayed, 'old-app', 'old-instance'));
        await w.wait(m => m.type === 'TEST_IMPORT_WAITING'); await w.send({ type: 'RESET' });
        expect(await w.send(init(appFile, 'old-app', 'old-instance'))).toMatchObject({ type: 'ERROR_RESPONSE', error: { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' } });
        expect(await w.send(init(appFile, 'new-app', 'new-instance'))).toMatchObject({ acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: 'new-instance' });
        w.worker.postMessage({ type: 'TEST_RELEASE_IMPORT' });
        expect(await old).toMatchObject({ type: 'ERROR_RESPONSE', error: { code: 'E_INIT_INVALIDATED' } });
        await w.send({ type: 'APP_OPEN' }); const snapshot = await draft(w, 'new-app');
        expect(await w.send(refMessage(snapshot))).toMatchObject({ instanceId: 'new-instance', terminal: { result: { error: { code: 'REF_EXECUTION_UNAVAILABLE' } } } });
    });
    it('a close during delayed INIT prevents a late ACK', async () => {
        const delayed = join(temporary, 'close-import.mjs');
        await writeFile(delayed, `import {parentPort} from 'node:worker_threads';parentPort.postMessage({type:'TEST_IMPORT_WAITING'});
            await new Promise(resolve=>{const receive=m=>{if(m.type==='TEST_RELEASE_IMPORT'){parentPort.off('message',receive);resolve();}};parentPort.on('message',receive);});${fixture}`);
        const w = wire(); const old = w.send(init(delayed)); await w.wait(m => m.type === 'TEST_IMPORT_WAITING');
        await w.send({ type: 'APP_CLOSE' }); w.worker.postMessage({ type: 'TEST_RELEASE_IMPORT' });
        expect(await old).toMatchObject({ type: 'ERROR_RESPONSE', error: { code: 'E_INIT_INVALIDATED' } });
        expect(w.messages.filter(m => m.type === 'INIT_RESPONSE')).toHaveLength(0);
    });
    it('late RESET cleanup cannot erase an overlapping new instance or its ACK', async () => {
        const closing = join(temporary, 'delayed-close.mjs');
        await writeFile(closing, `import {parentPort} from 'node:worker_threads';export default {async onClose(){
            parentPort.postMessage({type:'TEST_CLOSE_WAITING'});await new Promise(resolve=>{const receive=m=>{if(m.type==='TEST_RELEASE_CLOSE'){parentPort.off('message',receive);resolve();}};parentPort.on('message',receive);});}};`);
        const w = wire(); await w.send(init(closing, 'old', 'old')); const reset = w.send({ type: 'RESET' });
        await w.wait(m => m.type === 'TEST_CLOSE_WAITING');
        expect(await w.send(init(appFile, 'app', 'new'))).toMatchObject({ acceptedCapabilities: [REF_V1_CAPABILITY], appInstanceId: 'new' });
        w.worker.postMessage({ type: 'TEST_RELEASE_CLOSE' }); expect(await reset).toMatchObject({ type: 'RESET_RESPONSE' });
        await w.send({ type: 'APP_OPEN' }); const snapshot = await draft(w);
        expect(await w.send(refMessage(snapshot))).toMatchObject({ instanceId: 'new', terminal: { result: { error: { code: 'REF_EXECUTION_UNAVAILABLE' } } } });
    });
});
