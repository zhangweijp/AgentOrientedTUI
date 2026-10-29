import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kernel } from './index.js';
import { DesktopManager } from '../engine/core/manager.js';
import { Desktop } from '../engine/core/desktop.js';
import { SnapshotRegistry } from '../engine/system/registry.js';
import { createRuntime } from '../facades/facades.js';
import { createCloseOperation, freezeClose, newCloseState, snapshotClose } from '../engine/core/close-operation.js';
import type { AppManagerCloseReport } from '../spi/runtime/close.interface.js';

function barrier<T = void>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;const promise = new Promise<T>((yes, no) => { resolve = yes;reject = no; });return { promise, resolve, reject }; }
function setup(manager: any = new DesktopManager(), registry: any = new SnapshotRegistry()) {
    const dispatcher = { dispatch: vi.fn(async () => ({ success: true })) }, ops = { has: () => false, getToolDefinitions: () => [], execute: async () => ({ success: true }) };
    return { kernel: new Kernel(manager, registry, dispatcher as any, ops as any), manager, registry, dispatcher };
}
afterEach(() => { vi.restoreAllMocks();vi.useRealTimers(); });

describe('Kernel actual close reporting', () => {
    it.each((['active','single-close','successor','actual-isClosing'] as const).flatMap(state=>[false,true].flatMap(system=>(['success','failure','throw'] as const).map(outcome=>[state,system,outcome] as const))))('PF02 %s system=%s outcome=%s preserves business results and scopes all diagnostics',async(state,system,outcome)=>{
        const work=barrier<any>(),drain=barrier<void>();
        const old:any={id:'d',isClosing:false,drain:()=>drain.promise,delete:async()=>{},getAppInfo:vi.fn(()=>({name:'old'})),logAppOperation:vi.fn(),logSystem:vi.fn(),emitSignal:vi.fn()};
        const next:any={id:'d',drain:async()=>{},delete:async()=>{},getAppInfo:vi.fn(()=>({name:'next'})),logAppOperation:vi.fn(),logSystem:vi.fn(),emitSignal:vi.fn()};
        let current:any=old;
        const manager:any={get:()=>current,listDesktopIds:()=>current?['d']:[],destroy:async()=>{current=undefined;},shutdown:async()=>{},verifyLock:()=>true,refreshLock(){}};
        const kernel=new Kernel(manager,{shutdown(){}} as any,{dispatch:()=>work.promise} as any,{has:()=>system,getToolDefinitions:()=>[],execute:()=>work.promise} as any);
        const running=kernel.execute('d',{name:'inspect',context:{appId:'app',snapshotId:'old'},args:{}} as any,'owner');
        let closing:ReturnType<Kernel['beginDesktopShutdown']>|undefined;
        if(state==='single-close'||state==='successor')closing=kernel.beginDesktopShutdown('d');
        if(state==='successor')current=next;
        if(state==='actual-isClosing')old.isClosing=true;
        if(outcome==='throw')work.reject(Error('business failure'));else work.resolve({success:outcome==='success',data:{value:19},...(outcome==='failure'?{error:{code:'BUSINESS',message:'expected'}}:{})});
        const result=await running;expect(result.success).toBe(outcome==='success');expect(typeof result.data?.durationMs).toBe('number');
        if(outcome!=='throw')expect(result.data).toMatchObject({value:19,operationName:'inspect'});
        else expect(result.error?.code).toBe('EXECUTION_FAILED');
        const expected=state==='active'?1:0;
        expect(old.getAppInfo).toHaveBeenCalledTimes(expected);expect(old.logAppOperation.mock.calls.length+old.logSystem.mock.calls.length).toBe(expected);
        expect(old.emitSignal).toHaveBeenCalledTimes(state==='active'&&system&&outcome==='success'?1:0);
        expect(next.getAppInfo).not.toHaveBeenCalled();expect(next.logAppOperation).not.toHaveBeenCalled();expect(next.logSystem).not.toHaveBeenCalled();expect(next.emitSignal).not.toHaveBeenCalled();
        drain.resolve();await closing?.completion;await kernel.shutdown();
    });
    it('single Desktop close refuses snapshots including the pending import continuation, while serialization remains readable', async () => {
        const {kernel,registry}=setup(),id=await kernel.createDesktop('single'),desktop=kernel.getDesktop(id),gate=barrier<void>(),create=vi.spyOn(registry,'create');
        const snapshot=kernel.acquireSnapshot(id),closing=kernel.beginDesktopShutdown(id,{beforeClose:()=>gate.promise});
        await expect(snapshot).rejects.toHaveProperty('code','DESKTOP_DISPOSED');await expect(kernel.acquireSnapshot(id)).rejects.toHaveProperty('code','DESKTOP_DISPOSED');expect(create).not.toHaveBeenCalled();
        expect(()=>desktop.getSnapshotFragments()).toThrowError(expect.objectContaining({code:'DESKTOP_DISPOSED'}));expect(()=>kernel.acquireLock(id,'new')).toThrowError(expect.objectContaining({code:'DESKTOP_DISPOSED'}));
        for(const call of [()=>kernel.reinitializeDesktopApps(id),()=>kernel.suspend(id),()=>kernel.resume(id)])await expect(call()).rejects.toHaveProperty('code','DESKTOP_DISPOSED');
        expect(kernel.getDesktop(id)).toBe(desktop);expect(kernel.serialize(id).id).toBe(id);gate.resolve();await closing.completion;await kernel.shutdown();
    });
    it('legacy missing-object destroy still delegates once on success/failure and attaches a bounded fixed failure report', async()=>{
        const manager:any={get:()=>undefined,destroy:vi.fn(async()=>{throw Error('private missing close');}),listDesktopIds:()=>[]}, {kernel}=setup(manager);
        await expect(kernel.destroyDesktop('missing')).rejects.toMatchObject({code:'DESKTOP_CLOSE_FAILED',report:{found:false,hasFailures:true,verification:'unverified',desktops:{accepted:0}}});expect(manager.destroy).toHaveBeenCalledWith('missing');expect(manager.destroy).toHaveBeenCalledOnce();
        manager.destroy.mockResolvedValue(undefined);await expect(kernel.destroyDesktop('missing')).resolves.toBeUndefined();expect(manager.destroy).toHaveBeenCalledTimes(2);
        expect((await kernel.beginShutdown().completion).resourcesReleased).toBe(false);
    });
    it('all new asynchronous business is refused before dependencies while release/query/close remain usable', async () => {
        const { kernel, manager, dispatcher, registry } = setup();const id=await kernel.createDesktop('admission');const desktop=manager.get(id);
        const original=desktop.beginClose.bind(desktop),gate=barrier<void>();const childState=newCloseState('app-manager');childState.resourcesReleased=false;
        const childReport=():AppManagerCloseReport=>freezeClose({...snapshotClose(childState),scope:'app-manager'});
        vi.spyOn((desktop as any).appManager,'beginClose').mockReturnValue(createCloseOperation(childReport,gate.promise.then(()=>{childState.state='settled';childState.resourcesReleased=true;return childReport();})));
        const install=vi.spyOn(desktop,'installDynamicWorkerApp'),acquire=vi.spyOn(registry,'create'),shutdown=kernel.beginShutdown();
        for(const call of [()=>kernel.createDesktop(),()=>kernel.installDynamicWorkerApp(id,'/none'),()=>kernel.acquireSnapshot(id),()=>kernel.execute(id,{} as any,'x'),()=>kernel.reinitializeDesktopApps(id),()=>kernel.suspend(id),()=>kernel.resume(id)])await expect(call()).rejects.toHaveProperty('code','RUNTIME_SHUTDOWN');
        expect(install).not.toHaveBeenCalled();expect(acquire).not.toHaveBeenCalled();expect(dispatcher.dispatch).not.toHaveBeenCalled();expect(kernel.getDesktop(id)).toBe(desktop);expect(kernel.serialize(id).id).toBe(id);kernel.releaseSnapshot('missing');kernel.releaseLock(id,'x');
        gate.resolve();await shutdown.completion;await original().completion;
    });
    it('default factory provides managed shared operation and stable old void Promise', async () => {
        const kernel = createRuntime();const id = await kernel.createDesktop('empty');const operation = kernel.beginShutdown();
        expect(kernel.beginShutdown('ignored')).toBe(operation);const first = kernel.shutdown();expect(kernel.shutdown()).toBe(first);
        await expect(kernel.createDesktop()).rejects.toMatchObject({ code: 'RUNTIME_SHUTDOWN' });expect(() => kernel.acquireLock(id, 'late')).toThrowError(expect.objectContaining({ code: 'RUNTIME_SHUTDOWN' }));
        const report = await operation.completion;await first;expect(report).toMatchObject({ ok: true, cleanup: { registry: 'done', locks: 'done' }, pool: { ownership: 'owned', report: { state: 'closed', total: 0 } } });
        expect(Object.isFrozen(report.failures)).toBe(true);expect(kernel.beginShutdown()).toBe(operation);
    });
    it('enforces 128 accepted business calls before invoking dependencies and restores a slot', async () => {
        const { kernel, manager } = setup();const gate = barrier(), original = manager.create.bind(manager);
        const create = vi.spyOn(manager, 'create').mockImplementation((id: any) => { const accepted = original(id);return gate.promise.then(() => accepted); });
        const calls = Array.from({ length: 128 }, (_, i) => kernel.createDesktop('capacity-'+i));
        expect(create).toHaveBeenCalledTimes(128);await expect(kernel.createDesktop('overflow')).rejects.toMatchObject({ code: 'LIFECYCLE_CAPACITY_EXCEEDED' });expect(create).toHaveBeenCalledTimes(128);
        gate.resolve();await Promise.all(calls);await kernel.createDesktop('restored');expect(create).toHaveBeenCalledTimes(129);await kernel.shutdown();
    });
    it('snapshot dynamic import cannot create a Registry entry after shutdown has started', async () => {
        const { kernel, registry } = setup();const id = await kernel.createDesktop('snap');const create = vi.spyOn(registry, 'create');
        const snapshot = kernel.acquireSnapshot(id);const closing = kernel.beginShutdown();
        await expect(snapshot).rejects.toMatchObject({ code: 'RUNTIME_SHUTDOWN' });await closing.completion;expect(create).not.toHaveBeenCalled();expect((registry as any).snapshots.size).toBe(0);
    });
    it('Registry waits accepted async dispatch, then clears real TTLs independently of a hung Desktop close', async () => {
        vi.useFakeTimers();const { kernel, manager, registry, dispatcher } = setup();const id = await kernel.createDesktop('held');kernel.acquireLock(id, 'owner');
        const snapshot = registry.create({}, 'body', 300000), dispatched = barrier<any>();dispatcher.dispatch.mockImplementation(() => dispatched.promise);
        const desktop = manager.get(id), appState = newCloseState('app-manager');appState.resourcesReleased = false;
        const child = barrier<AppManagerCloseReport>();const report = (): AppManagerCloseReport => freezeClose({ ...snapshotClose(appState), scope: 'app-manager' });
        const appManager = (desktop as any).appManager, original = appManager.beginClose.bind(appManager);
        vi.spyOn(appManager, 'beginClose').mockReturnValue(createCloseOperation(report, child.promise));
        const execute = kernel.execute(id, { name: 'app-read', context: { appId: 'a', snapshotId: snapshot.id }, args: {} } as any, 'owner');
        const shutdown = kernel.beginShutdown();expect(shutdown.inspect()).toMatchObject({ pendingOperations: 1, cleanup: { registry: 'pending' } });
        kernel.releaseLock(id, 'owner');expect(kernel.getDesktop(id)).toBe(desktop);expect(kernel.serialize(id).id).toBe(id);
        await expect(desktop.openApp('a')).rejects.toMatchObject({ code: 'DESKTOP_DISPOSED' });
        await Promise.resolve();expect((registry as any).snapshots.size).toBe(1);
        // A legacy dispatcher is still allowed to consume its retained snapshot until it finishes.
        registry.retain(snapshot.id);dispatched.resolve({ success: false, error: { code: 'BUSINESS', message: 'business' } });
        expect((await execute).success).toBe(false);await vi.advanceTimersByTimeAsync(0);
        expect((registry as any).snapshots.size).toBe(0);expect(shutdown.inspect().cleanup.registry).toBe('done');expect(shutdown.inspect().state).toBe('closing');expect(vi.getTimerCount()).toBe(0);
        appState.state = 'settled';appState.resourcesReleased = true;child.resolve(report());await shutdown.completion;await original().completion;
    });
    it('late create from a legacy asynchronous Manager is captured and actually closed before completion', async () => {
        const gate = barrier(), desktops = new Map<string, Desktop>();const manager: any = {
            create: vi.fn(async () => { await gate.promise;const desktop = new Desktop('late');desktops.set('late', desktop);return 'late'; }),
            get: (id: string) => desktops.get(id), listDesktopIds: () => [...desktops.keys()],
            destroy: vi.fn(async (id: string) => { await desktops.get(id)?.dispose();desktops.delete(id); }),shutdown: vi.fn(async () => {})
        };
        const { kernel } = setup(manager);const creating = kernel.createDesktop(), shutdown = kernel.beginShutdown();expect(shutdown.inspect().state).toBe('closing');
        gate.resolve();await expect(creating).rejects.toMatchObject({ code: 'RUNTIME_SHUTDOWN' });const report = await shutdown.completion;
        expect(desktops.size).toBe(0);expect(manager.destroy).toHaveBeenCalledOnce();expect(report).toMatchObject({ ok: false, hasFailures: false, verification: 'mixed', desktops: { accepted: 1, settled: 1 } });
    });
    it('known Registry failure is retained in completion and the same rejected shutdown Promise forever', async () => {
        const registry = { shutdown: vi.fn(() => { throw Error('private failure'); }) }, { kernel, manager } = setup(undefined, registry);
        const id = await kernel.createDesktop('failure'), promise = kernel.shutdown();expect(kernel.shutdown()).toBe(promise);
        await expect(promise).rejects.toMatchObject({ code: 'RUNTIME_CLOSE_FAILED', report: { hasFailures: true, cleanup: { registry: 'failed' } } });
        expect(kernel.shutdown()).toBe(promise);await expect(kernel.shutdown()).rejects.toMatchObject({ code: 'RUNTIME_CLOSE_FAILED' });
        const report = await kernel.beginShutdown().completion;expect(JSON.stringify(report)).not.toContain('private failure');expect(manager.has(id)).toBe(false);expect(registry.shutdown).toHaveBeenCalledOnce();
    });
    it('graceful observer deadline never repeats destroy or cancels an entered callback; callback can serialize', async () => {
        vi.useFakeTimers();const { kernel, manager } = setup();const id = await kernel.createDesktop('graceful'), gate = barrier();
        const callback = vi.fn(async () => { expect(kernel.serialize(id).id).toBe(id);await gate.promise; });
        const graceful = kernel.gracefulShutdown(id, { timeoutMs: 10, beforeClose: callback });const handled = graceful.catch(error => error);
        await vi.advanceTimersByTimeAsync(0);expect(callback).toHaveBeenCalledOnce();const operation = kernel.beginDesktopShutdown(id, { beforeClose: callback });
        const runtime = kernel.beginShutdown();await vi.advanceTimersByTimeAsync(11);expect(await handled).toMatchObject({ code: 'CLOSE_DEADLINE_EXCEEDED' });expect(manager.has(id)).toBe(true);
        expect(operation.inspect().beforeClose).toBe('running');gate.resolve();expect((await operation.completion).beforeClose).toBe('done');await runtime.completion;expect(vi.getTimerCount()).toBe(0);
    });
    it('legacy Desktop and missing Registry shutdown preserve unverified facts and genuine failures', async () => {
        const desktop = { drain: vi.fn(async () => { throw Error('user'); }), delete: vi.fn(async () => {}) };
        const manager: any = { get: () => desktop, listDesktopIds: () => ['legacy'], destroy: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) };
        const { kernel } = setup(manager, {});const report = await kernel.beginShutdown().completion;
        expect(report).toMatchObject({ state: 'settled', ok: false, hasFailures: true, resourcesReleased: false, cleanup: { registry: 'unverified' } });
        expect(report.unverifiedParticipants).toBe(3);expect(report.failures.flatMap(x => x.codes)).toContain('LEGACY_CLOSE_FAILED');expect(manager.destroy).toHaveBeenCalledOnce();
        await expect(kernel.shutdown()).rejects.toMatchObject({ code: 'RUNTIME_CLOSE_FAILED' });
    });
    it('legacy Manager destroy failure after a managed Desktop close is still a fixed failed completion', async () => {
        const desktop=new Desktop('managed'),manager:any={get:()=>desktop,listDesktopIds:()=>['managed'],destroy:vi.fn(async()=>{throw Error('private manager failure');}),shutdown:vi.fn(async()=>{})};
        const {kernel}=setup(manager),operation=kernel.beginDesktopShutdown('managed');expect(kernel.beginDesktopShutdown('managed')).toBe(operation);
        const report=await operation.completion;expect(report).toMatchObject({hasFailures:true,resourcesReleased:false,state:'settled'});expect(report.failures.flatMap(row=>row.codes)).toContain('LEGACY_CLOSE_FAILED');expect(manager.destroy).toHaveBeenCalledOnce();
        await expect(kernel.destroyDesktop('managed')).rejects.toHaveProperty('code','DESKTOP_CLOSE_FAILED');await kernel.beginShutdown().completion;expect(JSON.stringify(report)).not.toContain('private manager failure');
    });
});
