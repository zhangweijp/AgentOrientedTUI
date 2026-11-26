import { compileToolParameters, compileValueSchema, createRefCapture } from '@aotui/core';
import { describe, expect, it } from 'vitest';
import Type from 'typebox';
import schemaContractVectors from '../../../core/src/tool/schema-contract-vectors.json' with { type: 'json' };
import { exportToolSchema, exportValueSchema } from './schema-export.js';
import { defineViewType, refParam } from './view-type-tool.js';
import { arrayRef, capturePublication, formatRef, ref } from '../app-factory/refs.js';
import type { JsonSchemaObject, StandardJSONSchemaV1 } from './schema-types.js';

function standard(declaration: JsonSchemaObject, targets: string[] = []): StandardJSONSchemaV1 {
  const metadata = {
    version: 1,
    vendor: 'schema-test',
    jsonSchema: {
      input({ target }: { target: 'draft-2020-12' }) {
        targets.push(target);
        return Object.defineProperty({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...declaration },
          '~standard', { value: metadata });
      },
      output(): never { throw new Error('Do not call output() for input declarations'); },
    },
  } as const;
  return { get '~standard'() { return metadata; } };
}

describe('exportToolSchema', () => {
  it('uses only the Standard JSON input exporter and removes only its boundary metadata', () => {
    const targets: string[] = [];
    const schema = standard({ type: 'object', properties: {
      pattern: { type: 'string' }, $schema: { type: 'boolean' }, '~standard': { type: 'integer' },
      fallback: { type: 'string', default: 'missing' },
      nested: { type: 'object', additionalProperties: true, properties: { value: { type: 'string' } } },
    }, required: ['pattern', '$schema'] }, targets);
    const view = defineViewType<object>()({ name: 'Export', multiplicity: 'single',
      tools: { submit: { description: 'test', inputSchema: schema, execute: () => ({ success: true }) } } });
    const { inputSchema } = view.tools.submit;
    expect(targets).toEqual(['draft-2020-12']);
    expect(inputSchema).not.toHaveProperty('$schema');
    expect(Object.hasOwn(inputSchema, '~standard')).toBe(false);
    expect(inputSchema).toMatchObject({ additionalProperties: false, properties: {
      $schema: { type: 'boolean' }, pattern: { type: 'string' }, '~standard': { type: 'integer' },
      nested: { additionalProperties: true },
    } });
    const checked = compileToolParameters(inputSchema);
    if (!checked.ok) throw new Error(checked.issue.message);
    const business = { pattern: '*', $schema: true, nested: { extra: 'retained' } };
    expect(checked.contract.validateResolvedInput(business)).toEqual({ ok: true, value: business });
    expect(checked.contract.validateResolvedInput({ ...business, extra: 1 })).toMatchObject({ ok: false });
    const openRoot = compileToolParameters(exportToolSchema(standard({ ...inputSchema, additionalProperties: true })));
    if (!openRoot.ok) throw new Error(openRoot.issue.message);
    expect(openRoot.contract.validateResolvedInput({ ...business, extra: 1 })).toMatchObject({ ok: true });
  });

  it('locates an incompatible dialect, unsupported keywords, and a nominal value export', () => {
    expect(() => exportValueSchema(standard({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'integer' })))
      .toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.$schema' }));
    const view = defineViewType<object>();
    const declaration = (inputSchema: any) => view({ name: 'Export', multiplicity: 'single',
      tools: { submit: { description: 'test', inputSchema, execute: () => ({ success: true }) } } });
    expect(() => declaration(standard({ type: 'object', properties: { value: { type: 'string', pattern: '^abc' } } })))
      .toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.value.pattern' }));
    expect(() => declaration({ type: 'object', properties: { item: refParam('Doc', standard({ type: 'string', format: 'email' })) } }))
      .toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.item["x-aotui-ref-value"].format' }));
  });

  it('accepts an arbitrary JSON field and requires a declared shape for refParam', () => {
    const ordinary = compileToolParameters(exportToolSchema(Type.Object({ body: Type.Unknown() })));
    expect(ordinary).toMatchObject({ ok: true, contract: { schema: { properties: { body: {} } } } });
    const ref = compileToolParameters(exportToolSchema(Type.Object({ item: refParam('Item', Type.Unknown()) })));
    expect(ref).toMatchObject({ ok: false, issue: {
      code: 'PARAMETER_DECLARATION_INVALID', path: '$.properties.item["x-aotui-ref-value"]',
    } });
  });
  it('removes only TypeBox node metadata and keeps JSON Schema fields and descriptions', () => {
    const input = Type.Object({
      filePath: Type.String({ description: 'Absolute path of an opened file.', minLength: 1 }),
      replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every match.' })),
      mode: Type.Enum(['name', 'content']),
    }, { additionalProperties: false });

    expect(exportToolSchema(input)).toEqual({
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

    expect(exportToolSchema(input)).toEqual({
      type: 'object', required: ['~kind'],
      properties: { '~kind': { type: 'string', default: { '~kind': 'user value' } } },
      additionalProperties: false,
    });
  });

  it('accepts only recognized TypeBox markers and refuses hidden semantics with a path', () => {
    const refined = Type.Object({ path: Type.Refine(Type.String(), value => value.startsWith('/')) });
    expect(() => exportToolSchema(refined)).toThrowError(expect.objectContaining({
      name: 'SchemaExportError', code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.path.~refine',
    }));

    const codec = Type.Object({ path: Type.Decode(Type.String(), value => value) });
    expect(() => exportToolSchema(codec)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.path.~codec',
    }));

    const unknown = Type.Object({ path: Type.String() });
    Object.defineProperty(unknown.properties.path!, '~author-rule', { value: true });
    expect(() => exportToolSchema(unknown)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.path.~author-rule',
    }));
  });

  it('checks hidden data and accepts portable Ref parameters', () => {
    const defaultValue = Object.defineProperty({}, '~kind', { value: 'String' });
    expect(() => exportToolSchema({ type: 'object', properties: { item: { default: defaultValue } } }))
      .toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_INVALID', path: '$.properties.item.default.~kind' }));

    const field = { 'x-aotui-ref-kind': 'Note', 'x-aotui-ref-value': { type: 'object' } };
    const input = { type: 'object', properties: { item: field } };
    expect(compileToolParameters(exportToolSchema(input))).toMatchObject({ ok: true });
    Object.defineProperty(field, '~unsafe', { value: true });
    expect(() => exportToolSchema(input)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.item.~unsafe' }));
  });

  it('ignores Optional and Readonly metadata only on Schema nodes', () => {
    const input = Type.Object({
      list: Type.Readonly(Type.Optional(Type.Array(Type.String()))),
    }, { additionalProperties: false });
    expect(exportToolSchema(input)).toEqual({
      type: 'object', properties: { list: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    });
  });

  it('exports fixed TypeBox positions as 2020-12 and keeps array values as data', () => {
    const seat = Type.Tuple([Type.String({ description: 'Row' }), Type.Integer({ minimum: 1 }), Type.Tuple([])], {
      description: 'Seat', default: ['A', 12, []], enum: [['A', 12, []], ['B', 3, []]],
    });
    expect(exportValueSchema(Type.Readonly(Type.Optional(seat)))).toEqual({
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
    expect(() => exportToolSchema(value)).toThrowError(expect.objectContaining({ path }));
  });

  it('charges structural commas only for validated exported keys at the byte boundary', () => {
    const input = Type.Object({ entry: Type.Readonly(Type.Optional(Type.String({ description: '' }))) }, { additionalProperties: true });
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    input.properties.entry!.description = 'x'.repeat(64 * 1024 - bytes(input));
    const exported = exportToolSchema(input);
    expect(bytes(exported)).toBe(64 * 1024);
    expect(exported.properties).toEqual({ entry: { type: 'string', description: input.properties.entry!.description } });

    input.properties.entry!.description += 'x';
    expect(() => exportToolSchema(input)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
    let reads = 0;
    Object.defineProperty(input.properties.entry!, '~unknown', { get() { reads++; return true; } });
    expect(() => exportToolSchema(input)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_INVALID', path: '$.properties.entry.~unknown' }));
    expect(reads).toBe(0);
  });

  it('counts a synthesized string type as one value at the exact node boundary', () => {
    const values = Array.from({ length: 4_993 }, (_, index) => index.toString(36));
    const input = { type: 'object', properties: { choice: { enum: values } } };
    expect(exportToolSchema(input).properties).toEqual({ choice: { enum: values, type: 'string' } });
    values.push('extra');
    expect(() => exportToolSchema(input)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
  });

  it('normalizes only unconstrained opaque objects supported by the Runtime profile', () => {
    const input = Type.Object({
      context: Type.Object({}, { additionalProperties: true }),
      contexts: Type.Array(Type.Object({})),
      restricted: Type.Object({}, { additionalProperties: false }),
    });
    expect(exportToolSchema(input)).toEqual({
      type: 'object',
      required: ['context', 'contexts', 'restricted'],
      properties: {
        context: { type: 'object' },
        contexts: { type: 'array', items: { type: 'object' } },
        restricted: { type: 'object', properties: {}, additionalProperties: false },
      },
      additionalProperties: false,
    });
  });

  it('keeps the export cost of fields removed during opaque object normalization', () => {
    const input = Type.Object({ opaque: Type.Object({}), after: Type.String({ description: '' }) }, { additionalProperties: false });
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const exportedBytes = bytes(exportToolSchema(input));
    input.properties.after!.description = 'x'.repeat(64 * 1024 - exportedBytes);
    expect(bytes(input)).toBeGreaterThan(64 * 1024);
    expect(() => exportToolSchema(input)).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
  });

  it('does not invoke getters and rejects symbols, malformed descriptors, and cycles', () => {
    let reads = 0;
    const getterSchema = { type: 'object', get description() { reads++; return 'unsafe'; }, properties: {} };
    expect(() => exportToolSchema(getterSchema)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$.description',
    }));
    expect(reads).toBe(0);

    const symbolSchema = { type: 'object', properties: {} };
    Object.defineProperty(symbolSchema, Symbol('hidden'), { value: true });
    expect(() => exportToolSchema(symbolSchema)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$',
    }));

    const cycle: { type: string; properties: Record<string, unknown> } = { type: 'object', properties: {} };
    cycle.properties.self = cycle;
    expect(() => exportToolSchema(cycle)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$.properties.self',
    }));

    const customArray = Object.setPrototypeOf(['x'], {});
    const customArraySchema = { type: 'object', properties: { mode: { type: 'string', enum: customArray } } };
    expect(() => exportToolSchema(customArraySchema)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$.properties.mode.enum',
    }));

    const sparseArray = new Array(2);
    const sparseSchema = { type: 'object', properties: { value: { type: 'array', items: { type: 'string' }, default: sparseArray } } };
    expect(() => exportToolSchema(sparseSchema)).toThrowError(expect.objectContaining({
      code: 'TOOL_SCHEMA_INVALID', path: '$.properties.value.default',
    }));

    const longKey = 'path'.repeat(100);
    const longPathSchema = { type: 'object', properties: {} as Record<string, unknown> };
    Object.defineProperty(longPathSchema.properties, longKey, { get: () => 'must not run', enumerable: true });
    try {
      exportToolSchema(longPathSchema);
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
    expect(() => exportToolSchema(nested)).toThrowError(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));

    const properties = Object.fromEntries(Array.from({ length: 2600 }, (_, i) => [`p${i}`, { type: 'string' }]));
    expect(() => exportToolSchema({ type: 'object', properties })).toThrowError(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));

    const large = Type.Object({ value: Type.String({ description: 'x'.repeat(70_000) }) });
    expect(() => exportToolSchema(large)).toThrowError(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
  });

  it('returns a fresh immutable JSON copy without freezing the author library object', () => {
    const input = Type.Object({ path: Type.String() });
    const first = exportToolSchema(input);
    const second = exportToolSchema(input);
    expect(first).not.toBe(input);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.properties.path)).toBe(false);
  });

  const vectors = schemaContractVectors as {
    toolSchemas: Array<Record<string, any>>;
    valueSchemas: Array<Record<string, any>>;
  };

  it.each(vectors.toolSchemas.map(vector => [vector.name, vector]))(
    'matches shared tool schema vector %s',
    (_name, vector) => {
      if (vector.expect !== 'valid') {
        const exported = exportToolSchema(vector.schema);
        const compiled = compileToolParameters(exported);
        expect(compiled).toMatchObject({
          ok: false,
          issue: { code: vector.expect === 'unsupported' ? 'PARAMETER_DECLARATION_UNSUPPORTED' : 'PARAMETER_DECLARATION_INVALID' },
        });
        return;
      }
      const exported = exportToolSchema(vector.schema);
      const compiled = compileToolParameters(exported);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) throw new Error('Expected valid tool schema vector');
      for (const input of vector.validInputs) expect(compiled.contract.validateResolvedInput(input).ok).toBe(true);
      for (const input of vector.invalidInputs) expect(compiled.contract.validateResolvedInput(input).ok).toBe(false);
      if (vector.preserveExact !== undefined) {
        expect(compiled.contract.validateResolvedInput(vector.preserveExact)).toEqual({ ok: true, value: vector.preserveExact });
      }
      if (vector.sdkExtraOk !== undefined) {
        expect(exported.additionalProperties).toBe(vector.sdkExtraOk);
        expect(compiled.contract.validateResolvedInput({ a: 'ok', extra: 1 }).ok).toBe(vector.sdkExtraOk);
      }
    },
  );

  it.each(vectors.valueSchemas.map(vector => [vector.name, vector]))(
    'matches shared value schema vector %s',
    (_name, vector) => {
      const exported = exportValueSchema(vector.schema);
      const compiled = compileValueSchema(exported);
      const nominal = compileToolParameters(exportToolSchema(Type.Object({ item: refParam('Item', vector.schema) })));
      if (vector.expect !== 'valid') {
        const code = vector.expect === 'unsupported' ? 'PARAMETER_DECLARATION_UNSUPPORTED' : 'PARAMETER_DECLARATION_INVALID';
        expect(compiled).toMatchObject({ ok: false, issue: { code } });
        expect(nominal).toMatchObject({ ok: false, issue: { code } });
        if (vector.issuePath) {
          expect(compiled).toMatchObject({ issue: { path: vector.issuePath } });
          expect(nominal).toMatchObject({ issue: { path: '$.properties.item["x-aotui-ref-value"]' + vector.issuePath.slice(1) } });
        }
        return;
      }
      expect(compiled.ok).toBe(true);
      expect(nominal.ok).toBe(true);
      if (!compiled.ok || !nominal.ok) throw new Error('Expected valid value schema vector');
      for (const [values, ok] of [[vector.validValues, true], [vector.invalidValues, false]] as const) {
        for (const value of values) {
          expect(compiled.validate(value) === undefined).toBe(ok);
          expect(nominal.contract.validateResolvedInput({ item: value }).ok).toBe(ok);
        }
      }
    },
  );
});

