/**
 * AOTUIError Unit Tests
 * 
 * @module @aotui/runtime/spi/core/errors.test
 */

import { describe, it, expect } from 'vitest';
import { AOTUIError } from './errors.js';

describe('AOTUIError', () => {
    describe('constructor', () => {
        it('should create error with correct code and message', () => {
            const err = new AOTUIError('DESKTOP_NOT_FOUND', { desktopId: 'abc123' });

            expect(err.code).toBe('DESKTOP_NOT_FOUND');
            expect(err.message).toContain('abc123');
            expect(err.message).toContain('Desktop');
            expect(err.name).toBe('AOTUIError');
        });

        it('should include context in error', () => {
            const context = { desktopId: 'desk_1', extra: 'info' };
            const err = new AOTUIError('DESKTOP_DISPOSED', context);

            expect(err.context).toEqual(context);
        });

        it('should set timestamp', () => {
            const before = Date.now();
            const err = new AOTUIError('RUNTIME_SHUTDOWN');
            const after = Date.now();

            expect(err.timestamp).toBeGreaterThanOrEqual(before);
            expect(err.timestamp).toBeLessThanOrEqual(after);
        });

        it('should handle missing context values gracefully', () => {
            const err = new AOTUIError('DESKTOP_NOT_FOUND', {});
            expect(err.message).toContain('unknown');
        });
    });

    describe('app factory export contract', () => {
        it('describes the sole managed default-export contract', () => {
            const err = new AOTUIError('APP_INVALID_EXPORT', { modulePath: './app.js' });
            expect(err.message).toBe("App module './app.js' must default-export an App factory created by createApp or createTUIApp");
        });
    });

    describe('instanceof chain', () => {
        it('should be instanceof Error', () => {
            const err = new AOTUIError('RUNTIME_SHUTDOWN');
            expect(err instanceof Error).toBe(true);
        });

        it('should be instanceof AOTUIError', () => {
            const err = new AOTUIError('RUNTIME_SHUTDOWN');
            expect(err instanceof AOTUIError).toBe(true);
        });
    });
});
