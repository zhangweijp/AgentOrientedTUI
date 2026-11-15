import { describe, expect, it } from 'vitest';
import { compileOrdinarySchema, compileValueSchema, type CompileResult } from './ordinary-parameter-contract.js';

function contract(result: CompileResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error('Expected compiled contract');
  return result.contract;
}
function json(value: unknown) { return JSON.parse(JSON.stringify(value)); }
function invalid(result: CompileResult, unsupported = false) {
  expect(result.ok).toBe(false);
  if (result.ok) throw Error('Expected an invalid declaration');
  expect(result.issue.code).toBe(unsupported ? 'PARAMETER_DECLARATION_UNSUPPORTED' : 'PARAMETER_DECLARATION_INVALID');
  expect(typeof result.issue.message).toBe('string');
  expect(typeof result.issue.path).toBe('string');
  expect(result.issue.path.length).toBeLessThanOrEqual(512);
}
const schema = (properties: object, extra: object = {}) => ({ type: 'object', properties, ...extra });
const compile = (properties: object, extra: object = {}) => contract(compileOrdinarySchema(schema(properties, extra)));

describe('W07-B1 ordinary parameter contract', () => {
  it('normalizes required order and preserves the supported Schema vocabulary', () => {
    const expected = {
      type: 'object', required: ['n', 's'], additionalProperties: false, properties: {
        b: { type: 'boolean', default: false },
        booleans: { type: 'array', items: { type: 'boolean' } },
        e: { type: 'string', enum: ['a', 'ab'], default: 'a', minLength: 1, maxLength: 2 },
        n: { type: 'number', minimum: -1.5, maximum: 3, default: 0 },
        numbers: { type: 'array', items: { type: 'number' } },
        o: { type: 'object', default: { nested: [null, 1] } },
        objects: { type: 'array', items: { type: 'object' } },
        s: { type: 'string', description: 'Text', default: 'a😀', minLength: 1, maxLength: 4 },
        strings: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2, default: [''] },
      },
    };
    const compiled = contract(compileOrdinarySchema({ ...expected, required: ['s', 'n'] }));
    expect(compiled.schema).toEqual(expected);
    expect(Object.keys(compiled.schema.properties as object)).toEqual(Object.keys(expected.properties));
    for (const input of [{ s: 'a😀', n: 0 }, { s: 'x', n: 0 }, { n: 0 }, { s: 'a', n: 0, extra: 1 }]) {
      expect(compiled.validateModelInput(input)).toEqual(compiled.validateResolvedInput(input));
    }
    expect(json(compiled.validateModelInput({ s: 'a😀', n: 0 }))).toEqual({ ok: true, value: { s: 'a😀', n: 0 } });
  });

  it.each([
    ['string', '', true], ['string', 0, false], ['string', false, false], ['string', null, false],
    ['number', 0, true], ['number', -1.5, true], ['number', '0', false], ['number', NaN, false],
    ['number', Infinity, false], ['number', null, false], ['boolean', false, true], ['boolean', true, true],
    ['boolean', 'false', false], ['boolean', 0, false], ['boolean', null, false],
    ['object', {}, true], ['object', { a: [null, {}] }, true], ['object', [], false], ['object', null, false],
  ])('P02 strict %s value %j has expected validity %s', (type, value, valid) => {
    expect(compile({ v: { type } }).validateModelInput({ v: value }).ok).toBe(valid);
  });
  it('P02 distinguishes optional absence from null/undefined and required absence', () => {
    const c = compile({ v: { type: 'string' } });
    expect(json(c.validateModelInput({}))).toEqual({ ok: true, value: {} });
    expect(c.validateModelInput({ v: undefined }).ok).toBe(false);
    expect(c.validateModelInput({ v: null }).ok).toBe(false);
    for (const root of [[], null, 1, 'x', false]) expect(c.validateModelInput(root).ok).toBe(false);
    expect(compile({ v: { type: 'string' } }, { required: ['v'] }).validateModelInput({}).ok).toBe(false);
  });

  it('P03 enum is a strict string and never calls user conversion', () => {
    let conversions = 0;
    const c = compile({ e: { type: 'string', enum: ['1', 'true', 'null'] } });
    for (const value of ['1', 'true', 'null']) expect(c.validateModelInput({ e: value }).ok).toBe(true);
    for (const value of [1, true, null, 'missing', { toString() { conversions++; return '1'; } }]) {
      expect(c.validateModelInput({ e: value }).ok).toBe(false);
    }
    expect(conversions).toBe(0);
  });
  it.each([[], ['a', 'a'], [1], ['a', true], null, 'a'])('P03 rejects invalid enum options %j', options => {
    invalid(compileOrdinarySchema(schema({ e: { type: 'string', enum: options } })));
  });

  it.each([
    ['string', ['', 'a'], ['', 1]], ['number', [0, -1.5], [0, '1']],
    ['boolean', [false, true], [false, 1]], ['object', [{}, { a: [null] }], [{}, []]],
  ])('P04 validates every %s array item with only array length keywords', (itemType, valid, mixed) => {
    const c = compile({ a: { type: 'array', items: { type: itemType }, minItems: 1, maxItems: 2 } });
    expect((c.schema.properties as any).a).toEqual({ type: 'array', items: { type: itemType }, minItems: 1, maxItems: 2 });
    expect(c.validateModelInput({ a: valid }).ok).toBe(true);
    expect(c.validateModelInput({ a: valid.slice(0, 1) }).ok).toBe(true);
    expect(c.validateModelInput({ a: [] }).ok).toBe(false);
    expect(c.validateModelInput({ a: [...valid, ...valid] }).ok).toBe(false);
    expect(c.validateModelInput({ a: mixed }).ok).toBe(false);
  });
  it('P04 permits empty unconstrained arrays and rejects sparse/extra properties', () => {
    const c = compile({ a: { type: 'array', items: { type: 'string' } } });
    expect(c.validateModelInput({ a: [] }).ok).toBe(true);
    expect(c.validateModelInput({ a: new Array(2) }).ok).toBe(false);
    expect(c.validateModelInput({ a: Object.assign(['x'], { secret: true }) }).ok).toBe(false);
    invalid(compileOrdinarySchema(schema({ a: { type: 'array' } })));
  });

  it('P05 counts string code points against supported length bounds', () => {
    const single = compile({ s: { type: 'string', minLength: 1, maxLength: 1 } });
    for (const s of ['a', '😀', '\ud800']) expect(single.validateModelInput({ s }).ok).toBe(true);
    for (const s of ['', 'ab', 'e\u0301']) expect(single.validateModelInput({ s }).ok).toBe(false);
    const c = compile({ s: { type: 'string', minLength: 1, maxLength: 3 } });
    expect(c.validateModelInput({ s: 'cat' }).ok).toBe(true);
    expect(c.validateModelInput({ s: '😀' }).ok).toBe(true);
    expect(c.validateModelInput({ s: '' }).ok).toBe(false);
    expect(c.validateModelInput({ s: 'cats' }).ok).toBe(false);
    const e = compile({ e: { type: 'string', enum: ['abc', 'xbc'], maxLength: 3 } });
    expect(e.validateModelInput({ e: 'abc' }).ok).toBe(true);
    expect(e.validateModelInput({ e: 'xbc' }).ok).toBe(true);
    expect(e.validateModelInput({ e: 'other' }).ok).toBe(false);
  });

  it('validates supported JSON Schema patterns', () => {
    const c = contract(compileOrdinarySchema(schema({ title: { type: 'string', pattern: '^a+$' } })));
    expect(c.validateModelInput({ title: 'aaa' }).ok).toBe(true);
    expect(c.validateModelInput({ title: 'aba' })).toMatchObject({ ok: false, diagnostics: [{ path: '$.title' }] });
  });
  it('rejects malformed patterns at their declaration paths', () => {
    expect(compileOrdinarySchema(schema({ title: { type: 'string', pattern: '[' } }))).toMatchObject({
      ok: false, issue: { code: 'PARAMETER_DECLARATION_INVALID', path: '$.properties.title.pattern' },
    });
  });
  it('P05 keeps an ordinary parameter named pattern as string data', () => {
    expect(compile({ pattern: { type: 'string', minLength: 1 } }).validateModelInput({ pattern: 'file-*.ts' }).ok).toBe(true);
  });

  it('P06 includes numeric boundaries without conversion', () => {
    const c = compile({ n: { type: 'number', minimum: -1.5, maximum: 2.5 } });
    for (const n of [-1.5, 0, 1, 2.5]) expect(c.validateModelInput({ n }).ok).toBe(true);
    for (const n of [-1.51, 2.51, '1']) expect(c.validateModelInput({ n }).ok).toBe(false);
  });
  it.each([
    { type: 'number', minimum: 2, maximum: 1 }, { type: 'number', minimum: Infinity },
    { type: 'number', maximum: '2' }, { type: 'string', minLength: -1 },
    { type: 'string', maxLength: 1.5 }, { type: 'string', minLength: 2, maxLength: 1 },
    { type: 'array', items: { type: 'object' }, minItems: 2, maxItems: 1 },
  ])('rejects malformed bounds %#', field => invalid(compileOrdinarySchema(schema({ v: field }))));

  it.each([
    [{ type: 'string' }, ''], [{ type: 'number' }, 0],
    [{ type: 'boolean' }, false], [{ type: 'object' }, { a: [null] }],
    [{ type: 'string', enum: ['a'] }, 'a'], [{ type: 'array', items: { type: 'object' } }, [{}]],
  ])('P07 preserves valid default annotation without filling %#', (field, value) => {
    const properties = { v: { ...field, default: value } };
    const c = compile(properties);
    expect((c.schema.properties as any).v.default).toEqual(value);
    expect(json(c.validateModelInput({}))).toEqual({ ok: true, value: {} });
    expect(compile(properties, { required: ['v'] }).validateModelInput({}).ok).toBe(false);
  });
  it.each([
    { type: 'number', default: '1' }, { type: 'number', minimum: 2, default: 1 },
    { type: 'string', default: null }, { type: 'string', maxLength: 1, default: 'ab' },
    { type: 'string', enum: ['a'], default: 'b' },
    { type: 'array', items: { type: 'number' }, default: ['1'] }, { type: 'boolean', default: 0 },
    { type: 'object', default: [] },
  ])('P07 rejects invalid defaults %#', field => invalid(compileOrdinarySchema(schema({ v: field }))));

  it('P08 preserves open extras and handles dangerous own keys safely', () => {
    const params = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"number"},"toString":{"type":"boolean"}}');
    const input = JSON.parse('{"__proto__":"safe","constructor":0,"toString":false,"unknown":{"nested":[null,"value"]}}');
    const c = compile(params);
    const result = c.validateModelInput(input);
    expect(json(result)).toEqual({ ok: true, value: input });
    if (result.ok) {
      expect(Object.getPrototypeOf(result.value)).toBe(null);
      expect(Object.getPrototypeOf(result.value.unknown)).toBe(null);
      expect(Object.isFrozen(result.value)).toBe(true);
    }
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    const closed = compile(params, { additionalProperties: false });
    expect(closed.validateModelInput(input).ok).toBe(false);
    delete input.unknown;
    expect(closed.validateModelInput(input).ok).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
    invalid(compileOrdinarySchema(schema({}, { required: ['toString'] })));
  });

  it('captures Schema keywords and defaults and deeply freezes only copies', () => {
    const properties = { e: { type: 'string', enum: ['a'], minLength: 1 }, o: { type: 'object', default: { a: ['initial'] } } };
    const sourceSchema = schema(properties, { additionalProperties: false });
    const c = contract(compileOrdinarySchema(sourceSchema));
    const before = JSON.stringify(c.schema);
    properties.e.enum.push('b'); properties.e.minLength = 2; properties.o.default.a[0] = 'changed';
    expect(JSON.stringify(c.schema)).toBe(before);
    expect(c.validateModelInput({ e: 'a' }).ok).toBe(true);
    expect(c.validateModelInput({ e: 'b' }).ok).toBe(false);
    expect(c.validateModelInput({ x: true }).ok).toBe(false);
    expect(contract(compileOrdinarySchema(sourceSchema)).schema).not.toEqual(c.schema);
    expect(Object.isFrozen(properties)).toBe(false);
    expect(Object.isFrozen(properties.o.default.a)).toBe(false);
    const frozen: any = c.schema;
    expect(Reflect.set(frozen.properties.e, 'minLength', 9)).toBe(false);
    expect(Reflect.set(frozen.properties.o.default.a, '0', 'changed')).toBe(false);
    const source: any = { type: 'object', properties: { x: { type: 'number', minimum: 0, default: 1 } }, required: ['x'] };
    const captured = contract(compileOrdinarySchema(source));
    source.properties.x.minimum = 10; source.required.length = 0;
    expect(captured.validateModelInput({ x: 1 }).ok).toBe(true);
    expect(captured.validateModelInput({}).ok).toBe(false);
  });
  it('normalizes insertion order and retains schema differences', () => {
    const a = compile({ z: { type: 'number' }, a: { type: 'string' } }, { required: ['a', 'z'] });
    const b = compile({ a: { type: 'string' }, z: { type: 'number' } }, { required: ['z', 'a'] });
    expect(JSON.stringify(a.schema)).toBe(JSON.stringify(b.schema));
    const original = compile({ x: { type: 'string' } });
    expect(compile({ x: { type: 'string' } }, { additionalProperties: false }).schema).not.toEqual(original.schema);
    const rootDesc = compile({ x: { type: 'string' } }, { description: 'root' });
    expect(rootDesc.schema.description).toBe('root');
  });

  it('P10 rejects accessors/hidden/symbol/class/cycle/non-JSON without reading values', () => {
    let reads = 0;
    const getter = { get secret() { reads++; throw Error('SECRET_GETTER'); } };
    const hidden = Object.defineProperty({}, 'secret', { value: 'SECRET_HIDDEN' });
    const symbol = { [Symbol('secret')]: 1 };
    class Custom { value = 1; }
    const cycle: any = {}; cycle.self = cycle;
    const c = compile({});
    for (const value of [getter, hidden, symbol, new Custom(), cycle, new Date(0), { x: undefined }, { x: 1n }, { x() {} }, { x: -Infinity }]) {
      expect(c.validateModelInput(value).ok).toBe(false);
      invalid(compileOrdinarySchema(value));
    }
    invalid(compileOrdinarySchema(schema({ v: { type: 'object', default: getter } })));
    expect(reads).toBe(0);
  });
  it('P10 separates shared subobjects and normalizes -0 without freezing originals', () => {
    const shared = { a: [false, -0] }; const input = { one: shared, two: shared };
    const result = compile({}).validateModelInput(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.one).not.toBe(result.value.two);
    expect(result.value.one).not.toBe(shared);
    expect(Object.is((result.value.one as any).a[1], -0)).toBe(false);
    expect(Object.is(input.one.a[1], -0)).toBe(true);
    expect(Object.isFrozen(shared.a)).toBe(false);
    expect(Reflect.set((result.value.one as any).a, '0', true)).toBe(false);
  });
  it('P10 enforces exact input depth/node/approximate-byte and canonical boundaries', () => {
    const c = compile({});
    const nested = (depth: number): any => depth ? { x: nested(depth - 1) } : 0;
    expect(c.validateModelInput({ v: nested(23) }).ok).toBe(true);
    expect(c.validateModelInput({ v: nested(24) }).ok).toBe(false);
    expect(c.validateModelInput({ a: Array(9_998).fill(null) }).ok).toBe(true);
    expect(c.validateModelInput({ a: Array(9_999).fill(null) }).ok).toBe(false);
    expect(c.validateModelInput({ v: 'a'.repeat(128 * 1024 - 9) }).ok).toBe(true);
    expect(c.validateModelInput({ v: 'a'.repeat(128 * 1024 - 8) }).ok).toBe(false);
    const atCanonical = { v: '\0'.repeat(21_844) };
    expect(new TextEncoder().encode(JSON.stringify(atCanonical)).length).toBe(128 * 1024);
    expect(c.validateModelInput(atCanonical).ok).toBe(true);
    expect(c.validateModelInput({ v: atCanonical.v + '\0' }).ok).toBe(false);
  });
  it('P10 enforces declaration and normalized Schema depth/node/canonical budgets', () => {
    const nested = (depth: number): any => depth ? { x: nested(depth - 1) } : 0;
    const decl = (value: unknown) => schema({ o: { type: 'object', default: { a: value } } }, { required: [], additionalProperties: true });
    const capacity = { ok: false, issue: { code: 'PARAMETER_DECLARATION_CAPACITY' } };
    expect(compileOrdinarySchema(decl(nested(20))).ok).toBe(true);
    expect(compileOrdinarySchema(decl(nested(21)))).toMatchObject(capacity);
    expect(compileOrdinarySchema(decl(Array(4_991).fill(null))).ok).toBe(true);
    expect(compileOrdinarySchema(decl(Array(4_992).fill(null)))).toMatchObject(capacity);
    const base = { type: 'object', properties: {}, required: [], additionalProperties: true, description: '' };
    const count = Math.floor((64 * 1024 - JSON.stringify(base).length) / 6);
    expect(compileOrdinarySchema({ ...base, description: '\0'.repeat(count) }).ok).toBe(true);
    expect(compileOrdinarySchema({ ...base, description: '\0'.repeat(count + 1) })).toMatchObject(capacity);
    expect(compileOrdinarySchema({ ...base, description: 'x'.repeat(64 * 1024 + 1) })).toMatchObject(capacity);
    expect(compileOrdinarySchema(schema({ ['x'.repeat(64 * 1024 + 1)]: {} }))).toMatchObject(capacity);
  });

  it('reports a copy budget rejection for a small declaration and keeps invalid and unsupported distinct', () => {
    const value = { type: 'array', items: { type: 'number' }, default: Array(3_000).fill(0) };
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(7 * 1024);
    const capacity = { ok: false, issue: { code: 'PARAMETER_DECLARATION_CAPACITY', path: expect.stringContaining('default') } };
    expect(compileValueSchema(value)).toMatchObject(capacity);
    expect(compileOrdinarySchema(schema({ xs: value }))).toMatchObject(capacity);
    expect(compileValueSchema({ ...value, default: ['0'] })).toMatchObject({
      ok: false, issue: { code: 'PARAMETER_DECLARATION_INVALID', path: '$.default' },
    });
    expect(compileValueSchema({ type: 'string', format: 'email' })).toMatchObject({
      ok: false, issue: { code: 'PARAMETER_DECLARATION_UNSUPPORTED', path: '$.format' },
    });
  });

  it('rejects the retired parameter DSL at the JSON Schema entry', () => {
    invalid(compileOrdinarySchema({ x: { type: 'string', required: true, desc: 'retired' } }));
  });
  it.each([
    { type: 'string', nullable: true },
    { type: 'string', 'x-aotui-ref': {} }, { $ref: '#/a' }, { allOf: [] }, { oneOf: [] },
    { type: 'string', mystery: 1 },
    { type: 'array', items: { type: 'string' }, minLength: 1 },
  ])('P11 rejects unsupported Schema vocabulary %#', field => invalid(compileOrdinarySchema(schema({ x: field })), true));
  it.each([
    { $ref: '#' }, { patternProperties: {} }, { additionalProperties: {} }, { 'x-aotui-mode': 'anything' },
  ])('P11 rejects unsupported root vocabulary %#', extra => invalid(compileOrdinarySchema(schema({}, extra)), true));
  it('P11 reports a bounded JSON Schema path for unsupported vocabulary', () => {
    const result = compileOrdinarySchema(schema({ content: { type: 'string', format: 'markdown' } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an unsupported declaration');
    expect(result.issue.path).toBe('$.properties.content.format');
    expect(result.issue.path!.length).toBeLessThanOrEqual(512);
  });
  it.each([
    [{ title: { type: 'string', minLength: -1 } }, '$.properties.title.minLength'],
    [{ title: { type: 'string', default: 7 } }, '$.properties.title.default'],
    [{ title: { type: 'string', enum: [] } }, '$.properties.title.enum'],
    [{ count: { type: 'number', minimum: 3, maximum: 2 } }, '$.properties.count.maximum'],
  ])('P11 points invalid field keywords to their JSON Schema paths %#', (properties, expectedPath) => {
    const result = compileOrdinarySchema(schema(properties));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an invalid declaration');
    expect(result.issue.path).toBe(expectedPath);
  });
  it('P11 points malformed required declarations at the root required keyword', () => {
    const result = compileOrdinarySchema(schema({ title: { type: 'string' } }, { required: ['missing'] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an invalid declaration');
    expect(result.issue.path).toBe('$.required');
  });
  it('P11 always returns a bounded path for capture failures without exposing exception text', () => {
    const result = compileOrdinarySchema(schema({ title: { type: 'string', default: 1n } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected invalid JSON input');
    expect(result.issue.path).toBe('$["properties"]["title"]["default"]');
    expect(result.issue.path.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(result)).not.toMatch(/BigInt|Cannot serialize/);
  });
  it('P11 bounds paths even when a property name is very long', () => {
    const result = compileOrdinarySchema(schema({ ['property_' + 'x'.repeat(2_000)]: { type: 'string', default: 1 } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an invalid declaration');
    expect(result.issue.path).toBeDefined();
    expect(result.issue.path!.length).toBeLessThanOrEqual(512);
  });
  it.each([
    { required: ['x', 'x'] }, { required: ['missing'] }, { required: 'x' }, { required: [1] },
    { properties: [] }, { description: 1 }, { additionalProperties: null },
  ])('P11 rejects malformed root fields %#', extra => invalid(compileOrdinarySchema(schema({ x: { type: 'string' } }, extra))));

  it('P12 bounds diagnostics and never reflects input/unknown keys/exception/pattern/default text', () => {
    const properties: Record<string, object> = {};
    for (let i = 0; i < 20; i++) properties['declared_' + i + '_'.repeat(200)] = { type: 'string' };
    const c = compile(properties, { required: Object.keys(properties), additionalProperties: false });
    const result = c.validateModelInput({ UNKNOWN_SECRET_KEY: 'INPUT_SECRET_VALUE' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PARAMETER_INPUT_INVALID');
    expect(result.diagnostics.length).toBe(16);
    for (const d of result.diagnostics) {
      expect(d.parameter!.length).toBeLessThanOrEqual(128);
      expect(d.message.length).toBeLessThanOrEqual(256);
    }
    expect(JSON.stringify(result)).not.toMatch(/UNKNOWN_SECRET_KEY|INPUT_SECRET_VALUE/);
    const closed = compile({}, { additionalProperties: false });
    expect(JSON.stringify(closed.validateModelInput({ UNKNOWN_SECRET_KEY: 'INPUT_SECRET_VALUE' }))).not.toMatch(/UNKNOWN_SECRET_KEY|INPUT_SECRET_VALUE/);
    for (const field of [
      { type: 'string', pattern: '[REGEX_SECRET' },
      { type: 'number', default: 'DEFAULT_SECRET' },
    ]) {
      const r = compileOrdinarySchema(schema({ private: field }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issue.message.length).toBeLessThanOrEqual(512);
      expect(JSON.stringify(r)).not.toMatch(/REGEX_SECRET|DEFAULT_SECRET/);
    }
    const name = 'line\n' + 'x'.repeat(200);
    const control = compile({ [name]: { type: 'string' } }, { required: [name] });
    const failure = control.validateModelInput({});
    if (!failure.ok) expect(failure.diagnostics[0]!.parameter).not.toContain('\n');
  });
});
