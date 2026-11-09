import { describe, expect, it } from 'vitest';
import Type from 'typebox';
import { exportTypeBoxSchema, TypeBoxSchemaExportError } from './typebox-schema.js';

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

  it('ignores Optional and Readonly metadata only on Schema nodes', () => {
    const input = Type.Object({
      list: Type.Readonly(Type.Optional(Type.Array(Type.String()))),
    }, { additionalProperties: false });
    expect(exportTypeBoxSchema(input)).toEqual({
      type: 'object', properties: { list: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    });
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
