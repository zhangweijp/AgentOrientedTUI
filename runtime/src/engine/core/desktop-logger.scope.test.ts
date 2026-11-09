import { expect, it } from 'vitest';
import { DesktopLogger } from './desktop-logger.js';
it('Desktop cleanup preserves another literal Desktop ID', () => {
    const logger = new DesktopLogger(), first = 'desk' as any, next = 'desk:a' as any;
    logger.logSystem(first, 'one');logger.logSystem(next, 'two');logger.cleanup(first);
    expect(logger.getSystemLogs(first)).toEqual([]);
    expect(logger.getSystemLogs(next).map(x => x.message)).toEqual(['two']);
});
it('bounded system buffers support arbitrary literal Desktop IDs and exact cleanup', () => {
    const logger = new DesktopLogger({ maxSystemLogs: 1 }), id = '__proto__' as any;
    logger.logSystem(id, 'old');logger.logSystem(id, 'new', 'warn');
    expect(logger.getSystemLogs(id)).toEqual([{ timestamp: expect.any(Number), message: 'new', level: 'warn' }]);
    logger.cleanup(id);expect(logger.getSystemLogs(id)).toEqual([]);
});
