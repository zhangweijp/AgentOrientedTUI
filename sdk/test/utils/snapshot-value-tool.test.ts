import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeSnapshotValueTool } from '../../src/utils/snapshot-value-tool.js';
import { validateArgs } from '../../src/utils/validateArgs.js';
import type { OperationResult, ParamDef, ParamSchema } from '../../src/operation/types.js';

const SENTINEL = 'W03_A_PRIVATE_PAYLOAD_7f392c_秘密';
const ref = (): ParamDef => ({ type: 'reference', required: true, refSource: 'snapshot-value-v1' });
const schema = (ordinary: ParamSchema = {}, slot = 'file'): ParamSchema => Object.fromEntries([[slot, ref()], ...Object.entries(ordinary)]);
const input = () => ({ file: { text: SENTINEL, nested: [{ deep: true }] } });
function diagnostics(result: any): Array<{ param: string; reason: string }> { return result.result.error?.context?.diagnostics ?? []; }
function safe(result: any) {
    const text = JSON.stringify(result);
    for (const word of [SENTINEL, 'receivedArgs', 'received', 'rawArgs', 'effectiveArgs']) expect(text).not.toContain(word);
    expect(result.result.error.message.length).toBeLessThanOrEqual(512);
    expect(diagnostics(result).length).toBeLessThanOrEqual(16);
    for (const item of diagnostics(result)) {
        expect(Object.keys(item).sort()).toEqual(['param', 'reason']);
        expect(item.param.length).toBeLessThanOrEqual(128); expect(item.reason.length).toBeLessThanOrEqual(256);
    }
}
function noUndefined(value: unknown) {
    expect(value).not.toBeUndefined();
    if (value && typeof value === 'object') for (const child of Object.values(value)) noUndefined(child);
}
afterEach(() => { vi.restoreAllMocks(); });