it('checks Ref IDs at declaration and uses the converted value Schema for marker type and publication', () => {
  const person = standard({ type: 'object', properties: { 'display.name': { type: 'string' } }, required: ['display.name'] });
  const payload = { 'display.name': '小梅' };
  const options = { scope: 'protected', schema: person } as const;
  for (const id of ['2fa', 'items[0]', 'items.name', '$note', '名字']) {
    expect(() => ref(id, payload, options)).toThrow(expect.objectContaining({ code: 'SNAPSHOT_INVALID', path: 'Ref ' + id }));
  }
  const published = ref('_person2', payload, options);
  expect(formatRef('小梅', published)).toBe('[小梅](protected _person2: object)');
  expect(capturePublication('list', createRefCapture(), published)).toMatchObject({
    id: '_person2', refType: 'object', value: payload, valueSchema: { type: 'object', properties: { 'display.name': { type: 'string' } } },
  });
  const list = arrayRef('people', [payload], { scope: 'protected', itemType: 'Person',
    schema: standard({ type: 'array', items: { type: 'object' } }) });
  expect(formatRef('小梅', list, 0)).toBe('[小梅](people[0])');
  expect(() => formatRef('Missing', list, 1)).toThrow(expect.objectContaining({ code: 'SNAPSHOT_INVALID' }));
});
