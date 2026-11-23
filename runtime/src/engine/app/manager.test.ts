/**
 * AppManager 单元测试
 * 
 * 测试 App 安装与生命周期管理功能。
 * 
 * [Worker-Only] 由于 AppManager 依赖 WorkerSandbox，
 * 我们使用 mock 来隔离 Worker 线程依赖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppManager } from './manager.js';
import type { AppID } from '@aotui/core';
import { WorkerSandbox } from './worker-sandbox.js';

// ============================================================================
// Mock Desktop
// ============================================================================
function createMockDesktop() {
    return {
        id: 'dt_test' as any,
        emitSignal: vi.fn(),
        logSystem: vi.fn(),
    };
}

// These private fixture objects own no OS resources. Their C1 reports describe only
// the controlled close attempt, retaining a rejected close as a known failure.
function c1Worker(reinitialize = vi.fn().mockResolvedValue(undefined), close = vi.fn().mockResolvedValue(undefined)) {
    let settled = false;const issues: string[] = [];
    const getCloseReport = () => ({ state: settled ? 'settled' : 'active', intent: settled ? 'close' : null,
        ok: settled && !issues.length, resourcesReleased: settled, issues: [...issues] });
    return { reinitialize, close, appInstanceId: 'worker-instance', getCloseReport, disposeAsync: vi.fn(async () => {
        try { await close(); } catch { issues.push('APP_CLOSE_FAILED'); }settled = true;return getCloseReport();
    }) };
}
function catalog(manager: AppManager, installationId: string, metadata: object, worker?: ReturnType<typeof c1Worker>) {
    const state = manager as any;
    const entry = { installationId, ...metadata, ...(worker ? { appId: installationId } : {}) };
    state.installedApps.set(installationId, entry);
    if (worker) {
        state.runs.set(installationId, entry);
        state.workers.set(installationId, worker);
    }
}
function launchConfig(manager: AppManager, appId: string) { return (manager.getWorkerSandbox(appId) as any).config; }

// ============================================================================
// Tests
// ============================================================================

describe('AppManager', () => {
    let desktop: ReturnType<typeof createMockDesktop>;
    let manager: AppManager;

    beforeEach(() => {
        desktop = createMockDesktop();
        manager = new AppManager(desktop);
    });

    afterEach(async () => {
        await manager.cleanupAsync();
    });

    // ════════════════════════════════════════════════════════════════
    // 构造与初始化
    // ════════════════════════════════════════════════════════════════

    describe('constructor', () => {
        it('创建 AppManager 实例', () => {
            expect(manager).toBeInstanceOf(AppManager);
        });

        it('初始状态下没有已安装的 App', () => {
            expect(manager.getInstalledApps()).toHaveLength(0);
        });

    });

    // ════════════════════════════════════════════════════════════════
    // 查询方法（无 Worker 依赖）
    // ════════════════════════════════════════════════════════════════

    describe('getInstalledApps', () => {
        it('返回空数组当没有安装 App', () => {
            const apps = manager.getInstalledApps();
            expect(apps).toEqual([]);
        });
    });

    describe('getWorkerSandbox', () => {
        it('对不存在的 App 返回 undefined', () => {
            expect(manager.getWorkerSandbox('nonexistent_app' as AppID)).toBeUndefined();
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 生命周期方法（空状态）
    // ════════════════════════════════════════════════════════════════

    describe('beginClose', () => {
        it('空状态下完成并返回关闭报告', async () => {
            await expect(manager.beginClose().completion).resolves.toMatchObject({ state: 'settled', resourcesReleased: true });
        });
    });

    describe('reinitializeAll', () => {
        it('对 running / collapsed app 重新初始化，并跳过 closed / pending', async () => {
            const startSpy = vi.spyOn(WorkerSandbox.prototype, 'installDynamic').mockResolvedValue(undefined);

            const runningWorker = c1Worker();
            const collapsedWorker = c1Worker();

            catalog(manager, 'app_running', {
                name: 'ide',
                status: 'running',
                installedAt: Date.now(),
                modulePath: '/running',
                config: { projectPath: '/repo' },
            }, runningWorker);
            catalog(manager, 'app_collapsed', {
                name: 'collapsed-app',
                status: 'collapsed',
                installedAt: Date.now(),
                modulePath: '/collapsed',
            }, collapsedWorker);
            catalog(manager, 'app_closed', {
                name: 'closed-app',
                status: 'closed',
                installedAt: Date.now(),
                modulePath: '/closed',
            });
            catalog(manager, 'app_pending', {
                name: 'pending-app',
                status: 'pending',
                installedAt: Date.now(),
                modulePath: '/pending',
            });


            const result = await manager.reinitializeAll({ reason: 'context_compaction' });

            expect(result).toEqual({
                reinitializedAppIds: ['app_running', 'app_collapsed'],
                skippedInstallationIds: ['app_closed', 'app_pending'],
                failedAppIds: [],
            });
            expect(runningWorker.reinitialize).toHaveBeenCalledWith('context_compaction');
            expect(collapsedWorker.reinitialize).toHaveBeenCalledWith('context_compaction');
            expect(runningWorker.close).toHaveBeenCalledTimes(1);
            expect(collapsedWorker.close).toHaveBeenCalledTimes(1);
            expect(startSpy).toHaveBeenCalledTimes(2);
            for (const [appId, modulePath] of [['app_running', '/running'], ['app_collapsed', '/collapsed']]) {
                expect(launchConfig(manager, appId)).toMatchObject({ appId, appModulePath: modulePath });
            }
            expect(launchConfig(manager, 'app_running').config.projectPath).toBe('/repo');
            expect(manager.getInstalledApps().find((app) => app.installationId === 'app_closed')?.status).toBe('closed');
            expect(manager.getInstalledApps().find((app) => app.installationId === 'app_pending')?.status).toBe('pending');

            startSpy.mockRestore();
        });

        it('单个 app 重新初始化失败时不影响其他 app，并将失败 app 置为 closed', async () => {
            const startSpy = vi.spyOn(WorkerSandbox.prototype, 'installDynamic').mockResolvedValue(undefined);

            const okWorker = c1Worker();
            const badWorker = c1Worker(vi.fn().mockRejectedValue(new Error('boom')), vi.fn().mockRejectedValue(new Error('boom')));

            catalog(manager, 'app_ok', {
                name: 'ok-app',
                status: 'running',
                installedAt: Date.now(),
                modulePath: '/ok',
            }, okWorker);
            catalog(manager, 'app_bad', {
                name: 'bad-app',
                status: 'running',
                installedAt: Date.now(),
                modulePath: '/bad',
            }, badWorker);


            const result = await manager.reinitializeAll({ reason: 'context_compaction' });

            expect(result.reinitializedAppIds).toEqual(['app_ok']);
            expect(result.failedAppIds).toEqual(['app_bad']);
            expect(result.skippedInstallationIds).toEqual([]);
            expect(startSpy).toHaveBeenCalledTimes(1);
            expect(launchConfig(manager, 'app_ok')).toMatchObject({ appId: 'app_ok', appModulePath: '/ok' });
            expect(manager.getInstalledApps().find((app) => app.installationId === 'app_bad')?.status).toBe('closed');

            startSpy.mockRestore();
        });
    });

    describe('openApp', () => {
        it('拒绝不存在的 installation ID', async () => {
            await expect(manager.openApp('nonexistent_app')).rejects.toMatchObject({ code: 'LIFECYCLE_CONFLICT' });
        });
    });

    describe('closeApp', () => {
        it('对不存在的 App 静默返回', async () => {
            await expect(manager.closeApp('nonexistent_app' as AppID)).resolves.toBeUndefined();
        });

        it('应该真正关闭 worker 并将 app 标记为 closed', async () => {
            const appId = 'app_0' as AppID;
            const worker = c1Worker();

            catalog(manager, appId, {
                name: 'ide',
                status: 'running',
                installedAt: Date.now(),
                modulePath: '/path/to/module',
            }, worker);

            await manager.closeApp(appId);

            expect(worker.close).toHaveBeenCalledTimes(1);
            expect(worker.disposeAsync).toHaveBeenCalledTimes(1);
            expect(worker.getCloseReport()).toMatchObject({ state: 'settled', resourcesReleased: true });
            expect(manager.getWorkerSandbox(appId)).toBeUndefined();
            expect(manager.getInstalledApps()[0]?.status).toBe('closed');
        });
    });

    describe('collapseApp', () => {
        it('对不存在的 App 静默返回', async () => {
            await expect(manager.collapseApp('nonexistent_app' as AppID)).resolves.toBeUndefined();
        });
    });

    describe('expandApp', () => {
        it('对不存在的 App 静默返回', async () => {
            await expect(manager.expandApp('nonexistent_app' as AppID)).resolves.toBeUndefined();
        });
    });

    // ════════════════════════════════════════════════════════════════
    // [RFC-014] 懒加载测试
    // ════════════════════════════════════════════════════════════════

    describe('Lazily Loaded Apps', () => {
        it('registerPendingApp 应该注册 App 但不创建 Worker', () => {
            const installationId = manager.registerPendingApp({
                name: 'lazy_app',
                modulePath: '/path/to/module',
                description: 'Lazy App'
            });

            expect(installationId).toBeDefined();

            // 验证已安装
            const apps = manager.getInstalledApps();
            expect(apps).toHaveLength(1);
            expect(apps[0]).toMatchObject({
                installationId,
                name: 'lazy_app',
                status: 'pending',
                description: 'Lazy App'
            });
            expect(apps[0]).not.toHaveProperty('modulePath');

            // 验证没有 Worker
            expect(manager.getInstalledApps()[0]).not.toHaveProperty('appId');
        });

        it('openApp 应该自动启动 pending 状态的 App', async () => {
            // Mock install 方法以避开 WorkerSandbox 创建
            const startSpy = vi.spyOn(WorkerSandbox.prototype, 'installDynamic').mockResolvedValue(undefined);

            const installationId = manager.registerPendingApp({
                name: 'lazy_app',
                modulePath: '/path/to/module'
            });

            const appId = await manager.openApp(installationId);

            expect(startSpy).toHaveBeenCalledTimes(1);
            expect(launchConfig(manager, appId)).toMatchObject({ appId, appModulePath: '/path/to/module', name: 'lazy_app' });
            expect(manager.getInstalledApps()[0].status).toBe('running');

            startSpy.mockRestore();
        });

        it('openApp 应该自动重新启动 closed 状态的 App', async () => {
            const startSpy = vi.spyOn(WorkerSandbox.prototype, 'installDynamic').mockResolvedValue(undefined);

            const installationId = manager.registerPendingApp({
                name: 'lazy_app',
                modulePath: '/path/to/module',
            });

            const installedApp = (manager as any).installedApps.get(installationId)!;
            installedApp.status = 'closed';
            installedApp.whatItIs = 'IDE';
            installedApp.whenToUse = 'Use for code';
            installedApp.config = { projectPath: '/repo' };
            expect(manager.getInstalledApps()[0]).toMatchObject({ installationId, status: 'closed', whatItIs: 'IDE', whenToUse: 'Use for code' });
            expect(manager.getInstalledApps()[0]).not.toHaveProperty('config');

            const appId = await manager.openApp(installationId);

            expect(startSpy).toHaveBeenCalledTimes(1);
            expect(launchConfig(manager, appId)).toMatchObject({
                appId, name: 'lazy_app', appModulePath: '/path/to/module',
                config: { projectPath: '/repo', AOTUI_APP_KEY: installationId },
            });
            expect(manager.getInstalledApps()[0]).toMatchObject({ installationId, status: 'running', whatItIs: 'IDE', whenToUse: 'Use for code' });

            startSpy.mockRestore();
        });

        it('openApp 返回运行时 appId 并保留 installationId', async () => {
            // Mock install 方法
            const startSpy = vi.spyOn(WorkerSandbox.prototype, 'installDynamic').mockResolvedValue(undefined);

            const installationId = manager.registerPendingApp({
                name: 'lazy_app',
                modulePath: '/path/to/module',
            });

            const appId = await manager.openApp(installationId);

            expect(appId).toBe('lazy_app');
            expect(appId).not.toBe(installationId);
            expect(startSpy).toHaveBeenCalledTimes(1);
            expect(launchConfig(manager, appId)).toMatchObject({ appId, name: 'lazy_app', appModulePath: '/path/to/module' });
            expect(manager.getInstalledApps()[0].status).toBe('running');

            startSpy.mockRestore();
        });

        it('openApp 拒绝已启动的 App', async () => {
            const startSpy = vi.spyOn(WorkerSandbox.prototype, 'installDynamic').mockResolvedValue(undefined);
            try {
                const installationId = manager.registerPendingApp({ name: 'already_started', modulePath: '/app' });
                await manager.openApp(installationId);
                await expect(manager.openApp(installationId)).rejects.toMatchObject({ code: 'LIFECYCLE_CONFLICT' });
                expect(startSpy).toHaveBeenCalledOnce();
            } finally { startSpy.mockRestore(); }
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 清理
    // ════════════════════════════════════════════════════════════════

    describe('cleanup', () => {
        it('清理后 installedApps 为空', async () => {
            await manager.cleanupAsync();
            expect(manager.getInstalledApps()).toHaveLength(0);
        });

    });
});
