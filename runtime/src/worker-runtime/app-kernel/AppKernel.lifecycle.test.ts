import { expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { AppKernel } from './AppKernel.js';
const defer = () => { let resolve!: () => void;const promise = new Promise<void>(yes => { resolve = yes; });return { promise, resolve }; };
function fixture(initialize: (context: any) => Promise<any> | any, extra = {}) {
    const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
    let runtime: any, render: (() => void) | undefined;
    const kernel = new AppKernel({ name: 'test', appName: 'test', component: { async initializeComponent(_container: any, context: any) { runtime = context;return initialize(context); } }, ...extra } as any);
    kernel.setId('app' as any);
    const context = { appId: 'app', desktopId: 'd', markDirty: vi.fn(), onRender(callback: () => void) { render = callback; } };
    const container = document.getElementById('app')!;
    return { kernel, context, container, runtime: () => runtime, render: () => render?.(), open: () => kernel.onOpen(context as any, container as any) };
}
it.each(['sync', 'async'])('C2-18 %s unmount failure still clears every listener and owned registry', async kind => {
    const f = fixture(context => {
        context.refExporter.registerRef('v', 'key', {});context.allocateViewId('one');context.viewTools.mount('v', 'Detail');
        return { unmount: () => { if (kind === 'sync') throw Error('private sync');return Promise.reject(Error('private async')); } };
    });
    const remove = vi.spyOn(f.container, 'removeEventListener');await f.open();expect(f.kernel.getViewOwnedViewInstances()).toHaveLength(1);
    const closing = f.kernel.onClose();expect(f.kernel.onClose()).toBe(closing);await expect(closing).rejects.toMatchObject({ code: 'APP_UNMOUNT_FAILED', message: 'APP_UNMOUNT_FAILED' });
    expect(remove.mock.calls.map(([name]) => name).sort()).toEqual(['aotui:ref-register', 'aotui:ref-unregister', 'aotui:system', 'aotui:type-tool-register', 'aotui:type-tool-unregister'].sort());
    expect(f.kernel.exportRefsToIndexMap()).toEqual({});expect(f.kernel.getViewOwnedViewInstances()).toHaveLength(0);
    expect((f.kernel as any).viewRegistry.getAll()).toHaveLength(0);expect((f.kernel as any).typeTools.size).toBe(0);expect((f.kernel as any).viewKeyToId.size).toBe(0);
});
it('C2-18 a listener removal failure cannot skip other listeners or registries', async () => {
    const f = fixture(context => { context.refExporter.registerRef('v', 'r', {});return { unmount() {} }; });await f.open();
    const original = f.container.removeEventListener.bind(f.container), seen: string[] = [];
    vi.spyOn(f.container, 'removeEventListener').mockImplementation(((name: string, ...args: any[]) => { seen.push(name);if (name === 'aotui:ref-register') throw Error('private listener');return original(name, ...args); }) as any);
    await expect(f.kernel.onClose()).rejects.toHaveProperty('code', 'APP_UNMOUNT_FAILED');expect(seen).toHaveLength(5);expect(f.kernel.exportRefsToIndexMap()).toEqual({});
});
it('C2-19 closing during initialization owns the late renderer without registering or reviving', async () => {
    const entered = defer(), finish = defer(), unmount = vi.fn();
    const f = fixture(async () => { entered.resolve();await finish.promise;return { unmount }; }), add = vi.spyOn(f.container, 'addEventListener');
    const opening = f.open();expect(f.open()).toBe(opening);await entered.promise;const closing = f.kernel.onClose();
    expect(() => f.runtime().registerView({})).toThrow(expect.objectContaining({ code: 'APP_KERNEL_CLOSED' }));
    expect(() => f.runtime().refExporter.registerRef('v', 'r', {})).toThrow(expect.objectContaining({ code: 'APP_KERNEL_CLOSED' }));
    expect(() => f.runtime().viewTools.mount('later', 'Detail')).toThrow(expect.objectContaining({ code: 'APP_KERNEL_CLOSED' }));
    const dirty = f.context.markDirty.mock.calls.length;f.runtime().markDirty();f.render();expect(f.context.markDirty).toHaveBeenCalledTimes(dirty);
    await expect(f.kernel.onReinitialize()).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');
    await expect(f.kernel.onOperation({} as any, 'x' as any, {})).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');
    finish.resolve();await expect(opening).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');await closing;expect(unmount).toHaveBeenCalledTimes(1);expect(add).not.toHaveBeenCalled();
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

it.each(['delete','close'] as const)('PF01 %s hanging rejects every bound family through actual registration without cancelling entered handlers',async stage=>{
    const lifecycle=defer(),entered=defer(),handlerGate=defer(),enteredHandler=defer(),calls:string[]=[];let releaseTool:(()=>void)|undefined;
    const f=fixture(context=>{
        const view=context.viewTools.mount('v','Detail');
        const ordinary=async()=>{calls.push('ordinary');return {phase:'entered-returned',result:{success:true,data:{value:19}}};};
        const register=(name:string,params:any,options?:any,mutating=false)=>context.viewTools.registerTool(view,name,{description:name,params,isMutating:mutating,handler:async()=>{calls.push(name);if(name==='held'){enteredHandler.resolve();await handlerGate.promise;}return {success:true,data:{value:19}};}},options);
        releaseTool=register('held',{});
        register('ordinary',{}, {safeOrdinaryInvocationMode:'ordinary-v1',createSafeOrdinaryInvoker:()=>ordinary});
        register('parameters',{n:{type:'number',required:true}}, {safeOrdinaryParametersInvocationMode:'ordinary-v2',additionalProperties:false,createSafeOrdinaryParametersInvoker:()=>async()=>{calls.push('parameters');return {phase:'entered-returned',result:{success:true}};}});
        const ref={file:{type:'reference',required:true,refSource:'snapshot-value-v1'}};
        register('ref',ref,{safeRefInvocationMode:'snapshot-value-v1',createSafeRefInvoker:()=>async()=>{calls.push('ref');return {phase:'entered-returned',result:{success:true}};}});
        register('snapshot',ref,{safeSnapshotValueParametersInvocationMode:'snapshot-value-v2',additionalProperties:false,createSafeSnapshotValueParametersInvoker:()=>async()=>{calls.push('snapshot');return {phase:'entered-returned',result:{success:true}};}});
        register('create',{name:{type:'string',required:true}},{safeCreateIfAbsentInvocationMode:'create-if-absent-v1',createSafeCreateIfAbsentInvoker:()=>async()=>{calls.push('create');return {phase:'entered-returned',outcome:{status:'succeeded',value:{created:true}}};}},true);
        return {async unmount(){if(stage==='close'){entered.resolve();await lifecycle.promise;}}};
    },{onDelete:async()=>{entered.resolve();await lifecycle.promise;}});
    await f.open();const tools=new Map(f.kernel.getViewOwnedToolDefinitions().map(tool=>[tool.name,tool]));
    const source=(name:string)=>tools.get(name)! as any,target=(name:string)=>source(name).targets[0];
    const invoke=[
        ()=>f.kernel.invokeBoundReadOnlyTool(source('held'),target('held'),{}),
        ()=>f.kernel.invokeBoundOrdinaryViewTool(source('ordinary'),target('ordinary'),{}),
        ()=>f.kernel.invokeBoundOrdinaryParametersViewTool(source('parameters'),target('parameters'),{n:1}),
        ()=>f.kernel.invokeBoundRefViewTool(source('ref'),target('ref'),{file:{}}),
        ()=>f.kernel.invokeBoundSnapshotValueParametersViewTool(source('snapshot'),target('snapshot'),{file:{}}),
        ()=>f.kernel.invokeBoundCreateIfAbsentViewTool(source('create'),target('create'),{name:'x'})
    ];
    // Prove every registered mode is usable before the close barrier, not merely rejected everywhere.
    for(const call of invoke.slice(1))expect((await call() as any).phase).toBe('entered-returned');
    const running=invoke[0]();await enteredHandler.promise;const initial=calls.length;
    const closing=stage==='delete'?f.kernel.onDelete():f.kernel.onClose();await entered.promise;
    const validations=[['held','validateBoundViewTool'],['ordinary','validateBoundOrdinaryViewTool'],['parameters','validateBoundOrdinaryParametersViewTool'],['ref','validateBoundRefViewTool'],['snapshot','validateBoundSnapshotValueParametersViewTool'],['create','validateBoundCreateIfAbsentViewTool']] as const;
    for(const [name,method] of validations)expect(f.kernel[method](source(name),target(name)).success).toBe(false);
    for(const call of invoke){const result:any=await call();expect(result.success??result.result?.success??(result.outcome?.status==='succeeded')).toBe(false);if('phase'in result)expect(result.phase).toBe('not-entered');}
    expect(calls).toHaveLength(initial);handlerGate.resolve();expect(await running).toMatchObject({success:true,data:{value:19}});
    // Cleanup capabilities remain usable while ordinary calls are refused.
    releaseTool?.();f.runtime().viewTools.unmount(target('held').viewInstanceId);
    lifecycle.resolve();await closing;await f.kernel.onClose();expect(f.kernel.getViewOwnedViewInstances()).toHaveLength(0);
});
