import { describe, it, expect, vi } from 'vitest';
import { AppKernel } from './AppKernel.js';
import type { AppContext } from '../../spi/index.js';

describe('AppKernel initialization', () => {
        const mockContext = { appId: 'test-app', desktopId: 'test-desktop' } as AppContext;
        it('should invoke onReinitialize hook with reason', async () => {
            const onReinitialize = vi.fn().mockResolvedValue(undefined);
            const appKernelWithHook = new AppKernel({
                appName: 'test_component_app',
                name: 'test-component-app',
                factory: {
                    initialize: vi.fn().mockResolvedValue({ close() {} }),
                },
                onReinitialize,
                launchConfig: {
                    __aotuiLifecycle: {
                        startupKind: 'reinitialize',
                        reason: 'context_compaction',
                    },
                },
            });
            appKernelWithHook.setId(mockContext.appId);

            await appKernelWithHook.onOpen(mockContext);
            await appKernelWithHook.onReinitialize({
                ...mockContext,
                reason: 'context_compaction',
            });

            expect(onReinitialize).toHaveBeenCalledWith({
                ...mockContext,
                reason: 'context_compaction',
            });
        });

        it('should require explicit appName instead of deriving from display name', () => {
            expect(() =>
                new AppKernel({
                    name: 'Test Component App',
                    factory: {
                        initialize: vi.fn().mockResolvedValue({ close() {} }),
                    },
                } as any)
            ).toThrow(/appName/);
        });

        it('rejects legacy root-mode configs and requires a factory initialize function', () => {
            expect(() =>
                new AppKernel({
                    appName: 'legacy_app',
                    name: 'legacy-app',
                    root: {} as any,
                } as any)
            ).toThrow(/factory initialize/);
        });

        it('should pass launchConfig through runtime context during initialization', async () => {
            const initialize = vi.fn().mockResolvedValue({ close() {} });
            const appKernelWithLaunchConfig = new AppKernel({
                appName: 'test_component_app',
                name: 'test-component-app',
                factory: {
                    initialize,
                },
                launchConfig: {
                    foo: 'bar',
                    __aotuiLifecycle: {
                        startupKind: 'reinitialize',
                        reason: 'context_compaction',
                    },
                },
            });
            appKernelWithLaunchConfig.setId(mockContext.appId);

            await appKernelWithLaunchConfig.onOpen(mockContext);

            expect(initialize).toHaveBeenCalledWith(
                expect.objectContaining({
                    launchConfig: expect.objectContaining({
                        foo: 'bar',
                        __aotuiLifecycle: {
                            startupKind: 'reinitialize',
                            reason: 'context_compaction',
                        },
                    }),
                })
            );
        });
    });
