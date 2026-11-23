/**
 * SPI Layer - Kernel Interfaces
 * 
 * Defines the Kernel and Desktop runtime contracts.
 */

import type { DesktopID, AppID } from '@aotui/core';
import type { UpdateSignal } from '../core/signals.js';
import type { ShutdownOptions, DesktopCloseOptions, DesktopCloseHandle, RuntimeCloseHandle } from './close.interface.js';
export type { ShutdownOptions } from './close.interface.js';
import type { AppInteractionOptions, AppInteractionResult } from './app-interaction.interface.js';
import type { AppInteractionPolicy, RequestSources, RequestSourceSelection } from '@aotui/core';
import type { AppWindows, ViewCloseResult, ViewWindowTarget } from './windows.js';

export interface RegisterPendingAppOptions extends AppInteractionOptions {
    installationId: string;
    localPath: string;
    config?: import('@aotui/core').AppLaunchConfig;
}

export interface ReinitializeDesktopAppsOptions {
    reason?: string;
}

export interface ReinitializeDesktopAppsResult {
    desktopId: DesktopID;
    reinitializedAppIds: AppID[];
    skippedInstallationIds: string[];
    failedAppIds: AppID[];
}

// ============================================================================
// Desktop Interface
// ============================================================================

/**
 * Desktop 接口
 * 
 * [Worker-Only] 隔离的运行时沙箱，托管多个 App。
 * 所有 App 运行在独立的 Worker Thread 中。
 */
export interface AppDiscoveryInfo {
    readonly installationId: string;
    readonly appId?: AppID;
    /** Runtime-owned identity of the current Worker execution, absent when no execution is active. */
    readonly appInstanceId?: string;
    readonly name: string;
    readonly status: 'pending' | 'running' | 'closed' | 'collapsed';
    readonly description?: string;
    readonly whatItIs?: string;
    readonly whenToUse?: string;
}

export interface IDesktop {
    getAppInteraction(appId: string, expectedInstanceId: string, policy?: AppInteractionPolicy): AppInteractionResult;
    bindRequestSources(input: RequestSourceSelection): RequestSources;
    beginClose(options?: DesktopCloseOptions): DesktopCloseHandle;
    readonly id: DesktopID;
    /** True from close admission onward, including after resources have been released. */
    readonly isClosing: boolean;

    /** Installed application catalog used by Semantic context and lifecycle controls. */
    getInstalledApps(): readonly AppDiscoveryInfo[];
    /** Optional, bounded by the adapter when projecting recent Desktop activity. */
    getSystemLogs?(): readonly { timestamp: number; message: string }[];

    /**
     * [Worker-Only] 安装 App
     * 
     * App 运行在独立的 Worker Thread 中。
     * 
     */
    installDynamicWorkerApp(
        appModulePath: string,
        options?: AppInteractionOptions & {
            installationId?: string;
            name?: string;
            /** [RFC-013] App description for Agent */
            description?: string;
            whatItIs?: string;
            whenToUse?: string;
            config?: import('@aotui/core').AppLaunchConfig;
        }
    ): Promise<string>;

    /**
     * [RFC-014] 注册待启动 App (懒加载)
     * 
     * App 信息写入 installedApps，但不启动 Worker。
     * Semantic context can present these apps and expose the corresponding open control.
     */
    registerPendingApp(options: RegisterPendingAppOptions): Promise<string>;

    // System Commands (App)
    openApp(installationId: string): Promise<AppID>;
    /** If supplied, a mismatch rejects with APP_INSTANCE_CHANGED before side effects; omitting it preserves trusted Host behavior. */
    closeApp(appId: AppID, expectedInstanceId?: string): Promise<void>;
    getAppWindows(appId: AppID, expectedInstanceId: string): AppWindows | undefined;
    collapseApp(appId: AppID, expectedInstanceId?: string, note?: string): Promise<void>;
    expandApp(appId: AppID, expectedInstanceId?: string): Promise<void>;
    collapseView(target: ViewWindowTarget, note?: string): Promise<void>;
    expandView(target: ViewWindowTarget): Promise<void>;
    closeView(target: ViewWindowTarget): Promise<ViewCloseResult>;

    output: {
        subscribe(listener: (signal: UpdateSignal) => void): void;
        unsubscribe(listener: (signal: UpdateSignal) => void): void;
    };

    /**
     * 重新初始化 Desktop 上的所有 App，同时保持 Desktop 身份稳定。
     */
    reinitializeApps(options?: ReinitializeDesktopAppsOptions): Promise<ReinitializeDesktopAppsResult>;

    /**
     * [RFC-015] 删除 Desktop
     * 
     * 请求 App 删除，等待 App/Worker 清理，并释放 Desktop 资源。
     */
    delete(): Promise<void>;
}

// ============================================================================
// Kernel Interface
// ============================================================================

/**
 * Kernel 接口
 * 
 * Runtime 的核心编排器。
 */
export interface IKernel {
    getAppInteraction(desktopId: DesktopID, appId: string, expectedInstanceId: string, policy?: AppInteractionPolicy): AppInteractionResult;
    beginShutdown(): RuntimeCloseHandle;
    beginDesktopShutdown(id: DesktopID, options?: ShutdownOptions): DesktopCloseHandle;
    createDesktop(desktopId?: DesktopID): Promise<DesktopID>;
    // [M1 FIX] Changed from void to Promise<void> to match implementation
    destroyDesktop(desktopId: DesktopID): Promise<void>;

    // App Management
    /**
     * [Worker-Only] 安装 App
     * 
     * @param desktopId - 目标桌面 ID
     * @param appModulePath - App 模块路径
     * @param options - 可选配置
     * @returns 分配的 appId
     * 
     */
    installDynamicWorkerApp(
        desktopId: DesktopID,
        appModulePath: string,
        options?: AppInteractionOptions & {
            installationId?: string;
            name?: string;
            /** [RFC-013] App description for Agent */
            description?: string;
            config?: import('@aotui/core').AppLaunchConfig;
        }
    ): Promise<string>;

    /**
     * 获取 Desktop 实例
     * @throws {Error} E_NOT_FOUND if Desktop doesn't exist
     */
    getDesktop(desktopId: DesktopID): IDesktop;

    /**
     * 重新初始化 Desktop 上的所有 App，同时保持 Desktop 身份稳定。
     */
    reinitializeDesktopApps(
        desktopId: DesktopID,
        options?: ReinitializeDesktopAppsOptions
    ): Promise<ReinitializeDesktopAppsResult>;


    /**
     * [RFC-015] 删除 Desktop
     * 
     * 永久销毁 Desktop 及其所有数据。
     * 会触发 App 的 onDelete 生命周期钩子。
     */
    deleteDesktop(desktopId: DesktopID): Promise<void>;

    /**
     * 关闭 Runtime 本体并释放进程级资源。
     *
     * - 幂等
     * - shutdown 后 Kernel 不再可用于创建/管理 Desktop
     */
    shutdown(): Promise<void>;
}

/**
 * [RFC-014] 优雅关闭选项
 */