describe('snapshot-value internal SDK invocation: subset and identity', () => {
    it('passes the original effective values, unknown keys and absence through without defaults or conversion', async () => {
        const params = schema({ missing: { type: 'string', default: 'not injected' }, choice: { type: 'enum', options: ['1'] },
            oldRef: { type: 'reference' }, list: { type: 'array', itemType: 'reference' } });
        const args = { ...input(), choice: 1, oldRef: 'unchanged-id', list: ['id', { a: 1 }], extra: { a: [1, false, null] }, phase: 'not-entered' };
        const before = Object.getOwnPropertyDescriptors(args); const result: OperationResult = { success: true };
        const handler = vi.fn(actual => { expect(actual).toBe(args); expect(actual.file).toBe(args.file); return result; });
        const terminal = await invokeSnapshotValueTool(params, args, handler);
        expect(terminal.phase).toBe('entered-returned'); expect(terminal.result).toBe(result);
        expect(handler).toHaveBeenCalledOnce(); expect(Object.getOwnPropertyDescriptors(args)).toEqual(before);
        expect(Object.hasOwn(args, 'missing')).toBe(false); expect(args.choice).toBe(1); noUndefined(terminal);
        expect(Object.keys(terminal.result)).toEqual(['success']);
    });
    it.each([['zero', {}], ['optional', { file: { ...ref(), required: false } }],
        ['required absent', { file: { type: 'reference', refSource: 'snapshot-value-v1' } }],
        ['multiple', { file: ref(), another: ref() }], ['wrong mode', { file: { ...ref(), refSource: 'unknown' } }],
        ['wrong type', { file: { ...ref(), type: 'object' } }]])('rejects the unsupported %s subset before business', async (_name, params) => {
        const handler = vi.fn(() => ({ success: true }));
        const result = await invokeSnapshotValueTool(params as ParamSchema, input(), handler);
        expect(result).toMatchObject({ phase: 'not-entered', result: { success: false, error: { code: 'REF_CONTRACT_UNSUPPORTED' } } });
        expect(handler).not.toHaveBeenCalled(); safe(result); noUndefined(result);
    });
    it('does not treat an inherited refSource or a nested declaration as a top-level opt-in', async () => {
        const inherited = Object.assign(Object.create({ refSource: 'snapshot-value-v1' }), { type: 'reference', required: true });
        const handler = vi.fn(() => ({ success: true }));
        expect(await invokeSnapshotValueTool({ file: inherited }, input(), handler)).toMatchObject({ phase: 'not-entered', result: { error: { code: 'REF_CONTRACT_UNSUPPORTED' } } });
        expect(await invokeSnapshotValueTool({ outer: { type: 'object', nested: ref() } } as any, input(), handler))
            .toMatchObject({ phase: 'not-entered', result: { error: { code: 'REF_CONTRACT_UNSUPPORTED' } } });
        expect(handler).not.toHaveBeenCalled();
    });
    it.each(['raw-id', SENTINEL, null, [], [1], 0, false])('rejects a non-object Ref %#', async value => {
        const handler = vi.fn(() => ({ success: true }));
        const result = await invokeSnapshotValueTool(schema(), { file: value }, handler);
        expect(result).toMatchObject({ phase: 'not-entered', result: { error: { code: 'E_INVALID_ARGS' } } });
        expect(handler).not.toHaveBeenCalled(); safe(result); noUndefined(result);
    });
    it('rejects a missing Ref even when the parameter has a default', async () => {
        const params = schema(); params.file.default = { value: 'default' };
        const handler = vi.fn(() => ({ success: true }));
        const result = await invokeSnapshotValueTool(params, {}, handler);
        expect(result.phase).toBe('not-entered'); expect(result.result.error?.code).toBe('E_INVALID_ARGS');
        expect(handler).not.toHaveBeenCalled(); safe(result);
    });
    it.each(['__proto__', 'constructor', 'toJSON', ''])('preserves an own special Ref slot %s and nested JSON', async slot => {
        const payload = Object.assign(Object.create(null), { text: SENTINEL });
        const args = Object.fromEntries([[slot, payload], ['unknown', JSON.parse('{"__proto__":{"x":1},"constructor":"n","toJSON":"text"}')]]);
        const handler = vi.fn(actual => { expect(actual).toBe(args); expect(actual[slot]).toBe(payload); return { success: true }; });
        expect((await invokeSnapshotValueTool(schema({}, slot), args, handler)).phase).toBe('entered-returned');
        expect(handler).toHaveBeenCalledOnce(); expect(Object.hasOwn(args, slot)).toBe(true);
    });
    it.each(['__proto__', 'constructor', 'toJSON'])('does not read a missing %s Ref slot from the prototype', async slot => {
        const handler = vi.fn(() => ({ success: true })); const args = {};
        const result = await invokeSnapshotValueTool(schema({}, slot), args, handler);
        expect(result.phase).toBe('not-entered'); expect(result.result.error?.code).toBe('E_INVALID_ARGS');
        expect(Object.hasOwn(args, slot)).toBe(false); expect(handler).not.toHaveBeenCalled(); safe(result);
    });
    it('preserves own special ordinary fields and treats absent required fields as missing', async () => {
        const params = schema(Object.fromEntries([['__proto__', { type: 'object', required: true }],
            ['constructor', { type: 'number', required: true }], ['toJSON', { type: 'string', required: true }]]) as ParamSchema);
        const args = JSON.parse('{"file":{},"__proto__":{"safe":true},"constructor":4,"toJSON":"text","extra":null}');
        const handler = vi.fn(actual => { expect(actual).toBe(args); return { success: true }; });
        expect((await invokeSnapshotValueTool(params, args, handler)).phase).toBe('entered-returned');
        const absent = await invokeSnapshotValueTool(params, input(), handler);
        expect(absent.phase).toBe('not-entered'); expect(diagnostics(absent).map(d => d.param)).toEqual(['__proto__', 'constructor', 'toJSON']);
        expect(handler).toHaveBeenCalledOnce(); safe(absent);
    });
});

