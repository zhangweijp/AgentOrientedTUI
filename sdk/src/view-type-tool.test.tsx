import Type from 'typebox';
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it, vi } from 'vitest';
import { ToolCatalog } from './components/ToolCatalog.js';
import { captureViewBindings, defineViewType, getToolCatalog, refParam } from './tools/view-type-tool.js';

const execute = () => ({ success: true as const });
const noArgs = Type.Object({}, { additionalProperties: false });

describe('shared ViewType definitions', () => {
    it('detaches deeply frozen business metadata and derives one model receiver', () => {
        const schema = Type.Object({ item: refParam('Item', Type.Object({ name: Type.String() })) });
        const descriptor = defineViewType<object>()({ name:'Reader', tools:{ inspect:{ description:'Inspect a row', inputSchema:schema, execute } } });
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
        const descriptor = defineViewType({ name:'Page' });
        expect(() => getToolCatalog([descriptor, defineViewType({ name:'Page' })]))
            .toThrow(expect.objectContaining({ code:'VIEW_TYPE_DUPLICATE' }));
        const invalid = (inputSchema: any) => defineViewType<object>()({ name:'Page',tools:{ change:{description:'Change',inputSchema,execute} } });
        expect(() => invalid(Type.Object({view_id:Type.String()}))).toThrow(expect.objectContaining({
            code:'TOOL_SCHEMA_INVALID', path:'$.properties.view_id',
        }));
        expect(() => invalid(Type.Object({value:Type.String({format:'uuid'})}))).toThrow(expect.objectContaining({
            code:'TOOL_SCHEMA_UNSUPPORTED',path:'$.properties.value.format',
        }));
        const get = vi.fn(() => noArgs);
        expect(() => defineViewType<object>()({ name:'Page',tools:{ change:Object.defineProperty({description:'Change',execute},'inputSchema',
            {enumerable:true,get}) as any } })).toThrow(expect.objectContaining({code:'TOOL_DEFINITION_INVALID'}));
        expect(get).not.toHaveBeenCalled();
    });

    it('renders only static names even when no instance of the type is mounted', () => {
        const Empty = defineViewType({ name:'Empty' });
        const Page = defineViewType<object>()({ name:'Page',tools:{ open:{ description:'Open a thing', inputSchema:noArgs, execute } } });
        const markup = renderToString(h(ToolCatalog,{viewTypes:[Empty,Page]}));
        expect(markup).toContain('Page: open');
        expect(markup).not.toMatch(/Open a thing|view_id|Empty/);
        expect(() => renderToString(h(ToolCatalog, {}))).toThrow(expect.objectContaining({
            code: 'TOOL_CATALOG_CONTEXT_REQUIRED', message: expect.stringContaining('viewTypes'),
        }));
    });

    it('normalizes an omitted Schema and rejects explicitly invalid schemas', () => {
        const close = { description: 'Close the page', execute };
        const declare = defineViewType<object>();
        const page = declare({ name: 'Page', tools: { close } });
        const empty = declare({ name: 'Page', tools: { close: { ...close, inputSchema: noArgs } } });
        expect(page.tools.close.inputSchema).toEqual(empty.tools.close.inputSchema);
        expect(getToolCatalog([page])[0]?.inputSchema).toMatchObject({
            type: 'object',
            properties: { view_id: { type: 'string' } },
            required: ['view_id'],
            additionalProperties: false,
        });
        expect(Object.keys(getToolCatalog([page])[0]!.inputSchema.properties!)).toEqual(['view_id']);
        for (const inputSchema of [undefined, null, Type.String(), Type.Object({ view_id: Type.String() })]) {
            const invalid = { ...close, inputSchema } as typeof close & { inputSchema: typeof noArgs };
            expect(() => declare({ name: 'Page', tools: { close: invalid } }))
                .toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_INVALID' }));
        }
    });

    it('keeps context local and retains executable declarations across SDK copies', async () => {
        type PageContext = { ready: boolean; change: () => void; self?: PageContext };
        const enabled = vi.fn((context: PageContext) => context.ready);
        const execute = vi.fn(({ context }: { context: PageContext }) => {
            context.change();
            return { success: true as const };
        });
        const Page = defineViewType<PageContext>()({ name: 'Page', tools: {
            change: { description: 'Modify the selected page', inputSchema: noArgs, execute, enabled },
        } });

        vi.resetModules();
        const other = await import('./tools/view-type-tool.js');
        expect(other.defineViewType).not.toBe(defineViewType);
        const types = other.captureViewTypes([Page]);
        const type = other.requireViewType(types, Page);
        expect(other.toolDefinitions(types)).toEqual([
            { name: 'change', viewType: 'Page', description: 'Modify the selected page', inputSchema: Page.tools.change.inputSchema },
        ]);
        expect(other.getToolCatalog([Page])[0]?.inputSchema.required).toEqual(['view_id']);
        expect(renderToString(h(ToolCatalog, { viewTypes: [Page] }))).toContain('Page: change');
        expect(enabled).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();

        const first: PageContext = { ready: true, change: vi.fn() };
        const second: PageContext = { ready: false, change: vi.fn() };
        first.self = first;
        const [available] = other.captureViewBindings(type, 'first', first);
        const [unavailable] = other.captureViewBindings(type, 'second', second);
        expect(available?.enabled).toBe(true);
        expect(unavailable?.enabled).toBe(false);
        expect(enabled.mock.calls).toEqual([[first], [second]]);
        await available!.execute({});
        expect(execute.mock.calls[0]?.[0]).toEqual({ input: {}, context: first });
        expect(execute.mock.calls[0]?.[0].context).toBe(first);
        expect(first.change).toHaveBeenCalledOnce();
        expect(second.change).not.toHaveBeenCalled();
        expect(Object.isFrozen(first)).toBe(false);
    });

    it('passes a callable page context by reference', async () => {
        const change = vi.fn();
        const Page = defineViewType<() => void>()({ name: 'Callable', tools: {
            change: { description: 'Change a page', execute({ context }) {
                expect(context).toBe(change);
                context();
                return { success: true };
            } },
        } });
        const [binding] = captureViewBindings(Page, 'page', change);
        await binding!.execute({});
        expect(change).toHaveBeenCalledOnce();
    });

    it('rejects invalid declarations and missing page contexts', () => {
        const execute = () => ({ success: true as const });
        const change = { description: 'Change', inputSchema: noArgs, execute };
        const declare = defineViewType<object>();
        const ContextPage = declare({ name: 'Page', tools: { change } });
        const getter = vi.fn();
        for (const input of [
            { ...change, execute: undefined },
            { ...change, enabled: false },
            Object.defineProperty({ ...change }, 'execute', { enumerable: true, get: getter }),
        ]) {
            expect(() => declare({ name: 'Page', tools: { change: input as typeof change } }))
                .toThrow(expect.objectContaining({ code: 'TOOL_DEFINITION_INVALID' }));
        }
        expect(getter).not.toHaveBeenCalled();
        expect(() => defineViewType({ name: 'Legacy', tools: { change: { description: 'Change' } } } as never))
            .toThrow(expect.objectContaining({ code: 'TOOL_DEFINITION_INVALID' }));
        expect(captureViewBindings(defineViewType({ name: 'Empty' }), 'empty')).toEqual([]);

        for (const context of [undefined, null, 'page']) {
            expect(() => captureViewBindings(ContextPage, 'page', context)).toThrow(expect.objectContaining({
                code: 'TOOL_BINDING_INVALID', path: 'View page.context',
            }));
        }
        const InvalidEnable = declare({ name: 'Page', tools: {
            change: { ...change, enabled: () => 1 as unknown as boolean },
        } });
        expect(() => captureViewBindings(InvalidEnable, 'page', {}))
            .toThrow(expect.objectContaining({ code: 'TOOL_BINDING_INVALID', path: 'View page.change.enabled' }));
    });
});
