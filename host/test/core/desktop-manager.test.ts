import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopManager } from '../../src/core/desktop-manager.js';

describe('DesktopManager', () => {
    let mockKernel: any;
    let mockCatalog: any;

    beforeEach(() => {
        mockKernel = {
            createDesktop: vi.fn().mockResolvedValue('dt_test'),
            getDesktop: vi.fn().mockReturnValue({ id: 'dt_test', getInstalledApps: () => [{ id: 'app' }] }),
        };

        mockCatalog = {
            discover: vi.fn().mockResolvedValue([]),
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

    it('uses standard AppCatalog installation without restating the Runtime tool default', async () => {
        const manager = new DesktopManager({ kernel: mockKernel, appCatalog: mockCatalog });
        const desktop = await manager.createDesktop('dt_test', { projectPath: '/test/workspace', AOTUI_DATA_DIR: '/fixture/state' });
        expect(mockKernel.createDesktop).toHaveBeenCalledWith('dt_test');
        expect(desktop.thirdPartyAppCount).toBe(1);
        expect(mockCatalog.installAll).toHaveBeenCalledWith(mockKernel.getDesktop(), {
            entries: undefined,
            dynamicConfig: { projectPath: '/test/workspace', AOTUI_DATA_DIR: '/fixture/state' },
        });
    });

    it('should prefer explicit app entries over ambient config loading', async () => {
        const manager = new DesktopManager({
            kernel: mockKernel,
            appCatalog: mockCatalog,
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

        expect(mockCatalog.discover).toHaveBeenCalledWith([
            {
                name: 'explicit-app',
                source: 'local:/explicit-app',
                enabled: true,
                autoStart: true,
            }
        ]);
        expect(mockCatalog.discover).toHaveBeenCalledTimes(1);
    });

    it('should expose app config from registry entries instead of Config singleton', async () => {
        const manager = new DesktopManager({
            kernel: mockKernel,
            appCatalog: mockCatalog,
        });

        const apps = await manager.getAppsConfig();

        expect(apps).toEqual({
            'explicit-app': {
                source: 'local:/explicit-app',
                enabled: true,
                autoStart: true,
            }
        });
        expect(mockCatalog.getEntries).toHaveBeenCalled();
    });
});
