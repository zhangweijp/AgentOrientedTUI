import { beforeEach, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({ boxes: [] as any[], create: (_box: any) => {}, reinitialize: (_box: any) => {} }));
vi.mock('./worker-sandbox.js', () => ({ WorkerSandbox: class {
    status = 'created';closedClients = 0;closed = false;appInstanceId: string | undefined;onUpdateRequest?: () => void;
    constructor(readonly config: any) { this.appInstanceId = `instance-${control.boxes.length + 1}`;control.boxes.push(this); }
    async installDynamic() { this.status = 'running'; }
    getCloseReport() { return { state: this.closed ? 'settled' : 'active', intent: 'close', resourcesReleased: this.closed, issues: [] }; }
    async disposeAsync() { this.closed = true;this.status = 'closed';return this.getCloseReport(); }
    createAppScope() { control.create(this);return { status: 'opened', client: { close: () => { this.closedClients++; } } }; }
    async pause() { this.status = 'paused'; }async resume() { this.status = 'running'; }
    async reinitialize() { control.reinitialize(this); }
} }));
import { AppManager } from './manager.js';
import { WorkerSandbox } from './worker-sandbox.js';
const desktop = { id: 'd', logSystem() {}, logAppOperation() {}, emitSignal() {} } as any;
beforeEach(() => { control.boxes = [];control.create = () => {};control.reinitialize = () => {}; });

it('binds Semantic lifecycle controls to the observed Worker instance before accepting side effects', async () => {
    const manager = new AppManager(desktop), id = await manager.install('/app'), first = control.boxes[0];
    const firstInstance = manager.getInstalledApps()[0].appInstanceId;
    expect(firstInstance).toBe(first.appInstanceId);
    expect((manager as any).installedApps.get(id)).not.toHaveProperty('appInstanceId');
    await manager.closeApp(id, firstInstance);
    await manager.openApp(id);
    const successor = control.boxes[1], successorInstance = manager.getInstalledApps()[0].appInstanceId;
    expect(successorInstance).toBe(successor.appInstanceId);
    expect(successorInstance).not.toBe(firstInstance);

    await expect(manager.closeApp(id, firstInstance)).rejects.toMatchObject({ code: 'APP_INSTANCE_CHANGED' });
    await expect(manager.collapseApp(id, firstInstance)).rejects.toMatchObject({ code: 'APP_INSTANCE_CHANGED' });
    await expect(manager.showApp(id, firstInstance)).rejects.toMatchObject({ code: 'APP_INSTANCE_CHANGED' });
    expect(successor.closed).toBe(false);
    expect(successor.status).toBe('running');

    await manager.collapseApp(id, successorInstance);
    expect(manager.getInstalledApps()[0].status).toBe('collapsed');
    await manager.showApp(id, successorInstance);
    expect(manager.getInstalledApps()[0].status).toBe('running');
    await manager.closeApp(id, successorInstance);
    expect(successor.closed).toBe(true);
    await manager.cleanupAsync();
});

it.each(['missing-worker', 'missing-identity'] as const)('rejects an expected instance when its %s is absent', async missing => {
    const manager = new AppManager(desktop), id = await manager.install('/app'), worker = control.boxes[0];
    const expected = worker.appInstanceId as string;
    if (missing === 'missing-worker') (manager as any).workers.delete(id);
    else worker.appInstanceId = undefined;

    await expect(manager.closeApp(id, expected)).rejects.toMatchObject({ code: 'APP_INSTANCE_CHANGED' });
    await expect(manager.collapseApp(id, expected)).rejects.toMatchObject({ code: 'APP_INSTANCE_CHANGED' });
    await expect(manager.showApp(id, expected)).rejects.toMatchObject({ code: 'APP_INSTANCE_CHANGED' });
    expect(worker.closed).toBe(false);
    expect(manager.getInstalledApps()[0].status).toBe('running');
    expect(worker.status).toBe('running');
    await manager.cleanupAsync();
});

it('keeps an accepted close attached to its captured Worker while cleanup is pending', async () => {
    const manager = new AppManager(desktop), id = await manager.install('/app'), first = control.boxes[0];
    const expected = first.appInstanceId as string;
    let release!: () => void;const gate = new Promise<void>(resolve => { release = resolve; });
    const dispose = first.disposeAsync.bind(first);
    first.disposeAsync = async () => { await gate;return dispose(); };
    const closing = manager.closeApp(id, expected);
    const successor = new WorkerSandbox({ appId: id, desktopId: 'd', appModulePath: '/next' } as any) as any;
    successor.status = 'running';(manager as any).workers.set(id, successor);
    release();await closing;
    expect(first.closed).toBe(true);
    expect(successor.closed).toBe(false);
    expect(successor.status).toBe('running');
    expect((manager as any).workers.get(id)).toBe(successor);
    await manager.cleanupAsync();
});

