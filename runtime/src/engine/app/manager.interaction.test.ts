import { beforeEach, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({ boxes: [] as any[] }));
vi.mock('./managed-app.js', () => ({ ManagedApp: class {
    status = 'created';closed = false;appInstanceId: string | undefined;onUpdate?: () => void;
    constructor(readonly config: any, readonly onClosing = () => {}, readonly onReleased = () => {}) { this.appInstanceId = `instance-${control.boxes.length + 1}`;control.boxes.push(this); }
    async start() { this.status = 'running'; }
    isClosing = false; closing?: { completion: Promise<unknown> };
    beginClose() {
        if (this.closing) return this.closing;
        this.isClosing = true; this.onClosing();
        return this.closing = { completion: Promise.resolve().then(() => { this.closed = true; this.status = 'closed'; this.onReleased(); }) };
    }
    getAppInteraction() { return { status: 'ready', interaction: {} }; }
    readonly windowActions = this;
    getWindows() { return { appId: this.config.appId, instanceId: this.appInstanceId, views: [] }; }
} }));
import { AppManager } from './manager.js';
import { ManagedApp } from './managed-app.js';
const closeAll = (manager: AppManager) => Promise.all(manager.stopAdmission().apps.map(app => app.beginClose().completion));
const desktop = { id: 'd', logSystem() {}, emitSignal() {} } as any;
beforeEach(() => { control.boxes = []; });

it('binds Semantic lifecycle controls to the observed Worker instance before accepting side effects', async () => {
    const manager = new AppManager(desktop), id = (await manager.install('/app', { name: 'app', installationId: 'installation' })).appId, first = control.boxes[0];
    const firstInstance = manager.listApps()[0].appInstanceId;
    expect(firstInstance).toBe(first.appInstanceId);
    expect((manager as any).installedApps.get('installation')).not.toHaveProperty('appInstanceId');
    await first.beginClose().completion;
    await manager.openApp('installation');
    const successor = control.boxes[1], successorInstance = manager.listApps()[0].appInstanceId;
    expect(successorInstance).toBe(successor.appInstanceId);
    expect(successorInstance).not.toBe(firstInstance);

    await first.beginClose().completion;
    const oldMount = { appId: id, instanceId: firstInstance!, viewId: 'view', viewInstanceId: 'mount' };
    await expect(manager.closeView(oldMount)).rejects.toMatchObject({ code: 'APP_INSTANCE_CHANGED' });
    expect(manager.getAppWindows(id, firstInstance!)).toBeUndefined();
    expect(successor.closed).toBe(false);
    expect(successor.status).toBe('running');

    expect(manager.getAppWindows(id, successorInstance!)).toEqual({ appId: id, instanceId: successorInstance, views: [] });
    expect(manager.listApps()[0].status).toBe('running');
    await successor.beginClose().completion;
    expect(successor.closed).toBe(true);
    await closeAll(manager);
});

it.each(['missing-worker', 'missing-identity'] as const)('rejects an expected instance when its %s is absent', async missing => {
    const manager = new AppManager(desktop), id = (await manager.install('/app', { name: 'app', installationId: 'installation' })).appId, worker = control.boxes[0];
    const expected = worker.appInstanceId as string;
    if (missing === 'missing-worker') (manager as any).workers.delete(id);
    else worker.appInstanceId = undefined;

    await expect(manager.closeView({ appId: id, instanceId: expected, viewId: 'view', viewInstanceId: 'mount' }))
        .rejects.toMatchObject({ code: 'APP_INSTANCE_CHANGED' });
    expect(manager.getAppWindows(id, expected)).toBeUndefined();
    expect(worker.closed).toBe(false);
    expect(manager.listApps()[0].status).toBe('running');
    expect(worker.status).toBe('running');
    await closeAll(manager);
});

it('keeps an accepted close attached to its captured Worker while cleanup is pending', async () => {
    const manager = new AppManager(desktop), id = (await manager.install('/app', { name: 'app', installationId: 'installation' })).appId, first = control.boxes[0];
        const closing = first.beginClose().completion;
    const successor = new ManagedApp({ appId: id, desktopId: 'd', appModulePath: '/next' } as any) as any;
    successor.status = 'running';(manager as any).workers.set(id, successor);
    await closing;
    expect(first.closed).toBe(true);
    expect(successor.closed).toBe(false);
    expect(successor.status).toBe('running');
    expect((manager as any).workers.get(id)).toBe(successor);
    await closeAll(manager);
});

it('preserves trusted Tool disablement across pending, open and reopen', async () => {
    const manager = new AppManager(desktop), options = { modulePath: '/app', name: 'app', toolsEnabled: false };
    const installationId = manager.registerPendingApp(options);options.toolsEnabled = true;
    expect(manager.getAppInteraction('app', manager.listApps()[0]?.appInstanceId ?? 'missing')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });expect(control.boxes).toHaveLength(0);
    expect(manager.listApps()[0]).not.toHaveProperty('toolsEnabled');
    const id = (await manager.openApp(installationId)).appId;expect(control.boxes[0].config.toolsEnabled).toBe(false);
    const original = control.boxes[0];await original.beginClose().completion;await manager.openApp(installationId);
    expect(control.boxes).toHaveLength(2);expect(control.boxes.every(box => box.config.toolsEnabled === false)).toBe(true);
    expect(control.boxes[1]).not.toBe(original);expect(manager.listApps()[0]).not.toHaveProperty('toolsEnabled');
    await closeAll(manager);
});

it('B2 C11 current closing and closed instances stop scope creation', async () => {
    const manager = new AppManager(desktop), id = (await manager.install('/app', { name: 'app', installationId: 'installation' })).appId;
    expect(manager.getAppInteraction(id, manager.listApps()[0]?.appInstanceId ?? 'missing').status).toBe('ready');const closing = control.boxes[0].beginClose().completion;
    expect(manager.getAppInteraction(id, manager.listApps()[0]?.appInstanceId ?? 'missing').status).toBe('rejected');await closing;
    expect(manager.getAppInteraction(id, manager.listApps()[0]?.appInstanceId ?? 'missing').status).toBe('rejected');await closeAll(manager);
});

it('C05 immediate install capture precedes async startup, ID allocation and mutation', async () => {
    const manager = new AppManager(desktop), input: any = { name: 'app', toolsEnabled: false };
    const installing = manager.install('/app', input);input.toolsEnabled = true;
    await installing;expect(control.boxes[0].config.toolsEnabled).toBe(false);
    await expect(manager.install('/bad', { toolsEnabled: 'bad' as any })).rejects.toHaveProperty('code', 'TOOLS_ENABLED_INVALID');
    expect(control.boxes).toHaveLength(1);expect(manager.registerPendingApp({ modulePath: '/next', name: 'next' })).toBe('app_1');
    await closeAll(manager);
});
