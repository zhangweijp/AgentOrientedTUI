import { beforeEach, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({ boxes: [] as any[], create: (_box: any) => {}, reinitialize: (_box: any) => {} }));
vi.mock('./worker-sandbox.js', () => ({ WorkerSandbox: class {
    status = 'created';disposed = false;closedClients = 0;closed = false;onUpdateRequest?: () => void;
    constructor(readonly config: any) { control.boxes.push(this); }
    async installDynamic() { this.status = 'running'; }
    getCloseReport() { return { state: this.closed ? 'settled' : 'active', intent: 'close', resourcesReleased: this.closed, issues: [] }; }
    async disposeAsync() { this.closed = true;this.status = 'closed';return this.getCloseReport(); }
    experimentalCreateAppScope() { control.create(this);return { status: 'opened', client: { close: () => { this.closedClients++; } } }; }
    async pause() { this.status = 'paused'; }async resume() { this.status = 'running'; }
    async reinitialize() { control.reinitialize(this); }
} }));
import { AppManager } from './manager.js';
const desktop = { id: 'd', logSystem() {}, logAppOperation() {}, emitSignal() {} } as any;
beforeEach(() => { control.boxes = [];control.create = () => {};control.reinitialize = () => {}; });

it('B2 C05–07 trusted modes survive pending/open/reopen/reinitialize with independent metadata and no allocation by the factory', async () => {
    const manager = new AppManager(desktop), values: any[] = ['ordinary-v2', 'ordinary-v1'];
    const id = manager.registerPendingApp({ modulePath: '/app', experimentalInteractionModes: values });values.length = 0;
    expect(manager.experimentalCreateAppScope(id, {} as any)).toMatchObject({ issue: { code: 'SCOPE_UNAVAILABLE' } });expect(control.boxes).toHaveLength(0);
    const copy = manager.getInstalledApps()[0];expect(copy.experimentalInteractionModes).toEqual(['ordinary-v1', 'ordinary-v2']);
    expect(Object.isFrozen(copy.experimentalInteractionModes)).toBe(true);expect(() => (copy.experimentalInteractionModes as any).push('snapshot-value-v1')).toThrow();
    (copy as any).experimentalInteractionModes = [];await manager.openApp(id);expect(control.boxes[0].config.experimentalInteractionModes).toEqual(['ordinary-v1', 'ordinary-v2']);
    const original = control.boxes[0];await manager.closeApp(id);await manager.openApp(id);await manager.reinitializeApp(id);
    expect(control.boxes).toHaveLength(3);expect(control.boxes.every(box => JSON.stringify(box.config.experimentalInteractionModes) === '["ordinary-v1","ordinary-v2"]')).toBe(true);
    expect(control.boxes[2]).not.toBe(original);expect(manager.getAppStates()[0]).not.toHaveProperty('experimentalInteractionModes');
    await manager.cleanupAsync();
});

it('B2 C11 collapsed is presentation while pending/paused/closed/current closing stop scope creation', async () => {
    const manager = new AppManager(desktop), id = await manager.install('/app', { experimentalInteractionModes: ['ordinary-v1'] });
    expect(manager.experimentalCreateAppScope(id, {} as any).status).toBe('opened');await manager.collapseApp(id);
    expect(manager.experimentalCreateAppScope(id, {} as any).status).toBe('opened');await manager.pauseAll();
    expect(manager.experimentalCreateAppScope(id, {} as any).status).toBe('rejected');await manager.resumeAll();
    expect(manager.experimentalCreateAppScope(id, {} as any).status).toBe('opened');const closing = manager.closeApp(id);
    expect(manager.experimentalCreateAppScope(id, {} as any).status).toBe('rejected');await closing;
    expect(manager.experimentalCreateAppScope(id, {} as any).status).toBe('rejected');await manager.cleanupAsync();
});

it.each(['meta', 'worker', 'close'] as const)('B2 C13 App factory revokes a returned client after trusted DI reentry: %s', async change => {
    const manager = new AppManager(desktop), id = await manager.install('/app'), captured = control.boxes[0];
    let close: Promise<unknown> | undefined;
    control.create = () => {
        if (change === 'meta') (manager as any).installedApps.set(id, { ...manager.getInstalledApps()[0] });
        if (change === 'worker') (manager as any).workers.set(id, { status: 'running', disposed: false });
        if (change === 'close') close = manager.closeApp(id);
    };
    expect(manager.experimentalCreateAppScope(id, {} as any)).toMatchObject({ status: 'rejected', issue: { code: 'SCOPE_UNAVAILABLE' } });expect(captured.closedClients).toBe(1);
    (manager as any).workers.set(id, captured);await close;await manager.cleanupAsync();
});

it('B2 C04/05 immediate install capture precedes async startup, ID allocation and mutation', async () => {
    const manager = new AppManager(desktop), input: any = { experimentalInteractionModes: ['ordinary-v1'] };
    const installing = manager.install('/app', input);input.experimentalInteractionModes.push('snapshot-value-v1');input.experimentalInteractionModes = [];
    const id = await installing;expect(control.boxes[0].config.experimentalInteractionModes).toEqual(['ordinary-v1']);
    await expect(manager.install('/bad', { experimentalInteractionModes: ['bad'] as any })).rejects.toHaveProperty('code', 'INTERACTION_MODES_INVALID');
    expect(control.boxes).toHaveLength(1);expect(manager.registerPendingApp({ modulePath: '/next' })).toBe('app_1');
    expect(manager.getInstalledApps().find(app => app.appId === id)?.experimentalInteractionModes).toEqual(['ordinary-v1']);await manager.cleanupAsync();
});
