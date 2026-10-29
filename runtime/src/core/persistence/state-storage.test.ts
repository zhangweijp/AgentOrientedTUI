import { describe, expect, it } from 'vitest';
import { canonicalJson, utf8Size } from '../snapshot/json.js';
import { captureStateAddress, captureStateMutationResult, captureStateReadResult, captureStateReleaseResult, captureStateValue, decodeStateRecord, encodeStateRecord, requireStateLimits } from './state-storage.js';
const limits = { maxDepth: 8, maxNodes: 100, maxValueBytes: 256, maxRecordBytes: 512, maxAddressBytes: 64 };
describe('A02/A03 strict values and explicit capacities', () => {
    it('uses exact tuple/identity bytes and no delimiter/path interpretation', () => {
        const a = captureStateAddress({ namespace: 'a:b', key: 'c' }, 64), b = captureStateAddress({ namespace: 'a', key: 'b:c' }, 64);
        expect(a.status).toBe('captured');expect(b.status).toBe('captured');if (a.status !== 'captured' || b.status !== 'captured') return;
        expect(a.identity).not.toBe(b.identity);expect(a.bytes).toBe(utf8Size('["a:b","c"]'));
        expect(captureStateAddress(a.address, a.bytes).status).toBe('captured');expect(captureStateAddress(a.address, a.bytes + 1).status).toBe('captured');expect(captureStateAddress(a.address, a.bytes - 1).status).toBe('rejected');
        expect(captureStateAddress({ namespace: '', key: 'x' }, 64).status).toBe('rejected');
    });
    it('copies shared JSON without freezing callers, including literal reserved/value properties', () => {
        const shared = { value: [1, true, null] }, original = { a: shared, b: shared };
        const result = captureStateValue(original, limits);expect(result.status).toBe('captured');if (result.status !== 'captured') return;
        shared.value[0] = 9;expect(canonicalJson(result.snapshot.value)).toBe('{"a":{"value":[1,true,null]},"b":{"value":[1,true,null]}}');
        expect(Object.isFrozen(shared)).toBe(false);expect(Object.isFrozen(result.snapshot.value)).toBe(true);
    });
    it.each(['undefined', 'function', 'symbol', 'bigint', 'infinite', 'nan', 'cycle', 'sparse', 'getter', 'hidden', 'prototype', 'symbol-key'])('refuses %s without evaluating getters or exposing values', kind => {
        let reads = 0;const bad: any = {};let value: any = bad;
        if (kind === 'undefined') value = undefined;if (kind === 'function') value = () => {};if (kind === 'symbol') value = Symbol();if (kind === 'bigint') value = 1n;if (kind === 'infinite') value = Infinity;if (kind === 'nan') value = NaN;
        if (kind === 'cycle') bad.self = bad;if (kind === 'sparse') value = Array(2);if (kind === 'getter') Object.defineProperty(bad, 'private', { enumerable: true, get() { reads++;return 'PRIVATE_STATE_SENTINEL'; } });
        if (kind === 'hidden') Object.defineProperty(bad, 'hidden', { value: 'PRIVATE_STATE_SENTINEL' });if (kind === 'prototype') value = new Date();if (kind === 'symbol-key') bad[Symbol()] = 1;
        const result = captureStateValue(value, limits);expect(result.status).toBe('rejected');expect(reads).toBe(0);expect(JSON.stringify(result)).not.toContain('PRIVATE_STATE_SENTINEL');
    });
    it('honors exact numeric/string/node/depth boundaries without the helper estimate becoming a smaller budget', () => {
        expect(captureStateValue(0, { ...limits, maxNodes: 1, maxValueBytes: 1 }).status).toBe('captured');
        const bytes = utf8Size(JSON.stringify('😀'));for (const maxValueBytes of [bytes - 1, bytes, bytes + 1]) expect(captureStateValue('😀', { ...limits, maxValueBytes }).status).toBe(maxValueBytes < bytes ? 'rejected' : 'captured');
        for (const maxNodes of [1, 2, 3]) expect(captureStateValue({ a: 1 }, { ...limits, maxNodes }).status).toBe(maxNodes === 1 ? 'rejected' : 'captured');
        for (const maxDepth of [1, 2, 3]) expect(captureStateValue({ a: { b: 1 } }, { ...limits, maxDepth }).status).toBe(maxDepth === 1 ? 'rejected' : 'captured');
    });
    it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid explicit capacity %s and copies valid configuration', value => {
        expect(() => requireStateLimits({ n: value }, ['n'])).toThrow('INVALID_INPUT');const source = { n: 1 }, copy = requireStateLimits(source, ['n']);source.n = 2;expect(copy.n).toBe(1);
    });
});
import { stateIssue } from './state-storage.js';
describe('Node adapter environment-independent issue codes', () => {
    it.each(['ADDRESS_UNSUPPORTED', 'RESOURCE_UNSUPPORTED'] as const)('captures fixed %s without adapter details', code => {
        const issue = stateIssue(code);expect(Object.isFrozen(issue)).toBe(true);
        expect(captureStateReadResult({ status: 'failed', issue: { code, message: 'PRIVATE_PATH_SENTINEL' } }, 10)).toEqual({ status: 'failed', issue });
        expect(captureStateMutationResult({ status: 'failed', effects: 'none', issue: { code, message: 'PRIVATE_PATH_SENTINEL' } })).toEqual({ status: 'failed', effects: 'none', issue });
        expect(JSON.stringify(issue)).not.toContain('PRIVATE_PATH_SENTINEL');
    });
});
describe('A04/Q01/Q02 record format and bounded receipts', () => {
    it('decodes only one wrapper and preserves raw business value fields', () => {
        const business = { version: 7, updatedAt: 9, value: { value: 'business' } }, raw = decodeStateRecord(JSON.stringify({ value: { value: 'business' } }), limits), wrapped = decodeStateRecord(JSON.stringify({ version: 1, updatedAt: 5, value: business }), limits);
        expect(raw).toMatchObject({ status: 'found', format: 'legacy-raw', snapshot: { value: { value: { value: 'business' } } } });
        expect(wrapped).toMatchObject({ status: 'found', format: 'v1', snapshot: { value: business } });
        const captured = captureStateValue(business, limits);if (captured.status !== 'captured') throw Error('fixture');const encoded = encodeStateRecord(captured.snapshot, 1, limits);expect(encoded.status).toBe('encoded');
        if (encoded.status === 'encoded') expect(decodeStateRecord(encoded.text, limits)).toMatchObject({ status: 'found', format: 'v1', snapshot: { value: business } });
    });
    it.each(['{', '{"version":2,"updatedAt":1,"value":0}', '{"version":2,"updatedAt":1,"value":0,"extra":1}', '{"version":1,"updatedAt":1,"value":0,"extra":1}', '{"version":1,"updatedAt":null,"value":0}', '1e999'])('blocks unsupported/corrupt original text %s', text => { expect(decodeStateRecord(text, limits).status).toBe('rejected'); });
    it('checks raw and complete encoded bytes separately from the value', () => {
        const text = '{"version":1,"updatedAt":1,"value":0}', bytes = utf8Size(text);expect(decodeStateRecord(text, { ...limits, maxRecordBytes: bytes - 1 }).status).toBe('rejected');expect(decodeStateRecord(text, { ...limits, maxRecordBytes: bytes }).status).toBe('found');
        const captured = captureStateValue(0, limits);if (captured.status !== 'captured') throw Error('fixture');const encoded = encodeStateRecord(captured.snapshot, 1, limits);if (encoded.status !== 'encoded') throw Error('fixture');
        expect(encodeStateRecord(captured.snapshot, 1, { ...limits, maxRecordBytes: encoded.bytes - 1 }).status).toBe('rejected');expect(encodeStateRecord(captured.snapshot, 1, { ...limits, maxRecordBytes: encoded.bytes }).status).toBe('encoded');expect(encodeStateRecord(captured.snapshot, NaN, limits).status).toBe('rejected');
    });
    it('copies fixed bounded issues, rejects accessor receipts, and never upgrades uncertain writes', () => {
        let reads = 0;const value = { status: 'found', get text() { reads++;return 'PRIVATE_STATE_SENTINEL'; } };
        expect(captureStateReadResult(value, 20)).toMatchObject({ status: 'failed' });expect(reads).toBe(0);
        const failed = { status: 'failed', effects: 'none', issue: { code: 'PERMISSION_DENIED', message: 'PRIVATE_STATE_SENTINEL' } };
        expect(captureStateMutationResult(failed)).toMatchObject({ status: 'failed', effects: 'none', issue: { code: 'PERMISSION_DENIED' } });expect(JSON.stringify(captureStateMutationResult(failed))).not.toContain('PRIVATE_STATE_SENTINEL');
        for (const result of [{}, { status: 'failed', issue: { code: 'IO_FAILED' } }, { status: 'applied', extra: true }]) expect(captureStateMutationResult(result).status).toBe('unknown');
        expect(captureStateReleaseResult({ status: 'released', extra: true }).status).toBe('unknown');
    });
});
