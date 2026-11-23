import { expect, it, vi } from 'vitest';
import { Kernel } from './index.js';
import { Desktop } from '../engine/core/desktop.js';
import { createRuntime } from '../facades/facades.js';
import { WorkerSandbox } from '../engine/app/worker-sandbox.js';
import { createDesktopId } from '../spi/core/id-factory.js';

it('B2 C02/13 missing Desktop and a closed parent reject explicitly without a TypeError', async () => {
    const runtime = createRuntime();
    expect(runtime.getAppInteraction(createDesktopId('d'), 'a', 'instance')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
    for (const name of ['acquireSnapshot', 'releaseSnapshot', 'execute', 'getSystemToolDefinitions', 'acquireLock', 'releaseLock', 'experimentalCreateAppScope']) {
        expect(runtime).not.toHaveProperty(name);
    }
    try {
        const id = await runtime.createDesktop('d' as any);
        expect(runtime.getAppInteraction(id, 'pending', 'instance')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
        const closing = runtime.beginShutdown();expect(runtime.getAppInteraction(id, 'a', 'instance').status).toBe('rejected');await closing.completion;
    } finally { await runtime.beginShutdown().completion; }
});

it.each(['replace', 'close', 'shutdown', 'getter'] as const)('B2 C13 Kernel keeps the captured Desktop object through trusted %s reentry', async change => {
    const runtime = new Kernel(), id = await runtime.createDesktop(createDesktopId('d'));
    const old = runtime.getDesktop(id), close = vi.fn();
    const desktops = (runtime as unknown as { desktops: Map<string, unknown> }).desktops;
    const delegate = vi.fn(() => {
        if (change === 'replace') desktops.set(id, new Desktop(id));
        if (change === 'close') old.beginClose();
        if (change === 'shutdown') runtime.beginShutdown();
        return { status: 'ready', interaction: { close } };
    });
    if (change === 'getter') Object.defineProperty(old, 'getAppInteraction', { get() { old.beginClose();return delegate; } });
    else old.getAppInteraction = delegate as any;
    try {
        expect(runtime.getAppInteraction(id, 'a', 'instance')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
        expect(delegate).toHaveBeenCalledTimes(change === 'getter' ? 0 : 1);
        expect(close).not.toHaveBeenCalled();
    } finally {
        const replacement = desktops.get(id);
        if (replacement instanceof Desktop && replacement !== old) {
            desktops.set(id, old);
            await replacement.beginClose().completion;
        }
        await runtime.beginShutdown().completion;
    }
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

it('B2 C04/05 Kernel/Desktop reject descriptors before dependency calls or launch config mutation', async () => {
    const runtime = createRuntime(), id = await runtime.createDesktop(createDesktopId('d'));
    const install = vi.spyOn(runtime.getDesktop(id), 'installDynamicWorkerApp').mockResolvedValue('a');
    let getters = 0;
    const invalid = Object.defineProperty({}, 'toolsEnabled', { enumerable: true, get() { getters++;return false; } });
    await expect(runtime.installDynamicWorkerApp(id, '/app', invalid)).rejects.toHaveProperty('code', 'TOOLS_ENABLED_INVALID');expect(install).not.toHaveBeenCalled();expect(getters).toBe(0);
    const input: any = { toolsEnabled: false };await runtime.installDynamicWorkerApp(id, '/app', input);input.toolsEnabled = true;
    expect(install.mock.calls[0][1].toolsEnabled).toBe(false);
    try {
        const id = await runtime.createDesktop('real' as any), desktop = runtime.getDesktop(id);
        const config: any = {};Object.defineProperty(invalid, 'config', { value: config });
        await expect(desktop.installDynamicWorkerApp('/app', invalid)).rejects.toHaveProperty('code', 'TOOLS_ENABLED_INVALID');
        await expect(desktop.registerPendingApp(Object.defineProperties({ installationId: 'pending', localPath: '/app' }, Object.getOwnPropertyDescriptors(invalid)))).rejects.toHaveProperty('code', 'TOOLS_ENABLED_INVALID');
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
