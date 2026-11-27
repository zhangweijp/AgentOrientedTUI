import { canonicalJson, compileToolParameters, type JsonValue } from '@aotui/core';
import { expect, it } from 'vitest';
import { Check } from 'typebox/value';
import type { XSchema } from 'typebox/schema';
import { NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA as address, projectNativeToolSchema } from './tool-projection.js';

type Schema = Readonly<Record<string, JsonValue>>;
const business = (properties: Schema, required: string[] = []) => {
    const result = compileToolParameters({ type: 'object', additionalProperties: false, properties, required });
    if (!result.ok) throw Error(JSON.stringify(result.issue));
    return result.contract.schema;
};
const compile = (inputSchema: Schema, multiplicity: 'multiple' | 'single' = 'multiple') =>
    projectNativeToolSchema({ inputSchema, viewType: 'Editor', multiplicity });
const props = (schema: Schema) => schema.properties as Schema;
const marker = { 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'string' } } as const;

it('compiles only declaration and multiplicity, and captures a frozen copy', () => {
    const original = business({ text: { type: 'string' }, raw: {}, priority: { type: 'integer' } }, ['text', 'priority']);
    const result = compile(original);
    expect(result).toMatchObject({ required: ['view_id', 'priority', 'text'], properties: {
        view_id: { type: 'string' }, text: { type: 'string' }, raw: {},
        priority: { anyOf: [{ type: 'integer' }, address] },
    } });
    expect(props(compile(original, 'single'))).not.toHaveProperty('view_id');
    expect(props(original)).not.toHaveProperty('view_id');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(props(result))).toBe(true);
    expect(Object.isFrozen(props(result).priority)).toBe(true);
    expect(canonicalJson(compile(JSON.parse(JSON.stringify(original))))).toBe(canonicalJson(result));
});

it('escapes literal const/enum/default only at named and direct array slots', () => {
    const original = business({
        exact: { type: 'string', const: '$ref.x', default: '$ref.x' },
        choice: { type: 'string', enum: ['open', '$$ref.x', '$HOME'] },
        bounded: { type: 'string', maxLength: 6 },
        tuple: { type: 'array', items: false, minItems: 2, prefixItems: [
            { type: 'string', const: '$$$ref.x' },
            { type: 'object', properties: { text: { type: 'string', const: '$ref.x' } } },
        ] },
        nested: { type: 'array', items: { type: 'array', items: { type: 'string', const: '$ref.x' } } },
        union: { anyOf: [{ type: 'string', const: '$ref.x' }, { type: 'number' }] },
        list: { type: 'array', items: { type: 'string' }, default: ['$ref.x', '$$ref.x', '$$$ref.x'] },
    });
    const before = canonicalJson(original);
    expect(props(compile(original))).toMatchObject({
        exact: { default: '$$ref.x', anyOf: [{ const: '$$ref.x' }, address] },
        choice: { anyOf: [{ enum: ['open', '$$$ref.x', '$HOME'] }, address] },
        bounded: { anyOf: [{ maxLength: 7 }, address] },
        tuple: { anyOf: [{ prefixItems: [
            { anyOf: [{ const: '$$$$ref.x' }, address] },
            { anyOf: [{ properties: { text: { const: '$ref.x' } } }, address] },
        ] }, address] },
        nested: { anyOf: [{ items: { anyOf: [{ items: { const: '$ref.x' } }, address] } }, address] },
        union: { anyOf: [{ const: '$$ref.x' }, { type: 'number' }, address] },
        list: { default: ['$$ref.x', '$$$ref.x', '$$$$ref.x'] },
    });
    expect(canonicalJson(original)).toBe(before);
});

it('distinguishes ordinary, whole refParam and refParam array slots', () => {
    const original = business({
        ordinary: { type: 'array', items: { type: 'integer' } },
        whole: { ...marker, 'x-aotui-ref-value': { type: 'array', items: { type: 'string' } } },
        parts: { type: 'array', items: marker, maxItems: 3 },
    });
    const result = props(compile(original));
    expect(result).toMatchObject({
        ordinary: { anyOf: [{ type: 'array', items: { anyOf: [{ type: 'integer' }, address] } }, address] },
        whole: { type: 'string', pattern: address.pattern },
        parts: { type: 'array', maxItems: 3, items: { type: 'string', pattern: address.pattern } },
    });
    expect(result.whole).not.toHaveProperty('anyOf');
    expect(result.parts).not.toHaveProperty('anyOf');
    expect(JSON.stringify(result)).not.toContain('x-aotui-ref-');
    const regex = new RegExp(address.pattern);
    expect(regex.test('$ref.app.list.items["mode.name"]')).toBe(true);
    for (const invalid of ['turbo', '$ref.app.list', '$ref.app.list.2fa', '$$ref.app.list.items']) expect(regex.test(invalid)).toBe(false);
});

