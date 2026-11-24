import { expect, it } from 'vitest';
import { createRuntime } from '../facades/facades.js';
import { createDesktopId } from '../spi/core/id-factory.js';

it('B2 C02/13 missing Desktop and a closed parent reject explicitly without a TypeError', async () => {
    const runtime = createRuntime();
    expect(() => runtime.getDesktop(createDesktopId('d'))).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
    for (const name of ['acquireSnapshot', 'releaseSnapshot', 'execute', 'getSystemToolDefinitions', 'acquireLock', 'releaseLock', 'experimentalCreateAppScope', 'shutdown', 'destroyDesktop', 'deleteDesktop', 'beginDesktopShutdown', 'reinitializeDesktopApps']) {
        expect(runtime).not.toHaveProperty(name);
    }
    try {
        const desktop = await runtime.createDesktop('d' as any);
        expect(desktop.getRunningApp('pending', 'instance')).toMatchObject({ issue: { code: 'APP_INTERACTION_UNAVAILABLE' } });
        const closing = runtime.beginClose();expect(desktop.getRunningApp('a', 'instance').status).toBe('rejected');await closing.completion;
    } finally { await runtime.beginClose().completion; }
});

it('rejects malformed Desktop installation options before accessing their values', async () => {
    const runtime = createRuntime();
    const desktop = await runtime.createDesktop(createDesktopId('real'));
    const config = {};
    let getters = 0;
    const invalid = { config, get toolsEnabled() { getters++; return false; } };
    try {
        await expect(desktop.installDynamicWorkerApp('/app', invalid)).rejects.toHaveProperty('code', 'TOOLS_ENABLED_INVALID');
        await expect(desktop.registerPendingApp(Object.defineProperties({ installationId: 'pending', localPath: '/app' },
            Object.getOwnPropertyDescriptors(invalid)))).rejects.toHaveProperty('code', 'TOOLS_ENABLED_INVALID');
        expect(config).toEqual({});
        expect(getters).toBe(0);
        expect(desktop.listApps()).toEqual([]);
    } finally { await runtime.beginClose().completion; }
});
