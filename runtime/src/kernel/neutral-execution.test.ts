import { expect, it, vi } from 'vitest';
import { createRuntime } from '../index.js';
import type { AppExecutionBackend, AppExecutionEvent, AppExecutionLaunch, AppExecutionProjection, AppExecutionRequest } from '../spi/runtime/execution-backend.js';
import type { SnapshotDraftEnvelope } from '@aotui/core/host';
import { readRuntimeProtocolIssue } from '../adapters/initialization-error.js';

const empty = (seq: number, first = false): AppExecutionProjection => ({
    sourceEpoch: seq, producerSeq: seq, healthySince: 1, views: [], tools: [], refs: [],
    ...(first ? { viewTypes: [] } : {}),
});
const stamp = (launch: AppExecutionLaunch, seq: number): SnapshotDraftEnvelope => ({
    appId: launch.appId, instanceId: launch.instanceId, sourceEpoch: seq, producerSeq: seq,
});
type Peer = { launch: AppExecutionLaunch; emit(event: AppExecutionEvent): void; sent: AppExecutionRequest[] };
type Behavior = (peer: Peer, request: AppExecutionRequest) => boolean | void;
function controlled(behavior: Behavior, timeoutMs = 1000) {
    let peer!: Peer;
    const terminate = vi.fn(() => peer.emit({ kind: 'exited' }));
    const backend: AppExecutionBackend = {
        start(launch, emit) {
            peer = { launch, emit, sent: [] };
            return { terminate, send(request) {
                peer.sent.push(request);
                if (behavior(peer, request)) return;
                const { id } = request;
                if (request.kind === 'initialize') emit({ kind: 'reply', id, status: 'ready' });
                else if (request.kind === 'open') {
                    expect(launch.acceptProjection(empty(1, true), 'authoritative', id).status).toBe('accepted');
                    emit({ kind: 'reply', id, status: 'done', publication: stamp(launch, 1) });
                } else if (request.kind === 'observe' && request.known) emit({ kind: 'projectionCurrent', id, publication: request.known });
                else if (request.kind === 'stop' || request.kind === 'close')
                    emit({ kind: 'reply', id, status: 'done', cleanup: { state: request.kind === 'stop' ? 'stopped' : 'completed', issues: [] } });
            } };
        },
    };
    const runtime = createRuntime({ executionBackends: { controlled: backend }, worker: { maxWorkers: 1, timeoutMs } });
    return { runtime, get peer() { return peer; }, terminate, async open() {
        const desktop = await runtime.createDesktop();
        await desktop.registerPendingApp({ installationId: 'fixture', name: 'neutral', backend: 'controlled' });
        return { desktop, opening: desktop.openApp('fixture') };
    } };
}

it.each(['absent', 'other-id', 'wrong-stamp', 'rejected-frame', 'superseded'] as const)('OPEN rejects %s even with a done event', async scenario => {
    const f = controlled(({ launch, emit }, r) => {
        if (r.kind !== 'open') return;
        if (scenario === 'other-id') launch.acceptProjection(empty(1, true), 'authoritative', 'different-id');
        if (scenario === 'wrong-stamp' || scenario === 'superseded') launch.acceptProjection(empty(1, true), 'authoritative', r.id);
        if (scenario === 'rejected-frame') launch.acceptProjection(empty(1), 'candidate', r.id);
        emit({ kind: 'reply', id: r.id, status: 'done', publication: stamp(launch, scenario === 'wrong-stamp' ? 2 : 1) });
        if (scenario === 'superseded') launch.acceptProjection(empty(2), 'authoritative');
        return true;
    });
    try {
        const { opening } = await f.open();
        await expect(opening).rejects.toMatchObject({ code: 'INSTALL_FAILED', closeReport: { resourcesReleased: true } });
        expect(f.terminate).toHaveBeenCalledOnce();
    } finally { await f.runtime.beginClose().completion; }
});

