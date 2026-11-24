import Type from 'typebox';
import { DynamicView, StaticView, createTUIApp, defineViewType, refParam, type ArgsOf } from '@aotui/sdk';
import { createApp, createView, type ProjectionLimits, type ViewHandle } from '@aotui/sdk/app';
// @ts-expect-error Per-page author bindings have left the root entry.
import type { ViewBindings } from '@aotui/sdk';
// @ts-expect-error Per-page author bindings have left the plain entry.
import type { ToolBinding } from '@aotui/sdk/app';

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
const detail = createView(Detail,{idPrefix:'one',region:'dynamic',render:() => ({body:'Rows',context:detailContext})});
const empty = createView(Empty,{idPrefix:'empty',region:'static',render:() => ({body:'Hello'})});
const views: readonly ViewHandle[] = [detail,empty];
export const plain = createApp({app_name:'plain',viewTypes:[Detail,Empty],initialize(context) {
    const limits: ProjectionLimits = context.projectionLimits;
    // @ts-expect-error The Host owns the effective limits, including their nested values.
    limits.metadata.maxNodes = 4;
    const ready: 'prepared' = context.prepareProjection({views}).status;
    const opened: 'prepared' = context.prepareOpeningProjection({views}).status;
    void [ready, opened];
    // @ts-expect-error The old author entry was removed.
    context.publish({views});
    // @ts-expect-error Openings use a separate author entry.
    context.prepareProjection({views}, {opening:true});
    // @ts-expect-error No App-wide binding map
    context.prepareProjection({views,bindings:{}});
}});
export const preact = createTUIApp({app_name:'preact',viewTypes:[Detail,Empty],component:() =>
    <DynamicView idPrefix="b"  type={Detail} context={detailContext}/>});
export const noTools = <StaticView idPrefix="empty"  type={Empty}/>;
// @ts-expect-error Context is required for a type with Tools
export const missing = <DynamicView idPrefix="x" type={Detail} />;
// @ts-expect-error A binding map cannot take the place of context
export const oldPage = <DynamicView idPrefix="x" type={Detail}  bindings={{use:{execute:() => ({success:true})}}}/>;
// @ts-expect-error A View uses a descriptor
export const legacy = <DynamicView idPrefix="x" type="Detail" />;
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
    idPrefix: 'editor', region: 'dynamic', render: () => ({ body: 'Content', context: editorContext }),
});
const heterogeneousViews: readonly ViewHandle[] = [editorHandle, detail, empty];
const editorTool: keyof typeof Editor.tools = 'replace';
const args: ArgsOf<typeof Editor.tools.replace> = { target: { id: 'a' }, text: 'next', segments: [] };
const resetArgs: ArgsOf<typeof Editor.tools.reset> = {};
// @ts-expect-error The descriptor also retains the empty input contract
resetArgs.extra;
void [heterogeneousViews, editorTool, args, resetArgs];
export const editorPage = <DynamicView idPrefix="editor"  type={Editor} context={editorContext}/>;
// @ts-expect-error Context type comes from the descriptor
export const wrongContext = <DynamicView idPrefix="editor"  type={Editor} context={{ writable: true }}/>;
// @ts-expect-error Contextual types require an instance context
export const missingContext = <DynamicView idPrefix="editor"  type={Editor}/>;
// @ts-expect-error JSX has no per-page author bindings property
export const mixedContext = <DynamicView idPrefix="editor"  type={Editor} context={editorContext} bindings={{}}/>;
// @ts-expect-error Tool-free types do not accept context
export const contextOnEmptyType = <DynamicView idPrefix="root"  type={Empty} context={editorContext}/>;
// @ts-expect-error A plain Tool-owning View requires context
createView(Editor, { idPrefix: 'editor', region: 'dynamic', render: () => ({ body: 'Content', bindings: {} }) });
type EditorRender = ReturnType<Parameters<typeof createView<typeof Editor>>[1]['render']>;
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
