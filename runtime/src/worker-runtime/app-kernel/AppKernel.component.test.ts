import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { describe, it, expect, vi } from 'vitest';
import { AppKernel } from './AppKernel.js';
import type { AppContext } from '@aotui/core';

describe('AppKernel initialization', () => {
        const mockContext = { appId: 'test-app', desktopId: 'test-desktop' } as AppContext;
        it('should pass launchConfig through runtime context during initialization', async () => {
            const initialize = vi.fn().mockResolvedValue({ close() {} });
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
    });
