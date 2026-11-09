import { describe, expect, it } from 'vitest';
import { compileOrdinaryParams, compileOrdinarySchema, type CompileResult } from './ordinary-parameter-contract.js';

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
function unsupportedAt(result: CompileResult, path: string) {
  invalid(result, true);
  if (result.ok) return;
  expect(result.issue.path).toBe(path);
}
const schema = (properties: object, extra: object = {}) => ({ type: 'object', properties, ...extra });
const both = (params: unknown, properties: object, extra: { required?: string[]; additionalProperties?: boolean } = {}) => [
  contract(compileOrdinaryParams(params, { additionalProperties: extra.additionalProperties ?? true })),
  contract(compileOrdinarySchema(schema(properties, extra))),
];

describe('W07-B1 ordinary parameter contract', () => {
  it('P01 normalizes both frontends to an independently written full subset', () => {
    const params = {
      s: { type: 'string', required: true, desc: 'Text', default: 'a😀', constraints: { minLength: 1, maxLength: 4 } },
      e: { type: 'enum', options: ['a', 'ab'], default: 'a', constraints: { minLength: 1, maxLength: 2 } },
      n: { type: 'number', required: true, constraints: { min: -1.5, max: 3 }, default: 0 },
      b: { type: 'boolean', default: false, constraints: {} },
      o: { type: 'object', default: { nested: [null, 1] } },
      strings: { type: 'array', itemType: 'string', constraints: { minLength: 1, maxLength: 2 }, default: [''] },
      numbers: { type: 'array', itemType: 'number' },
      booleans: { type: 'array', itemType: 'boolean' },
      objects: { type: 'array', itemType: 'object' },
    };
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
    const a = contract(compileOrdinaryParams(params, { additionalProperties: false }));
    const b = contract(compileOrdinarySchema({ ...expected, required: ['s', 'n'] }));
    expect(a.schema).toEqual(expected);
    expect(b.schema).toEqual(expected);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(Object.keys(a.schema.properties as object)).toEqual(Object.keys(expected.properties));
    for (const input of [{ s: 'a😀', n: 0 }, { s: 'x', n: 0 }, { n: 0 }, { s: 'a', n: 0, extra: 1 }])
      expect(a.validate(input)).toEqual(b.validate(input));
    expect(json(a.validate({ s: 'a😀', n: 0 }))).toEqual({ ok: true, value: { s: 'a😀', n: 0 } });
  });

  it.each([
    ['string', '', true], ['string', 0, false], ['string', false, false], ['string', null, false],
    ['number', 0, true], ['number', -1.5, true], ['number', '0', false], ['number', NaN, false],
    ['number', Infinity, false], ['number', null, false], ['boolean', false, true], ['boolean', true, true],
    ['boolean', 'false', false], ['boolean', 0, false], ['boolean', null, false],
    ['object', {}, true], ['object', { a: [null, {}] }, true], ['object', [], false], ['object', null, false],
  ])('P02 strict %s value %j has expected validity %s', (type, value, valid) => {
    for (const c of both({ v: { type } }, { v: { type } })) expect(c.validate({ v: value }).ok).toBe(valid);
  });
  it('P02 distinguishes optional absence from null/undefined and required absence', () => {
    for (const c of both({ v: { type: 'string' } }, { v: { type: 'string' } })) {
      expect(json(c.validate({}))).toEqual({ ok: true, value: {} });
      expect(c.validate({ v: undefined }).ok).toBe(false);
      expect(c.validate({ v: null }).ok).toBe(false);
      for (const root of [[], null, 1, 'x', false]) expect(c.validate(root).ok).toBe(false);
    }
    for (const c of both({ v: { type: 'string', required: true } }, { v: { type: 'string' } }, { required: ['v'] }))
      expect(c.validate({}).ok).toBe(false);
  });

  it('P03 enum is a strict string and never calls user conversion', () => {
    let conversions = 0;
    for (const c of both({ e: { type: 'enum', options: ['1', 'true', 'null'] } }, { e: { type: 'string', enum: ['1', 'true', 'null'] } })) {
      for (const value of ['1', 'true', 'null']) expect(c.validate({ e: value }).ok).toBe(true);
      for (const value of [1, true, null, 'missing', { toString() { conversions++; return '1'; } }])
        expect(c.validate({ e: value }).ok).toBe(false);
    }
    expect(conversions).toBe(0);
  });
  it.each([undefined, [], ['a', 'a'], [1], ['a', true], null, 'a'])('P03 rejects invalid enum options %j', options => {
    invalid(compileOrdinaryParams({ e: { type: 'enum', ...(options === undefined ? {} : { options }) } }));
    if (options !== undefined) invalid(compileOrdinarySchema(schema({ e: { type: 'string', enum: options } })));
  });

  it.each([
    ['string', ['', 'a'], ['', 1]], ['number', [0, -1.5], [0, '1']],
    ['boolean', [false, true], [false, 1]], ['object', [{}, { a: [null] }], [{}, []]],
  ])('P04 validates every %s array item with only array length keywords', (itemType, valid, mixed) => {
    for (const c of both({ a: { type: 'array', itemType, constraints: { minLength: 1, maxLength: 2 } } },
      { a: { type: 'array', items: { type: itemType }, minItems: 1, maxItems: 2 } })) {
      expect((c.schema.properties as any).a).toEqual({ type: 'array', items: { type: itemType }, minItems: 1, maxItems: 2 });
      expect(c.validate({ a: valid }).ok).toBe(true);
      expect(c.validate({ a: valid.slice(0, 1) }).ok).toBe(true);
      expect(c.validate({ a: [] }).ok).toBe(false);
      expect(c.validate({ a: [...valid, ...valid] }).ok).toBe(false);
      expect(c.validate({ a: mixed }).ok).toBe(false);
    }
  });
  it('P04 permits empty unconstrained arrays and rejects sparse/extra properties', () => {
    const c = contract(compileOrdinaryParams({ a: { type: 'array', itemType: 'string' } }));
    expect(c.validate({ a: [] }).ok).toBe(true);
    expect(c.validate({ a: new Array(2) }).ok).toBe(false);
    expect(c.validate({ a: Object.assign(['x'], { secret: true }) }).ok).toBe(false);
    invalid(compileOrdinaryParams({ a: { type: 'array' } }));
    invalid(compileOrdinarySchema(schema({ a: { type: 'array' } })));
  });

  it('P05 counts string code points against supported length bounds', () => {
    for (const c of both({ s: { type: 'string', constraints: { minLength: 1, maxLength: 1 } } },
      { s: { type: 'string', minLength: 1, maxLength: 1 } })) {
      for (const s of ['a', '😀', '\ud800']) expect(c.validate({ s }).ok).toBe(true);
      for (const s of ['', 'ab', 'e\u0301']) expect(c.validate({ s }).ok).toBe(false);
    }
    const c = contract(compileOrdinaryParams({ s: { type: 'string', constraints: { minLength: 1, maxLength: 3 } } }));
    expect(c.validate({ s: 'cat' }).ok).toBe(true);
    expect(c.validate({ s: '😀' }).ok).toBe(true);
    expect(c.validate({ s: '' }).ok).toBe(false);
    expect(c.validate({ s: 'cats' }).ok).toBe(false);
    const e = contract(compileOrdinaryParams({ e: { type: 'enum', options: ['abc', 'xbc'], constraints: { maxLength: 3 } } }));
    expect(e.validate({ e: 'abc' }).ok).toBe(true);
    expect(e.validate({ e: 'xbc' }).ok).toBe(true);
    expect(e.validate({ e: 'other' }).ok).toBe(false);
  });

  it.each([
    ['params.constraints.pattern', () => compileOrdinaryParams({ title: { type: 'string', constraints: { pattern: '^(a+)+$' } } }), '$params.title.constraints.pattern'],
    ['JSON Schema pattern', () => compileOrdinarySchema(schema({ title: { type: 'string', pattern: '^(a+)+$' } })), '$.properties.title.pattern'],
  ] as const)('P05 rejects arbitrary regex at declaration time: %s', (_label, compile, path) => {
    unsupportedAt(compile(), path);
  });
  it('P05 rejects malformed pattern strings as unsupported vocabulary', () => {
    unsupportedAt(compileOrdinaryParams({ title: { type: 'string', constraints: { pattern: '[' } } }),
      '$params.title.constraints.pattern');
    unsupportedAt(compileOrdinarySchema(schema({ title: { type: 'string', pattern: '[' } })),
      '$.properties.title.pattern');
  });
  it('P05 keeps an ordinary parameter named pattern as string data', () => {
    for (const c of both({ pattern: { type: 'string', constraints: { minLength: 1 } } },
      { pattern: { type: 'string', minLength: 1 } })) {
      expect(c.validate({ pattern: 'file-*.ts' }).ok).toBe(true);
    }
  });

  it('P06 includes numeric boundaries without conversion', () => {
    for (const c of both({ n: { type: 'number', constraints: { min: -1.5, max: 2.5 } } },
      { n: { type: 'number', minimum: -1.5, maximum: 2.5 } })) {
      for (const n of [-1.5, 0, 1, 2.5]) expect(c.validate({ n }).ok).toBe(true);
      for (const n of [-1.51, 2.51, '1']) expect(c.validate({ n }).ok).toBe(false);
    }
  });
  it.each([
    [{ type: 'number', constraints: { min: 2, max: 1 } }, { type: 'number', minimum: 2, maximum: 1 }],
    [{ type: 'number', constraints: { min: Infinity } }, { type: 'number', minimum: Infinity }],
    [{ type: 'number', constraints: { max: '2' } }, { type: 'number', maximum: '2' }],
    [{ type: 'string', constraints: { minLength: -1 } }, { type: 'string', minLength: -1 }],
    [{ type: 'string', constraints: { maxLength: 1.5 } }, { type: 'string', maxLength: 1.5 }],
    [{ type: 'string', constraints: { minLength: 2, maxLength: 1 } }, { type: 'string', minLength: 2, maxLength: 1 }],
    [{ type: 'array', itemType: 'object', constraints: { minLength: 2, maxLength: 1 } }, { type: 'array', items: { type: 'object' }, minItems: 2, maxItems: 1 }],
  ])('P06 rejects malformed declarations in both frontends %#', (dsl, field) => {
    invalid(compileOrdinaryParams({ v: dsl }));
    invalid(compileOrdinarySchema(schema({ v: field })));
  });
  it.each([
    { type: 'boolean', constraints: { min: 0 } }, { type: 'object', constraints: { maxLength: 1 } },
    { type: 'number', constraints: { pattern: 'x' } }, { type: 'array', itemType: 'string', constraints: { min: 0 } },
    { type: 'string', constraints: { min: 0 } },
  ])('P06 rejects inapplicable constraints %#', field => invalid(compileOrdinaryParams({ v: field }), true));
  it.each([
    { v: { type: 1 } }, { v: { type: 'string', required: 1 } }, { v: { type: 'string', desc: 1 } },
    { v: { type: 'string', constraints: [] } }, { v: null }, null, [],
  ])('P06 rejects wrong declaration shapes %#', params => invalid(compileOrdinaryParams(params)));

  it.each([
    [{ type: 'string' }, { type: 'string' }, ''], [{ type: 'number' }, { type: 'number' }, 0],
    [{ type: 'boolean' }, { type: 'boolean' }, false], [{ type: 'object' }, { type: 'object' }, { a: [null] }],
    [{ type: 'enum', options: ['a'] }, { type: 'string', enum: ['a'] }, 'a'],
    [{ type: 'array', itemType: 'object' }, { type: 'array', items: { type: 'object' } }, [{}]],
  ])('P07 preserves valid default annotation without filling %#', (dsl, field, value) => {
    for (const c of both({ v: { ...dsl, default: value } }, { v: { ...field, default: value } })) {
      expect((c.schema.properties as any).v.default).toEqual(value);
      expect(json(c.validate({}))).toEqual({ ok: true, value: {} });
    }
    for (const c of both({ v: { ...dsl, default: value, required: true } }, { v: { ...field, default: value } }, { required: ['v'] }))
      expect(c.validate({}).ok).toBe(false);
  });
  it.each([
    { type: 'number', default: '1' }, { type: 'number', constraints: { min: 2 }, default: 1 },
    { type: 'string', default: null }, { type: 'string', constraints: { maxLength: 1 }, default: 'ab' },
    { type: 'enum', options: ['a'], default: 'b' },
    { type: 'array', itemType: 'number', default: ['1'] }, { type: 'boolean', default: 0 },
    { type: 'object', default: [] },
  ])('P07 rejects invalid defaults %#', field => invalid(compileOrdinaryParams({ v: field })));

  it('P08 preserves open extras and handles dangerous own keys safely', () => {
    const params = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"number"},"toString":{"type":"boolean"}}');
    const input = JSON.parse('{"__proto__":"safe","constructor":0,"toString":false,"unknown":{"nested":[null,"value"]}}');
    const c = contract(compileOrdinaryParams(params));
    const result = c.validate(input);
    expect(json(result)).toEqual({ ok: true, value: input });
    if (result.ok) {
      expect(Object.getPrototypeOf(result.value)).toBe(null);
      expect(Object.getPrototypeOf(result.value.unknown)).toBe(null);
      expect(Object.isFrozen(result.value)).toBe(true);
    }
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    const closed = contract(compileOrdinaryParams(params, { additionalProperties: false }));
    expect(closed.validate(input).ok).toBe(false);
    delete input.unknown;
    expect(closed.validate(input).ok).toBe(true);
    expect(({} as any).polluted).toBeUndefined();
    invalid(compileOrdinarySchema(schema({}, { required: ['toString'] })));
  });
  it('P08 checks options as own enumerable boolean data only', () => {
    invalid(compileOrdinaryParams({}, { additionalProperties: 1 } as any));
    invalid(compileOrdinaryParams({}, { other: false } as any), true);
    invalid(compileOrdinaryParams({}, Object.create({ additionalProperties: false })));
    let reads = 0;
    invalid(compileOrdinaryParams({}, { get additionalProperties() { reads++; return true; } }));
    invalid(compileOrdinaryParams({}, Object.defineProperty({}, 'additionalProperties', { value: true })));
    expect(reads).toBe(0);
  });

  it('P09 captures source/default/options/constraints and deeply freezes only copies', () => {
    const params = { e: { type: 'enum', options: ['a'], constraints: { minLength: 1 } }, o: { type: 'object', default: { a: ['initial'] } } };
    const options = { additionalProperties: false };
    const c = contract(compileOrdinaryParams(params, options));
    const before = JSON.stringify(c.schema), identity = c.fingerprint;
    params.e.options.push('b'); params.e.constraints.minLength = 2; params.o.default.a[0] = 'changed'; options.additionalProperties = true;
    expect(JSON.stringify(c.schema)).toBe(before);
    expect(c.fingerprint).toBe(identity);
    expect(c.validate({ e: 'a' }).ok).toBe(true);
    expect(c.validate({ e: 'b' }).ok).toBe(false);
    expect(c.validate({ x: true }).ok).toBe(false);
    expect(contract(compileOrdinaryParams(params, options)).fingerprint).not.toBe(identity);
    expect(Object.isFrozen(params)).toBe(false);
    expect(Object.isFrozen(params.o.default.a)).toBe(false);
    const frozen: any = c.schema;
    expect(Reflect.set(frozen.properties.e, 'minLength', 9)).toBe(false);
    expect(Reflect.set(frozen.properties.o.default.a, '0', 'changed')).toBe(false);
    const source: any = { type: 'object', properties: { x: { type: 'number', minimum: 0, default: 1 } }, required: ['x'] };
    const captured = contract(compileOrdinarySchema(source));
    source.properties.x.minimum = 10; source.required.length = 0;
    expect(captured.validate({ x: 1 }).ok).toBe(true);
    expect(captured.validate({}).ok).toBe(false);
  });
  it('P09 uses full revision/schema identity with key/required order normalization', () => {
    const a = contract(compileOrdinaryParams({ z: { type: 'number', required: true }, a: { type: 'string', required: true } }));
    const b = contract(compileOrdinarySchema({ additionalProperties: true, required: ['z', 'a'], properties: { a: { type: 'string' }, z: { type: 'number' } }, type: 'object' }));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(JSON.parse(a.fingerprint)).toEqual({ revision: 'ordinary-params-v1', schema: json(a.schema) });
    const original = contract(compileOrdinaryParams({ x: { type: 'string' } }));
    for (const x of [{ type: 'number' }, { type: 'string', required: true }, { type: 'string', default: 'a' },
      { type: 'string', desc: 'description' }, { type: 'string', constraints: { minLength: 1 } }])
      expect(contract(compileOrdinaryParams({ x })).fingerprint).not.toBe(original.fingerprint);
    expect(contract(compileOrdinaryParams({ x: { type: 'string' } }, { additionalProperties: false })).fingerprint).not.toBe(original.fingerprint);
    const rootDesc = contract(compileOrdinarySchema(schema({ x: { type: 'string' } }, { description: 'root' })));
    expect(rootDesc.schema.description).toBe('root');
    expect(rootDesc.fingerprint).not.toBe(original.fingerprint);
    expect(contract(compileOrdinaryParams({ x: { type: 'string', constraints: {} } })).fingerprint).toBe(original.fingerprint);
  });

  it('P10 rejects accessors/hidden/symbol/class/cycle/non-JSON without reading values', () => {
    let reads = 0;
    const getter = { get secret() { reads++; throw Error('SECRET_GETTER'); } };
    const hidden = Object.defineProperty({}, 'secret', { value: 'SECRET_HIDDEN' });
    const symbol = { [Symbol('secret')]: 1 };
    class Custom { value = 1; }
    const cycle: any = {}; cycle.self = cycle;
    const c = contract(compileOrdinaryParams({}));
    for (const value of [getter, hidden, symbol, new Custom(), cycle, new Date(0), { x: undefined }, { x: 1n }, { x() {} }, { x: -Infinity }]) {
      expect(c.validate(value).ok).toBe(false);
      invalid(compileOrdinaryParams(value));
      invalid(compileOrdinarySchema(value));
    }
    invalid(compileOrdinaryParams({ v: { type: 'object', default: getter } }));
    expect(reads).toBe(0);
  });
  it('P10 separates shared subobjects and normalizes -0 without freezing originals', () => {
    const shared = { a: [false, -0] }; const input = { one: shared, two: shared };
    const result = contract(compileOrdinaryParams({})).validate(input);
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
    const c = contract(compileOrdinaryParams({}));
    const nested = (depth: number): any => depth ? { x: nested(depth - 1) } : 0;
    expect(c.validate({ v: nested(23) }).ok).toBe(true);
    expect(c.validate({ v: nested(24) }).ok).toBe(false);
    expect(c.validate({ a: Array(9_998).fill(null) }).ok).toBe(true);
    expect(c.validate({ a: Array(9_999).fill(null) }).ok).toBe(false);
    expect(c.validate({ v: 'a'.repeat(128 * 1024 - 9) }).ok).toBe(true);
    expect(c.validate({ v: 'a'.repeat(128 * 1024 - 8) }).ok).toBe(false);
    const atCanonical = { v: '\0'.repeat(21_844) };
    expect(new TextEncoder().encode(JSON.stringify(atCanonical)).length).toBe(128 * 1024);
    expect(c.validate(atCanonical).ok).toBe(true);
    expect(c.validate({ v: atCanonical.v + '\0' }).ok).toBe(false);
  });
  it('P10 enforces declaration and normalized Schema depth/node/canonical budgets', () => {
    const nested = (depth: number): any => depth ? { x: nested(depth - 1) } : 0;
    const decl = (value: unknown) => schema({ o: { type: 'object', default: { a: value } } }, { required: [], additionalProperties: true });
    expect(compileOrdinarySchema(decl(nested(20))).ok).toBe(true);
    invalid(compileOrdinarySchema(decl(nested(21))));
    expect(compileOrdinarySchema(decl(Array(4_991).fill(null))).ok).toBe(true);
    invalid(compileOrdinarySchema(decl(Array(4_992).fill(null))));
    const base = { type: 'object', properties: {}, required: [], additionalProperties: true, description: '' };
    const count = Math.floor((64 * 1024 - JSON.stringify(base).length) / 6);
    expect(compileOrdinarySchema({ ...base, description: '\0'.repeat(count) }).ok).toBe(true);
    invalid(compileOrdinarySchema({ ...base, description: '\0'.repeat(count + 1) }));
    invalid(compileOrdinaryParams({ s: { type: 'string', desc: 'x'.repeat(64 * 1024) } }));
    invalid(compileOrdinarySchema({ ...base, description: 'x'.repeat(64 * 1024) }));
  });

  it('P10 applies the new canonical declaration limit to normalized Schema, not raw DSL', () => {
    const params = Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['f' + i, {
      type: 'string', required: false, constraints: {}, desc: '\0'.repeat(44),
    }]));
    expect(new TextEncoder().encode(JSON.stringify(params)).length).toBeGreaterThan(64 * 1024);
    const c = contract(compileOrdinaryParams(params));
    expect(new TextEncoder().encode(JSON.stringify(c.schema)).length).toBeLessThanOrEqual(64 * 1024);
    expect(c.validate({}).ok).toBe(true);
  });

  it.each([
    { type: 'reference' }, { type: 'array', itemType: 'reference' }, { type: 'array', itemType: 'array' },
    { type: 'integer' }, { type: 'string', nullable: true }, { type: 'string', refType: 'File' },
    { type: 'string', options: ['a'] }, { type: 'boolean', itemType: 'string' },
  ])('P11 rejects unsupported DSL vocabulary %#', field => invalid(compileOrdinaryParams({ x: field }), true));
  it.each([
    { type: 'integer' }, { type: 'object', properties: {} }, { type: 'string', nullable: true },
    { type: 'string', 'x-aotui-ref': {} }, { $ref: '#/a' }, { allOf: [] }, { oneOf: [] },
    { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    { type: 'array', items: { type: 'object', properties: {} } }, { type: 'string', mystery: 1 },
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
    const params: any = {};
    for (let i = 0; i < 20; i++) params['declared_' + i + '_'.repeat(200)] = { type: 'string', required: true };
    const c = contract(compileOrdinaryParams(params, { additionalProperties: false }));
    const result = c.validate({ UNKNOWN_SECRET_KEY: 'INPUT_SECRET_VALUE' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PARAMETER_INPUT_INVALID');
    expect(result.diagnostics.length).toBe(16);
    for (const d of result.diagnostics) {
      expect(d.parameter!.length).toBeLessThanOrEqual(128);
      expect(d.message.length).toBeLessThanOrEqual(256);
    }
    expect(JSON.stringify(result)).not.toMatch(/UNKNOWN_SECRET_KEY|INPUT_SECRET_VALUE/);
    const closed = contract(compileOrdinaryParams({}, { additionalProperties: false }));
    expect(JSON.stringify(closed.validate({ UNKNOWN_SECRET_KEY: 'INPUT_SECRET_VALUE' }))).not.toMatch(/UNKNOWN_SECRET_KEY|INPUT_SECRET_VALUE/);
    for (const field of [
      { type: 'string', constraints: { pattern: '[REGEX_SECRET' } },
      { type: 'number', default: 'DEFAULT_SECRET' },
    ]) {
      const r = compileOrdinaryParams({ private: field });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issue.message.length).toBeLessThanOrEqual(512);
      expect(JSON.stringify(r)).not.toMatch(/REGEX_SECRET|DEFAULT_SECRET/);
    }
    const control = contract(compileOrdinaryParams({ ['line\n' + 'x'.repeat(200)]: { type: 'string', required: true } }));
    const failure = control.validate({});
    if (!failure.ok) expect(failure.diagnostics[0]!.parameter).not.toContain('\n');
  });
});
