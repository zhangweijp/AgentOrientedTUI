import { describe, expect, it } from 'vitest';
import { initializationError, initializationFailure } from './initialization-error.js';

describe('bounded local installation diagnostics', () => {
    it.each(['INIT', 'OPEN'] as const)('preserves native Error details across ordinary IPC data for %s', phase => {
        const original = new TypeError('private-installation-sentinel');
        const expected = { name: original.name, message: original.message, stack: original.stack };
        const record = initializationFailure(phase, original);
        original.message = 'changed after capture';
        const error = initializationError(structuredClone(record), 'app', phase);
        expect(error).toMatchObject({ code: phase === 'INIT' ? 'E_INIT_FAILED' : 'E_OPEN_FAILED',
            appId: 'app', phase, cause: expected });
        expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
        expect(JSON.stringify(error)).not.toContain('private-installation-sentinel');
        expect(Object.isFrozen(record.diagnostic)).toBe(true);
    });

    it('clips only diagnostic strings and marks truncation within the existing IPC capture boundary', () => {
        const record = initializationFailure('OPEN', { name: 'N'.repeat(200), message: '\0'.repeat(3000), stack: '\0'.repeat(9000) });
        expect(record.diagnostic).toMatchObject({ name: 'N'.repeat(128), message: '\0'.repeat(2048),
            stack: '\0'.repeat(8192), truncated: true });
        expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(64 * 1024);
        expect(initializationError(structuredClone(record), 'app', 'OPEN').cause).toEqual(record.diagnostic);
    });

    it('does not evaluate incoming accessors or retain malformed transport data', () => {
        let reads = 0;
        const input = { code: 'E_INIT_FAILED', message: 'App initialization failed',
            diagnostic: { phase: 'INIT', name: 'Error', get message() { reads++; return 'private'; } } };
        const error = initializationError(input, 'app', 'INIT');
        expect(reads).toBe(0); expect(error.cause).toBeUndefined();
        expect(error).toMatchObject({ code: 'E_INIT_FAILED', phase: 'INIT', appId: 'app' });
    });

    it('takes phase from the pending request and drops a mismatched diagnostic', () => {
        const error = initializationError(initializationFailure('OPEN', new Error('private')), 'bound_app', 'INIT');
        expect(error).toMatchObject({ phase: 'INIT', appId: 'bound_app' });
        expect(error.cause).toBeUndefined();
    });

    it('captures non-Error throws without serializing application payload or invoking toJSON', () => {
        let jsonCalls = 0;
        const record = initializationFailure('INIT', { name: 'AppError', message: 'declared failure',
            privatePayload: { secret: 'not-a-diagnostic' }, toJSON() { jsonCalls++; return 'wrong'; } });
        expect(JSON.stringify(record)).not.toContain('not-a-diagnostic'); expect(jsonCalls).toBe(0);
        expect(initializationError(record, 'app', 'INIT').cause).toMatchObject({ name: 'AppError', message: 'declared failure' });
        expect(initializationFailure('INIT', 'thrown text').diagnostic?.message).toBe('thrown text');
    });
});
