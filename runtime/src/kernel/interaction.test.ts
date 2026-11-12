import { expect, it, vi } from 'vitest';
import { Kernel } from './index.js';
import { Desktop } from '../engine/core/desktop.js';
import { createRuntime } from '../facades/facades.js';
import { WorkerSandbox } from '../engine/app/worker-sandbox.js';
import { createCloseHandle, freezeClose, newCloseState, snapshotClose } from '../engine/core/close-handle.js';

function kernelFixture() {
    let current: any = { id: 'd', isClosing: false, getAppInteraction: () => ({ status: 'rejected', issue: { code: 'APP_INTERACTION_UNAVAILABLE', message: 'App scope is unavailable' } }) };
    const runtimeState = newCloseState('runtime');runtimeState.state = 'settled';
    const runtimeReport = () => freezeClose({ ...snapshotClose(runtimeState), scope: 'runtime' as const, intent: 'close' as const });
    const manager: any = { get: () => current, listDesktopIds: () => [], destroy: vi.fn(async () => {}),
        beginDesktopShutdown: vi.fn(() => { throw new Error('unexpected desktop close'); }),
        beginShutdown: vi.fn(() => createCloseHandle(runtimeReport, Promise.resolve(runtimeReport()))) };
    const kernel = new Kernel(manager);
    return { kernel, manager, get: () => current, set: (next: any) => { current = next; } };
}

it('B2 C02/13 missing Desktop/old DI and a closed parent reject explicitly without a TypeError', async () => {
    const f = kernelFixture();expect(f.kernel.getAppInteraction('d' as any, 'a', 'instance')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
    for (const name of ['acquireSnapshot', 'releaseSnapshot', 'execute', 'getSystemToolDefinitions', 'acquireLock', 'releaseLock', 'experimentalCreateAppScope']) {
        expect(f.kernel).not.toHaveProperty(name);
    }
    f.set(undefined);expect(f.kernel.getAppInteraction('d' as any, 'a', 'instance').status).toBe('rejected');
    const runtime = createRuntime();
    try {
        const id = await runtime.createDesktop('d' as any);
        expect(runtime.getAppInteraction(id, 'pending', 'instance')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
        const closing = runtime.beginShutdown();expect(runtime.getAppInteraction(id, 'a', 'instance').status).toBe('rejected');await closing.completion;
    } finally { await runtime.beginShutdown().completion; }
});

it.each(['replace', 'close', 'shutdown', 'getter'] as const)('B2 C13 Kernel keeps the captured Desktop object through trusted %s reentry', async change => {
    const f = kernelFixture(), old = f.get(), close = vi.fn();let calls = 0;
    const delegate = () => { calls++;if (change === 'replace') f.set({ ...old });if (change === 'close') old.isClosing = true;if (change === 'shutdown') f.kernel.beginShutdown();return { status: 'ready', interaction: { close } }; };
    if (change === 'getter') Object.defineProperty(old, 'getAppInteraction', { get() { old.isClosing = true;return delegate; } });
    else old.getAppInteraction = delegate;
    expect(f.kernel.getAppInteraction('d' as any, 'a', 'instance')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
    expect(calls).toBe(change === 'getter' ? 0 : 1);expect(close).not.toHaveBeenCalled();
});

it.each(['replace', 'close'] as const)('B2 C13 Desktop keeps the captured AppManager through trusted %s reentry', async change => {
    const runtime = createRuntime();
    let desktop: Desktop | undefined, original: any, originalDraining: boolean | undefined;
    try {
        const id = await runtime.createDesktop('d' as any); desktop = runtime.getDesktop(id) as Desktop;
        original = (desktop as any).appManager; originalDraining = (desktop as any)._isDraining;
        const close = vi.fn();
        const manager = { getAppInteraction: () => { if (change === 'replace') (desktop as any).appManager = original;else (desktop as any)._isDraining = true;return { status: 'ready', interaction: { close } }; } };
        (desktop as any).appManager = manager;expect(desktop.getAppInteraction('a', 'instance').status).toBe('rejected');expect(close).not.toHaveBeenCalled();
    } finally {
        if (desktop) { (desktop as any).appManager = original; (desktop as any)._isDraining = originalDraining; }
        await runtime.beginShutdown().completion;
    }
});

it('B2 C04/05 Kernel/Desktop reject descriptors before dependency calls or environment config mutation', async () => {
    const f = kernelFixture(), install = vi.fn(async () => 'a');f.get().installDynamicWorkerApp = install;let getters = 0;
    const invalid = Object.defineProperty({}, 'interactionModes', { enumerable: true, get() { getters++;return []; } });
    await expect(f.kernel.installDynamicWorkerApp('d' as any, '/app', invalid)).rejects.toHaveProperty('code', 'INTERACTION_MODES_INVALID');expect(install).not.toHaveBeenCalled();expect(getters).toBe(0);
    const input: any = { interactionModes: ['view-type-parameters-v1'] };await f.kernel.installDynamicWorkerApp('d' as any, '/app', input);input.interactionModes.push('view-type-parameters-v1');
    expect(install.mock.calls[0][1].interactionModes).toEqual(['view-type-parameters-v1']);
    const runtime = createRuntime();
    try {
        const id = await runtime.createDesktop('real' as any, { env: { X: 'injected' } }), desktop = runtime.getDesktop(id);
        const config: any = {};Object.defineProperty(invalid, 'config', { value: config });
        await expect(desktop.installDynamicWorkerApp('/app', invalid)).rejects.toHaveProperty('code', 'INTERACTION_MODES_INVALID');
        await expect(desktop.registerPendingApp(Object.defineProperties({ modulePath: '/app' }, Object.getOwnPropertyDescriptors(invalid)))).rejects.toHaveProperty('code', 'INTERACTION_MODES_INVALID');
        expect(config).toEqual({});expect(getters).toBe(0);
    } finally { await runtime.beginShutdown().completion; }
});

it('B2 C13 Sandbox rejects the captured result when its Host object is replaced during delegation', async () => {
    const box = new WorkerSandbox({ appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused' }), close = vi.fn();
    const old = { appInstanceId: 'instance', getStatus: () => 'running', getAppInteraction: () => { (box as any).workerHost = { getStatus: () => 'running' };return { status: 'ready', interaction: { close } }; } };
    (box as any)._status = 'running';(box as any).workerHost = old;
    expect(box.getAppInteraction('instance')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });expect(close).not.toHaveBeenCalled();
    (box as any).workerHost = null;await box.disposeAsync();
});
