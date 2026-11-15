import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopManager } from '../../src/core/desktop-manager.js';

describe('DesktopManager', () => {
    let mockKernel: any;
    let mockRegistry: any;

    beforeEach(() => {
        mockKernel = {
            createDesktop: vi.fn().mockResolvedValue('dt_test'),
            getDesktop: vi.fn().mockReturnValue({ id: 'dt_test', getInstalledApps: () => [{ id: 'app' }] }),
        };

        mockRegistry = {
            loadFromConfig: vi.fn().mockResolvedValue([]),
            loadFromEntries: vi.fn().mockResolvedValue([]),
            list: vi.fn().mockReturnValue([]),
            installAll: vi.fn().mockResolvedValue([]),
            getEntries: vi.fn().mockReturnValue({
                'explicit-app': {
                    source: 'local:/explicit-app',
                    enabled: true,
                    autoStart: true,
                }
            }),
        };
    });

    it('uses standard AppRegistry installation without restating the Runtime tool default', async () => {
        const manager = new DesktopManager({ kernel: mockKernel, appRegistry: mockRegistry });
        const desktop = await manager.createDesktop(undefined, { projectPath: '/test/workspace' });
        expect(desktop.thirdPartyAppCount).toBe(1);
        expect(mockRegistry.installAll).toHaveBeenCalledWith(mockKernel.getDesktop(), {
            dynamicConfig: { projectPath: '/test/workspace' },
        });
    });

    it('should prefer explicit app entries over ambient config loading', async () => {
        const manager = new DesktopManager({
            kernel: mockKernel,
            appRegistry: mockRegistry,
        });

        await manager.initialize({
            appEntries: [
                {
                    name: 'explicit-app',
                    source: 'local:/explicit-app',
                    enabled: true,
                    autoStart: true,
                }
            ]
        });

        expect(mockRegistry.loadFromEntries).toHaveBeenCalledWith([
            {
                name: 'explicit-app',
                source: 'local:/explicit-app',
                enabled: true,
                autoStart: true,
            }
        ]);
        expect(mockRegistry.loadFromConfig).not.toHaveBeenCalled();
    });

    it('should expose app config from registry entries instead of Config singleton', async () => {
        const manager = new DesktopManager({
            kernel: mockKernel,
            appRegistry: mockRegistry,
        });

        const apps = await manager.getAppsConfig();

        expect(apps).toEqual({
            'explicit-app': {
                source: 'local:/explicit-app',
                enabled: true,
                autoStart: true,
            }
        });
        expect(mockRegistry.getEntries).toHaveBeenCalled();
    });
});
