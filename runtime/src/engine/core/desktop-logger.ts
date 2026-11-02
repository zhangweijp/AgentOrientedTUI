/**
 * DesktopLogger - Desktop 日志记录模块
 * 
 * [H1 拆分 Phase 2] 从 Desktop 提取的日志管理模块。
 * 
 * 职责:
 * - 记录系统级日志 (Desktop 生命周期事件)
 * - 记录 App 操作日志 (App 内部操作)
 * - 提供日志查询接口
 */

import type { DesktopID, AppID } from '../../spi/index.js';

/**
 * 日志条目
 */
export interface LogEntry {
    timestamp: number;
    message: string;
    level: 'info' | 'warn' | 'error';
}

export type LogLevel = LogEntry['level'];

/**
 * DesktopLogger 配置
 */
export interface DesktopLoggerOptions {
    /** 每个 Desktop 最大系统日志条数，默认 100 */
    maxSystemLogs?: number;
    /** 每个 App 最大操作日志条数，默认 50 */
    maxAppLogs?: number;
}

/**
 * DesktopLogger - 统一管理所有 Desktop 的日志
 */
export class DesktopLogger {
    private systemLogs = new Map<DesktopID, LogEntry[]>();
    private appLogs = new Map<DesktopID, Map<AppID, LogEntry[]>>();
    private options: Required<DesktopLoggerOptions>;

    constructor(options?: DesktopLoggerOptions) {
        this.options = {
            maxSystemLogs: options?.maxSystemLogs ?? 100,
            maxAppLogs: options?.maxAppLogs ?? 50
        };
    }

    // ========================================================================
    // 系统日志
    // ========================================================================

    /**
     * 记录系统日志
     */
    logSystem(
        desktopId: DesktopID,
        message: string,
        level: LogLevel = 'info'
    ): void {
        let logs = this.systemLogs.get(desktopId);
        if (!logs) {
            logs = [];
            this.systemLogs.set(desktopId, logs);
        }

        logs.push({
            timestamp: Date.now(),
            message,
            level
        });

        // 限制日志数量
        if (logs.length > this.options.maxSystemLogs) {
            logs.shift();
        }
    }

    /**
     * 获取系统日志
     */
    getSystemLogs(desktopId: DesktopID): LogEntry[] {
        return this.systemLogs.get(desktopId) ?? [];
    }

    // ========================================================================
    // App 操作日志
    // ========================================================================

    /**
     * 记录 App 操作日志
     */
    logApp(
        desktopId: DesktopID,
        appId: AppID,
        message: string,
        level: LogLevel = 'info'
    ): void {
        let apps = this.appLogs.get(desktopId);
        if (!apps) { apps = new Map();this.appLogs.set(desktopId, apps); }
        let logs = apps.get(appId);
        if (!logs) {
            logs = [];
            apps.set(appId, logs);
        }

        logs.push({
            timestamp: Date.now(),
            message,
            level
        });

        // 限制日志数量
        if (logs.length > this.options.maxAppLogs) {
            logs.shift();
        }
    }

    /**
     * 获取 App 操作日志
     */
    getAppLogs(desktopId: DesktopID, appId: AppID): LogEntry[] {
        return this.appLogs.get(desktopId)?.get(appId) ?? [];
    }

    // ========================================================================
    // 清理
    // ========================================================================

    /**
     * 清理指定 Desktop 的所有日志
     */
    cleanup(desktopId: DesktopID): void {
        this.systemLogs.delete(desktopId);

        this.appLogs.delete(desktopId);
    }

    /**
     * 清理指定 App 的日志
     */
    cleanupApp(desktopId: DesktopID, appId: AppID): void {
        const apps = this.appLogs.get(desktopId);
        apps?.delete(appId);
        if (apps?.size === 0) this.appLogs.delete(desktopId);
    }

    // ========================================================================
    // 调试辅助
    // ========================================================================

    /**
     * 获取日志统计（用于调试）
     */
    getStats(desktopId: DesktopID): { systemCount: number; appCounts: Record<string, number> } {
        const systemCount = this.systemLogs.get(desktopId)?.length ?? 0;
        const appCounts: Record<string, number> = Object.fromEntries(
            [...this.appLogs.get(desktopId) ?? []].map(([appId, logs]) => [appId, logs.length]),
        );

        return { systemCount, appCounts };
    }
}
