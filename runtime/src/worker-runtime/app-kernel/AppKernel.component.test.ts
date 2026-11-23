import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core/internal';
import { describe, it, expect, vi } from 'vitest';
import { AppKernel } from './AppKernel.js';
import type { AppContext } from '@aotui/core';

describe('AppKernel initialization', () => {
        const mockContext = { appId: 'test-app', desktopId: 'test-desktop' } as AppContext;
        it('should invoke onReinitialize hook with reason', async () => {
            const onReinitialize = vi.fn().mockResolvedValue(undefined);
            const appKernelWithHook = new AppKernel({
                ...mockContext, instanceId: 'kernel-test', projectionLimits: DEFAULT_PROJECTION_LIMITS,
                appName: 'test_app',
                factory: {
                    initialize: vi.fn().mockResolvedValue({ close() {} }),
                },
                onReinitialize,
            });

            await appKernelWithHook.onOpen();
            await appKernelWithHook.onReinitialize('context_compaction');

            expect(onReinitialize).toHaveBeenCalledWith({
                ...mockContext,
                reason: 'context_compaction',
            });
            await appKernelWithHook.onReinitialize();
            expect(onReinitialize).toHaveBeenLastCalledWith({ ...mockContext, reason: undefined });
        });

        it('should pass launchConfig through runtime context during initialization', async () => {
            const initialize = vi.fn().mockResolvedValue({ close() {} });
            const appKernelWithLaunchConfig = new AppKernel({
                ...mockContext, instanceId: 'kernel-test', projectionLimits: DEFAULT_PROJECTION_LIMITS,
                appName: 'test_app',
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
    });