const values: unknown[] = [null, true, false, 0, 2, 'hi', '', {}, [], [1], { x: [1, null] }];
const basicCases = ['string', 'number', 'boolean', 'object', 'reference'].flatMap(type => values.map(value => ({ type, value })));
const ordinaryCases: Array<{ name: string; def: ParamDef; value: unknown; missing?: boolean }> = [
    { name: 'required missing', def: { type: 'string', required: true }, value: null, missing: true },
    { name: 'optional missing', def: { type: 'number', default: 9 }, value: null, missing: true },
    { name: 'optional null', def: { type: 'string' }, value: null },
    { name: 'array all strings', def: { type: 'array', itemType: 'string' }, value: ['a', 'b'] },
    { name: 'array item mismatch', def: { type: 'array', itemType: 'number' }, value: [1, 'bad'] },
    { name: 'array boolean', def: { type: 'array', itemType: 'boolean' }, value: [true, false] },
    { name: 'array objects', def: { type: 'array', itemType: 'object' }, value: [{}] },
    { name: 'array nested array not object', def: { type: 'array', itemType: 'object' }, value: [[]] },
    { name: 'array references', def: { type: 'array', itemType: 'reference' }, value: ['id', {}] },
    { name: 'array unconstrained', def: { type: 'array' }, value: [1, null, false] },
    { name: 'empty array', def: { type: 'array', itemType: 'number' }, value: [] },
    { name: 'array type mismatch', def: { type: 'array' }, value: 'text' },
    { name: 'enum string', def: { type: 'enum', options: ['a'] }, value: 'a' },
    { name: 'enum invalid', def: { type: 'enum', options: ['a'] }, value: 'b' },
    { name: 'enum String(number)', def: { type: 'enum', options: ['2'] }, value: 2 },
    { name: 'enum String(boolean)', def: { type: 'enum', options: ['false'] }, value: false },
    { name: 'enum String(object)', def: { type: 'enum', options: ['[object Object]'] }, value: {} },
    { name: 'enum String(array)', def: { type: 'enum', options: ['a,b'] }, value: ['a', 'b'] },
    { name: 'enum options absent', def: { type: 'enum' }, value: 'a' },
    { name: 'string minimum equal', def: { type: 'string', constraints: { minLength: 2 } }, value: 'ab' },
    { name: 'string minimum fail', def: { type: 'string', constraints: { minLength: 2 } }, value: 'a' },
    { name: 'string maximum equal', def: { type: 'string', constraints: { maxLength: 2 } }, value: 'ab' },
    { name: 'string maximum fail', def: { type: 'string', constraints: { maxLength: 2 } }, value: 'abc' },
    { name: 'pattern accept', def: { type: 'string', constraints: { pattern: '^a+$' } }, value: 'aa' },
    { name: 'pattern reject', def: { type: 'string', constraints: { pattern: '^a+$' } }, value: 'b' },
    { name: 'invalid regex remains skipped', def: { type: 'string', constraints: { pattern: '[' } }, value: 'anything' },
    { name: 'minimum number equal', def: { type: 'number', constraints: { min: 2 } }, value: 2 },
    { name: 'minimum number fail', def: { type: 'number', constraints: { min: 2 } }, value: 1 },
    { name: 'maximum number equal', def: { type: 'number', constraints: { max: 2 } }, value: 2 },
    { name: 'maximum number fail', def: { type: 'number', constraints: { max: 2 } }, value: 3 },
    { name: 'array length minimum', def: { type: 'array', constraints: { minLength: 2 } }, value: [1] },
    { name: 'array length maximum', def: { type: 'array', constraints: { maxLength: 1 } }, value: [1, 2] },
    { name: 'multiple constraints', def: { type: 'number', constraints: { min: 10, max: 0 } }, value: 5 },
    { name: 'unmarked reference raw ID', def: { type: 'reference' }, value: 'legacy-ref' },
];
describe('safe ordinary checks share the old ParamSchema judgments', () => {
    it.each(basicCases)('$type / %# has the same ordinary acceptance', async ({ type, value }) => {
        const def = { type } as ParamDef; const accepted = validateArgs({ value }, { value: def }).length === 0;
        const handler = vi.fn(() => ({ success: true })); const args = { ...input(), value };
        const result = await invokeSnapshotValueTool(schema({ value: def }), args, handler);
        expect(result.phase === 'entered-returned').toBe(accepted); expect(handler).toHaveBeenCalledTimes(accepted ? 1 : 0);
        if (!accepted) safe(result);
    });
    it.each(ordinaryCases)('$name', async ({ def, value, missing }) => {
        const ordinary = missing ? {} : { value }; const expected = validateArgs(ordinary, { value: def });
        const handler = vi.fn(actual => { expect(actual).toEqual({ ...input(), ...ordinary }); return { success: true }; });
        const result = await invokeSnapshotValueTool(schema({ value: def }), { ...input(), ...ordinary }, handler);
        expect(result.phase === 'entered-returned').toBe(expected.length === 0);
        expect(handler).toHaveBeenCalledTimes(expected.length ? 0 : 1); if (expected.length) safe(result);
    });
    it('safely rejects strict JSON objects whose enum String conversion throws', async () => {
        const value = Object.assign(Object.create(null), { nested: SENTINEL });
        const ordinary = { value: { type: 'enum', options: ['allowed'] } } as ParamSchema;
        expect(() => validateArgs({ value }, ordinary)).toThrow();
        const handler = vi.fn(() => ({ success: true }));
        const result = await invokeSnapshotValueTool(schema(ordinary), { ...input(), value }, handler);
        expect(result).toMatchObject({ phase: 'not-entered', result: { error: { code: 'E_INVALID_ARGS' } } });
        expect(handler).not.toHaveBeenCalled(); safe(result); noUndefined(result);
    });
});

