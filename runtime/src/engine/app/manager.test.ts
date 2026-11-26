import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppManager } from './manager.js';
import type { AppID } from '@aotui/core';
import { ManagedApp } from './managed-app.js';

function launchConfig(manager: AppManager, appId: string) { return (manager.getManagedApp(appId) as any).host; }

describe('App installation directory', () => {
    let manager: AppManager;
    beforeEach(() => { manager = new AppManager({ id: 'dt_test' as any, emitSignal: vi.fn(), logSystem: vi.fn() }); });
    afterEach(async () => {
        await Promise.all(manager.stopAdmission().apps.map(app => app.beginClose().completion));
        vi.restoreAllMocks();
    });
    it('rejects an unknown installation without starting an App', async () => {
        await expect(manager.openApp('nonexistent_app')).rejects.toHaveProperty('code', 'LIFECYCLE_CONFLICT');
        expect(manager.listApps()).toEqual([]);
    });
    it('rejects View closure for an absent App instance', async () => {
        await expect(manager.closeView({ appId: 'nonexistent_app' as AppID, instanceId: 'absent', viewId: 'view', viewInstanceId: 'mount' }))
            .rejects.toMatchObject({ code: 'APP_INSTANCE_CHANGED' });
    });

    describe('Lazily Loaded Apps', () => {
        it('registerPendingApp 应该注册 App 但不创建 Worker', () => {
            const installationId = manager.registerPendingApp({
                name: 'lazy_app',
                modulePath: '/path/to/module',
                description: 'Lazy App'
            });

            expect(installationId).toBeDefined();

            // 验证已安装
            const apps = manager.listApps();
            expect(apps).toHaveLength(1);
            expect(apps[0]).toMatchObject({
                installationId,
                name: 'lazy_app',
                status: 'pending',
                description: 'Lazy App'
            });
            expect(apps[0]).not.toHaveProperty('modulePath');

            // 验证没有 Worker
            expect(manager.listApps()[0]).not.toHaveProperty('appId');
        });

        it('openApp 应该自动启动 pending 状态的 App', async () => {
            // Mock install 方法以避开 ManagedApp 创建
            const startSpy = vi.spyOn(ManagedApp.prototype, 'start').mockResolvedValue(undefined);

            const installationId = manager.registerPendingApp({
                name: 'lazy_app',
                modulePath: '/path/to/module'
            });

            const appId = (await manager.openApp(installationId)).appId;

            expect(startSpy).toHaveBeenCalledTimes(1);
            expect(launchConfig(manager, appId)).toMatchObject({ appId, appModulePath: '/path/to/module', name: 'lazy_app' });
            expect(manager.listApps()[0].status).toBe('running');

            startSpy.mockRestore();
        });

        it('openApp 应该自动重新启动 closed 状态的 App', async () => {
            const startSpy = vi.spyOn(ManagedApp.prototype, 'start').mockResolvedValue(undefined);

            const installationId = manager.registerPendingApp({
                name: 'lazy_app',
                modulePath: '/path/to/module',
            });

            const installedApp = (manager as any).installedApps.get(installationId)!;
            installedApp.status = 'closed';
            installedApp.whatItIs = 'IDE';
            installedApp.whenToUse = 'Use for code';
            installedApp.config = { projectPath: '/repo' };
            expect(manager.listApps()[0]).toMatchObject({ installationId, status: 'closed', whatItIs: 'IDE', whenToUse: 'Use for code' });
            expect(manager.listApps()[0]).not.toHaveProperty('config');

            const appId = (await manager.openApp(installationId)).appId;

            expect(startSpy).toHaveBeenCalledTimes(1);
            expect(launchConfig(manager, appId)).toMatchObject({
                appId, name: 'lazy_app', appModulePath: '/path/to/module',
                config: { projectPath: '/repo' },
            });
            expect(manager.listApps()[0]).toMatchObject({ installationId, status: 'running', whatItIs: 'IDE', whenToUse: 'Use for code' });

            startSpy.mockRestore();
        });

        it('openApp 返回运行时 appId 并保留 installationId', async () => {
            // Mock install 方法
            const startSpy = vi.spyOn(ManagedApp.prototype, 'start').mockResolvedValue(undefined);

            const installationId = manager.registerPendingApp({
                name: 'lazy_app',
                modulePath: '/path/to/module',
            });

            const appId = (await manager.openApp(installationId)).appId;

            expect(appId).toBe('lazy_app');
            expect(appId).not.toBe(installationId);
            expect(startSpy).toHaveBeenCalledTimes(1);
            expect(launchConfig(manager, appId)).toMatchObject({ appId, name: 'lazy_app', appModulePath: '/path/to/module' });
            expect(manager.listApps()[0].status).toBe('running');

            startSpy.mockRestore();
        });

        it('openApp 拒绝已启动的 App', async () => {
            const startSpy = vi.spyOn(ManagedApp.prototype, 'start').mockResolvedValue(undefined);
            try {
                const installationId = manager.registerPendingApp({ name: 'already_started', modulePath: '/app' });
                await manager.openApp(installationId);
                await expect(manager.openApp(installationId)).rejects.toMatchObject({ code: 'LIFECYCLE_CONFLICT' });
                expect(startSpy).toHaveBeenCalledOnce();
            } finally { startSpy.mockRestore(); }
        });
    });

});