it('adopts a healthy empty frame; current is an exact unchanged sample and generic done cannot borrow it', async () => {
    let mode = 'current';
    const f = controlled(({ launch, emit }, r) => {
        if (r.kind !== 'observe') return;
        if (mode === 'current') return;
        if (mode === 'generic') emit({ kind: 'reply', id: r.id, status: 'done', publication: r.known });
        else if (mode === 'wrong') emit({ kind: 'projectionCurrent', id: r.id, publication: { ...stamp(launch, 1), instanceId: 'wrong' } });
        else if (mode === 'reject') {
            launch.acceptProjection({ ...empty(2), viewTypes: [] }, 'candidate', r.id);
            emit({ kind: 'reply', id: r.id, status: 'done', publication: stamp(launch, 1) });
        } else {
            expect(launch.acceptProjection(empty(2), 'authoritative', r.id).status).toBe('accepted');
            emit({ kind: 'reply', id: r.id, status: 'done', publication: stamp(launch, 2) });
        }
        return true;
    });
    try {
        const { opening } = await f.open(), app = await opening;
        const initial = await app.preview(); expect(initial.status).toBe('previewed');
        expect(await app.preview()).toEqual(initial);
        for (mode of ['generic', 'wrong', 'reject']) expect((await app.preview()).status).toBe('rejected');
        mode = 'new'; expect((await app.preview()).status).toBe('previewed');
        mode = 'current';
        expect((await app.preview()).status).toBe('previewed');
        expect(f.peer.sent.filter(r => r.kind === 'observe').at(-1)).toMatchObject({ known: stamp(f.peer.launch, 2) });
    } finally { await f.runtime.beginClose().completion; }
});

it('a caller timeout retains its original refresh slot; a late result cannot complete a new request', async () => {
    vi.useFakeTimers();
    const f = controlled((_p, r) => r.kind === 'observe' || undefined, 1000);
    try {
        const { opening } = await f.open(), app = await opening;
        const pending = app.preview();
        const old = f.peer.sent.at(-1)!;
        expect(old.kind).toBe('observe');
        await vi.advanceTimersByTimeAsync(1001);
        expect((await pending).status).toBe('rejected');
        expect((await app.preview()).status).toBe('rejected');
        expect(f.peer.sent.filter(r => r.kind === 'observe')).toHaveLength(1);
        f.peer.emit({ kind: 'projectionCurrent', id: old.id, publication: stamp(f.peer.launch, 1) });
        const next = app.preview(); const current = f.peer.sent.at(-1)!;
        expect(current.id).not.toBe(old.id);
        let settled = false; void next.then(() => { settled = true; });
        f.peer.emit({ kind: 'projectionCurrent', id: old.id, publication: stamp(f.peer.launch, 1) });
        await Promise.resolve(); expect(settled).toBe(false);
        f.peer.emit({ kind: 'projectionCurrent', id: current.id, publication: stamp(f.peer.launch, 1) });
        expect((await next).status).toBe('previewed');
    } finally { await f.runtime.beginClose().completion; vi.useRealTimers(); }
});

it('reentrant close during OPEN sends STOP first and joins the actual original reply before one CLOSE', async () => {
    let closing: ReturnType<ReturnType<typeof createRuntime>['beginClose']>;
    const entered = Promise.withResolvers<string>();
    const f = controlled((_p, r) => {
        if (r.kind === 'open') { closing = f.runtime.beginClose(); entered.resolve(r.id); return true; }
    });
    const { opening } = await f.open();
    const id = await entered.promise;
    expect(f.peer.sent.map(r => r.kind)).toEqual(['initialize','open','stop']);
    expect(f.peer.launch.acceptProjection(empty(1,true),'candidate',id)).toMatchObject({ status:'rejected' });
    f.peer.emit({ kind:'reply',id,status:'done',publication:stamp(f.peer.launch,1) });
    await expect(opening).rejects.toMatchObject({code:'INSTALL_FAILED'});
    expect(await closing!.completion).toMatchObject({resourcesReleased:true});
    expect(f.peer.sent.map(r=>r.kind)).toEqual(['initialize','open','stop','close']);
    expect(f.terminate).toHaveBeenCalledOnce();
});

