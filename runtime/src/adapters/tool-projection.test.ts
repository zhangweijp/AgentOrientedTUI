import { expect, it } from 'vitest';
import type { ObservedRef, ObservedTool } from '@aotui/core';
import { NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA, projectNativeToolSchema } from './tool-projection.js';

const app = { appId: 'app', instanceId: 'one' };
const publisher = { appId: 'contacts', instanceId: 'book' };
const receiver = { viewId: 'draft_1', viewInstanceId: 'draft-mount' };
const base: ObservedTool = { id: 'edit', name: 'edit', viewType: 'draft', description: 'Edit the draft', multiplicity: 'multiple',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text', 'priority'], properties: {
        text: { type: 'string' }, priority: { type: 'integer' }, raw: {},
        values: { type: 'array', items: { type: 'boolean' } },
    } } };
const ref: ObservedRef = { viewId: 'list', viewInstanceId: 'list-mount', refId: 'items', scope: 'public', refType: 'Value',
    valueSchema: { type: 'array', items: { type: 'integer' } } };

it('shows a string reference alternative only for an eligible and possibly compatible parameter', () => {
    const result = projectNativeToolSchema(base, app, [receiver], [{ source: publisher, ref }]);
    expect(result).toMatchObject({
        required: ['view_id', 'text', 'priority'],
        properties: { view_id: { type: 'string' }, text: { type: 'string' },
            priority: { anyOf: [{ type: 'integer' }, { type: 'string' }] }, raw: {},
            values: { anyOf: [{ type: 'array', items: { type: 'boolean' } }, { type: 'string' }] } },
    });
    expect(result.properties).not.toHaveProperty('text.anyOf');
    expect(result.properties).not.toHaveProperty('raw.anyOf');
    expect(base.inputSchema.properties).not.toHaveProperty('view_id');
});
it.each([
    { ...ref, scope: 'protected' } as const,
    { ...ref, scope: 'private' } as const,
    { ...ref, consumers: [{ ...app, ...receiver, viewInstanceId: 'retired' }] },
    { ...ref, consumers: [{ ...app, ...receiver, instanceId: 'retired' }] },
    { ...ref, valueSchema: { type: 'string' } },
])('keeps the business schema when no reference can reach this mount and type', limited => {
    const observed = projectNativeToolSchema({ ...base, multiplicity: 'single' }, app, [receiver], [{ source: publisher, ref: limited }]);
    expect(observed).toEqual(base.inputSchema);
});
it('measures the actual projected schema at its own boundary', () => {
    const large = { ...base, inputSchema: { ...base.inputSchema,
        properties: { limited: { type: 'string', description: '中'.repeat(22_000) } } } };
    expect(() => projectNativeToolSchema(large, app, [receiver], [])).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_CAPACITY' }));
});

it('maps literal transport spellings only at the parameter and direct element slots', () => {
    const tool: ObservedTool = { ...base, inputSchema: { ...base.inputSchema, properties: {
        exact: { type: 'string', const: '$ref.x' },
        choice: { type: 'string', enum: ['open', '$$ref.x', '$HOME'] },
        bounded: { type: 'string', maxLength: 6 },
        tuple: { type: 'array', items: false, minItems: 2, prefixItems: [
            { type: 'string', const: '$$$ref.x' },
            { type: 'object', properties: { text: { type: 'string', const: '$ref.x' } } },
        ] },
        union: { anyOf: [{ type: 'string', const: '$ref.x' }, { type: 'number' }] },
    } } };
    expect(projectNativeToolSchema(tool, app, [receiver], []).properties).toMatchObject({
        exact: { const: '$$ref.x' },
        choice: { enum: ['open', '$$$ref.x', '$HOME'] },
        bounded: { maxLength: 7 },
        tuple: { prefixItems: [{ const: '$$$$ref.x' }, { properties: { text: { const: '$ref.x' } } }] },
        union: { anyOf: [{ const: '$$ref.x' }, { type: 'number' }] },
    });
});

it('retains a restricted string choice when a same-App protected Ref is usable', () => {
    const mode = { type: 'string', enum: ['fast', 'accurate'] };
    const exact = { type: 'string', const: '$$ref.x' };
    const tool: ObservedTool = { ...base, inputSchema: { ...base.inputSchema,
        properties: { mode, exact }, required: ['mode', 'exact'] } };
    const stringRef: ObservedRef = { ...ref, scope: 'protected',
        valueSchema: { type: 'object', properties: { mode: { type: 'string' } }, additionalProperties: false } };
    const protectedRef = { source: app, ref: stringRef };
    const privateRef = { source: app, ref: { ...stringRef, scope: 'private' as const } };
    for (const refs of [[], [privateRef]]) {
        expect(projectNativeToolSchema(tool, app, [receiver], refs).properties).toMatchObject({
            mode, exact: { type: 'string', const: '$$$ref.x' },
        });
    }
    expect(projectNativeToolSchema(tool, app, [receiver], [protectedRef]).properties).toMatchObject({
        mode: { anyOf: [mode, NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA] },
        exact: { anyOf: [{ type: 'string', const: '$$$ref.x' }, NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA] },
    });
    const address = new RegExp(NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA.pattern);
    expect(address.test('$ref.app.list.items["mode.name"]')).toBe(true);
    for (const invalid of ['turbo', '$ref.app.list', '$ref.app.list.2fa', '$$ref.app.list.items'])
        expect(address.test(invalid)).toBe(false);
});
