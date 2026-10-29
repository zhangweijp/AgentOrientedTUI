import { expect, it } from 'vitest';
import { DesktopLogger } from './desktop-logger.js';
it('C2-23 colon-bearing Desktop/App tuples never collide or prefix-delete each other', () => {
    const logger = new DesktopLogger(), first = 'desk' as any, next = 'desk:a' as any;
    logger.logApp(first, 'a:b' as any, 'one');logger.logApp(next, 'b' as any, 'two');logger.logSystem(next, 'system');
    expect(logger.getAppLogs(first, 'a:b' as any).map(x => x.message)).toEqual(['one']);
    expect(logger.getAppLogs(next, 'b' as any).map(x => x.message)).toEqual(['two']);
    expect(logger.getStats(first).appCounts).toEqual({ 'a:b': 1 });logger.cleanup(first);
    expect(logger.getAppLogs(next, 'b' as any)).toHaveLength(1);expect(logger.getSystemLogs(next)).toHaveLength(1);expect(logger.getStats(first)).toEqual({ systemCount: 0, appCounts: {} });
    logger.cleanupApp(next, 'b' as any);expect(logger.getStats(next)).toEqual({ systemCount: 1, appCounts: {} });
});
it('C2-23 exact tuple cleanup preserves logging API, bounded buffers, and arbitrary literal IDs', () => {
    const logger = new DesktopLogger({ maxAppLogs: 1, maxSystemLogs: 1 }), d = 'd' as any, app = '__proto__' as any;
    logger.logApp(d, app, 'old');logger.logApp(d, app, 'new', 'warn');logger.logSystem(d, 'old');logger.logSystem(d, 'new');
    expect(logger.getAppLogs(d, app)).toEqual([{ timestamp: expect.any(Number), message: 'new', level: 'warn' }]);
    expect(Object.hasOwn(logger.getStats(d).appCounts, '__proto__')).toBe(true);expect(logger.getStats(d).appCounts.__proto__).toBe(1);
    expect(logger.getSystemLogs(d)).toHaveLength(1);logger.cleanup(d);expect(logger.getStats(d)).toEqual({ systemCount: 0, appCounts: {} });
});
