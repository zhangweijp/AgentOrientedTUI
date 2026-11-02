import { describe, expect, it } from 'vitest';
import { captureBoundedJson, mapExecutionFact } from './invocation-outcome.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
const limits = { maxDepth: 52, maxNodes: 32032, maxApproxBytes: 520 * 1024, maxCanonicalBytes: 520 * 1024 };
const error = { code: 'E_INVALID_ARGS', message: 'Business failure', context: { synthetic: true } };
describe('B2 bounded JSON byte measurement', () => {
    it('matches canonical UTF-8 bytes for escaped, Unicode, numeric and unusual object keys', () => {
        const record = Object.create(null) as Record<string, unknown>;
        record['10'] = 'line\u2028 paragraph\u2029 quote " slash \\ nul \u0000 lone \uD800';
        record['2'] = -0;
        record.__proto__ = { nested: [null, true, false, 1e21, 1e-7, '漢字😀'] };
        record.toJSON = 'ordinary JSON data';
        record.constructor = { empty: [] };
        const input = { record, tuple: [null, true, false, -0, 1e21, 1e-7, '\uDFFF'] };
        const copied = copyJson(input, limits);
        const canonicalBytes = utf8Size(canonicalJson(copied));
        const nativeBytes = utf8Size(JSON.stringify(copied)!);

        expect(nativeBytes).toBe(canonicalBytes);
        expect(captureBoundedJson(input, { ...limits, maxCanonicalBytes: canonicalBytes }).bytes).toBe(canonicalBytes);
        expect(() => captureBoundedJson(input, { ...limits, maxCanonicalBytes: canonicalBytes - 1 }))
            .toThrow(new RangeError('Bounded JSON capacity exceeded'));
        expect(Object.isFrozen(copied)).toBe(true);
        expect(Object.isFrozen((copied as { record: object }).record)).toBe(true);
        expect(Object.isFrozen((copied as { tuple: readonly unknown[] }).tuple)).toBe(true);
        expect(Object.getPrototypeOf((copied as { record: object }).record)).toBeNull();
        expect(Object.getPrototypeOf((copied as { tuple: readonly unknown[] }).tuple)).toBe(Array.prototype);
    });

    it.each(['array', 'object'] as const)('does not invoke inherited %s toJSON while capturing detached JSON', prototype => {
        const input = { nested: [{ value: '漢字😀\uD800' }, 1e21, -0] };
        const expected = utf8Size(canonicalJson(copyJson(input, limits)));
        const target = prototype === 'array' ? Array.prototype : Object.prototype;
        const previous = Object.getOwnPropertyDescriptor(target, 'toJSON');
        let getterReads = 0, functionCalls = 0;
        const descriptor: PropertyDescriptor = prototype === 'array'
            ? { configurable: true, get() { getterReads++; return () => { functionCalls++; return 'changed'; }; } }
            : { configurable: true, writable: true, value() { functionCalls++; return 'changed'; } };
        let result: ReturnType<typeof captureBoundedJson> | undefined;
        try {
            Object.defineProperty(target, 'toJSON', descriptor);
            result = captureBoundedJson(input, { ...limits, maxCanonicalBytes: expected });
        } finally {
            if (previous) Object.defineProperty(target, 'toJSON', previous);
            else Reflect.deleteProperty(target, 'toJSON');
        }
        expect(getterReads).toBe(0);
        expect(functionCalls).toBe(0);
        expect(result?.bytes).toBe(expected);
    });
});

describe('B2 neutral fact mapping', () => {
    it.each([
        [{ kind: 'operation-result', phase: 'not-entered', result: { success: false, error } }, 'rejected', 'not-entered'],
        [{ kind: 'operation-result', phase: 'entered-returned', result: { success: false, error } }, 'unknown', 'entered-returned'],
        [{ kind: 'operation-result', phase: 'entered-returned', result: { success: false, error }, failureEffects: 'none' }, 'failed', 'entered-returned'],
        [{ kind: 'operation-result', phase: 'entered-returned', result: { success: false, error }, failureEffects: 'partial' }, 'failed', 'entered-returned'],
        [{ kind: 'operation-result', phase: 'entered-returned', result: { success: true, data: { value: 7 }, error } }, 'succeeded', 'entered-returned'],
        [{ kind: 'action', phase: 'not-entered', outcome: { status: 'rejected', code: 'BUSINESS', message: 'Declined' } }, 'rejected', 'not-entered'],
        [{ kind: 'action', phase: 'entered-returned', outcome: { status: 'rejected', code: 'BUSINESS', message: 'Declined' } }, 'unknown', 'entered-returned'],
        [{ kind: 'action', phase: 'entered-returned', outcome: { status: 'failed', code: 'BUSINESS', message: 'Declined', effects: 'partial' } }, 'failed', 'entered-returned'],
        [{ kind: 'action', phase: 'entered-returned', outcome: { status: 'accepted', operationId: 'op' } }, 'accepted', 'entered-returned'],
    ])('preserves the trusted phase and maps %j', (fact, status, phase) => {
        const mapped = mapExecutionFact(fact, limits); expect(mapped.outcome.status).toBe(status); expect(mapped.executionPhase).toBe(phase);
        if (fact.kind === 'operation-result') {
            const outcome = mapped.outcome;
            if (outcome.status === 'succeeded') expect(outcome.value).toEqual(fact.result);
            else if ('details' in outcome) expect(outcome.details).toMatchObject({ result: fact.result });
        }
    });
    it.each([
        { kind: 'operation-result', phase: 'not-entered', result: { success: true } },
        { kind: 'operation-result', phase: 'entered-returned', result: { success: true }, failureEffects: 'none' },
        { kind: 'operation-result', phase: 'entered-returned', result: { success: false, extra: true } },
        { kind: 'action', phase: 'not-entered', outcome: { status: 'succeeded', value: 1 } },
        { kind: 'action', phase: 'entered-returned', outcome: { status: 'failed', effects: 'unknown', code: 'x', message: 'x' } },
        { kind: 'unknown', extra: 'secret' }, { success: false },
    ])('does not infer safe effects from invalid facts %j', fact => {
        expect(mapExecutionFact(fact, limits)).toMatchObject({ executionPhase: 'unknown', queryTerminal: false, outcome: { status: 'unknown', code: 'ACTION_OUTCOME_UNKNOWN' } });
    });
    it('does not read getters or salvage unbounded business output', () => {
        let reads = 0;
        const fact = { get kind() { reads++; throw new Error('secret'); } };
        expect(mapExecutionFact(fact, limits).outcome.status).toBe('unknown'); expect(reads).toBe(0);
        expect(mapExecutionFact({ kind: 'action', phase: 'entered-returned', outcome: { status: 'succeeded', value: '\u0000'.repeat(100000) } }, limits).outcome.status).toBe('unknown');
    });
});