describe('safe framework diagnostics and phase', () => {
    it.each([
        { type: 'enum', options: [SENTINEL] },
        { type: 'string', constraints: { pattern: '^' + SENTINEL + '$' } },
        { type: 'number' },
        { type: 'array', itemType: 'number' },
    ] as ParamDef[])('does not expose inputs or schema free text for %#', async def => {
        const logs = ['log', 'warn', 'error', 'info', 'debug'].map(name => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
        const value = def.type === 'array' ? [SENTINEL] : def.type === 'string' ? 'bad-pattern' : SENTINEL + '_invalid';
        const handler = vi.fn(() => ({ success: true }));
        const result = await invokeSnapshotValueTool(schema({ value: def }), { ...input(), value, phase: 'entered-returned', __safeMode: true }, handler);
        expect(result.phase).toBe('not-entered'); expect(handler).not.toHaveBeenCalled(); safe(result);
        for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    });
    it.each([15, 16, 17, 40])('caps %i diagnostics while still rejecting the whole call', async count => {
        const params = schema(Object.fromEntries(Array.from({ length: count }, (_, i) => ['arg_' + i, { type: 'number', required: true }])) as ParamSchema);
        const handler = vi.fn(() => ({ success: true })); const result = await invokeSnapshotValueTool(params, input(), handler);
        expect(diagnostics(result)).toHaveLength(Math.min(count, 16)); expect(result.phase).toBe('not-entered');
        expect(handler).not.toHaveBeenCalled(); safe(result); noUndefined(result);
    });
    it.each([127, 128, 129, 400])('caps a parameter name with %i UTF-16 units', async size => {
        const name = 'x'.repeat(size); const handler = vi.fn(() => ({ success: true }));
        const result = await invokeSnapshotValueTool(schema({ [name]: { type: 'number', required: true } }), input(), handler);
        expect(diagnostics(result)[0].param.length).toBe(Math.min(size, 128)); safe(result);
        expect(handler).not.toHaveBeenCalled();
    });
    it('bounds Unicode names and the actual combined message while retaining sixteen diagnostics', async () => {
        const params = schema(Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['界😀'.repeat(80) + i, { type: 'number', required: true }])) as ParamSchema);
        const handler = vi.fn(() => ({ success: true })); const result = await invokeSnapshotValueTool(params, input(), handler);
        expect(diagnostics(result)).toHaveLength(16); expect(diagnostics(result).every(d => d.param.length === 128)).toBe(true);
        expect(result.result.error?.message.length).toBe(512); expect(handler).not.toHaveBeenCalled(); safe(result);
    });
    it.each([127, 128, 129])('also bounds the rejected Ref slot name at %i units', async size => {
        const slot = '界'.repeat(size); const result = await invokeSnapshotValueTool(schema({}, slot), { [slot]: SENTINEL }, () => ({ success: true }));
        expect(diagnostics(result)[0].param.length).toBe(Math.min(size, 128)); safe(result);
    });
    it.each([
        { success: true }, { success: true, data: { text: SENTINEL } },
        { success: false, error: { code: 'BUSINESS_FAILED', message: SENTINEL } },
        { success: false, error: { code: 'E_INVALID_ARGS', message: SENTINEL } },
    ] as OperationResult[])('preserves the business result and determines entry by the call site %#', async business => {
        const handler = vi.fn(() => business); const result = await invokeSnapshotValueTool(schema(), input(), handler);
        expect(result.phase).toBe('entered-returned'); expect(result.result).toBe(business); expect(handler).toHaveBeenCalledOnce();
    });
    it.each(['sync', 'async'])('uses a fixed safe handler error for %s exceptions without reading exception getters', async kind => {
        let reads = 0; const thrown = {};
        for (const key of ['message', 'toString']) Object.defineProperty(thrown, key, { get() { reads++; throw new Error(SENTINEL); } });
        const logs = ['log', 'warn', 'error', 'info', 'debug'].map(name => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
        const handler = vi.fn(() => { if (kind === 'sync') throw thrown; return Promise.reject(thrown); });
        const result = await invokeSnapshotValueTool(schema(), input(), handler);
        expect(result).toMatchObject({ phase: 'entered-returned', result: { success: false, error: { code: 'E_HANDLER_ERROR' } } });
        expect(handler).toHaveBeenCalledOnce(); expect(reads).toBe(0); for (const spy of logs) expect(spy).not.toHaveBeenCalled();
        safe(result); noUndefined(result);
    });
    it.each(['error', 'string', 'promise-error', 'promise-string'])('does not echo a business %s exception', async kind => {
        const cause = kind.endsWith('string') ? SENTINEL : new Error(SENTINEL);
        const logs = ['log', 'warn', 'error', 'info', 'debug'].map(name => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
        const handler = vi.fn(() => { if (kind.startsWith('promise')) return Promise.reject(cause); throw cause; });
        const result = await invokeSnapshotValueTool(schema(), input(), handler);
        expect(result).toMatchObject({ phase: 'entered-returned', result: { error: { code: 'E_HANDLER_ERROR', message: 'Tool handler failed' } } });
        expect(handler).toHaveBeenCalledOnce(); for (const spy of logs) expect(spy).not.toHaveBeenCalled(); safe(result);
    });
    it('does not manufacture undefined optional fields or normalize business output beyond the A boundary', async () => {
        const minimal = await invokeSnapshotValueTool(schema(), input(), () => ({ success: false }));
        expect(Object.keys(minimal.result)).toEqual(['success']); noUndefined(minimal);
        const business: OperationResult = { success: true, data: { ownUndefined: undefined, callable: () => SENTINEL } };
        const result = await invokeSnapshotValueTool(schema(), input(), () => business);
        expect(result.phase).toBe('entered-returned'); expect(result.result).toBe(business);
        expect(Object.hasOwn(result.result.data!, 'ownUndefined')).toBe(true);
    });
});
