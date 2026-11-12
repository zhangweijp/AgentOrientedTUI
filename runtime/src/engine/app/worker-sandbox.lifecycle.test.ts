import { beforeEach, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
    log: [] as string[], fail: '',
    start: undefined as Promise<void> | undefined,
    open: undefined as Promise<void> | undefined,
    close: undefined as Promise<void> | undefined,
}));

vi.mock('./worker-host.js', () => ({ AppWorkerHost: class {
    onUpdateRequest?: () => void;
    state = 'ready';
    readonly appInstanceId = 'instance';
    constructor() { control.log.push('host-create');if (control.fail === 'constructor') throw Error('private constructor'); }
    async start() { control.log.push('start');await control.start;if (control.fail === 'start') throw Error('private start'); }
    async open() { control.log.push('open');await control.open;if (control.fail === 'open') throw Error('private open');this.state = 'running'; }
    async close(intent: 'close' | 'delete') {
        control.log.push(intent);
        await Promise.allSettled([control.start, control.open, control.close]);
        this.state = 'closed';
        if (control.fail === 'close') throw Error('private close');
        if (control.fail === 'delete') throw Object.assign(Error('private delete'), { code: 'APP_DELETE_FAILED' });
    }
    async waitForResourceRelease() { return this.getResourceReport(); }
    getResourceReport() {
        const closed = this.state === 'closed', unsafe = control.fail === 'storage';
        return Object.freeze({
            worker: closed ? 'exited' : 'owned', resourcesReleased: closed,
            storage: { support: unsafe ? 'managed' : 'rejected', unsafe, ...(unsafe ? { lifecycle: { ok: true } } : {}) },
            issues: control.fail === 'host-issue' ? ['WORKER_TERMINATION_FAILED'] : [],
        });
    }
    getStatus() { return this.state; }
    getAppInteraction() { control.log.push('scope');return { status: 'rejected', issue: { code: 'APP_INTERACTION_UNAVAILABLE' } }; }
    pushLLMOutput() { control.log.push('push'); }
} }));

import { WorkerSandbox } from './worker-sandbox.js';

const defer = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};
const sandbox = () => new WorkerSandbox({ appId: 'a', desktopId: 'd', appModulePath: '/unused' });

beforeEach(() => { control.log = [];control.fail = '';control.start = control.open = control.close = undefined; });

it('close before an accepted install starts prevents construction', async () => {
    const before = sandbox();
    await before.close();
    await expect(before.installDynamic()).rejects.toMatchObject({ code: 'SANDBOX_CLOSED' });
    const s = sandbox();
    const installing = s.installDynamic();
    expect(s.installDynamic()).toBe(installing);
    const closing = s.close();
    await expect(installing).rejects.toMatchObject({ code: 'INSTALL_FAILED' });
    await expect(closing).rejects.toMatchObject({ code: 'SANDBOX_CLOSE_FAILED' });
    expect(await s.disposeAsync()).toMatchObject({ state: 'settled', resourcesReleased: true, issues: ['INSTALL_FAILED'] });
    expect(control.log).toEqual([]);
});

it.each(['start', 'open'] as const)('closing during %s joins the same cleanup and cannot publish running', async stage => {
    const gate = defer();control[stage] = gate.promise;
    const s = sandbox(), installing = s.installDynamic();
    await vi.waitFor(() => expect(control.log).toContain(stage));
    const closing = s.close(), report = s.disposeAsync();
    expect(s.close()).toBe(closing);
    expect(s.disposeAsync()).toBe(report);
    expect(control.log).toContain('close');
    expect(s.getCloseReport().state).toBe('closing');
    gate.resolve();
    await expect(installing).rejects.toMatchObject({ code: 'INSTALL_FAILED' });
    await expect(closing).rejects.toMatchObject({ code: 'SANDBOX_CLOSE_FAILED' });
    expect((await report).resourcesReleased).toBe(true);
    expect(s.status).toBe('closed');
    expect(control.log.filter(event => event === 'close')).toHaveLength(1);
    if (stage === 'start') expect(control.log).not.toContain('open');
});

it('keeps the first close intent and stops new App events and scopes synchronously', async () => {
    const s = sandbox();await s.installDynamic();
    const gate = defer();control.close = gate.promise;
    const closing = s.close();
    await expect(s.delete()).rejects.toMatchObject({ code: 'LIFECYCLE_CONFLICT' });
    for (const action of [() => s.pause(), () => s.resume(), () => s.reinitialize(), () => s.sendExternalEvent('v', 'e', {})])
        await expect(action()).rejects.toMatchObject({ code: 'SANDBOX_CLOSED' });
    s.pushLLMOutput({}, 'complete');
    expect(s.getAppInteraction('instance')).toMatchObject({ status: 'rejected', issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
    expect(control.log).not.toContain('push');
    expect(control.log).not.toContain('scope');
    gate.resolve();
    await closing;
    expect(control.log).not.toContain('delete');
    expect(s.getCloseReport()).toMatchObject({ intent: 'close', ok: true, resourcesReleased: true });
});

it('delegates interaction to the exact running App instance', async () => {
    const s = sandbox();await s.installDynamic();
    expect(s.getAppInteraction('wrong')).toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });
    expect(control.log).not.toContain('scope');
    expect(s.getAppInteraction('instance')).toMatchObject({ status: 'rejected', issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
    expect(control.log).toContain('scope');
    expect(s).not.toHaveProperty('experimentalCreateAppScope');
    expect(s).not.toHaveProperty('dismountView');
    expect(s).not.toHaveProperty('mountViewByLink');
    await s.close();
});

it.each(['constructor', 'start', 'open', 'close', 'delete', 'host-issue', 'storage'])('preserves %s failure after resource release', async stage => {
    const s = sandbox();control.fail = stage;
    if (['constructor', 'start', 'open'].includes(stage)) await expect(s.installDynamic()).rejects.toHaveProperty('code', 'INSTALL_FAILED');
    else await s.installDynamic();
    const closing = stage === 'delete' ? s.delete() : s.close();
    await expect(closing).rejects.toMatchObject({ code: 'SANDBOX_CLOSE_FAILED' });
    const report = await s.disposeAsync();
    expect(report).toMatchObject({ state: 'settled', ok: false, resourcesReleased: true });
    expect(Object.isFrozen(report)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private');
    if (stage === 'host-issue') expect(report.issues).toContain('RESOURCE_RELEASE_FAILED');
    if (stage === 'storage') expect(report.host?.storage.unsafe).toBe(true);
    if (stage === 'delete') expect(report.issues).toContain('DELETE_FAILED');
});

it('shares one delete and gives disposeAsync the same final facts', async () => {
    const s = sandbox();await s.installDynamic();
    const deleting = s.delete();
    expect(s.delete()).toBe(deleting);
    await deleting;
    expect(await s.disposeAsync()).toMatchObject({ intent: 'delete', ok: true, resourcesReleased: true });
    expect(control.log.filter(event => event === 'delete')).toHaveLength(1);
    expect(control.log).not.toContain('close');
});
