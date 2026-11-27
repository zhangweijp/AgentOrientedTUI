import Type from 'typebox';
import { createApp, createView, defineViewType, ref, refParam, type ArgsOf, type JsonValue, type ProjectionLimits,
    type StandardJSONSchemaV1, type ViewHandle } from '@aotui/sdk';
// @ts-expect-error Per-page author bindings have left the root entry.
import type { ViewBindings } from '@aotui/sdk';
// @ts-expect-error Per-page author bindings have left the SDK.
import type { ToolBinding } from '@aotui/sdk';

type DetailContext = { record(id: string): void };
const Detail = defineViewType<DetailContext>()({ multiplicity: 'multiple', name:'Detail', tools:{
    use: { description:'Use a ref',
        inputSchema:Type.Object({ selected:refParam('Item',Type.Object({ id:Type.String() })),
            many:Type.Optional(Type.Array(refParam('Item',Type.Object({ name:Type.String() })))) }),
        execute({ input: { selected, many }, context }) {
            const id: string = selected.id;
            const name: string | undefined = many?.[0]?.name;
            // @ts-expect-error Observed values are deeply readonly
            selected.id = 'new';
            // @ts-expect-error Resolved optional Ref arrays are readonly
            many?.push({name:'another'});
            context.record(id);
            return {success:true,data:{id,name:name ?? ''}};
        },
    },
} });
const Empty = defineViewType({ multiplicity: 'multiple', name:'Empty' });
const detailContext: DetailContext = { record() {} };
const detail = createView(Detail,{idPrefix:'one',region:'dynamic'});
const empty = createView(Empty,{idPrefix:'empty',region:'static'});
const views: readonly ViewHandle[] = [detail,empty];
export const plain = createApp({app_name:'plain',viewTypes:[Detail,Empty],initialize(context) {
    const limits: ProjectionLimits = context.projectionLimits;
    // @ts-expect-error The Host owns the effective limits, including their nested values.
    limits.metadata.maxNodes = 4;
    const ready = context.publish(() => [detail.frame({body:'Rows',context:detailContext}), empty.frame({body:'Hello'})]);
    const opened = context.publish(() => [], {mode:'candidate'});
    void [ready, opened];
    // @ts-expect-error The old author entry was removed.
    context.publish({views});
    // @ts-expect-error Openings use a separate author entry.
    context.publish(() => [], {opening:true});
    // @ts-expect-error No App-wide binding map
    context.publish(() => ({views,bindings:{}}));
}});
const oldDeclaration = { name: 'Invalid', tools: { change: { description: 'Modify state' } } };
// @ts-expect-error Direct declarations only create tool-free ViewTypes
defineViewType(oldDeclaration);

type EditorContext = { readonly writable: boolean; replace(id: string, text: string): void };
const Editor = defineViewType<EditorContext>()({ multiplicity: 'multiple', name: 'Editor',
    tools: {
        replace: {
            description: 'Replace selected text',
            inputSchema: Type.Object({
                target: refParam('Item', Type.Object({ id: Type.String() })),
                text: Type.String(),
                mode: Type.Optional(Type.Literal('safe')),
                segments: Type.Array(Type.String()),
                tags: Type.Optional(Type.Array(refParam('Tag', Type.Object({ name: Type.String() })))),
            }),
            enabled: ({ writable }) => writable,
            execute({ input, context: { replace } }) {
                replace(input.target.id, input.text.toUpperCase());
                const tag: string | undefined = input.tags?.[0]?.name;
                const mode: 'safe' | undefined = input.mode;
                const segment: string = input.segments[0]!;
                // @ts-expect-error Business arrays are deeply readonly
                input.segments.push('extra');
                // @ts-expect-error Ref payloads stay deeply readonly
                input.target.id = 'other';
                // @ts-expect-error Receiver selection stays outside the business input
                input.view_id;
                void [tag, mode, segment];
                return { success: true };
            },
        },
        clear: {
            description: 'Clear selected text',
            inputSchema: Type.Object({ since: Type.Number() }),
            execute({ input: { since }, context }) {
                since.toFixed();
                // @ts-expect-error Each tool infers its own business schema
                since.toUpperCase();
                // @ts-expect-error The page context is not widened
                context.workspace;
                return { success: true };
            },
        },
        reset: {
            description: 'Reset the editor',
            execute({ input, context }) {
                // @ts-expect-error Omitted Schema means zero business properties
                input.since;
                // @ts-expect-error A receiver field is never an author input
                input.view_id;
                void context.writable;
                return { success: true };
            },
        },
    },
});
const editorContext: EditorContext = { writable: true, replace() {} };
const editorHandle = createView(Editor, {
    idPrefix: 'editor', region: 'dynamic',
});
const heterogeneousViews: readonly ViewHandle[] = [editorHandle, detail, empty];
const editorTool: keyof typeof Editor.tools = 'replace';
const args: ArgsOf<typeof Editor.tools.replace> = { target: { id: 'a' }, text: 'next', segments: [] };
const resetArgs: ArgsOf<typeof Editor.tools.reset> = {};
// @ts-expect-error The descriptor also retains the empty input contract
resetArgs.extra;
void [heterogeneousViews, editorTool, args, resetArgs];
// @ts-expect-error A plain Tool-owning View requires context
editorHandle.frame({ body: 'Content' });
type EditorRender = Parameters<typeof editorHandle.frame>[0];
const invalidRender: EditorRender = {
    body: 'Content',
    context: editorContext,
    // @ts-expect-error The public render result has no per-page author bindings property
    bindings: {},
};
void invalidRender;
// @ts-expect-error Contextual declarations require each execute implementation
defineViewType<EditorContext>()({ multiplicity: 'multiple', name: 'Invalid', tools: { clear: { description: 'Clear', inputSchema: Type.Object({}) } } });
// @ts-expect-error Executable callbacks are private to the SDK
Editor.tools.replace.execute;