describe('R1-F01: OperationResult lexical compatibility', () => {
    const errors = [
        { code: 'E_RESULT', message: '' }, { code: 'E_RESULT', message: ' \t' },
        { code: ' \t', message: 'business error' }, { code: 'E_RESULT', message: 'business error' },
    ];
    const variants = [
        { phase: 'not-entered', success: false, status: 'rejected' },
        { phase: 'entered-returned', success: false, failureEffects: 'none', status: 'failed' },
        { phase: 'entered-returned', success: false, status: 'unknown' },
        { phase: 'entered-returned', success: true, status: 'succeeded' },
    ] as const;
    it.each(errors.flatMap(error => variants.map(variant => ({ error, variant }))))('preserves %j as detached business JSON', ({ error, variant }) => {
        const result = { success: variant.success, data: { retained: 'data' }, error: { ...error, context: { retained: 'context' } } };
        const original = JSON.stringify(result);
        const mapped = mapExecutionFact({ kind: 'operation-result', phase: variant.phase, result,
            ...('failureEffects' in variant ? { failureEffects: variant.failureEffects } : {}) }, limits);
        expect(mapped.executionPhase).toBe(variant.phase); expect(mapped.outcome.status).toBe(variant.status);
        const recovered = mapped.outcome.status === 'succeeded' ? mapped.outcome.value
            : 'details' in mapped.outcome && mapped.outcome.details?.kind === 'operation-result' ? mapped.outcome.details.result : undefined;
        expect(JSON.stringify(recovered)).toBe(original); expect(recovered).not.toBe(result); expect(Object.isFrozen(recovered)).toBe(true);
        result.data.retained = 'changed'; result.error.context.retained = 'changed';
        expect(JSON.stringify(recovered)).toBe(original);
    });
    it.each([
        { success: false, error: { code: '', message: '' } },
        { success: false, error: { code: 'E', message: null } },
        { success: false, error: { code: 'E', message: 1 } },
        { success: false, error: { code: 'E', message: '', extra: true } },
        { success: false, error: { code: 'E', message: '', context: [] } },
        { success: false, error: { code: 'E', message: '', context: null } },
        { success: false, data: [] }, { success: false, data: null }, { success: false, extra: true },
    ])('still rejects malformed compatible results %j', result => {
        expect(mapExecutionFact({ kind: 'operation-result', phase: 'entered-returned', result }, limits))
            .toMatchObject({ executionPhase: 'unknown', queryTerminal: false, outcome: { status: 'unknown', code: 'ACTION_OUTCOME_UNKNOWN' } });
    });
    it('does not read an error getter or retain a result that exceeds the fact profile', () => {
        let reads = 0;
        const result = { success: false, error: { code: 'E', get message() { reads++; return ''; } } };
        expect(mapExecutionFact({ kind: 'operation-result', phase: 'not-entered', result }, limits).executionPhase).toBe('unknown');
        expect(reads).toBe(0);
        const oversized = { success: false, error: { code: 'E', message: '', context: { value: '\u0000'.repeat(100000) } } };
        expect(mapExecutionFact({ kind: 'operation-result', phase: 'entered-returned', result: oversized }, limits).outcome)
            .toEqual({ status: 'unknown', code: 'ACTION_OUTCOME_UNKNOWN', message: 'The final business outcome could not be established' });
    });
    it.each(errors.slice(0, 3))('retains native ActionOutcome nonempty rules for %j', error => {
        for (const status of ['rejected', 'unknown', 'failed']) {
            const outcome = { status, code: error.code, message: error.message, ...(status === 'failed' ? { effects: 'none' } : {}) };
            expect(mapExecutionFact({ kind: 'action', phase: 'entered-returned', outcome }, limits))
                .toMatchObject({ executionPhase: 'unknown', queryTerminal: false, outcome: { code: 'ACTION_OUTCOME_UNKNOWN' } });
        }
    });
});