it('admits direct element addresses for array enum/const without weakening business choices or object literals', () => {
    const original = business({
        choices: { type: 'array', items: { type: 'string' }, enum: [['fast']], maxItems: 1 },
        tuple: { type: 'array', items: false, prefixItems: [{ type: 'integer' }], minItems: 1, const: [1] },
        literal: { type: 'object', enum: [{ a: '$ref.x' }] },
    });
    const before = canonicalJson(original);
    const result = props(compile(original));
    expect(result.choices).toMatchObject({ anyOf: [{ type: 'array', items: { type: 'string' }, maxItems: 1 }, address] });
    expect((result.choices as Schema).anyOf).toHaveLength(2);
    expect((result.choices as { anyOf: Schema[] }).anyOf[0]).not.toHaveProperty('enum');
    expect(Check(result.choices as XSchema, ['$ref.workspace.editor_1.fast'])).toBe(true);
    expect(Check(result.choices as XSchema, ['$ref.workspace.editor_1.turbo'])).toBe(true);
    expect(Check(result.choices as XSchema, ['fast', 'accurate'])).toBe(false);
    expect(Check(props(original).choices as XSchema, ['fast'])).toBe(true);
    expect(Check(props(original).choices as XSchema, ['turbo'])).toBe(false);

    expect(result.tuple).toMatchObject({ anyOf: [{ items: false, minItems: 1, prefixItems: [{ anyOf: [{ type: 'integer' }, address] }] }, address] });
    expect(result.literal).toMatchObject({ anyOf: [{ enum: [{ a: '$ref.x' }] }, address] });
    expect(canonicalJson(original)).toBe(before);
});

it('reduces exact duplicate and plainly contained branches only', () => {
    const result = props(compile(business({
        text: { anyOf: [{ type: 'string' }, { const: 'foo' }, { type: 'integer' }, { type: 'integer' }] },
        all: { anyOf: [{}, { type: 'integer' }] },
        constrained: { type: 'string', enum: ['fast', 'accurate'] },
    })));
    expect(result.text).toMatchObject({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
    expect((result.text as Schema).anyOf).toHaveLength(2);
    expect(result.all).not.toHaveProperty('anyOf');
    expect(result.constrained).toMatchObject({ anyOf: [{ enum: ['fast', 'accurate'] }, address] });
});

it('reports exact unsupported schema paths and bounded JSON failures', () => {
    const original = business({ choices: { type: 'array', items: { type: 'string' }, anyOf: [{ const: ['fast'] }] } });
    expect(() => compile(original)).toThrow(expect.objectContaining({ code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED', path: '$.properties.choices.anyOf' }));
    const base = business({});
    const exact = 64 * 1024 - Buffer.byteLength(JSON.stringify(compile({ ...base, description: '' })));
    expect(Buffer.byteLength(JSON.stringify(compile({ ...base, description: 'x'.repeat(exact) })))).toBe(64 * 1024);
    expect(() => compile({ ...base, description: 'x'.repeat(exact + 1) })).toThrow(expect.objectContaining({ code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED', path: '$["description"]', message: 'Encoded JSON exceeds the byte limit' }));
    let nested: JsonValue = null;
    for (let i = 0; i < 60; i++) nested = [nested];
    expect(() => compile({ ...base, properties: { deep: { const: nested } } })).toThrow(expect.objectContaining({
        code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED', path: '$["properties"]["deep"]["const"]' + '[0]'.repeat(46), message: 'Depth budget exceeded',
    }));
    expect(() => compile({ ...base, properties: { wide: { enum: Array(100_001).fill(null) } } })).toThrow(expect.objectContaining({
        code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED', path: '$["properties"]["wide"]["enum"]', message: 'Encoded JSON exceeds the byte limit',
    }));
});
