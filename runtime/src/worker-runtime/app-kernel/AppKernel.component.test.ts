import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppKernel } from './AppKernel.js';
import type { AppKernelConfig, AppContext } from '../../spi/index.js';

describe('AppKernel - Component Mode', () => {
    let appKernel: AppKernel;
    let mockContext: AppContext;
    let mockContainer: HTMLElement;

    beforeEach(() => {
        // Create mock AppContext
        mockContext = {
            appId: 'test-app' as any,
            desktopId: 'test-desktop' as any,
            onRender: vi.fn(),
            markDirty: vi.fn(),
        };

        // Create mock DOM elements
        const mockViewsContainer = {
            appendChild: vi.fn(),
            setAttribute: vi.fn(),
        };

        const mockAppRoot = {
            setAttribute: vi.fn(),
        };

        // Create comprehensive mock container
        const mockDocument = {
            createElement: vi.fn((tag: string) => {
                if (tag === 'div') {
                    return mockAppRoot;
                }
                return {
                    setAttribute: vi.fn(),
                    appendChild: vi.fn(),
                    innerHTML: '',
                };
            }),
        };

        mockContainer = {
            innerHTML: '',
            querySelector: vi.fn((selector: string) => {
                if (selector === '[data-views]') {
                    return mockViewsContainer;
                }
                return null;
            }),
            querySelectorAll: vi.fn(),
            appendChild: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            ownerDocument: mockDocument,
        } as any;

        // Create AppKernel with component mode config
        const config: AppKernelConfig = {
            appName: 'test_component_app',
            name: 'test-component-app',
            component: {
                initializeComponent: vi.fn().mockResolvedValue({}),
            },
        };

        appKernel = new AppKernel(config);
        appKernel.setId('app_0' as any);
    });

    it('has no legacy Operation router; component Views own the only Tool route', () => {
        expect((appKernel as any).onOperation).toBeUndefined();
    });

        it('should invoke onReinitialize hook with reason', async () => {
            const onReinitialize = vi.fn().mockResolvedValue(undefined);
            const appKernelWithHook = new AppKernel({
                appName: 'test_component_app',
                name: 'test-component-app',
                component: {
                    initializeComponent: vi.fn().mockResolvedValue({}),
                },
                onReinitialize,
                launchConfig: {
                    __aotuiLifecycle: {
                        startupKind: 'reinitialize',
                        reason: 'context_compaction',
                    },
                },
            });
            appKernelWithHook.setId('app_0' as any);

            await appKernelWithHook.onOpen(mockContext, mockContainer);
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
                    component: {
                        initializeComponent: vi.fn().mockResolvedValue({}),
                    },
                } as any)
            ).toThrow(/appName/);
        });

        it('rejects legacy root-mode configs and documents component mode as the only supported path', () => {
            expect(() =>
                new AppKernel({
                    appName: 'legacy_app',
                    name: 'legacy-app',
                    root: {} as any,
                } as any)
            ).toThrow(/component is required|component mode/i);
        });

        it('should pass launchConfig through runtime context during initialization', async () => {
            const initializeComponent = vi.fn().mockResolvedValue({});
            const appKernelWithLaunchConfig = new AppKernel({
                appName: 'test_component_app',
                name: 'test-component-app',
                component: {
                    initializeComponent,
                },
                launchConfig: {
                    foo: 'bar',
                    __aotuiLifecycle: {
                        startupKind: 'reinitialize',
                        reason: 'context_compaction',
                    },
                },
            });
            appKernelWithLaunchConfig.setId('app_0' as any);

            await appKernelWithLaunchConfig.onOpen(mockContext, mockContainer);

            expect(initializeComponent).toHaveBeenCalledWith(
                expect.anything(),
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
