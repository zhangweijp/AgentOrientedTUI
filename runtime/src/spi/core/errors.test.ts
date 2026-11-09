/**
 * AOTUIError Unit Tests
 * 
 * @module @aotui/runtime/spi/core/errors.test
 */

import { describe, it, expect } from 'vitest';
import {
    ERROR_CODES,
    AOTUIError,
} from './errors.js';
import type { ErrorCode } from './errors.js';

describe('ERROR_CODES', () => {
    it('should have all expected domains', () => {
        // Desktop
        expect(ERROR_CODES.DESKTOP_NOT_FOUND).toBe('DESKTOP_NOT_FOUND');
        expect(ERROR_CODES.DESKTOP_DISPOSED).toBe('DESKTOP_DISPOSED');
        expect(ERROR_CODES).not.toHaveProperty('DESKTOP_LOCKED');

        // App
        expect(ERROR_CODES.APP_NOT_FOUND).toBe('APP_NOT_FOUND');
        expect(ERROR_CODES.APP_INVALID_EXPORT).toBe('APP_INVALID_EXPORT');

        // App registration
        expect(ERROR_CODES.APP_ALREADY_REGISTERED).toBe('APP_ALREADY_REGISTERED');

        // Worker
        expect(ERROR_CODES.WORKER_NOT_STARTED).toBe('WORKER_NOT_STARTED');

        // Generic
        expect(ERROR_CODES.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    });

    it('should be readonly (type-level immutability)', () => {
        // `as const` provides compile-time immutability, not runtime
        // This test verifies the values are correct strings (not objects that could be mutated)
        const codes = Object.values(ERROR_CODES);
        codes.forEach(code => {
            expect(typeof code).toBe('string');
        });

        // Verify specific codes haven't changed
        expect(ERROR_CODES.DESKTOP_NOT_FOUND).toBe('DESKTOP_NOT_FOUND');
    });

    it('does not publish retired ViewFactory, ViewLink, or Tool dispatcher codes', () => {
        for (const code of [
            'VIEW_NOT_FOUND',
            'VIEW_PARENT_NOT_FOUND',
            'VIEW_ROOT_EXISTS',
            'VIEW_MOUNTABLE_NOT_FOUND',
            'VIEW_INVALID_FACTORY',
            'LINK_DUPLICATE',
            'LINK_NOT_FOUND',
            'TOOL_NOT_FOUND',
            'TOOL_NO_HANDLER',
            'TOOL_REQUIRES_CONTEXT',
        ]) {
            expect(ERROR_CODES).not.toHaveProperty(code);
        }
    });

    it('does not publish error codes with no Runtime producer', () => {
        for (const code of [
            'APP_LOAD_FAILED', 'APP_INVALID_MANIFEST', 'VIEW_DUPLICATE', 'TOOL_INVALID_ARGS',
            'WORKER_TIMEOUT', 'WORKER_TERMINATED', 'SNAPSHOT_NOT_FOUND', 'SNAPSHOT_EXPIRED',
            'CONTEXT_NOT_FOUND', 'NOT_IMPLEMENTED', 'EXECUTION_FAILED',
        ]) {
            expect(ERROR_CODES).not.toHaveProperty(code);
        }
    });
});

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
            const err = new AOTUIError('INTERNAL_ERROR');
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
            expect(err.message).toBe("App module './app.js' must default-export a managed TUIAppFactory component factory");
        });
    });

    describe('instanceof chain', () => {
        it('should be instanceof Error', () => {
            const err = new AOTUIError('INTERNAL_ERROR');
            expect(err instanceof Error).toBe(true);
        });

        it('should be instanceof AOTUIError', () => {
            const err = new AOTUIError('INTERNAL_ERROR');
            expect(err instanceof AOTUIError).toBe(true);
        });
    });
});

describe('Error Code Coverage', () => {
    // Ensure all error codes have message templates
    it('should have message templates for all error codes', () => {
        const allCodes = Object.values(ERROR_CODES) as ErrorCode[];

        for (const code of allCodes) {
            const err = new AOTUIError(code, {});
            // Should not just return the code as-is
            expect(err.message).toBeDefined();
            expect(err.message.length).toBeGreaterThan(0);
        }
    });
});
