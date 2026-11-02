import { beforeEach, describe, expect, it, vi } from 'vitest';
const controls = vi.hoisted(() => ({ boxes: [] as any[], install: async (_box: any) => {}, clean: async (_box: any) => true, reinitialize: async (_box: any, _reason?: string) => {} }));
vi.mock('./worker-sandbox.js', () => ({ WorkerSandbox: class {
    config: any;appId: string;name: string;onUpdateRequest?: () => void;status = 'created';
    state = 'active';intent: string | null = null;released = false;issues: string[] = [];installing?: Promise<void>;cleaning?: Promise<any>;
    installCalls = 0;cleanCalls = 0;deleteCalls = 0;reinitializeCalls: unknown[] = [];
    constructor(config: any) { this.config = config;this.appId = config.appId;this.name = config.name;controls.boxes.push(this); }
    getCloseReport() { return { state: this.state, intent: this.intent, ok: this.state === 'settled' && this.released && !this.issues.length, resourcesReleased: this.released, issues: [...this.issues] }; }
    installDynamic() { this.installCalls++;return this.installing = controls.install(this).then(() => { if (this.intent) { this.issues.push('INSTALL_FAILED');throw Error('closed while opening'); }this.status = 'running'; }); }
    disposeAsync() { if (this.cleaning) return this.cleaning;this.cleanCalls++;this.intent ??= 'close';this.state = 'closing';
        return this.cleaning = (async () => { const cleaning = controls.clean(this);await this.installing?.catch(() => {});this.released = await cleaning;this.state = 'settled';return this.getCloseReport(); })(); }
    delete() { if (this.intent === 'close') return Promise.reject(Error('LIFECYCLE_CONFLICT'));this.deleteCalls++;this.intent = 'delete';return Promise.resolve(); }
    async reinitialize(reason?: string) { this.reinitializeCalls.push(reason);await controls.reinitialize(this, reason); }
    async pause() { this.status = 'paused'; }async resume() { this.status = 'running'; }
} }));
import { AppManager } from './manager.js';
import { WorkerSandbox } from './worker-sandbox.js';

function barrier() { let resolve!: () => void, reject!: (error: unknown) => void;const promise = new Promise<void>((yes, no) => { resolve = yes;reject = no; });return { promise, resolve, reject }; }
function fixture() { const desktop = { id: 'd', emitSignal: vi.fn(), logSystem: vi.fn(), logAppOperation: vi.fn() };return { manager: new AppManager(desktop as any), desktop }; }
beforeEach(() => { controls.boxes.length = 0;controls.install = async () => {};controls.clean = async () => true;controls.reinitialize = async () => {}; });

