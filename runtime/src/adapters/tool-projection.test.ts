import { expect, it } from 'vitest';
import type { ObservedRef, ObservedTool } from '@aotui/core';
import { projectNativeToolSchema } from './tool-projection.js';

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
