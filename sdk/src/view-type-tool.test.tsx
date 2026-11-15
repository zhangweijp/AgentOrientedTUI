import Type from 'typebox';
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it, vi } from 'vitest';
import { ToolCatalog } from './components/ToolCatalog.js';
import { captureViewBindings, defineViewType, getToolCatalog, refParam } from './tools/view-type-tool.js';

const noArgs = Type.Object({}, { additionalProperties: false });

describe('shared ViewType definitions', () => {
    it('detaches deeply frozen business metadata and derives one model receiver', () => {
        const schema = Type.Object({ item: refParam('Item', Type.Object({ name: Type.String() })) });
        const descriptor = defineViewType({ name:'Reader', tools:{ inspect:{ description:'Inspect a row', inputSchema:schema } } });
        schema.properties.item.minLength = 9;
        const tool = descriptor.tools.inspect;
        expect(Object.isFrozen(tool.inputSchema.properties)).toBe(true);
        expect(tool.inputSchema).toMatchObject({ properties:{ item:{ minLength:1 } } });
        const [entry] = getToolCatalog([descriptor]);
        expect(entry!.inputSchema).toMatchObject({
            properties: {
                view_id: { type:'string', description: expect.stringContaining('Reader') },
                item: { type:'string', description: expect.stringContaining('view_id.ref_id') },
            },
            required:['view_id','item'],
        });
        expect(entry!.inputSchema).not.toHaveProperty('properties.item.x-aotui-ref-value');
        expect(tool.inputSchema).not.toHaveProperty('properties.view_id');
    });

    it('rejects duplicate types, reserved parameters, accessors and unsupported TypeBox fields', () => {
        const descriptor = defineViewType({ name:'Page',tools:{} });
        expect(() => getToolCatalog([descriptor, defineViewType({ name:'Page',tools:{} })]))
            .toThrow(expect.objectContaining({ code:'VIEW_TYPE_DUPLICATE' }));
        const invalid = (inputSchema: any) => defineViewType({ name:'Page',tools:{ change:{description:'Change',inputSchema} } });
        expect(() => invalid(Type.Object({view_id:Type.String()}))).toThrow(expect.objectContaining({
            code:'TOOL_SCHEMA_INVALID', path:'$.properties.view_id',
        }));
        expect(() => invalid(Type.Object({value:Type.String({format:'uuid'})}))).toThrow(expect.objectContaining({
            code:'TOOL_SCHEMA_UNSUPPORTED',path:'$.properties.value.format',
        }));
        const get = vi.fn(() => noArgs);
        expect(() => defineViewType({ name:'Page',tools:{ change:Object.defineProperty({description:'Change'},'inputSchema',
            {enumerable:true,get}) as any } })).toThrow(expect.objectContaining({code:'TOOL_DEFINITION_INVALID'}));
        expect(get).not.toHaveBeenCalled();
    });

    it('requires exactly the declared bindings and captures the executable without reading getters', () => {
        const Page = defineViewType({ name:'Page',tools:{ change:{ description:'Change',inputSchema:noArgs } } });
        const execute = vi.fn(() => ({success:true as const}));
        const author = { change:{execute} };
        const next = captureViewBindings(Page, author, 'a');
        author.change.execute = vi.fn(() => ({success:true as const}));
        expect(next).toEqual([{name:'change',enabled:true,execute}]);
        const get = vi.fn();
        for (const bindings of [undefined, {}, {...author,other:{execute}}, {change:{execute,enabled:undefined}},
            {change:Object.defineProperty({},'execute',{enumerable:true,get})}]) {
            expect(() => captureViewBindings(Page, bindings, 'a')).toThrow(expect.objectContaining({code:'TOOL_BINDING_INVALID'}));
        }
        expect(get).not.toHaveBeenCalled();
    });

    it('renders only static names even when no instance of the type is mounted', () => {
        const Empty = defineViewType({ name:'Empty',tools:{} });
        const Page = defineViewType({ name:'Page',tools:{ open:{ description:'Open a thing', inputSchema:noArgs } } });
        const markup = renderToString(h(ToolCatalog,{viewTypes:[Empty,Page]}));
        expect(markup).toContain('Page: open');
        expect(markup).not.toMatch(/Open a thing|view_id|Empty/);
    });
});
