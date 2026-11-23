import { describe, expect, it } from 'vitest';
import Type from 'typebox';
import { exportTypeBoxSchema, exportTypeBoxValueSchema } from './typebox-schema.js';

describe('exportTypeBoxSchema', () => {
  it('removes only TypeBox node metadata and keeps JSON Schema fields and descriptions', () => {
    const input = Type.Object({
      filePath: Type.String({ description: 'Absolute path of an opened file.', minLength: 1 }),
      replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every match.' })),
      mode: Type.Enum(['name', 'content']),
    }, { additionalProperties: false });

    expect(exportTypeBoxSchema(input)).toEqual({
      type: 'object',
      required: ['filePath', 'mode'],
      properties: {
        filePath: { type: 'string', description: 'Absolute path of an opened file.', minLength: 1 },
        replaceAll: { type: 'boolean', description: 'Replace every match.' },
        mode: { enum: ['name', 'content'], type: 'string' },
      },
      additionalProperties: false,
    });
  });

  it('preserves property and default data named like TypeBox metadata', () => {
    const input = Type.Object({
      '~kind': Type.String({ default: { '~kind': 'user value' } }),
    }, { additionalProperties: false });

    expect(exportTypeBoxSchema(input)).toEqual({
      type: 'object', required: ['~kind'],
      properties: { '~kind': { type: 'string', default: { '~kind': 'user value' } } },
      additionalProperties: false,
    });
  });

  it('accepts only recognized TypeBox markers and refuses hidden semantics with a path', () => {
    const refined = Type.Object({ path: Type.Refine(Type.String(), value => value.startsWith('/')) });
    expect(() => exportTypeBoxSchema(refined)).toThrowError(expect.objectContaining({
      name: 'TypeBoxSchemaExportError', code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.path.~refine',
    }));

    const codec = Type.Object({ path: Type.Decode(Type.String(), value => value) });
    expect(() => exportTypeBoxSchema(codec)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.path.~codec',
    }));

    const unknown = Type.Object({ path: Type.String() });
    Object.defineProperty(unknown.properties.path!, '~author-rule', { value: true });
    expect(() => exportTypeBoxSchema(unknown)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.path.~author-rule',
    }));
  });

  it('checks hidden data and Ref witnesses before filtering TypeBox metadata', () => {
    const defaultValue = Object.defineProperty({}, '~kind', { value: 'String' });
    expect(() => exportTypeBoxSchema({ type: 'object', properties: { item: { default: defaultValue } } }))
      .toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_INVALID', path: '$.properties.item.default.~kind' }));

    const field = { type: 'string', 'x-aotui-ref-kind': 'Note', 'x-aotui-ref-value': { type: 'object' } };
    const input = { type: 'object', properties: { item: field } };
    expect(() => exportTypeBoxSchema(input)).toThrow(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$.properties.item', reason: 'Ref value annotations require a TypeBox static value witness',
    }));
    Object.defineProperty(field, '~unsafe', { value: true });
    expect(() => exportTypeBoxSchema(input)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.item.~unsafe' }));
  });

  it('ignores Optional and Readonly metadata only on Schema nodes', () => {
    const input = Type.Object({
      list: Type.Readonly(Type.Optional(Type.Array(Type.String()))),
    }, { additionalProperties: false });
    expect(exportTypeBoxSchema(input)).toEqual({
      type: 'object', properties: { list: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    });
  });

  it('exports fixed TypeBox positions as 2020-12 and keeps array values as data', () => {
    const seat = Type.Tuple([Type.String({ description: 'Row' }), Type.Integer({ minimum: 1 }), Type.Tuple([])], {
      description: 'Seat', default: ['A', 12, []], enum: [['A', 12, []], ['B', 3, []]],
    });
    expect(exportTypeBoxValueSchema(Type.Readonly(Type.Optional(seat)))).toEqual({
      type: 'array', description: 'Seat', default: ['A', 12, []], enum: [['A', 12, []], ['B', 3, []]],
      prefixItems: [{ type: 'string', description: 'Row' }, { type: 'integer', minimum: 1 },
        { type: 'array', items: false, minItems: 0 }], items: false, minItems: 3,
    });
    expect(JSON.stringify(seat)).toContain('additionalItems');
  });

  it.each([
    [Type.Tuple([Type.String()], { minItems: 0 }), '$.minItems'],
    [Type.Tuple([Type.String()], { maxItems: 2 }), '$.maxItems'],
    [Type.Tuple([Type.String()], { prefixItems: [Type.Integer()] }), '$.prefixItems'],
    [{ type: 'array', items: [{ type: 'string' }], additionalItems: false, minItems: 1 }, '$.items'],
  ])('reports incompatible tuple declarations at %j', (value, path) => {
    expect(() => exportTypeBoxSchema(value)).toThrowError(expect.objectContaining({ path }));
  });

  it('charges structural commas only for validated exported keys at the byte boundary', () => {
    const input = Type.Object({ entry: Type.Readonly(Type.Optional(Type.String({ description: '' }))) });
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    input.properties.entry!.description = 'x'.repeat(64 * 1024 - bytes(input));
    const exported = exportTypeBoxSchema(input);
    expect(bytes(exported)).toBe(64 * 1024);
    expect(exported.properties).toEqual({ entry: { type: 'string', description: input.properties.entry!.description } });

    input.properties.entry!.description += 'x';
    expect(() => exportTypeBoxSchema(input)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
    let reads = 0;
    Object.defineProperty(input.properties.entry!, '~unknown', { get() { reads++; return true; } });
    expect(() => exportTypeBoxSchema(input)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_INVALID', path: '$.properties.entry.~unknown' }));
    expect(reads).toBe(0);
  });

  it('counts a synthesized string type as one value at the exact node boundary', () => {
    const values = Array.from({ length: 4_994 }, (_, index) => index.toString(36));
    const input = { type: 'object', properties: { choice: { enum: values } } };
    expect(exportTypeBoxSchema(input).properties).toEqual({ choice: { enum: values, type: 'string' } });
    values.push('extra');
    expect(() => exportTypeBoxSchema(input)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
  });

  it('normalizes only unconstrained opaque objects supported by the Runtime profile', () => {
    const input = Type.Object({
      context: Type.Object({}, { additionalProperties: true }),
      contexts: Type.Array(Type.Object({})),
      restricted: Type.Object({}, { additionalProperties: false }),
    });
    expect(exportTypeBoxSchema(input)).toEqual({
      type: 'object',
      required: ['context', 'contexts', 'restricted'],
      properties: {
        context: { type: 'object' },
        contexts: { type: 'array', items: { type: 'object' } },
        restricted: { type: 'object', properties: {}, additionalProperties: false },
      },
    });
  });

  it('keeps the export cost of fields removed during opaque object normalization', () => {
    const input = Type.Object({ opaque: Type.Object({}), after: Type.String({ description: '' }) });
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const exportedBytes = bytes(exportTypeBoxSchema(input));
    input.properties.after!.description = 'x'.repeat(64 * 1024 - exportedBytes);
    expect(bytes(input)).toBeGreaterThan(64 * 1024);
    expect(() => exportTypeBoxSchema(input)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
  });

  it('does not invoke getters and rejects symbols, malformed descriptors, and cycles', () => {
    let reads = 0;
    const getterSchema = { type: 'object', get description() { reads++; return 'unsafe'; }, properties: {} };
    expect(() => exportTypeBoxSchema(getterSchema)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$.description',
    }));
    expect(reads).toBe(0);

    const symbolSchema = { type: 'object', properties: {} };
    Object.defineProperty(symbolSchema, Symbol('hidden'), { value: true });
    expect(() => exportTypeBoxSchema(symbolSchema)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$',
    }));

    const cycle: { type: string; properties: Record<string, unknown> } = { type: 'object', properties: {} };
    cycle.properties.self = cycle;
    expect(() => exportTypeBoxSchema(cycle)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$.properties.self',
    }));

    const customArray = Object.setPrototypeOf(['x'], {});
    const customArraySchema = { type: 'object', properties: { mode: { type: 'string', enum: customArray } } };
    expect(() => exportTypeBoxSchema(customArraySchema)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$.properties.mode.enum',
    }));

    const sparseArray = new Array(2);
    const sparseSchema = { type: 'object', properties: { value: { type: 'array', items: { type: 'string' }, default: sparseArray } } };
    expect(() => exportTypeBoxSchema(sparseSchema)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$.properties.value.default',
    }));

    const longKey = 'path'.repeat(100);
    const longPathSchema = { type: 'object', properties: {} as Record<string, unknown> };
    Object.defineProperty(longPathSchema.properties, longKey, { get: () => 'must not run', enumerable: true });
    try {
      exportTypeBoxSchema(longPathSchema);
      throw new Error('expected invalid descriptor');
    } catch (error) {
      expect(error).toMatchObject({ code: 'TOOL_SCHEMA_INVALID' });
      expect((error as Error & { path: string }).path.length).toBeLessThanOrEqual(240);
      expect(reads).toBe(0);
    }
  });

  it('bounds Schema depth, node count, and UTF-8 bytes', () => {
    let nested: unknown = { type: 'string' };
    for (let i = 0; i < 30; i++) nested = { type: 'object', properties: { child: nested } };
    expect(() => exportTypeBoxSchema(nested)).toThrowError(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));

    const properties = Object.fromEntries(Array.from({ length: 2600 }, (_, i) => [`p${i}`, { type: 'string' }]));
    expect(() => exportTypeBoxSchema({ type: 'object', properties })).toThrowError(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));

    const large = Type.Object({ value: Type.String({ description: 'x'.repeat(70_000) }) });
    expect(() => exportTypeBoxSchema(large)).toThrowError(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
  });

  it('returns a fresh immutable JSON copy without freezing the author library object', () => {
    const input = Type.Object({ path: Type.String() });
    const first = exportTypeBoxSchema(input);
    const second = exportTypeBoxSchema(input);
    expect(first).not.toBe(input);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.properties.path)).toBe(false);
  });
});
