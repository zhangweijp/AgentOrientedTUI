/**
 * DesktopLogger - Desktop 日志记录模块
 * 
 * [H1 拆分 Phase 2] 从 Desktop 提取的日志管理模块。
 * 
 * 职责:
 * - 记录系统级日志 (Desktop 生命周期事件)
 * - 提供日志查询接口
 */

import type { DesktopID } from '../../spi/index.js';

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

}

/**
 * DesktopLogger - 统一管理所有 Desktop 的日志
 */
export class DesktopLogger {
    private systemLogs = new Map<DesktopID, LogEntry[]>();
    private options: Required<DesktopLoggerOptions>;

    constructor(options?: DesktopLoggerOptions) {
        this.options = {
            maxSystemLogs: options?.maxSystemLogs ?? 100
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

    cleanup(desktopId: DesktopID): void {
        this.systemLogs.delete(desktopId);
    }
}
