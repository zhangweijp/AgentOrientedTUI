import { expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { AppKernel } from './AppKernel.js';
const defer = () => { let resolve!: () => void;const promise = new Promise<void>(yes => { resolve = yes; });return { promise, resolve }; };
function fixture(initialize: (context: any) => Promise<any> | any, extra = {}) {
    const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
    let runtime: any;
    const kernel = new AppKernel({ name: 'test', appName: 'test', component: { async initializeComponent(_container: any, context: any) { runtime = context;return initialize(context); } }, ...extra } as any);
    kernel.setId('app' as any);
    const context = { appId: 'app', desktopId: 'd', markDirty: vi.fn(), onRender: vi.fn() };
    const container = document.getElementById('app')!;
    return { kernel, context, container, runtime: () => runtime, open: () => kernel.onOpen(context as any, container as any) };
}
it('injects the formal lifecycle port when a managed factory is initialized directly', async () => {
    const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
    let runtime: any;
    const kernel = new AppKernel({ name: 'test', appName: 'test', component: {
        appLifecycleSupport: 'app-lifecycle-v2',
        async initializeComponent(_container: any, context: any) { runtime = context;return { unmount() {} }; },
    } } as any);
    kernel.setId('app' as any);
    await kernel.onOpen({ appId: 'app', desktopId: 'd', markDirty() {}, onRender() {} } as any, document.getElementById('app') as any);
    expect(runtime.appLifecycle).toMatchObject({ protocol: 'app-lifecycle-v2' });
    const close = vi.fn();runtime.appLifecycle.register({ close });
    await kernel.onClose();expect(close).toHaveBeenCalledTimes(1);
});
it.each(['sync', 'async'])('C2-18 %s unmount failure still clears owned registries', async kind => {
    const f = fixture(context => {
        context.refExporter.registerRef('v', 'key', {});context.viewTools.mount('v', 'Detail');
        return { unmount: () => { if (kind === 'sync') throw Error('private sync');return Promise.reject(Error('private async')); } };
    });
    await f.open();expect(f.kernel.getViewOwnedViewInstances()).toHaveLength(1);
    const closing = f.kernel.onClose();expect(f.kernel.onClose()).toBe(closing);await expect(closing).rejects.toMatchObject({ code: 'APP_UNMOUNT_FAILED', message: 'APP_UNMOUNT_FAILED' });
    expect(f.kernel.getViewRefs()).toEqual([]);expect(f.kernel.getViewOwnedViewInstances()).toHaveLength(0);
    expect((f.kernel as any).viewRegistry).toBeUndefined();expect((f.kernel as any).typeTools).toBeUndefined();expect((f.kernel as any).viewKeyToId).toBeUndefined();
});
it('C2-19 closing during initialization owns the late renderer without registering or reviving', async () => {
    const entered = defer(), finish = defer(), unmount = vi.fn();
    const f = fixture(async () => { entered.resolve();await finish.promise;return { unmount }; });
    const opening = f.open();expect(f.open()).toBe(opening);await entered.promise;const closing = f.kernel.onClose();
    expect(f.runtime().registerView).toBeUndefined();expect(f.runtime().allocateViewId).toBeUndefined();expect(f.runtime().typeTools).toBeUndefined();
    expect(() => f.runtime().refExporter.registerRef('v', 'r', {})).toThrow(expect.objectContaining({ code: 'APP_KERNEL_CLOSED' }));
    expect(() => f.runtime().viewTools.mount('later', 'Detail')).toThrow(expect.objectContaining({ code: 'APP_KERNEL_CLOSED' }));
    const dirty = f.context.markDirty.mock.calls.length;f.runtime().markDirty();expect(f.context.markDirty).toHaveBeenCalledTimes(dirty);
    await expect(f.kernel.onReinitialize()).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');
    expect((f.kernel as any).onOperation).toBeUndefined();
    finish.resolve();await expect(opening).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');await closing;expect(unmount).toHaveBeenCalledTimes(1);
    await expect(f.open()).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');expect(f.kernel.onClose()).toBe(closing);
});
it('C2-19 async unmount is actually awaited and its rejection never becomes a success', async () => {
    const entered = defer(), finish = defer();let ended = false;
    const f = fixture(() => ({ async unmount() { entered.resolve();await finish.promise;throw Error('private delayed'); } }));await f.open();
    const closing = f.kernel.onClose();void closing.then(() => { ended = true; }, () => { ended = true; });await entered.promise;expect(ended).toBe(false);
    finish.resolve();await expect(closing).rejects.toHaveProperty('code', 'APP_UNMOUNT_FAILED');expect(ended).toBe(true);
});
it.each(['sync', 'async'])('C2-20 %s delete failure is fixed, called once and joined by independent close cleanup', async kind => {
    const entered = defer(), finish = defer(), unmount = vi.fn(), onDelete = vi.fn(() => { entered.resolve();if (kind === 'async') return finish.promise.then(() => { throw Error('private delete'); });throw Error('private delete'); });
    const f = fixture(() => ({ unmount }), { onDelete });await f.open();const deleting = f.kernel.onDelete();expect(f.kernel.onDelete()).toBe(deleting);await entered.promise;
    const closing = f.kernel.onClose();if (kind === 'async') expect(unmount).not.toHaveBeenCalled();finish.resolve();
    await expect(deleting).rejects.toMatchObject({ code: 'APP_DELETE_FAILED', message: 'APP_DELETE_FAILED' });await closing;expect(onDelete).toHaveBeenCalledTimes(1);expect(unmount).toHaveBeenCalledTimes(1);
});

it.each(['delete','close'] as const)('PF01 %s hanging rejects every supported V2 parameter family without cancelling entered handlers',async stage=>{
    const lifecycle=defer(),entered=defer(),handlerGate=defer(),enteredHandler=defer(),calls:string[]=[];let releaseTool:(()=>void)|undefined;
    const f=fixture(context=>{
        const view=context.viewTools.mount('v','Detail');
        const handler=(name:string)=>async()=>{calls.push(name);if(name==='held'){enteredHandler.resolve();await handlerGate.promise;}return {success:true,data:{value:19}};};
        const ordinary=(name:string)=>({safeOrdinaryParametersInvocationMode:'ordinary-v2',additionalProperties:false,createSafeOrdinaryParametersInvoker:()=>async()=>({phase:'entered-returned',result:await handler(name)()})});
        const register=(name:string,params:any,options:any,mutating=false)=>context.viewTools.registerTool(view,name,{description:name,params,isMutating:mutating,handler:handler(name)},options);
        releaseTool=register('held',{},ordinary('held'));
        register('parameters',{n:{type:'number',required:true}},ordinary('parameters'));
        const ref={file:{type:'reference',required:true,refSource:'snapshot-value-v1'}};
        register('snapshot',ref,{safeSnapshotValueParametersInvocationMode:'snapshot-value-v2',additionalProperties:false,createSafeSnapshotValueParametersInvoker:()=>async()=>({phase:'entered-returned',result:await handler('snapshot')()})});
        return {async unmount(){if(stage==='close'){entered.resolve();await lifecycle.promise;}}};
    },{onDelete:async()=>{entered.resolve();await lifecycle.promise;}});
    await f.open();const tools=new Map(f.kernel.getViewOwnedToolDefinitions().map(tool=>[tool.name,tool]));
    const source=(name:string)=>tools.get(name)! as any,target=(name:string)=>source(name).targets[0];
    const invoke=[
        ()=>f.kernel.invokeBoundOrdinaryParametersViewTool(source('held'),target('held'),{}),
        ()=>f.kernel.invokeBoundOrdinaryParametersViewTool(source('parameters'),target('parameters'),{n:1}),
        ()=>f.kernel.invokeBoundSnapshotValueParametersViewTool(source('snapshot'),target('snapshot'),{file:{}}),
    ];
    // Prove every registered mode is usable before the close barrier, not merely rejected everywhere.
    for(const call of invoke.slice(1))expect((await call() as any).phase).toBe('entered-returned');
    const running=invoke[0]();await enteredHandler.promise;const initial=calls.length;
    const closing=stage==='delete'?f.kernel.onDelete():f.kernel.onClose();await entered.promise;
    const validations=[['held','validateBoundOrdinaryParametersViewTool'],['parameters','validateBoundOrdinaryParametersViewTool'],['snapshot','validateBoundSnapshotValueParametersViewTool']] as const;
    for(const [name,method] of validations)expect(f.kernel[method](source(name),target(name)).success).toBe(false);
    for(const call of invoke){const result:any=await call();expect(result.result?.success).toBe(false);if('phase'in result)expect(result.phase).toBe('not-entered');}
    expect(calls).toHaveLength(initial);handlerGate.resolve();expect(await running).toMatchObject({phase:'entered-returned',result:{success:true,data:{value:19}}});
    // Cleanup capabilities remain usable while ordinary calls are refused.
    releaseTool?.();f.runtime().viewTools.unmount(target('held').viewInstanceId);
    lifecycle.resolve();await closing;await f.kernel.onClose();expect(f.kernel.getViewOwnedViewInstances()).toHaveLength(0);
});
