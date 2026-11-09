/**
 * DesktopLogger 单元测试
 * 
 * 测试系统日志功能。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DesktopLogger, type LogEntry } from './desktop-logger.js';
import type { DesktopID } from '../../spi/index.js';

describe('DesktopLogger', () => {
    let logger: DesktopLogger;
    const desktopId = 'dt_test' as DesktopID;

    beforeEach(() => {
        logger = new DesktopLogger();
    });

    // ════════════════════════════════════════════════════════════════
    // 构造函数
    // ════════════════════════════════════════════════════════════════

    describe('constructor', () => {
        it('创建 DesktopLogger 实例', () => {
            expect(logger).toBeInstanceOf(DesktopLogger);
        });

        it('使用默认配置', () => {
            // 默认 maxSystemLogs = 100
            // 通过添加超过限制的日志来验证
            const customLogger = new DesktopLogger({ maxSystemLogs: 3 });
            customLogger.logSystem(desktopId, 'log1');
            customLogger.logSystem(desktopId, 'log2');
            customLogger.logSystem(desktopId, 'log3');
            customLogger.logSystem(desktopId, 'log4');

            const logs = customLogger.getSystemLogs(desktopId);
            expect(logs.length).toBe(3);
            expect(logs[0].message).toBe('log2'); // log1 被删除
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 系统日志
    // ════════════════════════════════════════════════════════════════

    describe('logSystem', () => {
        it('记录系统日志', () => {
            logger.logSystem(desktopId, 'Test message');

            const logs = logger.getSystemLogs(desktopId);
            expect(logs.length).toBe(1);
            expect(logs[0].message).toBe('Test message');
        });

        it('默认 level 为 info', () => {
            logger.logSystem(desktopId, 'Test');

            const logs = logger.getSystemLogs(desktopId);
            expect(logs[0].level).toBe('info');
        });

        it('支持指定 level', () => {
            logger.logSystem(desktopId, 'Warning', 'warn');
            logger.logSystem(desktopId, 'Error', 'error');

            const logs = logger.getSystemLogs(desktopId);
            expect(logs[0].level).toBe('warn');
            expect(logs[1].level).toBe('error');
        });

        it('添加 timestamp', () => {
            const before = Date.now();
            logger.logSystem(desktopId, 'Test');
            const after = Date.now();

            const logs = logger.getSystemLogs(desktopId);
            expect(logs[0].timestamp).toBeGreaterThanOrEqual(before);
            expect(logs[0].timestamp).toBeLessThanOrEqual(after);
        });

        it('超过 maxSystemLogs 时删除旧日志', () => {
            const customLogger = new DesktopLogger({ maxSystemLogs: 2 });
            customLogger.logSystem(desktopId, 'log1');
            customLogger.logSystem(desktopId, 'log2');
            customLogger.logSystem(desktopId, 'log3');

            const logs = customLogger.getSystemLogs(desktopId);
            expect(logs.length).toBe(2);
            expect(logs[0].message).toBe('log2');
            expect(logs[1].message).toBe('log3');
        });
    });

    describe('getSystemLogs', () => {
        it('返回空数组当没有日志', () => {
            expect(logger.getSystemLogs(desktopId)).toEqual([]);
        });

        it('返回所有系统日志', () => {
            logger.logSystem(desktopId, 'log1');
            logger.logSystem(desktopId, 'log2');

            const logs = logger.getSystemLogs(desktopId);
            expect(logs.length).toBe(2);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // App 操作日志
    // ════════════════════════════════════════════════════════════════

    

    

    // ════════════════════════════════════════════════════════════════
    // 清理
    // ════════════════════════════════════════════════════════════════

    describe('cleanup', () => {
        it('清理指定 Desktop 的系统日志', () => {
            logger.logSystem(desktopId, 'log');
            logger.cleanup(desktopId);

            expect(logger.getSystemLogs(desktopId)).toEqual([]);
        });

        

        it('不影响其他 Desktop 的日志', () => {
            const desktopId2 = 'dt_test2' as DesktopID;
            logger.logSystem(desktopId, 'log1');
            logger.logSystem(desktopId2, 'log2');
            logger.cleanup(desktopId);

            expect(logger.getSystemLogs(desktopId2).length).toBe(1);
        });
    });

    

    // ════════════════════════════════════════════════════════════════
    // 调试辅助
    // ════════════════════════════════════════════════════════════════

    
});