it.each(['throw-before-reply','reply-before-throw'] as const)('send %s preserves caller result and actual startup ownership', async mode => {
    const delivered = Promise.withResolvers<string>(), sentinel = Error('original delivery error');
    const f = controlled(({emit},r) => {
        if(r.kind !== 'initialize') return;
        delivered.resolve(r.id);
        if(mode==='reply-before-throw') emit({kind:'reply',id:r.id,status:'ready'});
        throw sentinel;
    });
    try {
        const {opening} = await f.open(), id = await delivered.promise;
        if(mode==='reply-before-throw') {
            const app=await opening; expect((await app.preview()).status).toBe('previewed'); return;
        }
        await vi.waitFor(()=>expect(f.peer.sent.map(r=>r.kind)).toEqual(['initialize','stop']));
        f.peer.emit({kind:'reply',id,status:'ready'});
        const error=await opening.catch(e=>e);
        expect(error).toMatchObject({code:'INSTALL_FAILED',cause:sentinel,closeReport:{resourcesReleased:true}});
        expect(f.peer.sent.map(r=>r.kind)).toEqual(['initialize','stop','close']);
        expect(readRuntimeProtocolIssue(error)).toBeUndefined();
    } finally { await f.runtime.beginClose().completion; }
});

it('custom invokes and closes with original Ref, actual terminal and original Receipt identity',async()=>{
    const frame:AppExecutionProjection={
        sourceEpoch:1,producerSeq:1,healthySince:1,
        viewTypes:[{name:'File',multiplicity:'single'},{name:'Reader',multiplicity:'single'}],
        views:[{id:'file',type:'File',name:'File',region:'dynamic',body:'seed',viewInstanceId:'m:1',tools:[]},
            {id:'reader',type:'Reader',name:'Reader',region:'dynamic',body:'read',viewInstanceId:'m:2',closeActivationId:'a:2',tools:[{name:'read',activationId:'a:1'}]}],
        refs:[{id:'text',viewId:'file',viewInstanceId:'m:1',scope:'public',continuity:[1,1,1],valueSchema:{type:'string'},value:'seed'}],
        tools:[{viewType:'Reader',name:'read',multiplicity:'single',description:'Read selected text',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}],
    };
    const f=controlled(({launch,emit},r)=>{
        if(r.kind==='open'){
            expect(launch.acceptProjection(frame,'authoritative',r.id).status).toBe('accepted');
            emit({kind:'reply',id:r.id,status:'done',publication:stamp(launch,1)});return true;
        }
        if(r.kind==='invoke'){
            expect(r.input).toEqual({value:'seed'});
            expect(r.localRefs).toEqual([{param:'value',viewId:'file',viewInstanceId:'m:1',refId:'text',since:1}]);
            emit({kind:'reply',id:r.id,status:'tool',terminal:{phase:'entered-returned',result:{success:true}}});return true;
        }
        if(r.kind==='closeView'){
            expect(r).toMatchObject({viewId:'reader',viewInstanceId:'m:2',closeActivationId:'a:2'});
            emit({kind:'reply',id:r.id,status:'tool',terminal:{phase:'entered-returned',result:{success:true}}});return true;
        }
    });
    try{
        const {desktop,opening}=await f.open(), app=await opening;
        const prepared=await app.observe();
        if(prepared.status!=='prepared')throw Error(JSON.stringify(prepared));
        const {candidate}=prepared,o=candidate.observation;
        const views=o.views.map(v=>({viewId:v.id,viewInstanceId:v.viewInstanceId}));
        const adopted=desktop.adoptTurn({apps:[{candidate,windows:{activeViews:views,closeViews:views.filter(v=>v.viewId==='reader')}}]});
        if(adopted.status!=='adopted')throw Error(JSON.stringify(adopted));
        const turn=adopted.turn;
        try{
            const result=await turn.invoke(app.appId,{observationId:o.observationId,invocationId:'ref',toolId:o.tools[0]!.id,input:{value:'$ref.'+app.appId+'.file.text'}});
            expect(result).toMatchObject({kind:'receipt',locator:{appId:app.appId,instanceId:app.instanceId,observationId:o.observationId,invocationId:'ref'},receipt:{executionPhase:'entered-returned',outcome:{status:'succeeded'}}});
            if(result.kind!=='receipt')throw Error(JSON.stringify(result));
            expect(await desktop.readReceipt(result.locator)).toEqual(result);
            const close=await desktop.closeView({turn,invocationId:'close',target:{appId:app.appId,instanceId:app.instanceId,viewId:'reader',viewInstanceId:'m:2'}});
            expect(close).toMatchObject({kind:'receipt',receipt:{executionPhase:'entered-returned',operation:{kind:'closeView'},outcome:{status:'succeeded'}}});
        }finally{turn.release();}
    }finally{await f.runtime.beginClose().completion;}
});