it('C05 trusted V2 modes survive pending/open/reopen/reinitialize with independent metadata', async () => {
    const manager = new AppManager(desktop), values: any[] = ['snapshot-value-v2', 'ordinary-v2'];
    const id = manager.registerPendingApp({ modulePath: '/app', interactionModes: values });values.length = 0;
    expect(manager.createAppScope(id, {} as any)).toMatchObject({ issue: { code: 'SCOPE_UNAVAILABLE' } });expect(control.boxes).toHaveLength(0);
    const copy = manager.getInstalledApps()[0];expect(copy.interactionModes).toEqual(['ordinary-v2', 'snapshot-value-v2']);
    expect(Object.isFrozen(copy.interactionModes)).toBe(true);expect(() => (copy.interactionModes as any).push('ordinary-v2')).toThrow();
    (copy as any).interactionModes = [];await manager.openApp(id);expect(control.boxes[0].config.interactionModes).toEqual(['ordinary-v2', 'snapshot-value-v2']);
    const original = control.boxes[0];await manager.closeApp(id);await manager.openApp(id);await manager.reinitializeApp(id);
    expect(control.boxes).toHaveLength(3);expect(control.boxes.every(box => JSON.stringify(box.config.interactionModes) === '["ordinary-v2","snapshot-value-v2"]')).toBe(true);
    expect(control.boxes[2]).not.toBe(original);expect(manager.getAppStates()[0]).not.toHaveProperty('interactionModes');
    await manager.cleanupAsync();
});

it('B2 C11 collapsed is presentation while pending/paused/closed/current closing stop scope creation', async () => {
    const manager = new AppManager(desktop), id = await manager.install('/app', { interactionModes: ['ordinary-v2'] });
    expect(manager.createAppScope(id, {} as any).status).toBe('opened');await manager.collapseApp(id);
    expect(manager.createAppScope(id, {} as any).status).toBe('opened');await manager.pauseAll();
    expect(manager.createAppScope(id, {} as any).status).toBe('rejected');await manager.resumeAll();
    expect(manager.createAppScope(id, {} as any).status).toBe('opened');const closing = manager.closeApp(id);
    expect(manager.createAppScope(id, {} as any).status).toBe('rejected');await closing;
    expect(manager.createAppScope(id, {} as any).status).toBe('rejected');await manager.cleanupAsync();
});

it.each(['meta', 'worker', 'close'] as const)('B2 C13 App factory revokes a returned client after trusted DI reentry: %s', async change => {
    const manager = new AppManager(desktop), id = await manager.install('/app'), captured = control.boxes[0];
    let close: Promise<unknown> | undefined;
    control.create = () => {
        if (change === 'meta') (manager as any).installedApps.set(id, { ...manager.getInstalledApps()[0] });
        if (change === 'worker') (manager as any).workers.set(id, { status: 'running' });
        if (change === 'close') close = manager.closeApp(id);
    };
    expect(manager.createAppScope(id, {} as any)).toMatchObject({ status: 'rejected', issue: { code: 'SCOPE_UNAVAILABLE' } });expect(captured.closedClients).toBe(1);
    (manager as any).workers.set(id, captured);await close;await manager.cleanupAsync();
});

it('C05 immediate install capture precedes async startup, ID allocation and mutation', async () => {
    const manager = new AppManager(desktop), input: any = { interactionModes: ['ordinary-v2'] };
    const installing = manager.install('/app', input);input.interactionModes.push('snapshot-value-v2');input.interactionModes = [];
    const id = await installing;expect(control.boxes[0].config.interactionModes).toEqual(['ordinary-v2']);
    await expect(manager.install('/bad', { interactionModes: ['bad'] as any })).rejects.toHaveProperty('code', 'INTERACTION_MODES_INVALID');
    expect(control.boxes).toHaveLength(1);expect(manager.registerPendingApp({ modulePath: '/next' })).toBe('app_1');
    expect(manager.getInstalledApps().find(app => app.appId === id)?.interactionModes).toEqual(['ordinary-v2']);await manager.cleanupAsync();
});
