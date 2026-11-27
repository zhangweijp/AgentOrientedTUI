import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { describe, it, expect, vi } from 'vitest';
import { AppKernel } from './AppKernel.js';
import type { AppContext, RuntimeContext } from '@aotui/core';

describe('AppKernel initialization', () => {
        const mockContext = { appId: 'test_app', desktopId: 'test-desktop' } as AppContext;
        it('should pass launchConfig through runtime context during initialization', async () => {
            const initialize = vi.fn((context: RuntimeContext) => { context.defineViewTypes([]); context.publishFrame(() => ({ views: [] })); });
            const appKernelWithLaunchConfig = new AppKernel({
                ...mockContext, instanceId: 'kernel-test', projectionLimits: DEFAULT_PROJECTION_LIMITS,

                factory: {
                    initialize,
                },
                launchConfig: { foo: 'bar' },
            });

            await appKernelWithLaunchConfig.onOpen();

            expect(initialize).toHaveBeenCalledWith(
                expect.objectContaining({
                    launchConfig: { foo: 'bar' },
                })
            );
        });
        it.each([undefined, {}])('distinguishes omitted and explicit empty configuration: %j', async config => {
            const initialize = vi.fn((context: RuntimeContext) => {
                expect(Object.hasOwn(context, 'launchConfig')).toBe(config !== undefined);
                expect(context.launchConfig).toEqual(config);
                if (config !== undefined) expect(Object.isFrozen(context.launchConfig)).toBe(true);
                context.defineViewTypes([]); context.publishFrame(() => ({ views: [] }));
            });
            const kernel = new AppKernel({ ...mockContext, instanceId: 'configuration',
                projectionLimits: DEFAULT_PROJECTION_LIMITS, factory: { initialize },
                ...(config === undefined ? {} : { launchConfig: config }),
            });
            try { await kernel.onOpen(); expect(initialize).toHaveBeenCalledTimes(1); }
            finally { await kernel.onClose(); }
        });
        it('captures an independent deeply frozen config before entering a direct factory', async () => {
            const input = { nested: { list: ['original'] } };
            const initialize = vi.fn((context: RuntimeContext) => {
                expect(context.launchConfig).not.toBe(input);
                const nested = context.launchConfig?.nested as typeof input.nested;
                expect(nested).not.toBe(input.nested);
                expect(Object.isFrozen(context.launchConfig)).toBe(true);
                expect(Object.isFrozen(nested)).toBe(true);
                expect(Object.isFrozen(nested.list)).toBe(true);
                input.nested.list[0] = 'later';
                expect(nested.list).toEqual(['original']);
                context.defineViewTypes([]); context.publishFrame(() => ({ views: [] }));
            });
            const kernel = new AppKernel({ ...mockContext, instanceId: 'configuration',
                projectionLimits: DEFAULT_PROJECTION_LIMITS, factory: { initialize }, launchConfig: input });
            try { await kernel.onOpen(); expect(initialize).toHaveBeenCalledTimes(1); }
            finally { await kernel.onClose(); }
        });
        it('rejects a nested accessor before any direct factory code runs', async () => {
            const getter = vi.fn(() => 'unsafe');
            const initialize = vi.fn(() => undefined);
            const kernel = new AppKernel({ ...mockContext, instanceId: 'configuration',
                projectionLimits: DEFAULT_PROJECTION_LIMITS, factory: { initialize },
                launchConfig: { nested: Object.defineProperty({}, 'field', { enumerable: true, get: getter }) },
            });
            try {
                await expect(kernel.onOpen()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
                expect(initialize).not.toHaveBeenCalled();
                expect(getter).not.toHaveBeenCalled();
            } finally { await kernel.onClose(); }
        });
    });
