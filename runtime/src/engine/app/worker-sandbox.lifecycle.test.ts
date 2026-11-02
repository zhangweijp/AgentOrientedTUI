import { beforeEach, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({ log: [] as string[], hosts: [] as any[], pools: [] as any[], fail: '' as string,
    acquire: undefined as undefined | Promise<void>, start: undefined as undefined | Promise<void>, open: undefined as undefined | Promise<void>, close: undefined as undefined | Promise<void> }));
vi.mock('./worker-pool.js', () => ({ WorkerPool: class {
    state = 'open';active = 0;destroyPromise?: Promise<any>;finish?: () => void;releases: boolean[] = [];
    constructor(readonly config: any) { control.pools.push(this); }
    acquireLease() {
        control.log.push('acquire');this.active++;const worker = {};let result: Promise<any> | undefined;
        const lease = Object.freeze({ worker, release: (healthy: boolean) => {
            if (result) return result;control.log.push('lease-release');this.releases.push(healthy);this.active--;if (!this.active && this.state === 'closing') { this.state = 'closed';this.finish?.(); }
            result = Promise.resolve(Object.freeze({ disposition: healthy && this.state === 'open' ? 'pooled' : 'exited', ...(control.fail === 'lease-issue' ? { issue: 'WORKER_TERMINATION_FAILED' } : {}) }));return result;
        } });
        return Promise.resolve(control.acquire).then(() => lease);
    }
    getReport() { return Object.freeze({ state: this.state, total: this.active, leased: this.active, idle: 0, retiring: 0, reserved: 0, limit: 10, issues: control.fail === 'pool-issue' ? ['WORKER_ERROR'] : [] }); }
    destroy() {
        if (this.destroyPromise) return this.destroyPromise;control.log.push('pool-destroy');this.state = 'closing';
        if (!this.active) { this.state = 'closed';return this.destroyPromise = Promise.resolve(this.getReport()); }
        return this.destroyPromise = new Promise<void>(resolve => { this.finish = resolve; }).then(() => this.getReport());
    }
} }));
vi.mock('./worker-host.js', () => ({ AppWorkerHost: class {
    onUpdateRequest?: () => void;state = 'ready';released = false;
    interactionsClosed = false;
    beginInteractionClose() { this.interactionsClosed = true; }
    beginApplicationStop() { control.log.push('app-stop'); }
    constructor(readonly config: any) { control.log.push('host-create');if (control.fail === 'constructor') throw Error('private constructor');control.hosts.push(this); }
    async start() { control.log.push('start');await control.start;if (control.fail === 'start') throw Error('private start'); }
    async open() { control.log.push('open');await control.open;if (control.fail === 'open') throw Error('private open');this.state = 'running'; }
    async close() { control.log.push('close');await control.close;this.state = 'closed';if (control.fail === 'close') throw Error('private close'); }
    async delete() { control.log.push('delete');if (control.fail === 'delete') throw Error('private delete'); }
    async releaseWorker(retireLease?: () => Promise<unknown>) {
        control.log.push('reset');
        if (control.fail === 'unpoolable') { await retireLease?.();control.log.push('host-exit');this.released = true;return null; }
        if (control.fail === 'reset') { await retireLease?.();this.released = true;return null; }
        if (control.fail === 'terminate') return null;
        this.released = true;return this.config.existingWorker;
    }
    terminate() { control.log.push('terminate');if (control.fail === 'terminate') throw Error('private terminate');this.released = true; }
    waitForResourceRelease() { control.log.push('resources');return Promise.resolve(this.getResourceReport()); }
    getResourceReport() { return Object.freeze({ state: this.released ? 'settled' : 'active', worker: this.released ? control.fail === 'unpoolable' ? 'exited' : 'transferred' : 'owned',
        interactions: { closed: this.interactionsClosed, retainedScopes: 0, retainedBytes: 0 },
        storage: { support: control.fail === 'unpoolable' ? 'managed' : 'rejected', pending: 0, opening: false,
            unsafe: control.fail === 'unpoolable', ...(control.fail === 'unpoolable' ? { lifecycle: { ok: true } } : {}), release: { status: 'released' } }, resourcesReleased: this.released,
        issues: control.fail === 'host-issue' ? ['WORKER_TERMINATION_FAILED'] : control.fail === 'reset' ? ['RESET_FAILED'] : [] }); }
    getStatus() { return this.state; }
    async pause() { control.log.push('pause'); }
    async resume() { control.log.push('resume'); }
    async reinitialize() { control.log.push('reinitialize'); }
    async sendExternalEvent() { control.log.push('event'); }
    createInteractionScope() { control.log.push('scope');return { status: 'rejected', issue: { code: 'SCOPE_UNAVAILABLE', message: 'App scope is unavailable' } }; }
    pushLLMOutput() { control.log.push('push'); }
} }));
import { WorkerSandbox } from './worker-sandbox.js';
import { WorkerPool } from './worker-pool.js';
const defer = () => { let resolve!: () => void;const promise = new Promise<void>(yes => { resolve = yes; });return { promise, resolve }; };
const sandbox = (extra = {}) => new WorkerSandbox({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused', ...extra });
const until = async (event: string) => { for (let i = 0; i < 20 && !control.log.includes(event); i++) await Promise.resolve();expect(control.log).toContain(event); };
beforeEach(() => { control.log = [];control.hosts = [];control.pools = [];control.fail = '';control.acquire = control.start = control.open = control.close = undefined; });
it('C1-13 close before install and await acquire never reopens or loses the granted lease', async () => {
    const before = sandbox();await before.close();await expect(before.installDynamic()).rejects.toMatchObject({ code: 'SANDBOX_CLOSED' });expect(control.hosts).toHaveLength(0);
    const gate = defer();control.acquire = gate.promise;const s = sandbox();const install = s.installDynamic();expect(s.installDynamic()).toBe(install);await until('acquire');
    const close = s.close();const report = s.disposeAsync();gate.resolve();await expect(install).rejects.toMatchObject({ code: 'INSTALL_FAILED' });
    await expect(close).rejects.toMatchObject({ code: 'SANDBOX_CLOSE_FAILED' });expect(await report).toMatchObject({ state: 'settled', resourcesReleased: true, issues: ['INSTALL_FAILED'] });
    expect(control.hosts).toHaveLength(0);expect(control.pools.at(-1).releases).toEqual([false]);expect(s.status).toBe('closed');
});
it.each(['start', 'open'] as const)('C1-13 close while awaiting %s shares cleanup and cannot publish running', async stage => {
    const gate = defer();control[stage] = gate.promise;const s = sandbox();const install = s.installDynamic();await until(stage);
    const close = s.close();expect(s.close()).toBe(close);const report = s.disposeAsync();expect(s.disposeAsync()).toBe(report);
    expect(control.log).toContain('app-stop');expect(control.log).not.toContain('close');
    gate.resolve();await expect(install).rejects.toMatchObject({ code: 'INSTALL_FAILED' });await expect(close).rejects.toHaveProperty('code', 'SANDBOX_CLOSE_FAILED');
    expect((await report).resourcesReleased).toBe(true);expect(s.status).toBe('closed');expect(control.log.filter(e => e === 'close')).toHaveLength(1);expect(control.log.filter(e => e === 'reset')).toHaveLength(1);
    if (stage === 'start') expect(control.log).not.toContain('open');
});
it('C1-14 close/delete first intent wins; event pushes stop synchronously and obsolete View routes are absent', async () => {
    const s = sandbox();await s.installDynamic();const gate = defer();control.close = gate.promise;const closing = s.close();
    await expect(s.delete()).rejects.toMatchObject({ code: 'LIFECYCLE_CONFLICT' });
    const count = control.log.length;
    for (const action of [() => s.pause(), () => s.resume(), () => s.reinitialize(), () => s.sendExternalEvent('v' as any, 'e', {})])
        await expect(action()).rejects.toMatchObject({ code: 'SANDBOX_CLOSED' });
    expect(s).not.toHaveProperty('experimentalCreateAppScope');
    expect(s).not.toHaveProperty('dismountView');
    expect(s).not.toHaveProperty('mountViewByLink');
    s.pushLLMOutput({}, 'complete');expect(control.log).toHaveLength(count);gate.resolve();await closing;
    expect(control.log).not.toContain('delete');expect(s.getCloseReport()).toMatchObject({ intent: 'close', ok: true, resourcesReleased: true });
});
it('exposes only the formal App scope entry and delegates to the active Host', async () => {
    const s = sandbox();await s.installDynamic();
    expect(s.createAppScope({} as any)).toMatchObject({ status: 'rejected', issue: { code: 'SCOPE_UNAVAILABLE' } });
    expect(control.log).toContain('scope');
    expect(s).not.toHaveProperty('experimentalCreateAppScope');
    await s.close();
});
it.each(['constructor', 'start', 'open', 'close', 'delete', 'reset', 'terminate'])('C1-15 %s failure retains facts and independently cleans lease/owned pool', async stage => {
    const s = sandbox();control.fail = stage;
    if (['constructor', 'start', 'open'].includes(stage)) await expect(s.installDynamic()).rejects.toHaveProperty('code', 'INSTALL_FAILED');else await s.installDynamic();
    const voidResult = stage === 'delete' ? s.delete() : s.close();const reportPromise = s.disposeAsync();await expect(voidResult).rejects.toMatchObject({ code: 'SANDBOX_CLOSE_FAILED' });
    const report = await reportPromise;expect(report).toMatchObject({ state: 'settled', ok: false, resourcesReleased: stage !== 'terminate', ownedPool: { state: 'closed' } });expect(Object.isFrozen(report)).toBe(true);expect(JSON.stringify(report)).not.toContain('private');
    expect(control.pools[0].releases).toEqual([false]);expect(control.log).toContain('pool-destroy');expect(control.log).toContain('lease-release');
    if (stage === 'reset') expect(report.issues).toContain('RESET_FAILED');
    if (stage === 'delete') expect(control.log.indexOf('close')).toBeGreaterThan(control.log.indexOf('delete'));
});
it('C1-14/15 delete duplicates once and disposeAsync reports that same intent; injected pool remains owned by its parent', async () => {
    const parent = new WorkerPool({ initialSize: 0 }), s = sandbox({ workerPool: parent });await s.installDynamic();const a = s.delete(), b = s.delete();expect(b).toBe(a);
    await a;const report = await s.disposeAsync();expect(report).toMatchObject({ intent: 'delete', ok: true, lease: { disposition: 'pooled' } });expect(report.ownedPool).toBeUndefined();
    expect(control.log.filter(e => e === 'delete')).toHaveLength(1);expect(control.log).not.toContain('pool-destroy');await parent.destroy();
});
it.each(['lease-issue', 'pool-issue', 'host-issue'])('C1-19 %s is retained after actual release and cannot become top-level success', async source => {
    const s = sandbox();await s.installDynamic();control.fail = source;const report = await s.disposeAsync();
    expect(report).toMatchObject({ state: 'settled', resourcesReleased: true, ok: false, issues: ['RESOURCE_RELEASE_FAILED'] });
    await expect(s.close()).rejects.toHaveProperty('code', 'SANDBOX_CLOSE_FAILED');
});
it('does not label an expected nonpoolable Host exit as a reset or resource failure', async () => {
    const s = sandbox();await s.installDynamic();control.fail = 'unpoolable';
    const report = await s.disposeAsync();
    expect(report).toMatchObject({ state: 'settled', ok: false, resourcesReleased: true, issues: [],
        host: { worker: 'exited', issues: [], storage: { unsafe: true } }, lease: { disposition: 'exited' } });
    expect(control.log.indexOf('lease-release')).toBeLessThan(control.log.indexOf('host-exit'));
});
