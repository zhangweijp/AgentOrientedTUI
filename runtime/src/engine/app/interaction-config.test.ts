import { expect, it } from 'vitest';
import { captureToolsEnabled } from './interaction-config.js';
import { AppWorkerHost } from './worker-host.js';
import { WorkerSandbox } from './worker-sandbox.js';
import { AppManager } from './manager.js';

const hostConfig = { appId: 'a' as any, desktopId: 'd' as any, appModulePath: '/unused' };

it('captures explicit booleans and leaves the omitted default to the WorkerHost', () => {
    expect(captureToolsEnabled()).toBeUndefined();
    expect(captureToolsEnabled({})).toBeUndefined();
    expect(captureToolsEnabled({ toolsEnabled: undefined })).toBeUndefined();
    expect(captureToolsEnabled({ toolsEnabled: true })).toBe(true);
    expect(captureToolsEnabled({ toolsEnabled: false })).toBe(false);
});

it('rejects retired keys and invalid descriptors before allocation without running getters', async () => {
    let getters = 0;
    const badOptions = [null, 1, 'false', [], {}].map(toolsEnabled => ({ toolsEnabled }));
    badOptions.push({ interactionModes: [] } as any, { interactionModes: undefined, toolsEnabled: true } as any,
        Object.defineProperty({}, 'toolsEnabled', { enumerable: true, get() { getters++; return false; } }),
        Object.defineProperty({}, 'toolsEnabled', { value: false }), Object.create({ toolsEnabled: false }),
        Object.defineProperty({}, 'interactionModes', { get() { getters++; return []; } }), Object.create({ interactionModes: [] }));
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
