import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { captureProjectionLimits, captureToolsEnabled } from './interaction-config.js';
import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { AppWorkerHost } from './worker-host.js';
import { AppManager } from './manager.js';
import { Desktop } from '../core/desktop.js';

const localPath = fileURLToPath(new URL('../../../test/fixtures/pending-app/', import.meta.url));

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
        for (const run of [() => captureToolsEnabled(input),
            () => new AppWorkerHost(merge({ ...hostConfig }) as any), () => manager.registerPendingApp(merge({ modulePath: '/unused' }) as any)]) {
            expect(run).toThrow(expect.objectContaining({ code: 'TOOLS_ENABLED_INVALID' }));
        }
    }
    expect(getters).toBe(0);
    expect(manager.listApps()).toEqual([]);
    expect(manager.registerPendingApp({ modulePath: '/unused', name: 'unused' })).toBe('app_0');
    manager.clearInactiveInstallations();
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
    await expect(desktop.registerPendingApp({ installationId: 'pending', localPath, extra: true } as never)).rejects.toMatchObject({
        code: 'CONFIG_INVALID', context: { path: 'options.extra' },
    });
    await expect(desktop.installDynamicWorkerApp('/unused', [] as never)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(reads).toBe(0);
    expect(desktop.listApps()).toEqual([]);
    expect(await desktop.registerPendingApp({ installationId: 'pending', localPath, toolsEnabled: false })).toBe('pending');
    await desktop.beginClose().completion;
});

it('copies just the trusted projection limits and forwards the same frozen effective value', () => {
    const overrides = { maxViews: 2, metadata: { maxNodes: 30 }, observation: { maxApproxBytes: 4096 } };
    const limits = captureProjectionLimits({ projectionLimits: overrides });
    overrides.maxViews = 3;
    overrides.metadata.maxNodes = 40;
    overrides.observation.maxApproxBytes = 8192;
    expect(limits).toEqual({ ...DEFAULT_PROJECTION_LIMITS, maxViews: 2,
        metadata: { ...DEFAULT_PROJECTION_LIMITS.metadata, maxNodes: 30 },
        observation: { ...DEFAULT_PROJECTION_LIMITS.observation, maxApproxBytes: 4096 },
    });
    expect([limits, limits.observation, limits.metadata].every(Object.isFrozen)).toBe(true);
    expect(captureProjectionLimits({ projectionLimits: limits })).toBe(limits);
    expect(captureProjectionLimits()).toBe(DEFAULT_PROJECTION_LIMITS);
});

it('rejects out-of-range, unknown and accessor limits before an instance is reserved', async () => {
    const desktop = new Desktop('d');
    let reads = 0;
    const accessor = Object.defineProperty({}, 'maxDepth', { enumerable: true, get() { reads++; return 1; } });
    for (const [projectionLimits, field] of [
        [{ maxViews: DEFAULT_PROJECTION_LIMITS.maxViews + 1 }, 'maxViews'],
        [{ maxRefs: 0 }, 'maxRefs'],
        [{ maxTools: 1.5 }, 'maxTools'],
        [{ maxTotalBytes: 8 }, 'maxTotalBytes'],
        [{ observation: [] }, 'observation'],
        [{ metadata: accessor }, 'metadata.maxDepth'],
    ] as const) {
        const error = { code: 'CONFIG_INVALID', context: { path: `options.projectionLimits.${field}` } };
        await expect(desktop.installDynamicWorkerApp('/unused', { projectionLimits } as never)).rejects.toMatchObject(error);
    }
    await expect(desktop.registerPendingApp({ installationId: 'pending', localPath, projectionLimits: { maxViews: 0 } }))
        .rejects.toMatchObject({ code: 'CONFIG_INVALID', context: { path: 'options.projectionLimits.maxViews' } });
    expect(reads).toBe(0);
    expect(desktop.listApps()).toEqual([]);
    expect(await desktop.registerPendingApp({ installationId: 'pending', localPath })).toBe('pending');
    await desktop.beginClose().completion;
});
