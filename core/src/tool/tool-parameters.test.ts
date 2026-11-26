import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileToolParameters, compileValueSchema, type ToolParameterCompileResult as CompileResult } from './tool-parameters.js';

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
const compile = (properties: object, extra: object = {}) => contract(compileToolParameters(schema(properties, extra)));

describe('Tuple and union tool parameters', () => {
  it('accepts TypeBox fixed tuples and preserves nested literal strings', () => {
    const tuple = { type: 'array', minItems: 2, items: false,
      prefixItems: [{ type: 'number' }, { anyOf: [{ type: 'string' }, { type: 'null' }] }] };
    const c = compile({ pair: tuple });
    expect(c.validateResolvedInput({ pair: [1, null] }).ok).toBe(true);
    expect(c.validateResolvedInput({ pair: [1, '$price'] }).ok).toBe(true);
    expect(c.validateResolvedInput({ pair: [1] }).ok).toBe(false);
    expect(c.validateResolvedInput({ pair: [1, null, 2] }).ok).toBe(false);
    expect(c.validateResolvedInput({ pair: ['1', null] }).ok).toBe(false);
    expect(c.validateResolvedInput({ pair: [1, '$price'] })).toEqual({ ok: true, value: { pair: [1, '$price'] } });
    invalid(compileToolParameters(schema({ pair: { ...tuple, items: { type: 'integer' } } })));
  });

  it('checks nested fixed positions, array defaults and enum without filling omitted keys', () => {
    const empty = { type: 'array', items: false, minItems: 0 };
    const tuple = { type: 'array', items: false, minItems: 2,
      prefixItems: [{ type: 'integer', minimum: 1 }, empty], default: [1, []], enum: [[1, []], [2, []]] };
    const c = compile({ 'seat/row~': tuple });
    expect(c.validateResolvedInput({})).toEqual({ ok: true, value: {} });
    expect(c.validateResolvedInput({ 'seat/row~': [2, []] }).ok).toBe(true);
    expect(c.validateResolvedInput({ 'seat/row~': [3, []] }).ok).toBe(false);
    expect(c.validateResolvedInput({ 'seat/row~': null }).ok).toBe(false);
    invalid(compileToolParameters(schema({ e: { ...empty, prefixItems: [] } })));
    invalid(compileToolParameters(schema({ e: { ...tuple, default: [3, []] } })));
    expect(compileValueSchema(empty)).toMatchObject({ ok: true });
  });

  it('bounds the compiled checker diagnostics and keeps nested property and array positions', () => {
    const field = { type: 'object', properties: { '0/.~': { type: 'array', items: false, minItems: 1,
      prefixItems: [{ type: 'integer' }] } } };
    const keys = Array.from({ length: 20 }, (_, index) => `p${index}`);
    const c = compile(Object.fromEntries(keys.map(key => [key, field])));
    const result = c.validateResolvedInput(Object.fromEntries(keys.map(key => [key, { '0/.~': ['1'] }])));
    expect(result.ok).toBe(false);
    if (result.ok) throw Error('Expected rejected positions');
    expect(result.diagnostics).toHaveLength(16);
    expect(result.diagnostics[0]).toMatchObject({ path: '$.p0["0/.~"][0]', message: 'Expected type integer.' });
  });

  it('reports a failed union at the shared path even when the first branch fails a nested property', () => {
    const c = compile({ selection: { anyOf: [{ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      { type: 'array', items: { type: 'string' } }] } });
    expect(c.validateResolvedInput({ selection: { name: 7 } })).toMatchObject({ ok: false, diagnostics: [
      { path: '$.selection', message: 'Value does not match any declared alternative.' },
    ] });
    const open = compile({ selection: { anyOf: [{ type: 'string' }, { type: 'object', properties: { name: { type: 'string' } },
      required: ['name'], additionalProperties: false }] } });
    expect(open.validateResolvedInput({ selection: { other: 7 } })).toMatchObject({ ok: false, diagnostics: [
      { path: '$.selection', message: 'Value does not match any declared alternative.' },
    ] });
  });

});

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
    const compiled = contract(compileToolParameters({ ...expected, required: ['s', 'n'] }));
    expect(compiled.schema).toEqual(expected);
    expect(Object.keys(compiled.schema.properties as object)).toEqual(Object.keys(expected.properties));
    expect(json(compiled.validateResolvedInput({ s: 'a😀', n: 0 }))).toEqual({ ok: true, value: { s: 'a😀', n: 0 } });
  });

  it.each([
    ['string', '', true], ['string', 0, false], ['string', false, false], ['string', null, false],
    ['number', 0, true], ['number', -1.5, true], ['number', '0', false], ['number', NaN, false],
    ['number', Infinity, false], ['number', null, false], ['boolean', false, true], ['boolean', true, true],
    ['boolean', 'false', false], ['boolean', 0, false], ['boolean', null, false],
    ['object', {}, true], ['object', { a: [null, {}] }, true], ['object', [], false], ['object', null, false],
  ])('P02 strict %s value %j has expected validity %s', (type, value, valid) => {
    expect(compile({ v: { type } }).validateResolvedInput({ v: value }).ok).toBe(valid);
  });
  it('P02 distinguishes optional absence from null/undefined and required absence', () => {
    const c = compile({ v: { type: 'string' } });
    expect(json(c.validateResolvedInput({}))).toEqual({ ok: true, value: {} });
    expect(c.validateResolvedInput({ v: undefined }).ok).toBe(false);
    expect(c.validateResolvedInput({ v: null }).ok).toBe(false);
    for (const root of [[], null, 1, 'x', false]) expect(c.validateResolvedInput(root).ok).toBe(false);
    expect(compile({ v: { type: 'string' } }, { required: ['v'] }).validateResolvedInput({}).ok).toBe(false);
  });

  it('P03 enum is a strict string and never calls user conversion', () => {
    let conversions = 0;
    const c = compile({ e: { type: 'string', enum: ['1', 'true', 'null'] } });
    for (const value of ['1', 'true', 'null']) expect(c.validateResolvedInput({ e: value }).ok).toBe(true);
    for (const value of [1, true, null, 'missing', { toString() { conversions++; return '1'; } }]) {
      expect(c.validateResolvedInput({ e: value }).ok).toBe(false);
    }
    expect(conversions).toBe(0);
  });
  it.each([[], ['a', 'a'], [1], ['a', true], null, 'a'])('P03 rejects invalid enum options %j', options => {
    invalid(compileToolParameters(schema({ e: { type: 'string', enum: options } })));
  });

  it.each([
    ['string', ['', 'a'], ['', 1]], ['number', [0, -1.5], [0, '1']],
    ['boolean', [false, true], [false, 1]], ['object', [{}, { a: [null] }], [{}, []]],
  ])('P04 validates every %s array item with only array length keywords', (itemType, valid, mixed) => {
    const c = compile({ a: { type: 'array', items: { type: itemType }, minItems: 1, maxItems: 2 } });
    expect((c.schema.properties as any).a).toEqual({ type: 'array', items: { type: itemType }, minItems: 1, maxItems: 2 });
    expect(c.validateResolvedInput({ a: valid }).ok).toBe(true);
    expect(c.validateResolvedInput({ a: valid.slice(0, 1) }).ok).toBe(true);
    expect(c.validateResolvedInput({ a: [] }).ok).toBe(false);
    expect(c.validateResolvedInput({ a: [...valid, ...valid] }).ok).toBe(false);
    expect(c.validateResolvedInput({ a: mixed }).ok).toBe(false);
  });
  it('P04 permits empty unconstrained arrays and rejects sparse/extra properties', () => {
    const c = compile({ a: { type: 'array', items: { type: 'string' } } });
    expect(c.validateResolvedInput({ a: [] }).ok).toBe(true);
    expect(c.validateResolvedInput({ a: new Array(2) }).ok).toBe(false);
    expect(c.validateResolvedInput({ a: Object.assign(['x'], { secret: true }) }).ok).toBe(false);
    invalid(compileToolParameters(schema({ a: { type: 'array' } })));
  });

  it('P05 counts string code points against supported length bounds', () => {
    const single = compile({ s: { type: 'string', minLength: 1, maxLength: 1 } });
    for (const s of ['a', '😀', '\ud800']) expect(single.validateResolvedInput({ s }).ok).toBe(true);
    for (const s of ['', 'ab', 'e\u0301']) expect(single.validateResolvedInput({ s }).ok).toBe(false);
    const c = compile({ s: { type: 'string', minLength: 1, maxLength: 3 } });
    expect(c.validateResolvedInput({ s: 'cat' }).ok).toBe(true);
    expect(c.validateResolvedInput({ s: '😀' }).ok).toBe(true);
    expect(c.validateResolvedInput({ s: '' }).ok).toBe(false);
    expect(c.validateResolvedInput({ s: 'cats' }).ok).toBe(false);
    const e = compile({ e: { type: 'string', enum: ['abc', 'xbc'], maxLength: 3 } });
    expect(e.validateResolvedInput({ e: 'abc' }).ok).toBe(true);
    expect(e.validateResolvedInput({ e: 'xbc' }).ok).toBe(true);
    expect(e.validateResolvedInput({ e: 'other' }).ok).toBe(false);
  });

  it.each([
    ['ordinary', { type: 'string', pattern: '^a+$' }],
    ['malformed', { type: 'string', pattern: '[PATTERN_SAMPLE' }],
    ['nested-quantifier with a default', { type: 'string', pattern: '^(a+)+$', default: 'a' }],
  ])('rejects an unsupported %s pattern at its declaration path', (_label, field) => {
    const result = compileToolParameters(schema({ title: field }));
    expect(result).toMatchObject({
      ok: false, issue: { code: 'PARAMETER_DECLARATION_UNSUPPORTED', path: '$.properties.title.pattern' },
    });
    expect(JSON.stringify(result)).not.toContain(field.pattern);
  });
  it('rejects a pattern in a union branch inside an array of objects', () => {
    const filter = { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^file$' }] };
    const result = compileToolParameters(schema({ rules: { type: 'array', items: schema({ filter }) } }));
    expect(result).toMatchObject({ ok: false, issue: {
      code: 'PARAMETER_DECLARATION_UNSUPPORTED', path: '$.properties.rules.items.properties.filter.anyOf[1].pattern',
    } });
  });
  it('P05 preserves pattern as a business key in parameters and nested default and enum data', () => {
    const options = { rules: [{ pattern: 'file-*.ts' }] };
    const c = compile({
      pattern: { type: 'string', minLength: 1 },
      options: { type: 'object', default: options, enum: [options] },
    });
    const input = { pattern: '[', options };
    expect(c.schema).toMatchObject({ properties: { options: { default: options, enum: [options] } } });
    expect(c.validateResolvedInput(input)).toEqual({ ok: true, value: input });
    expect(c.validateResolvedInput(input)).toEqual({ ok: true, value: input });
  });

  it('P06 includes numeric boundaries without conversion', () => {
    const c = compile({ n: { type: 'number', minimum: -1.5, maximum: 2.5 } });
    for (const n of [-1.5, 0, 1, 2.5]) expect(c.validateResolvedInput({ n }).ok).toBe(true);
    for (const n of [-1.51, 2.51, '1']) expect(c.validateResolvedInput({ n }).ok).toBe(false);
  });
  it.each([
    { type: 'number', minimum: 2, maximum: 1 }, { type: 'number', minimum: Infinity },
    { type: 'number', maximum: '2' }, { type: 'string', minLength: -1 },
    { type: 'string', maxLength: 1.5 }, { type: 'string', minLength: 2, maxLength: 1 },
    { type: 'array', items: { type: 'object' }, minItems: 2, maxItems: 1 },
  ])('rejects malformed bounds %#', field => invalid(compileToolParameters(schema({ v: field }))));

  it.each([
    [{ type: 'string' }, ''], [{ type: 'number' }, 0],
    [{ type: 'boolean' }, false], [{ type: 'object' }, { a: [null] }],
    [{ type: 'string', enum: ['a'] }, 'a'], [{ type: 'array', items: { type: 'object' } }, [{}]],
  ])('P07 preserves valid default annotation without filling %#', (field, value) => {
    const properties = { v: { ...field, default: value } };
    const c = compile(properties);
    expect((c.schema.properties as any).v.default).toEqual(value);
    expect(json(c.validateResolvedInput({}))).toEqual({ ok: true, value: {} });
    expect(compile(properties, { required: ['v'] }).validateResolvedInput({}).ok).toBe(false);
  });
  it.each([
    { type: 'number', default: '1' }, { type: 'number', minimum: 2, default: 1 },
    { type: 'string', default: null }, { type: 'string', maxLength: 1, default: 'ab' },
    { type: 'string', enum: ['a'], default: 'b' },
    { type: 'array', items: { type: 'number' }, default: ['1'] }, { type: 'boolean', default: 0 },
    { type: 'object', default: [] },
  ])('P07 rejects invalid defaults %#', field => invalid(compileToolParameters(schema({ v: field }))));

  it('P08 preserves open extras and handles dangerous own keys safely', () => {
    const params = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"number"},"toString":{"type":"boolean"}}');
    const input = JSON.parse('{"__proto__":"safe","constructor":0,"toString":false,"unknown":{"nested":[null,"value"]}}');
    const c = compile(params);
    const result = c.validateResolvedInput(input);
    expect(json(result)).toEqual({ ok: true, value: input });
    if (result.ok) expect(result.value).not.toBe(input);
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    const closed = compile(params, { additionalProperties: false });
    expect(closed.validateResolvedInput(input).ok).toBe(false);
    delete input.unknown;
    expect(closed.validateResolvedInput(input).ok).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
    invalid(compileToolParameters(schema({}, { required: ['toString'] })));
  });

  it('captures Schema keywords and defaults and deeply freezes only copies', () => {
    const properties = { e: { type: 'string', enum: ['a'], minLength: 1 }, o: { type: 'object', default: { a: ['initial'] } } };
    const sourceSchema = schema(properties, { additionalProperties: false });
    const c = contract(compileToolParameters(sourceSchema));
    const before = JSON.stringify(c.schema);
    properties.e.enum.push('b'); properties.e.minLength = 2; properties.o.default.a[0] = 'changed';
    expect(JSON.stringify(c.schema)).toBe(before);
    expect(c.validateResolvedInput({ e: 'a' }).ok).toBe(true);
    expect(c.validateResolvedInput({ e: 'b' }).ok).toBe(false);
    expect(c.validateResolvedInput({ x: true }).ok).toBe(false);
    expect(contract(compileToolParameters(sourceSchema)).schema).not.toEqual(c.schema);
    expect(Object.isFrozen(properties)).toBe(false);
    expect(Object.isFrozen(properties.o.default.a)).toBe(false);
    const frozen: any = c.schema;
    expect(Reflect.set(frozen.properties.e, 'minLength', 9)).toBe(false);
    expect(Reflect.set(frozen.properties.o.default.a, '0', 'changed')).toBe(false);
    const source: any = { type: 'object', properties: { x: { type: 'number', minimum: 0, default: 1 } }, required: ['x'] };
    const captured = contract(compileToolParameters(source));
    source.properties.x.minimum = 10; source.required.length = 0;
    expect(captured.validateResolvedInput({ x: 1 }).ok).toBe(true);
    expect(captured.validateResolvedInput({}).ok).toBe(false);
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
      expect(c.validateResolvedInput(value).ok).toBe(false);
      invalid(compileToolParameters(value));
    }
    invalid(compileToolParameters(schema({ v: { type: 'object', default: getter } })));
    expect(reads).toBe(0);
  });
  it('checks an already owned argument without allocating a second tree', () => {
    const input = Object.freeze({ nested: Object.freeze({ values: Object.freeze(['text', null]) }) });
    const result = compile({}).validateResolvedInput(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(input);
  });
  it('P10 enforces declaration and normalized Schema depth/node/canonical budgets', () => {
    const nested = (depth: number): any => depth ? { x: nested(depth - 1) } : 0;
    const decl = (value: unknown) => schema({ o: { type: 'object', default: { a: value } } }, { required: [], additionalProperties: true });
    const capacity = { ok: false, issue: { code: 'PARAMETER_DECLARATION_CAPACITY' } };
    expect(compileToolParameters(decl(nested(20))).ok).toBe(true);
    expect(compileToolParameters(decl(nested(21)))).toMatchObject(capacity);
    expect(compileToolParameters(decl(Array(4_991).fill(null))).ok).toBe(true);
    expect(compileToolParameters(decl(Array(4_992).fill(null)))).toMatchObject(capacity);
    const base = { type: 'object', properties: {}, required: [], additionalProperties: true, description: '' };
    const count = Math.floor((64 * 1024 - JSON.stringify(base).length) / 6);
    expect(compileToolParameters({ ...base, description: '\0'.repeat(count) }).ok).toBe(true);
    expect(compileToolParameters({ ...base, description: '\0'.repeat(count + 1) })).toMatchObject(capacity);
    expect(compileToolParameters({ ...base, description: 'x'.repeat(64 * 1024 + 1) })).toMatchObject(capacity);
    expect(compileToolParameters(schema({ ['x'.repeat(64 * 1024 + 1)]: {} }))).toMatchObject(capacity);
  });

  it('reports a copy budget rejection for a small declaration and keeps invalid and unsupported distinct', () => {
    const value = { type: 'array', items: { type: 'number' }, default: Array(3_000).fill(0) };
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(7 * 1024);
    const capacity = { ok: false, issue: { code: 'PARAMETER_DECLARATION_CAPACITY', path: expect.stringContaining('default') } };
    expect(compileValueSchema(value)).toMatchObject(capacity);
    expect(compileToolParameters(schema({ xs: value }))).toMatchObject(capacity);
    expect(compileValueSchema({ ...value, default: ['0'] })).toMatchObject({
      ok: false, issue: { code: 'PARAMETER_DECLARATION_INVALID', path: '$.default' },
    });
    expect(compileValueSchema({ type: 'string', format: 'email' })).toMatchObject({
      ok: false, issue: { code: 'PARAMETER_DECLARATION_UNSUPPORTED', path: '$.format' },
    });
  });

  it('rejects the retired parameter DSL at the JSON Schema entry', () => {
    invalid(compileToolParameters({ x: { type: 'string', required: true, desc: 'retired' } }));
  });
  it.each([
    { type: 'string', nullable: true },
    { type: 'string', 'x-aotui-ref': {} }, { $ref: '#/a' }, { allOf: [] }, { oneOf: [] },
    { type: 'string', mystery: 1 },
    { type: 'array', items: { type: 'string' }, minLength: 1 },
  ])('P11 rejects unsupported Schema vocabulary %#', field => invalid(compileToolParameters(schema({ x: field })), true));
  it.each([
    { $ref: '#' }, { patternProperties: {} }, { additionalProperties: {} }, { 'x-aotui-mode': 'anything' },
  ])('P11 rejects unsupported root vocabulary %#', extra => invalid(compileToolParameters(schema({}, extra)), true));
  it('P11 reports a bounded JSON Schema path for unsupported vocabulary', () => {
    const result = compileToolParameters(schema({ content: { type: 'string', format: 'markdown' } }));
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
    const result = compileToolParameters(schema(properties));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an invalid declaration');
    expect(result.issue.path).toBe(expectedPath);
  });
  it('P11 points malformed required declarations at the root required keyword', () => {
    const result = compileToolParameters(schema({ title: { type: 'string' } }, { required: ['missing'] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an invalid declaration');
    expect(result.issue.path).toBe('$.required');
  });
  it('P11 always returns a bounded path for capture failures without exposing exception text', () => {
    const result = compileToolParameters(schema({ title: { type: 'string', default: 1n } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected invalid JSON input');
    expect(result.issue.path).toBe('$["properties"]["title"]["default"]');
    expect(result.issue.path.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(result)).not.toMatch(/BigInt|Cannot serialize/);
  });
  it('P11 bounds paths even when a property name is very long', () => {
    const result = compileToolParameters(schema({ ['property_' + 'x'.repeat(2_000)]: { type: 'string', default: 1 } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an invalid declaration');
    expect(result.issue.path).toBeDefined();
    expect(result.issue.path!.length).toBeLessThanOrEqual(512);
  });
  it.each([
    { required: ['x', 'x'] }, { required: ['missing'] }, { required: 'x' }, { required: [1] },
    { properties: [] }, { description: 1 }, { additionalProperties: null },
  ])('P11 rejects malformed root fields %#', extra => invalid(compileToolParameters(schema({ x: { type: 'string' } }, extra))));

  it('P12 bounds diagnostics and never reflects input/unknown keys/exception/pattern/default text', () => {
    const properties: Record<string, object> = {};
    for (let i = 0; i < 20; i++) properties['declared_' + i + '_'.repeat(200)] = { type: 'string' };
    const c = compile(properties, { required: Object.keys(properties), additionalProperties: false });
    const result = c.validateResolvedInput({ UNKNOWN_SECRET_KEY: 'INPUT_SECRET_VALUE' });
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
    expect(JSON.stringify(closed.validateResolvedInput({ UNKNOWN_SECRET_KEY: 'INPUT_SECRET_VALUE' }))).not.toMatch(/UNKNOWN_SECRET_KEY|INPUT_SECRET_VALUE/);
    for (const field of [
      { type: 'string', pattern: '[REGEX_SECRET' },
      { type: 'number', default: 'DEFAULT_SECRET' },
    ]) {
      const r = compileToolParameters(schema({ private: field }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issue.message.length).toBeLessThanOrEqual(512);
      expect(JSON.stringify(r)).not.toMatch(/REGEX_SECRET|DEFAULT_SECRET/);
    }
    const name = 'line\n' + 'x'.repeat(200);
    const control = compile({ [name]: { type: 'string' } }, { required: [name] });
    const failure = control.validateResolvedInput({});
    if (!failure.ok) expect(failure.diagnostics[0]!.parameter).not.toContain('\n');
  });
});

describe('Shared JSON Schema 2020-12 contract vectors', () => {
  const vectors = JSON.parse(readFileSync(new URL('./schema-contract-vectors.json', import.meta.url), 'utf8')) as {
    toolSchemas: Array<Record<string, any>>;
    valueSchemas: Array<Record<string, any>>;
  };

  it.each(vectors.toolSchemas.map(vector => [vector.name, vector]))(
    'evaluates tool schema vector %s',
    (_name, vector) => {
      const result = compileToolParameters(vector.schema);
      if (vector.expect !== 'valid') {
        invalid(result, vector.expect === 'unsupported');
        return;
      }
      const compiled = contract(result);
      for (const input of vector.validInputs) expect(compiled.validateResolvedInput(input).ok).toBe(true);
      for (const input of vector.invalidInputs) expect(compiled.validateResolvedInput(input).ok).toBe(false);
      if (vector.preserveExact !== undefined) {
        expect(compiled.validateResolvedInput(vector.preserveExact)).toEqual({ ok: true, value: vector.preserveExact });
      }
      if (vector.coreExtraOk !== undefined) {
        expect(compiled.schema.additionalProperties).toBe(true);
        expect(compiled.validateResolvedInput({ a: 'ok', extra: 1 }).ok).toBe(vector.coreExtraOk);
      }
    },
  );

  it.each(vectors.valueSchemas.map(vector => [vector.name, vector]))(
    'evaluates value schema vector %s',
    (_name, vector) => {
      const result = compileValueSchema(vector.schema);
      const nominal = compileToolParameters(schema({ item: {
        'x-aotui-ref-kind': 'Item', 'x-aotui-ref-value': vector.schema,
      } }));
      if (vector.expect !== 'valid') {
        const code = vector.expect === 'unsupported' ? 'PARAMETER_DECLARATION_UNSUPPORTED' : 'PARAMETER_DECLARATION_INVALID';
        expect(result).toMatchObject({ ok: false, issue: { code } });
        expect(nominal).toMatchObject({ ok: false, issue: { code } });
        if (vector.issuePath) {
          expect(result).toMatchObject({ issue: { path: vector.issuePath } });
          expect(nominal).toMatchObject({ issue: { path: '$.properties.item["x-aotui-ref-value"]' + vector.issuePath.slice(1) } });
        }
        return;
      }
      expect(result.ok).toBe(true);
      if (!result.ok) throw Error('Expected valid value vector');
      const tool = contract(nominal);
      for (const [values, ok] of [[vector.validValues, true], [vector.invalidValues, false]] as const) {
        for (const value of values) {
          expect(result.validate(value) === undefined).toBe(ok);
          expect(tool.validateResolvedInput({ item: value }).ok).toBe(ok);
        }
      }
    },
  );
});