it('public directory reads and exact closing identity retain the original owner and frozen failed release report',async()=>{
    let holdObserve=false;
    const f=controlled((_p,r)=>holdObserve&&r.kind==='observe'||undefined);
    try{
        const {desktop,opening}=await f.open(),app=await opening;
        const notices: import('../spi/core/signals.js').UpdateSignal[]=[];
        desktop.output.subscribe(signal=>notices.push(signal));
        const directory=()=>desktop.listApps().find(a=>a.appInstanceId===app.instanceId);
        const prepared=await app.observe();
        expect(prepared.status).toBe('prepared');
        if(prepared.status!=='prepared')throw Error('No actual candidate');
        holdObserve=true;
        const preview=app.preview();
        const prior=f.peer.sent.at(-1)!;
        const calls=f.peer.sent.length;
        const first=directory();
        expect(first?.run).toMatchObject({phase:'opened',execution:{resource:'owned',channel:'open'},projection:{health:'ready'},availability:{status:'ready'},resourcesReleased:false});
        const host=(desktop as any).appManager.getManagedApp(app.appId).host;
        const stats=host.snapshotReceiver.getInteractionStats();
        for(let i=0;i<100;i++)expect(directory()).toEqual(first);
        expect(host.snapshotReceiver.getInteractionStats()).toEqual(stats);
        expect(f.peer.sent).toHaveLength(calls);
        expect(notices).toHaveLength(0);
        f.peer.emit({kind:'projectionCurrent',id:prior.id,publication:stamp(f.peer.launch,1)});
        expect((await preview).status).toBe('previewed');
        prepared.candidate.discard();holdObserve=false;

        const old=f.peer;
        f.terminate.mockImplementationOnce(()=>{throw Error('first termination denied');});
        const handle=desktop.beginCloseApp(app.appId,app.instanceId);
        expect(directory()?.run).toMatchObject({phase:'closing',resourcesReleased:false,availability:{status:'unavailable'}});
        expect(desktop.beginCloseApp(app.appId,app.instanceId)).toBe(handle);
        const failed=await handle.completion;
        expect(failed).toMatchObject({state:'settled',worker:'retiring',resourcesReleased:false,hasFailures:true});
        expect(Object.isFrozen(failed)).toBe(true);
        expect(directory()?.run).toMatchObject({phase:'closing',execution:{resource:'retiring'},resourcesReleased:false});
        expect(notices.some(s=>s.reason==='app_runtime_changed'&&s.instanceId===app.instanceId)).toBe(true);
        old.emit({kind:'exited'});
        await vi.waitFor(()=>expect(directory()?.run).toMatchObject({execution:{resource:'exited',channel:'ended'},resourcesReleased:true}));
        const released=await desktop.beginCloseApp(app.appId,app.instanceId).completion;
        expect(released).toMatchObject({resourcesReleased:true,hasFailures:true});
        expect(handle.inspect()).toBe(failed);
        expect(failed.resourcesReleased).toBe(false);
        expect(directory()).toBeUndefined();
        expect(old.sent.filter(r=>r.kind==='stop'||r.kind==='close').map(r=>r.kind)).toEqual(['stop','close']);
        const successor=await desktop.openApp('fixture');
        expect(successor.instanceId).not.toBe(app.instanceId);
        const newNotices=notices.length;
        old.emit({kind:'update',reason:'attention_requested'});
        old.emit({kind:'exited'});
        expect(notices).toHaveLength(newNotices);
        expect(()=>desktop.beginCloseApp(successor.appId,app.instanceId)).toThrow();
        expect((await successor.preview()).status).toBe('previewed');
    }finally{await f.runtime.beginClose().completion;}
});