// @ts-expect-error Context handlers take one named invocation object
defineViewType<EditorContext>()({ multiplicity: 'multiple', name: 'OldPrototype', tools: { clear: { description: 'Clear', execute(_input: object, _context: EditorContext) { return { success: true }; } } } });
// @ts-expect-error The receiver field is reserved in the business Schema
defineViewType<EditorContext>()({ multiplicity: 'multiple', name: 'InvalidReceiver', tools: { send: { description: 'Send', inputSchema: Type.Object({ view_id: Type.String() }), execute() { return { success: true }; } } } });

declare const standardObject: StandardJSONSchemaV1<{
    must: string;
    optional?: string;
    pair: [string, number];
}, { must: number; optional: string; pair: [number, number] }>;
declare const standardValue: StandardJSONSchemaV1<{ path: string }, { path: number }>;

const Inputs = defineViewType<object>()({
    name: 'Inputs', multiplicity: 'single', tools: {
        standard: {
            description: 'Use a Standard JSON Schema', inputSchema: standardObject,
            execute({ input }) {
                const must: string = input.must;
                const optional: string | undefined = input.optional;
                const pair: readonly [string, number] = input.pair;
                // @ts-expect-error The handler sees the schema input, not the converted output.
                const converted: number = input.must;
                // @ts-expect-error Tuple elements are read-only.
                input.pair[0] = 'new';
                void [must, optional, pair, converted];
                return { success: true };
            },
        },
        json: {
            description: 'Compose business JSON and a nominal Ref',
            inputSchema: {
                type: 'object', properties: {
                    pattern: { type: 'string' }, $schema: { type: 'boolean' },
                    optional: { default: 'initial', type: 'string' }, item: refParam('File', standardValue),
                    tuple: { type: 'array', prefixItems: [{ type: 'number' }, { const: 'fixed' }], items: false, minItems: 2 },
                },
                required: ['pattern', '$schema', 'item', 'tuple'],
            },
            execute({ input }) {
                const actual: string = input.item.path;
                const available: string | undefined = input.optional;
                const tuple: readonly [number, 'fixed'] = input.tuple;
                // @ts-expect-error Ref values are read-only.
                input.item.path = 'new';
                // @ts-expect-error Undeclared business parameters are not in the input type.
                input.unlisted;
                void [actual, available, tuple];
                return { success: true };
            },
        },
        open: {
            description: 'Keep additional JSON values',
            inputSchema: {
                type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: true,
            },
            execute({ input }) {
                const key: string = input.key;
                const captured: JsonValue = input;
                return { success: true, data: { key, captured } };
            },
        },
    },
});

const business: ArgsOf<typeof Inputs.tools.json> = { pattern: '.*', $schema: true, item: { path: 'notes.txt' }, tuple: [2, 'fixed'] };
// @ts-expect-error The prefixed tuple positions and required keys are inferred from the declaration.
const wrongBusiness: ArgsOf<typeof Inputs.tools.json> = { pattern: '.*', item: { path: 'notes.txt' }, tuple: ['2', 'fixed'] };
// @ts-expect-error The Standard input preserves a required key.
const missingRequired: ArgsOf<typeof Inputs.tools.standard> = { pair: ['a', 1] };
const openBusiness: ArgsOf<typeof Inputs.tools.open> = { key: 'open', other: [1, false] };
void [business, wrongBusiness, missingRequired, openBusiness];

const Unions = defineViewType<object>()({
    name: 'Unions', multiplicity: 'single', tools: {
        typebox: {
            description: 'Read a literal union',
            inputSchema: Type.Object({ name: Type.Union([Type.Literal('A.txt'), Type.Literal('B.txt')]) }),
            execute({ input }) {
                const name: 'A.txt' | 'B.txt' = input.name;
                return { success: true, data: { name } };
            },
        },
        json: {
            description: 'Intersect alternatives with declared rules',
            inputSchema: {
                type: 'object', properties: {
                    typed: { type: 'string', anyOf: [{ const: 'label' }, { type: 'number' }] },
                    fixed: { const: 'same', anyOf: [{ enum: ['same', 'different'] }, { type: 'null' }] },
                    listed: { enum: ['open', 'closed'], anyOf: [{ const: 'open' }, { type: 'boolean' }] },
                },
                required: ['typed', 'fixed', 'listed'],
            },
            execute({ input }) {
                const typed: 'label' = input.typed;
                const fixed: 'same' = input.fixed;
                const listed: 'open' = input.listed;
                return { success: true, data: { typed, fixed, listed } };
            },
        },
    },
});
void Unions;

const choice = { anyOf: [{ const: 'fast' }, { const: 'accurate' }] } as const;
ref('current_choice', 'fast', { scope: 'public', schema: choice });
// @ts-expect-error A pure anyOf publication must match a declared branch.
ref('current_choice', 'turbo', { scope: 'public', schema: choice });
