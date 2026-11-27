import { expect, it, vi } from 'vitest';
import { createHostedAppInteraction, createSnapshotCore, createTurnCoordinator, projectCompleteViews } from '../host.js';
import { createViewOwnedTools } from '../producer.js';
import { SNAPSHOT_SCHEMA_VERSION, type AppSnapshot, type ExecutionBinding, type ExecutionFact, type InvocationContext, type InteractionLimitOverrides, type ObservationCandidate, type ActiveTurn, type ReceiptQuery } from '../index.js';
import { normalizeInteractionLimits, RECEIPT_BYTES } from './interaction-limits.js';
import * as json from '../snapshot/json.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
const success = (): ExecutionFact => ({kind:'tool-result',phase:'entered-returned',result:{success:true}});
const id = {appId:'app',instanceId:'run'};
function fixture(limits: InteractionLimitOverrides = {}) {
    let time = 0, seq = 0, closeCount = 0;
    const snapshots = createSnapshotCore({...id, now:()=>time});
    const registry = createViewOwnedTools(id.appId,id.instanceId);
    registry.defineViewTypes([{name:'Detail',multiplicity:'single',tools:[{name:'edit',description:'Edit',inputSchema:{type:'object',properties:{}}}]}]);
    const owner = {};
    let target = 'A';
    let mounted = true;
    const entered: string[] = [], authorized: string[] = [];
    const ctl = {
        authorize: (_ctx: InvocationContext): boolean | Promise<boolean> => true,
        execute: (_ctx: InvocationContext): ExecutionFact | Promise<ExecutionFact> => success(),
        close: () => ({success:true}),
        read: (): boolean | Promise<boolean> => true,
        project: (source: AppSnapshot) => ({...projectCompleteViews({source}),closeViews:source.views.filter(v=>v.closeActivationId).map(v=>({viewId:v.id,viewInstanceId:v.viewInstanceId}))}),
    };
    function publish(key = target, open = mounted) {
        target = key; mounted = open;
        const plan = registry.prepareFrame(open ? [{id:'detail',type:'Detail',owner,bindingKey:key,
            bindings:[{name:'edit',enabled:true,execute:()=>({success:true})}],
            onClose:()=>{closeCount++;return ctl.close();}}] : []);
        plan.accept(); seq++;
        const result = snapshots.committer.accept({ ...id, healthySince:1,schemaVersion:SNAPSHOT_SCHEMA_VERSION,sourceEpoch:seq,producerSeq:seq,capturedAt:time,
            views:plan.instances.map(v=>({id:v.viewId,viewInstanceId:v.viewInstanceId,type:'Detail',name:'Detail',region:'dynamic',content:{format:'markdown-v1',value:key},
                toolBindings:v.toolBindings,closeActivationId:v.closeActivationId!})),refs:{},tools:Object.fromEntries(plan.tools.map(t=>[t.id,t]))});
        if(result.status === 'rejected') throw Error(result.issue.code);
    }
    publish();
    const binding: ExecutionBinding = {
        identity:{},isLive:()=>true,
        async execute(ctx) {
            entered.push(ctx.invocationId);
            if(ctx.source.kind==='closeView') {
                const r=ctx.source.receiver;
                const terminal=await registry.closeView(r.viewId,r.viewInstanceId,r.closeActivationId);
                if(terminal.phase==='finished-unknown')return {kind:'unknown'};
                return {kind:'tool-result',...terminal};
            }
            return ctl.execute(ctx);
        }
    };
    const {interaction:client,control}=createHostedAppInteraction(snapshots.store,{...id,namespace:'b2',now:()=>time,limits,
        policy:{project:({source})=>ctl.project(source),authorize:ctx=>{authorized.push(ctx.invocationId);return ctl.authorize(ctx);},canReadReceipt:()=>ctl.read()},
        execution:{resolve:()=>binding}});
    const turns=createTurnCoordinator();
    async function observe(closeOnly=false) {
        const prepared=await turns.prepareObservation(client,()=>true);
        if(prepared.status!=='prepared')throw Error(prepared.issue.code);
        const candidate=prepared.candidate;
        const views=candidate.observation.views.map(v=>({viewId:v.id,viewInstanceId:v.viewInstanceId}));
        const result=turns.adoptTurn({apps:[{candidate,windows:{activeViews:closeOnly?[]:views,closeViews:views}}]});
        if(result.status!=='adopted')throw Error(result.issue.code);
        return {turn:result.turn,candidate,views};
    }
    function request(o:ObservationCandidate, invocationId:string) {
        return {observationId:o.observation.observationId,invocationId,toolId:o.observation.tools[0]!.id,input:{}};
    }
    function closeRequest(o:ObservationCandidate,invocationId:string) {
        const v=o.observation.views[0]!;
        return {kind:'closeView' as const,observationId:o.observation.observationId,invocationId,viewId:v.id,viewInstanceId:v.viewInstanceId};
    }
    async function dispose() {turns.close();client.close();await client.whenClosed();registry.dispose();snapshots.lifecycle.dispose();}
    return {client,control,ctl,turns,observe,request,closeRequest,publish,dispose,entered,authorized, get closeCount(){return closeCount;},
        setTime(t:number){time=t;},holds:()=>snapshots.store.inspect().activeHolds};
}
const query = ({observationId,invocationId}:ReceiptQuery):ReceiptQuery=>({observationId,invocationId});
const ok={kind:'receipt',receipt:{executionPhase:'entered-returned',outcome:{status:'succeeded'}}};
const refused=(path:string)=>({kind:'refused',code:'INVOCATION_CAPACITY',path:'interactionLimits.'+path});
const originalCancelled={kind:'unavailable',code:'INVOCATION_CANCELLED',executionPhase:'not-dispatched'};
it('N=3 real FIFO shares close and Tool capacity; duplicate waits without another reservation',async()=>{
    const f=fixture({maxPendingInvocations:3});const {turn,candidate}=await f.observe();
    const gate=deferred<ExecutionFact>(), started=deferred<void>();
    f.ctl.execute=ctx=>{if(ctx.invocationId==='A'){started.resolve();return gate.promise;}return success();};
    try {
        const a=turn.invoke('app',f.request(candidate,'A')); await started.promise;
        const bReq=f.closeRequest(candidate,'B'), b=turn.invoke('app',bReq), c=turn.invoke('app',f.request(candidate,'C'));
        const duplicate=turn.invoke('app',bReq);
        expect(await turn.invoke('app',f.request(candidate,'D'))).toMatchObject(refused('maxPendingInvocations'));
        expect(f.client.inspect()).toMatchObject({activeInvocations:3,queuedInvocations:2,receiptEntries:3,receiptReservations:3,receiptReservedBytes:3*RECEIPT_BYTES});
        expect(f.entered).toEqual(['A']);expect(f.authorized).toEqual(['A']);
        gate.resolve(success());const results=await Promise.all([a,b,c,duplicate]);
        for(const r of results)expect(r).toMatchObject(ok);
        expect(results[1]).toEqual(results[3]);
        expect(f.entered).toEqual(['A','B','C']);expect(f.authorized).toEqual(['A','B','C']);
        expect(f.closeCount).toBe(1);
        expect(f.client.inspect()).toMatchObject({activeInvocations:0,queuedInvocations:0,receiptEntries:3,receiptContents:3,receiptReservations:0,activeReads:0});
    } finally {gate.resolve(success());await f.dispose();}
});
it('original B cancellation releases queued capacity, duplicate B cancellation only releases its own wait',async()=>{
    const f=fixture({maxPendingInvocations:3});const {turn,candidate}=await f.observe();const started=deferred<void>(),gate=deferred<ExecutionFact>();
    f.ctl.execute=ctx=>{if(ctx.invocationId==='A'){started.resolve();return gate.promise;}return success();};
    try{
        const original=new AbortController(), duplicateAbort=new AbortController(),headAbort=new AbortController();
        const a=turn.invoke('app',f.request(candidate,'A'),undefined,headAbort.signal);await started.promise;
        const bReq=f.request(candidate,'B'),b=turn.invoke('app',bReq,undefined,original.signal),c=turn.invoke('app',f.request(candidate,'C'));
        const duplicate=turn.invoke('app',bReq,undefined,duplicateAbort.signal);duplicateAbort.abort();
        expect(await duplicate).toMatchObject({kind:'unavailable',code:'INVOCATION_WAIT_CANCELLED',locator:query(bReq)});
        expect(f.client.inspect()).toMatchObject({activeInvocations:3,queuedInvocations:2});
        original.abort();expect(await b).toMatchObject({...originalCancelled,locator:query(bReq)});
        expect(await f.client.readReceipt(query(bReq))).toMatchObject({kind:'receipt',receipt:{executionPhase:'not-dispatched',outcome:{status:'rejected',code:'INVOCATION_CANCELLED'}}});
        headAbort.abort();expect(await a).toMatchObject({kind:'unavailable',code:'INVOCATION_WAIT_CANCELLED'});
        expect(f.client.inspect()).toMatchObject({activeInvocations:2,queuedInvocations:1});
        const d=turn.invoke('app',f.request(candidate,'D'));
        expect(f.entered).toEqual(['A']);
        gate.resolve(success());expect(await c).toMatchObject(ok);expect(await d).toMatchObject(ok);
        expect(f.entered).toEqual(['A','C','D']);
        expect(await f.client.readReceipt(query(f.request(candidate,'A')))).toMatchObject(ok);
    }finally{gate.resolve(success());await f.dispose();}
});
it('preparing cancellation wakes only the original waiter and keeps the head and hold until actual authorization settles',async()=>{
    const f=fixture({maxPendingInvocations:2});const {turn,candidate}=await f.observe();
    const started=deferred<void>(),gate=deferred<boolean>(),abort=new AbortController();
    f.ctl.authorize=ctx=>{if(ctx.invocationId==='A'){started.resolve();return gate.promise;}return true;};
    try{
        const req=f.request(candidate,'A'),a=turn.invoke('app',req,undefined,abort.signal);await started.promise;
        const duplicate=turn.invoke('app',req),b=turn.invoke('app',f.request(candidate,'B'));let settled=false;void duplicate.then(()=>settled=true);
        abort.abort();expect(await a).toMatchObject({...originalCancelled,locator:query(req)});
        expect(settled).toBe(false);expect(f.holds()).toBe(2);expect(f.entered).toEqual([]);
        expect(f.client.inspect()).toMatchObject({activeInvocations:2,queuedInvocations:1,receiptReservations:2,receiptContents:0});
        gate.resolve(true);
        expect(await duplicate).toMatchObject({kind:'receipt',receipt:{executionPhase:'not-dispatched',outcome:{code:'INVOCATION_CANCELLED'}}});
        expect(await b).toMatchObject(ok);expect(f.entered).toEqual(['B']);
    }finally{gate.resolve(true);await f.dispose();}
});
it('invalid original close activation cannot revive after A-B-A; close-only turn reuses exact selection and dedup survives removal/expiry',async()=>{
    const f=fixture({receiptTtlMs:10});try {
        const old=await f.observe(true), req=f.closeRequest(old.candidate,'old');
        f.publish('B');f.publish('A');
        expect(await old.turn.invoke('app',req)).toMatchObject({kind:'refused',code:'VIEW_CLOSE_SOURCE_STALE'});
        expect(f.closeCount).toBe(0);expect(f.authorized).toEqual([]);
        const fresh=await f.observe(true);expect(old.turn.isCurrent).toBe(false);
        expect(await fresh.turn.invoke('app',f.request(fresh.candidate,'ordinary'))).toMatchObject({kind:'refused'});
        const re=f.turns.adoptTurn({apps:[{candidate:fresh.candidate}]});if(re.status!=='adopted')throw Error(re.issue.code);
        expect(await re.turn.invoke('app',f.request(fresh.candidate,'ordinary2'))).toMatchObject({kind:'refused'});
        const close=f.closeRequest(fresh.candidate,'close');
        expect(await re.turn.invoke('app',close)).toMatchObject(ok);
        expect(await re.turn.invoke('app',close)).toMatchObject(ok);expect(f.closeCount).toBe(1);
        f.publish('A',false);
        expect(await re.turn.invoke('app',close)).toMatchObject(ok);
        expect(await f.client.readReceipt(query(close))).toMatchObject(ok);
        f.setTime(10);
        expect(await re.turn.invoke('app',close)).toMatchObject({kind:'unavailable',code:'RESULT_EXPIRED',locator:query(close)});
        expect(f.closeCount).toBe(1);re.turn.release();expect(f.holds()).toBe(0);
    }finally{await f.dispose();}
});
it('a retired queued Turn is settled before a new valid call is refused for pending capacity',async()=>{
    const f=fixture({maxPendingInvocations:2});const started=deferred<void>(),gate=deferred<ExecutionFact>();
    f.ctl.execute=ctx=>{if(ctx.invocationId==='A'){started.resolve();return gate.promise;}return success();};
    try{
        const old=await f.observe();const a=old.turn.invoke('app',f.request(old.candidate,'A'));await started.promise;
        const bReq=f.closeRequest(old.candidate,'B'),b=old.turn.invoke('app',bReq);
        const fresh=await f.observe(),c=fresh.turn.invoke('app',f.request(fresh.candidate,'C'));
        expect(await b).toMatchObject({kind:'unavailable',code:'TURN_NOT_ACTIVE',executionPhase:'not-dispatched',locator:query(bReq)});
        expect(f.client.inspect()).toMatchObject({activeInvocations:2,queuedInvocations:1});
        gate.resolve(success());expect(await a).toMatchObject(ok);expect(await c).toMatchObject(ok);expect(f.entered).toEqual(['A','C']);expect(f.closeCount).toBe(0);
    }finally{gate.resolve(success());await f.dispose();}
});
it.each([[32,64,false,'maxEntriesPerScope'],[64,32,false,'maxEntries'],[64,128,false,'maxEntriesPerScope'],[64,64,true,'maxEntries'],[64,64,false,'maxEntriesPerScope']] as const)
('real fixed-clock scope=%i total=%i new observation=%s rejects the first %s overflow',async(scope,total,separate,field)=>{
    const f=fixture({maxEntriesPerScope:scope,maxEntries:total});try{
        let o=await f.observe();
        const cap=Math.min(scope,total);
        for(let i=0;i<cap;i++){if(separate&&i)o=await f.observe();expect(await o.turn.invoke('app',f.request(o.candidate,'i'+i))).toMatchObject(ok);}
        if(separate)o=await f.observe();
        const r=await o.turn.invoke('app',f.request(o.candidate,'overflow'));
        expect(r).toMatchObject(refused(field));expect(r).not.toHaveProperty('locator');
        expect(f.entered.length).toBe(cap);expect(f.authorized.length).toBe(cap);expect(f.client.inspect().receiptEntries).toBe(cap);
    }finally{await f.dispose();}
});
it('TTL drops bytes but the actual old read protects its Entry even after its waiter times out',async()=>{
    vi.useFakeTimers();const f=fixture({maxEntries:1,receiptTtlMs:10});const reading=deferred<boolean>(),started=deferred<void>();
    try{
        const o=await f.observe(),x=f.request(o.candidate,'X');
        expect(await o.turn.invoke('app',x)).toMatchObject(ok);
        f.ctl.read=()=>{started.resolve();return reading.promise;};
        const wait=f.client.readReceipt(query(x),5);await started.promise;
        f.setTime(5);await vi.advanceTimersByTimeAsync(5);
        expect(await wait).toMatchObject({kind:'unavailable',code:'INVOCATION_WAIT_TIMEOUT',locator:query(x)});
        const fresh=await f.observe();f.setTime(10);
        expect(f.client.inspect()).toMatchObject({activeReads:1,receiptEntries:1,receiptContents:0,receiptBytes:0});
        expect(await fresh.turn.invoke('app',f.request(fresh.candidate,'X'))).toMatchObject({kind:'refused',code:'INVOCATION_ID_CONFLICT'});
        expect(await fresh.turn.invoke('app',f.request(fresh.candidate,'Y'))).toMatchObject(refused('maxEntries'));
        f.ctl.read=()=>true;reading.resolve(true);await vi.advanceTimersByTimeAsync(0);
        expect(f.client.inspect()).toMatchObject({activeReads:0,receiptEntries:0});
        expect(await fresh.turn.invoke('app',f.request(fresh.candidate,'X'))).toMatchObject(ok);
        expect(await f.client.readReceipt(query(x))).toMatchObject({kind:'unavailable',code:'RESULT_UNAVAILABLE'});
    }finally{reading.resolve(true);await f.dispose();vi.useRealTimers();}
});
it('an independent body budget reserves R and releases unused bytes only at actual terminal',async()=>{
    const f=fixture({maxPendingInvocations:3,maxReceiptContents:3,maxReceiptBytes:RECEIPT_BYTES});
    const started=deferred<void>(),gate=deferred<ExecutionFact>();
    f.ctl.execute=()=>{started.resolve();return gate.promise;};
    try{const o=await f.observe(),a=o.turn.invoke('app',f.request(o.candidate,'A'));await started.promise;
        expect(await o.turn.invoke('app',f.request(o.candidate,'B'))).toMatchObject(refused('maxReceiptBytes'));
        expect(f.client.inspect()).toMatchObject({receiptReservedBytes:RECEIPT_BYTES,receiptBytes:0});
        gate.resolve(success());expect(await a).toMatchObject(ok);
        const stats=f.client.inspect();expect(stats.receiptReservedBytes).toBe(0);expect(stats.receiptBytes).toBeGreaterThan(0);expect(stats.receiptBytes).toBeLessThan(RECEIPT_BYTES);
    }finally{gate.resolve(success());await f.dispose();}
});
it('confirmed terminal encoding failure remains unavailable until TTL then expires, with no replay',async()=>{
    const f=fixture({receiptTtlMs:10});
    const real=json.copyWireJson;
    const spy=vi.spyOn(json,'copyWireJson').mockImplementation((input,limits)=>{
        if(limits.maxCanonicalBytes===RECEIPT_BYTES)throw Error('injected final receipt encoding failure');
        return real(input,limits);
    });
    try{
        const o=await f.observe(),r=f.request(o.candidate,'X');
        expect(await o.turn.invoke('app',r)).toMatchObject({kind:'unavailable',code:'RESULT_UNAVAILABLE',locator:query(r)});
        expect(f.client.inspect()).toMatchObject({receiptEntries:1,receiptReservations:0,receiptBytes:0});
        f.setTime(10);
        expect(await o.turn.invoke('app',r)).toMatchObject({kind:'unavailable',code:'RESULT_EXPIRED'});
        expect(f.entered).toEqual(['X']);
    }finally{spy.mockRestore();await f.dispose();}
});
it('permanent dispatch block drains queued entries while preserving the real dispatched terminal',async()=>{
    const f=fixture({maxPendingInvocations:3}),started=deferred<void>(),gate=deferred<ExecutionFact>();
    f.ctl.execute=()=>{started.resolve();return gate.promise;};
    try{const o=await f.observe(),a=o.turn.invoke('app',f.request(o.candidate,'A'));await started.promise;
        const r=f.closeRequest(o.candidate,'B'),b=o.turn.invoke('app',r);
        f.control.blockDispatch({code:'EXECUTION_CHANNEL_ENDED',message:'ended'});
        expect(await b).toMatchObject({kind:'unavailable',code:'EXECUTION_CHANNEL_ENDED',executionPhase:'not-dispatched'});
        expect(f.client.inspect()).toMatchObject({activeInvocations:1,queuedInvocations:0});
        gate.resolve(success());expect(await a).toMatchObject(ok);
        expect(await f.client.readReceipt(query(f.request(o.candidate,'A')))).toMatchObject(ok);
        expect(await o.turn.invoke('app',f.request(o.candidate,'C'))).toMatchObject({kind:'refused',code:'EXECUTION_CHANNEL_ENDED'});
    }finally{gate.resolve(success());await f.dispose();}
});
it('normalizes independent limits, derives defaults and rejects every retired field',()=>{
    const raw={maxEntries:64,maxEntriesPerScope:32};const got=normalizeInteractionLimits(raw);expect(got.maxPendingInvocations).toBe(4);
    raw.maxEntries=1;expect(got).toMatchObject({maxEntries:64,maxEntriesPerScope:32,maxReceiptContents:64,maxReceiptBytes:64*RECEIPT_BYTES});expect(Object.isFrozen(got)).toBe(true);
    for(const key of ['request','rawInput','metadata','fact','receipt','maxReceipts','maxReceiptsPerObservation'])
        expect(()=>normalizeInteractionLimits({[key]:1})).toThrow();
    for(const [key,value] of Object.entries({maxEntries:129,maxPendingInvocations:65,maxReads:0,maxReceiptBytes:RECEIPT_BYTES-1,maxReceiptContents:129,receiptTtlMs:600001}))
        expect(()=>normalizeInteractionLimits({[key]:value})).toThrow(expect.objectContaining({path:'options.interactionLimits.'+key}));
});

