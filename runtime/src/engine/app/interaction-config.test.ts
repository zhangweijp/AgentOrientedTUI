import { expect, it } from 'vitest';
import { captureToolsEnabled } from './interaction-config.js';
import { AppWorkerHost } from './worker-host.js';
import { WorkerSandbox } from './worker-sandbox.js';
import { AppManager } from './manager.js';
import { Desktop } from '../core/desktop.js';

const hostConfig = { appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused' };

it('captures explicit booleans and leaves the omitted default to the WorkerHost', () => {
    expect(captureToolsEnabled()).toBeUndefined();
    expect(captureToolsEnabled({})).toBeUndefined();
    expect(captureToolsEnabled({ toolsEnabled: undefined })).toBeUndefined();
    expect(captureToolsEnabled({ toolsEnabled: true })).toBe(true);
    expect(captureToolsEnabled({ toolsEnabled: false })).toBe(false);
});

it('rejects invalid Tool setting descriptors before allocation without running getters', async () => {
    let getters = 0;
    const badOptions = [null, 1, 'false', [], {}].map(toolsEnabled => ({ toolsEnabled }));
    badOptions.push(
        Object.defineProperty({}, 'toolsEnabled', { enumerable: true, get() { getters++; return false; } }),
        Object.defineProperty({}, 'toolsEnabled', { value: false }), Object.create({ toolsEnabled: false }));
    const manager = new AppManager({ id: 'd', logSystem() {} } as any);
    for (const input of badOptions) {
        const merge = (base: object) => Object.defineProperties(Object.setPrototypeOf(base, Object.getPrototypeOf(input)), Object.getOwnPropertyDescriptors(input));
        for (const run of [() => captureToolsEnabled(input), () => new WorkerSandbox(merge({ ...hostConfig }) as any),
            () => new AppWorkerHost(merge({ ...hostConfig }) as any), () => manager.registerPendingApp(merge({ modulePath: '/unused' }) as any)]) {
            expect(run).toThrow(expect.objectContaining({ code: 'TOOLS_ENABLED_INVALID' }));
        }
    }
    expect(getters).toBe(0);
    expect(manager.getInstalledApps()).toEqual([]);
    expect(manager.registerPendingApp({ modulePath: '/unused' })).toBe('app_0');
    await manager.cleanupAsync();
});

it('rejects unknown Host options before allocating a Worker or pending App', async () => {
    const desktop = new Desktop('d');
    let reads = 0;
    const unknown = Object.defineProperty({ toolsEnabled: false }, 'interactionModes', {
        enumerable: true, get() { reads++; return []; },
    });
    await expect(desktop.installDynamicWorkerApp('/unused', unknown)).rejects.toMatchObject({
        code: 'CONFIG_INVALID', context: { path: 'options.interactionModes' },
    });
    await expect(desktop.registerPendingApp({ modulePath: '/unused', extra: true } as never)).rejects.toMatchObject({
        code: 'CONFIG_INVALID', context: { path: 'options.extra' },
    });
    await expect(desktop.installDynamicWorkerApp('/unused', [] as never)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(reads).toBe(0);
    expect(desktop.getInstalledApps()).toEqual([]);
    expect(await desktop.registerPendingApp({ modulePath: '/unused', toolsEnabled: false })).toBe('app_0');
    await desktop.dispose();
});
