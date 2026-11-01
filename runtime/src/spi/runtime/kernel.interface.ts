/**
 * SPI Layer - Kernel Interfaces
 * 
 * Defines the Kernel and Desktop runtime contracts.
 */

import type {
    DesktopID,
    AppID,
    DesktopState
} from '../core/types.js';
// [C1 FIX] Command type removed - unified to Operation
import type { UpdateSignal } from '../core/signals.js';
import type { IRuntimeContext } from './context.interface.js'; // New
import type { ShutdownOptions, DesktopCloseOptions, DesktopCloseOperation, RuntimeCloseOperation } from './close.interface.js';
export type { ShutdownOptions } from './close.interface.js';
import type { AppInteractionOptions, RuntimeInteractionAccess, DesktopInteractionAccess } from './app-interaction.interface.js';

export interface ReinitializeDesktopAppsOptions {
    reason?: string;
    preserve?: {
        desktopIdentity?: boolean;
        installedApps?: boolean;
        rootSurface?: boolean;
    };
}

export interface ReinitializeDesktopAppsResult {
    desktopId: DesktopID;
    reinitializedAppIds: AppID[];
    skippedAppIds: AppID[];
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
    readonly appId: AppID;
    /** Runtime-owned identity of the current Worker execution, absent when no execution is active. */
    readonly appInstanceId?: string;
    readonly name?: string;
    readonly status: 'pending' | 'running' | 'paused' | 'closed' | 'collapsed';
    readonly description?: string;
    readonly whatItIs?: string;
    readonly whenToUse?: string;
}

export interface IDesktop {
    createAppScope: DesktopInteractionAccess['createAppScope'];
    beginClose(options?: DesktopCloseOptions): DesktopCloseOperation;
    id: DesktopID;

    /** Installed application catalog used by Semantic context and lifecycle controls. */
    getInstalledApps(): readonly AppDiscoveryInfo[];
    /** Optional, bounded by the adapter when projecting recent Desktop activity. */
    getSystemLogs?(): readonly { timestamp: number; message: string }[];

    /**
     * [Worker-Only] 安装 App
     * 
     * App 运行在独立的 Worker Thread 中。
     * 
     * [C1 Fix] workerScriptPath 现在是可选的，默认使用 Runtime 内置的 worker-runtime
     */
    installDynamicWorkerApp(
        appModulePath: string,
        options?: AppInteractionOptions & {
            workerScriptPath?: string;
            appId?: string;
            name?: string;
            /** [RFC-013] App description for Agent */
            description?: string;
            whatItIs?: string;
            whenToUse?: string;
            config?: import('../app/app-config.interface.js').AppLaunchConfig;
            promptRole?: 'user' | 'assistant';
        }
    ): Promise<string>;

    /**
     * [RFC-014] 注册待启动 App (懒加载)
     * 
     * App 信息写入 installedApps，但不启动 Worker。
     * Semantic context can present these apps and expose the corresponding open control.
     */
    registerPendingApp(options: AppInteractionOptions & {
        appId?: string;
        name?: string;
        description?: string;
        whatItIs?: string;
        whenToUse?: string;
        modulePath: string;
        workerScriptPath?: string;
        config?: import('../app/app-config.interface.js').AppLaunchConfig;
        promptRole?: 'user' | 'assistant';
    }): Promise<string>;

    // System Commands (App)
    openApp(appId: AppID): Promise<void>;
    /** If supplied, a mismatch rejects with APP_INSTANCE_CHANGED before side effects; omitting it preserves trusted Host behavior. */
    closeApp(appId: AppID, expectedInstanceId?: string): Promise<void>;
    collapseApp(appId: AppID, expectedInstanceId?: string): Promise<void>;
    showApp(appId: AppID, expectedInstanceId?: string): Promise<void>;

    output: {
        subscribe(listener: (signal: UpdateSignal) => void): void;
        unsubscribe(listener: (signal: UpdateSignal) => void): void;
    };

    /**
     * 获取 App 信息
     * @param appId - App ID
     * @returns App 信息 (name, etc.) 或 undefined
     */
    getAppInfo?(appId: AppID): { name?: string } | undefined;

    /**
     * 重新初始化 Desktop 上的所有 App，同时保持 Desktop 身份稳定。
     */
    reinitializeApps(options?: ReinitializeDesktopAppsOptions): Promise<ReinitializeDesktopAppsResult>;

    /**
     * 等待所有活动 Worker 结束
     * 
     * 用于 Graceful Shutdown
     */
    drain(): Promise<void>;

    /**
     * [RFC-015] 删除 Desktop
     * 
     * 1. 调用所有 App 的 onDelete() (清理持久化数据)
     * 2. 调用 drain() (关闭 Worker)
     * 3. 清理资源
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
    createAppScope: RuntimeInteractionAccess['createAppScope'];
    beginShutdown(reason?: string): RuntimeCloseOperation;
    beginDesktopShutdown(id: DesktopID, options?: ShutdownOptions): DesktopCloseOperation;
    createDesktop(desktopId?: DesktopID, context?: IRuntimeContext): Promise<DesktopID>;
    // [M1 FIX] Changed from void to Promise<void> to match implementation
    destroyDesktop(desktopId: DesktopID): Promise<void>;

    // App Management
    /**
     * [Worker-Only] 安装 App
     * 
     * @param desktopId - 目标桌面 ID
     * @param appModulePath - App 模块路径
     * @param workerScriptPath - Worker 脚本路径 (可选，默认使用 Runtime 内置)
     * @param options - 可选配置
     * @returns 分配的 appId
     * 
     * [C1 Fix] workerScriptPath 现在是可选的
     */
    installDynamicWorkerApp(
        desktopId: DesktopID,
        appModulePath: string,
        options?: AppInteractionOptions & {
            workerScriptPath?: string;
            appId?: string;
            name?: string;
            /** [RFC-013] App description for Agent */
            description?: string;
            config?: import('../app/app-config.interface.js').AppLaunchConfig;
            promptRole?: 'user' | 'assistant';
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

    // [H3 FIX] Changed from void to Promise<void> - Desktop methods are async
    suspend(desktopId: DesktopID): Promise<void>;
    resume(desktopId: DesktopID): Promise<void>;
    serialize(desktopId: DesktopID): DesktopState;

    /**
     * [RFC-014] 优雅关闭 Desktop
     * 
     * 1. 调用 Desktop.drain() 等待 App 清理
     * 2. 执行 beforeClose 回调（如持久化）
     * 3. 销毁 Desktop
     * 
     * @param desktopId - Desktop ID
     * @param options - 关闭选项
     */
    gracefulShutdown(desktopId: DesktopID, options?: ShutdownOptions): Promise<void>;

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
    shutdown(reason?: string): Promise<void>;
}

/**
 * [RFC-014] 优雅关闭选项
 */