describe('AppManager owned lifecycle (controlled C1 Sandbox seam, no OS Workers)', () => {
    it.each(['close','delete','cleanup'] as const)('accepted initialization remains supervised during %s and cannot restore running metadata', async intent => {
        const gate = barrier();controls.install = () => gate.promise;const { manager, desktop } = fixture();
        const installing = manager.install('/pending', { appId: 'app' });
        if (intent === 'delete') void manager.beginClose('delete').completion.catch(() => {});else if (intent === 'cleanup') void manager.cleanupAsync().catch(() => {});else void manager.beginClose().completion.catch(() => {});
        expect(manager.getDynamicAppIds()).toHaveLength(1);expect(manager.getCloseReport().state).toBe('closing');expect(controls.boxes[0].cleanCalls).toBe(1);
        gate.resolve();await expect(installing).rejects.toHaveProperty('code','INSTALL_FAILED');await manager.cleanupAsync();
        expect(manager.getDynamicAppIds()).toEqual([]);expect(manager.getInstalledApps()).toEqual([]);expect(desktop.emitSignal).not.toHaveBeenCalled();
    });
    it('registers Sandbox and metadata before await; duplicate active/pending/closing IDs cannot overwrite', async () => {
        const gate = barrier();controls.install = () => gate.promise;const { manager } = fixture();
        const installing = manager.install('/app', { appId: 'app_0' });expect(manager.getDynamicAppIds()).toEqual(['app_0']);expect(manager.getInstalledApps()[0].status).toBe('pending');
        await expect(manager.install('/other', { appId: 'app_0' })).rejects.toMatchObject({ code: 'APP_ALREADY_EXISTS' });
        expect(() => manager.registerPendingApp({ appId: 'app_0', modulePath: '/x' })).toThrow('APP_ALREADY_EXISTS');
        const operation = manager.beginClose();expect(manager.beginClose()).toBe(operation);expect(controls.boxes[0].cleanCalls).toBe(1);
        await expect(manager.install('/late')).rejects.toMatchObject({ code: 'APP_MANAGER_CLOSED' });gate.resolve();
        await expect(installing).rejects.toMatchObject({ code: 'INSTALL_FAILED' });const report = await operation.completion;
        expect(report).toMatchObject({ state: 'settled', pendingOperations: 0, apps: { accepted: 1, settled: 1 }, hasFailures: true });expect(manager.getDynamicAppIds()).toEqual([]);await manager.cleanupAsync();
    });
    it('enforces 128 accepted installs before any Sandbox side effect and restores capacity when calls end', async () => {
        const gate = barrier();controls.install = () => gate.promise;const { manager } = fixture();
        const calls = Array.from({ length: 128 }, (_, i) => manager.install('/app', { appId: 'x'+i }));expect(controls.boxes).toHaveLength(128);
        await expect(manager.install('/overflow', { appId: 'overflow' })).rejects.toMatchObject({ code: 'LIFECYCLE_CAPACITY_EXCEEDED' });expect(controls.boxes).toHaveLength(128);
        gate.resolve();await Promise.all(calls);await manager.install('/later', { appId: 'later' });expect(controls.boxes).toHaveLength(129);expect(manager.getCloseReport().pendingOperations).toBe(0);
        await manager.cleanupAsync();
    });
    it('shares pending open/reinitialize operations without consuming a second slot; automatic IDs avoid explicit IDs', async () => {
        const { manager } = fixture();manager.registerPendingApp({ appId: 'app_0', modulePath: '/explicit' });
        expect(manager.registerPendingApp({ modulePath: '/auto' })).toBe('app_1');const gate = barrier();controls.install = () => gate.promise;
        const first = manager.startPendingApp('app_0'), second = manager.startPendingApp('app_0');expect(first).toBe(second);expect(manager.getCloseReport().pendingOperations).toBe(1);
        gate.resolve();await first;const reset = barrier();controls.reinitialize = () => reset.promise;
        const a = manager.reinitializeApp('app_0', { reason: 'r' }), b = manager.reinitializeApp('app_0', { reason: 'r' });expect(a).toBe(b);expect(manager.getCloseReport().pendingOperations).toBe(1);
        reset.resolve();await a;expect(controls.boxes[0].reinitializeCalls).toEqual(['r']);await manager.cleanupAsync();
    });
    it('all cleanups start before waiting on one hung install or resource; metadata is preserved until cleanupAsync', async () => {
        const gate = barrier();const { manager } = fixture();await manager.install('/a', { appId: 'a' });await manager.install('/b', { appId: 'b' });
        controls.clean = async box => { if (box.appId === 'a') await gate.promise;return true; };
        const close = manager.beginClose();expect(manager.beginClose()).toBe(close);expect(controls.boxes.map(box => box.cleanCalls)).toEqual([1,1]);
        await Promise.resolve();expect(manager.getCloseReport().state).toBe('closing');expect(manager.getInstalledApps().every(app => app.status === 'running')).toBe(true);
        expect(() => manager.beginClose('delete')).toThrow(/LIFECYCLE_CONFLICT/);gate.resolve();await close.completion;
        expect(manager.getInstalledApps().every(app => app.status === 'running')).toBe(true);expect(manager.getDynamicAppIds()).toEqual([]);await manager.cleanupAsync();expect(manager.getInstalledApps()).toEqual([]);
    });
    it('cleanup never drops an unconfirmed owner and metadata/query snapshots cannot mutate ownership', async () => {
        const { manager } = fixture();await manager.install('/a', { appId: 'a' });
        const record = manager.getInstalledApps()[0];record.appId = 'wrong';record.status = 'closed';record.modulePath = '/wrong';
        const state = manager.getAppStates()[0];state.status = 'closed';expect(manager.getDynamicAppIds()).toEqual(['a']);expect(manager.getInstalledApps()[0]).toMatchObject({ appId: 'a', status: 'running', modulePath: '/a' });
        controls.clean = async () => false;const report = await manager.cleanupAsync();expect(report.resourcesReleased).toBe(false);expect(report.apps.notVerifiedReleased).toBe(1);
        expect(manager.getDynamicAppIds()).toEqual(['a']);expect(manager.getInstalledApps()).toHaveLength(1);
    });
    it('failure-sample limits never remove the forty actual controlled Sandbox owners or truncate identity keys', async()=>{
        const {manager}=fixture(),ids=Array.from({length:40},(_,i)=>'🙂'.repeat(100)+i);
        for(const id of ids)await manager.install('/app',{appId:id});
        controls.clean=async box=>{box.issues.push('APP_CLOSE_FAILED');return false;};
        const report=await manager.cleanupAsync();expect(report).toMatchObject({state:'settled',hasFailures:true,resourcesReleased:false,samplesTruncated:true,failureCount:40,apps:{accepted:40,settled:40,notVerifiedReleased:40}});
        expect(report.failures).toHaveLength(16);expect(report.failures.every(sample=>Buffer.byteLength(sample.appId!,'utf8')<=256)).toBe(true);expect(Buffer.byteLength(JSON.stringify(report),'utf8')).toBeLessThanOrEqual(65536);
        expect(manager.getDynamicAppIds()).toEqual(ids);expect(manager.getInstalledApps()).toHaveLength(40);
    });
    it('reinitialize failure only cleans its captured Sandbox, never a same-ID successor', async () => {
        const { manager } = fixture();await manager.install('/old', { appId: 'same' });const old = controls.boxes[0], reset = barrier();controls.reinitialize = () => reset.promise;
        const reinitializing = manager.reinitializeApp('same');const next = new WorkerSandbox({ appId: 'same', desktopId: 'd', appModulePath: '/new' });
        (manager as any).workers.set('same', next);(manager as any).installedApps.set('same', { appId: 'same', status: 'running', modulePath: '/new', installedAt: 0 });
        reset.reject(Error('private'));await expect(reinitializing).rejects.toMatchObject({ code: 'APP_CLOSE_FAILED' });
        expect(old.cleanCalls).toBe(1);expect((next as any).cleanCalls).toBe(0);expect(manager.getWorkerSandbox('same')).toBe(next);expect(manager.getInstalledApps()[0].status).toBe('running');await manager.cleanupAsync();
    });
    it('reinitializeAll starts independent entries and never restarts a failed one', async () => {
        const { manager } = fixture();for (const id of ['bad','good']) await manager.install('/'+id, { appId: id });
        manager.registerPendingApp({ appId: 'pending', modulePath: '/pending' });controls.reinitialize = async box => { if (box.appId === 'bad') throw Error('bad'); };
        const result = await manager.reinitializeAll({ reason: 'reset' });expect(result).toEqual({ reinitializedAppIds: ['good'], failedAppIds: ['bad'], skippedAppIds: ['pending'] });
        expect(controls.boxes.map(box => box.appId)).toEqual(['bad','good','good']);expect(manager.getInstalledApps().find(app => app.appId === 'bad')?.status).toBe('closed');await manager.cleanupAsync();
    });
    it('bulk close interrupted reinitialize preserves logical reopen metadata until serialization cleanup', async () => {
        const { manager } = fixture();await manager.install('/old',{appId:'app'});const reset = barrier();controls.reinitialize = () => reset.promise;
        const reinitializing = manager.reinitializeApp('app'), closing = manager.beginClose();reset.resolve();
        await expect(reinitializing).rejects.toHaveProperty('code','APP_CLOSE_FAILED');await closing.completion;
        expect(manager.getInstalledApps()[0].status).toBe('running');expect(controls.boxes).toHaveLength(1);await manager.cleanupAsync();
    });
    it('one throwing cleanup cannot prevent other current children from starting or erase its owner', async () => {
        const { manager } = fixture();for (const id of ['throw','held','done']) await manager.install('/'+id,{appId:id});const gate = barrier();
        controls.clean = async box => { if(box.appId==='throw'){box.state='settled';box.issues.push('RESOURCE_RELEASE_FAILED');throw Error('private');}if(box.appId==='held')await gate.promise;return true; };
        const closing = manager.beginClose();expect(controls.boxes.map(box=>box.cleanCalls)).toEqual([1,1,1]);await Promise.resolve();expect(closing.inspect().state).toBe('closing');
        gate.resolve();const report=await closing.completion;expect(report.hasFailures).toBe(true);expect(report.resourcesReleased).toBe(false);expect(manager.isWorkerMode('throw')).toBe(true);expect(manager.getDynamicAppIds()).toEqual(['throw']);await manager.cleanupAsync();
    });
    it('delete first starts delete and actual cleanup once; ID counter does not wrap or reset', async () => {
        const { manager } = fixture();await manager.install('/a', { appId: 'a' });const deleted = manager.beginClose('delete');expect(manager.beginClose('delete')).toBe(deleted);expect(controls.boxes[0].deleteCalls).toBe(1);await deleted.completion;await manager.cleanupAsync();
        const other = fixture().manager;(other as any).appIdCounter = Number.MAX_SAFE_INTEGER;
        expect(other.registerPendingApp({ modulePath: '/last' })).toBe('app_'+Number.MAX_SAFE_INTEGER);
        expect(() => other.registerPendingApp({ modulePath: '/overflow' })).toThrow('LIFECYCLE_CAPACITY_EXCEEDED');await other.cleanupAsync();expect((other as any).idsExhausted).toBe(true);
    });
});
