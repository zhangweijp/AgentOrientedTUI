import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { appInstallFields, captureInstallationOptions } from './interaction-config.js';
import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { Desktop } from '../core/desktop.js';

const localPath = fileURLToPath(new URL('../../../test/fixtures/pending-app/', import.meta.url));


it('captures Tool availability, including the default', () => {
    for (const value of [undefined, true, false]) {
        expect(captureInstallationOptions({ toolsEnabled: value }, appInstallFields).toolsEnabled).toBe(value !== false);
    }
});

it('rejects invalid Tool setting descriptors at both installation entries without running getters', async () => {
    const desktop = new Desktop('d');
    let getters = 0;
    const badOptions = [null, 1, 'false', [], {}].map(toolsEnabled => ({ toolsEnabled }));
    badOptions.push(
        Object.defineProperty({}, 'toolsEnabled', { enumerable: true, get() { getters++; return false; } }),
        Object.defineProperty({}, 'toolsEnabled', { value: false }),
        Object.create({ toolsEnabled: false }));
    for (const option of badOptions) {
        const options = Object.create(Object.getPrototypeOf(option), {
            ...Object.getOwnPropertyDescriptors(option),
            installationId: { value: 'pending', enumerable: true },
        });
        const pending = Object.create(Object.getPrototypeOf(options), {
            ...Object.getOwnPropertyDescriptors(options), localPath: { value: localPath, enumerable: true },
        });
        const code = Object.getPrototypeOf(option) === Object.prototype ? 'TOOLS_ENABLED_INVALID' : 'CONFIG_INVALID';
        await expect(desktop.installDynamicWorkerApp('/unused', options)).rejects.toHaveProperty('code', code);
        await expect(desktop.registerPendingApp(pending)).rejects.toHaveProperty('code', code);
    }
    expect(getters).toBe(0);
    expect(desktop.listApps()).toEqual([]);
    await desktop.beginClose().completion;
});

it.each([
    ['toolsEnabled', false, { code: 'TOOLS_ENABLED_INVALID' }],
    ['projectionLimits', { maxViews: 1 }, { code: 'CONFIG_INVALID', context: { path: 'options.projectionLimits' } }],
] as const)('rejects inherited %s at both public installation entries without reading the getter', async (key, value, issue) => {
    const desktop = new Desktop('d');
    const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
    let reads = 0;
    let attempts;
    try {
        Object.defineProperty(Object.prototype, key, { configurable: true, get() { reads++; return value; } });
        attempts = Promise.allSettled([
            desktop.installDynamicWorkerApp('/unused', { name: 'direct' }),
            desktop.registerPendingApp({ installationId: 'pending', localPath }),
        ]);
    } finally {
        if (original) Object.defineProperty(Object.prototype, key, original);
        else Reflect.deleteProperty(Object.prototype, key);
    }
    try {
        for (const result of await attempts) expect(result).toMatchObject({ status: 'rejected', reason: issue });
        expect(reads).toBe(0);
        expect(desktop.listApps()).toEqual([]);
    } finally {
        await desktop.beginClose().completion;
    }
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

it('captures immutable effective projection limits', () => {
    const overrides = { maxViews: 2, metadata: { maxNodes: 30 }, observation: { maxApproxBytes: 4096 } };
    const limits = captureInstallationOptions({ projectionLimits: overrides }, appInstallFields).projectionLimits;
    overrides.maxViews = 3;
    overrides.metadata.maxNodes = 40;
    overrides.observation.maxApproxBytes = 8192;
    expect(limits).toEqual({ ...DEFAULT_PROJECTION_LIMITS, maxViews: 2,
        metadata: { ...DEFAULT_PROJECTION_LIMITS.metadata, maxNodes: 30 },
        observation: { ...DEFAULT_PROJECTION_LIMITS.observation, maxApproxBytes: 4096 },
    });
    expect([limits, limits.observation, limits.metadata].every(Object.isFrozen)).toBe(true);
    expect(captureInstallationOptions({}, appInstallFields).projectionLimits).toBe(DEFAULT_PROJECTION_LIMITS);
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
