import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kernel } from './index.js';
import { DesktopManager } from '../engine/core/manager.js';
import { Desktop } from '../engine/core/desktop.js';
import { createRuntime } from '../facades/facades.js';
import { createCloseHandle, freezeClose, newCloseState, snapshotClose } from '../engine/core/close-handle.js';
import type { AppManagerCloseReport, DesktopCloseOptions, DesktopCloseHandle, DesktopCloseReport, RuntimeCloseHandle, RuntimeCloseReport } from '../spi/runtime/close.interface.js';

function barrier<T = void>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;const promise = new Promise<T>((yes, no) => { resolve = yes;reject = no; });return { promise, resolve, reject }; }
function setup(manager: any = new DesktopManager()) {
    return { kernel: new Kernel(manager), manager };
}
afterEach(() => { vi.restoreAllMocks();vi.useRealTimers(); });

describe('Kernel close reporting', () => {
    it('single Desktop close rejects new lifecycle work while serialization remains readable', async () => {
        const {kernel}=setup(),id=await kernel.createDesktop('single'),desktop=kernel.getDesktop(id),gate=barrier<void>();
        const closing=kernel.beginDesktopShutdown(id,{beforeClose:()=>gate.promise});
        await expect(desktop.openApp('app')).rejects.toHaveProperty('code','DESKTOP_DISPOSED');
        for(const call of [()=>kernel.reinitializeDesktopApps(id),()=>kernel.suspend(id),()=>kernel.resume(id)])await expect(call()).rejects.toHaveProperty('code','DESKTOP_DISPOSED');
        expect(kernel.getDesktop(id)).toBe(desktop);expect(kernel.serialize(id).id).toBe(id);gate.resolve();await closing.completion;await kernel.shutdown();
    });
    it('missing Desktop destroy is reported by the managed manager as an idempotent no-op', async()=>{
        const {kernel}=setup();
        await expect(kernel.destroyDesktop('missing')).resolves.toBeUndefined();
        expect(await kernel.beginShutdown().completion).toMatchObject({ ok: true, resourcesReleased: true, verification: 'managed', desktops: { accepted: 0, settled: 0 } });
    });
    it('new asynchronous business is refused before dependencies after Runtime shutdown starts', async () => {
        const { kernel, manager } = setup();const id=await kernel.createDesktop('admission');const desktop=manager.get(id);
        const original=desktop.beginClose.bind(desktop),gate=barrier<void>();const childState=newCloseState('app-manager');childState.resourcesReleased=false;
        const childReport=():AppManagerCloseReport=>freezeClose({...snapshotClose(childState),scope:'app-manager'});
        vi.spyOn((desktop as any).appManager,'beginClose').mockReturnValue(createCloseHandle(childReport,gate.promise.then(()=>{childState.state='settled';childState.resourcesReleased=true;return childReport();})));
        const install=vi.spyOn(desktop,'installDynamicWorkerApp'),shutdown=kernel.beginShutdown();
        for(const call of [()=>kernel.createDesktop(),()=>kernel.installDynamicWorkerApp(id,'/none'),()=>kernel.reinitializeDesktopApps(id),()=>kernel.suspend(id),()=>kernel.resume(id)])await expect(call()).rejects.toHaveProperty('code','RUNTIME_SHUTDOWN');
        expect(install).not.toHaveBeenCalled();expect(kernel.getDesktop(id)).toBe(desktop);expect(kernel.serialize(id).id).toBe(id);
        gate.resolve();await shutdown.completion;await original().completion;
    });
    it('default factory provides a managed close handle and stable void Promise', async () => {
        const kernel = createRuntime();const id = await kernel.createDesktop('empty');const handle = kernel.beginShutdown();
        expect(kernel.beginShutdown('ignored')).toBe(handle);const first = kernel.shutdown();expect(kernel.shutdown()).toBe(first);
        await expect(kernel.createDesktop()).rejects.toMatchObject({ code: 'RUNTIME_SHUTDOWN' });
        expect(kernel.getAppInteraction(id, 'app', 'instance')).toMatchObject({ status: 'rejected', issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
        const report = await handle.completion;await first;expect(report).toMatchObject({ ok: true, resourcesReleased: true, workers: { ownership: 'owned', report: { state: 'closed', total: 0 } } });
        expect(Object.isFrozen(report.failures)).toBe(true);expect(kernel.beginShutdown()).toBe(handle);
    });
    it('enforces 128 accepted business calls before invoking dependencies and restores a slot', async () => {
        const { kernel, manager } = setup();const gate = barrier(), original = manager.create.bind(manager);
        const create = vi.spyOn(manager, 'create').mockImplementation((id: any) => { const accepted = original(id);return gate.promise.then(() => accepted); });
        const calls = Array.from({ length: 128 }, (_, i) => kernel.createDesktop('capacity-'+i));
        expect(create).toHaveBeenCalledTimes(128);await expect(kernel.createDesktop('overflow')).rejects.toMatchObject({ code: 'LIFECYCLE_CAPACITY_EXCEEDED' });expect(create).toHaveBeenCalledTimes(128);
        gate.resolve();await Promise.all(calls);await kernel.createDesktop('restored');expect(create).toHaveBeenCalledTimes(129);await kernel.shutdown();
    });
    it('late accepted create is closed and included in the managed Runtime report', async () => {
        const gate = barrier(), desktops = new Map<string, Desktop>(), state = newCloseState('runtime');state.state = 'settled';
        const runtimeReport = (): RuntimeCloseReport => freezeClose({ ...snapshotClose(state), scope: 'runtime', intent: 'close' });
        const emptyRuntimeClose = (): RuntimeCloseHandle => createCloseHandle(runtimeReport, Promise.resolve(runtimeReport()));
        const manager: any = {
            create: vi.fn(async () => { await gate.promise;const desktop = new Desktop('late');desktops.set('late', desktop);return 'late'; }),
            get: (id: string) => desktops.get(id), listDesktopIds: () => [...desktops.keys()],
            beginDesktopShutdown: vi.fn((id: string, options?: DesktopCloseOptions): DesktopCloseHandle => {
                const desktop = desktops.get(id);
                if (!desktop) {
                    const missing = newCloseState('desktop', options?.intent ?? 'close');missing.state = 'settled';
                    const report: DesktopCloseReport = freezeClose({ ...snapshotClose(missing), scope: 'desktop', intent: options?.intent ?? 'close', desktopId: id, found: false });
                    return createCloseHandle(() => report, Promise.resolve(report));
                }
                const handle = desktop.beginClose(options);
                void handle.completion.then(report => { if (report.resourcesReleased && desktops.get(id) === desktop) desktops.delete(id); });
                return handle;
            }),
            beginShutdown: vi.fn(() => emptyRuntimeClose()),
            destroy: vi.fn(async (id: string) => { await manager.beginDesktopShutdown(id).completion; }),
        };
        const { kernel } = setup(manager);const creating = kernel.createDesktop(), shutdown = kernel.beginShutdown();expect(shutdown.inspect().state).toBe('closing');
        gate.resolve();await expect(creating).rejects.toMatchObject({ code: 'RUNTIME_SHUTDOWN' });const report = await shutdown.completion;
        expect(desktops.size).toBe(0);expect(manager.beginDesktopShutdown).toHaveBeenCalledOnce();expect(report).toMatchObject({ ok: true, hasFailures: false, verification: 'managed', desktops: { accepted: 1, settled: 1 } });
    });
    it('graceful observer deadline never repeats destroy or cancels an entered callback; callback can serialize', async () => {
        vi.useFakeTimers();const { kernel, manager } = setup();const id = await kernel.createDesktop('graceful'), gate = barrier();
        const callback = vi.fn(async () => { expect(kernel.serialize(id).id).toBe(id);await gate.promise; });
        const graceful = kernel.gracefulShutdown(id, { timeoutMs: 10, beforeClose: callback });const handled = graceful.catch(error => error);
        await vi.advanceTimersByTimeAsync(0);expect(callback).toHaveBeenCalledOnce();const handle = kernel.beginDesktopShutdown(id, { beforeClose: callback });
        const runtime = kernel.beginShutdown();await vi.advanceTimersByTimeAsync(11);expect(await handled).toMatchObject({ code: 'CLOSE_DEADLINE_EXCEEDED' });expect(manager.get(id)).toBeDefined();
        expect(handle.inspect().beforeClose).toBe('running');gate.resolve();expect((await handle.completion).beforeClose).toBe('done');await runtime.completion;expect(vi.getTimerCount()).toBe(0);
    });
    it('a real Manager close exception remains a bounded failure fact', async () => {
        const manager = new DesktopManager(), actualBeginShutdown = manager.beginShutdown.bind(manager);vi.spyOn(manager, 'beginShutdown').mockImplementation(() => { throw Error('private manager failure'); });
        const { kernel } = setup(manager), report = await kernel.beginShutdown().completion;
        expect(report).toMatchObject({ state: 'settled', hasFailures: true, resourcesReleased: false });
        expect(report.failures.flatMap(row => row.codes)).toContain('MANAGER_CLEANUP_FAILED');
        expect(report.failures).toContainEqual(expect.objectContaining({ stage: 'manager', codes: ['MANAGER_CLEANUP_FAILED'] }));
        expect(JSON.stringify(report)).not.toContain('private manager failure');
        vi.mocked(manager.beginShutdown).mockRestore();
        expect(await actualBeginShutdown().completion).toMatchObject({ workers: { ownership: 'owned', report: { state: 'closed', total: 0 } } });
    });
});