it('uses the original absolute queued deadline and a pre-aborted duplicate only exits its own wait', async()=>{
    vi.useFakeTimers(); const f=fixture({maxPendingInvocations:3}), started=deferred<void>(),gate=deferred<ExecutionFact>();
    f.ctl.execute=ctx=>{if(ctx.invocationId==='A'){started.resolve();return gate.promise;}return success();};
    try {
        const o=await f.observe(), a=o.turn.invoke('app',f.request(o.candidate,'A'));await started.promise;
        const req=f.request(o.candidate,'B'), b=o.turn.invoke('app',req,10);
        const already=new AbortController(); already.abort();
        const before=f.client.inspect();
        expect(await o.turn.invoke('app',req,undefined,already.signal)).toMatchObject({kind:'unavailable',code:'INVOCATION_WAIT_CANCELLED',locator:query(req)});
        expect(f.client.inspect()).toEqual(before);
        expect(await o.turn.invoke('app',{...req,input:{different:true}},undefined,already.signal)).toMatchObject({kind:'refused',code:'INVOCATION_ID_CONFLICT'});
        const duplicate=o.turn.invoke('app',req,100);
        f.setTime(10);await vi.advanceTimersByTimeAsync(10);
        expect(await b).toMatchObject({kind:'unavailable',code:'INVOCATION_DEADLINE_EXCEEDED',executionPhase:'not-dispatched',locator:query(req)});
        expect(await duplicate).toMatchObject({kind:'receipt',receipt:{executionPhase:'not-dispatched',outcome:{code:'INVOCATION_DEADLINE_EXCEEDED'}}});
        expect(f.authorized).toEqual(['A']);expect(f.client.inspect()).toMatchObject({activeInvocations:1,queuedInvocations:0});
        gate.resolve(success());expect(await a).toMatchObject(ok);expect(f.entered).toEqual(['A']);
    }finally{gate.resolve(success());await f.dispose();vi.useRealTimers();}
});


it('B4 readStats does not advance the clock, expire receipts or release a held real operation', async()=>{
    const f=fixture({receiptTtlMs:10}), held=deferred<ExecutionFact>(), entered=deferred<void>();
    try {
        const {turn,candidate}=await f.observe();
        expect(await turn.invoke('app',f.request(candidate,'first'))).toMatchObject(ok);
        f.ctl.execute=()=>{entered.resolve();return held.promise;};
        const waiting=turn.invoke('app',f.request(candidate,'held'));await entered.promise;
        f.setTime(100);
        const before=f.control.readStats();
        expect(before.receiptContents).toBe(1);
        expect(before.activeInvocations).toBe(1);
        const holds=f.holds();
        for(let i=0;i<5;i++)expect(f.control.readStats()).toEqual(before);
        expect(f.holds()).toBe(holds);
        expect(f.client.inspect().receiptContents).toBe(0);
        held.resolve(success());expect(await waiting).toMatchObject(ok);
    } finally {held.resolve(success());await f.dispose();}
});
