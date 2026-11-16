import Type from 'typebox';
import { View, createTUIApp, defineViewType, refParam, type ArgsOf } from '../src/index.js';
import { createApp, createView, type ViewHandle } from '../src/app.js';

const Detail = defineViewType({ name:'Detail', tools:{
    use: { description:'Use a ref',
        inputSchema:Type.Object({ selected:refParam('Item',Type.Object({ id:Type.String() })),
            many:Type.Optional(Type.Array(refParam('Item',Type.Object({ name:Type.String() })))) }) },
} });
const Empty = defineViewType({ name:'Empty', tools:{} });

const detail = createView(Detail,{id:'one',kind:'state',render:() => ({body:'Rows',bindings:{
    use:{ execute({ selected, many }) {
        const id: string = selected.id;
        const name: string | undefined = many?.[0]?.name;
        // @ts-expect-error Observed values are deeply readonly
        selected.id = 'new';
        // @ts-expect-error Resolved optional Ref arrays are readonly
        many?.push({name:'another'});
        return {success:true,data:{id,name:name ?? ''}};
    } },
}})});
const empty = createView(Empty,{id:'empty',kind:'instruction',render:() => ({body:'Hello'})});
const views: readonly ViewHandle[] = [detail,empty];
export const plain = createApp({app_name:'plain',viewTypes:[Detail,Empty],initialize({publish}) {
    const ready: 'prepared' = publish({views}).status;
    void ready;
    // @ts-expect-error No App-wide binding map
    publish({views,bindings:{}});
}});
export const preact = createTUIApp({app_name:'preact',viewTypes:[Detail,Empty],component:() =>
    <View id="b" kind="state" type={Detail} bindings={{use:{execute(args) {
        const id: string = args.selected.id;
        // @ts-expect-error The framework-only receiver is not a business argument
        const view_id = args.view_id;
        return {success:true,data:{id}};
    }}}}/>});
export const noTools = <View id="empty" kind="instruction" type={Empty}/>;
// @ts-expect-error Bindings are required for a type with Tools
export const missing = <View id="x" type={Detail} kind="state"/>;
// @ts-expect-error Unknown binding
export const extra = <View id="x" type={Detail} kind="state" bindings={{use:{execute:() => ({success:true})},extra:{execute:() => ({success:true})}}}/>;
// @ts-expect-error A View uses a descriptor
export const legacy = <View id="x" type="Detail" kind="state"/>;
// @ts-expect-error Static Tool declarations do not contain handlers
defineViewType({name:'Invalid',tools:{change:{description:'Modify state',inputSchema:Type.Object({}),execute(){ return {success:true}; }}}});

type EditorContext = { readonly writable: boolean; replace(id: string, text: string): void };
const Editor = defineViewType<EditorContext>()({
    name: 'Editor',
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
    id: 'editor', kind: 'state', render: () => ({ body: 'Content', context: editorContext }),
});
const heterogeneousViews: readonly ViewHandle[] = [editorHandle, detail, empty];
const editorTool: keyof typeof Editor.tools = 'replace';
const args: ArgsOf<typeof Editor.tools.replace> = { target: { id: 'a' }, text: 'next', segments: [] };
const resetArgs: ArgsOf<typeof Editor.tools.reset> = {};
// @ts-expect-error The descriptor also retains the empty input contract
resetArgs.extra;
void [heterogeneousViews, editorTool, args, resetArgs];
export const editorPage = <View id="editor" kind="state" type={Editor} context={editorContext}/>;
// @ts-expect-error Context type comes from the descriptor
export const wrongContext = <View id="editor" kind="state" type={Editor} context={{ writable: true }}/>;
// @ts-expect-error Contextual types require an instance context
export const missingContext = <View id="editor" kind="state" type={Editor}/>;
// @ts-expect-error Context and explicit bindings are mutually exclusive
export const mixedContext = <View id="editor" kind="state" type={Editor} context={editorContext} bindings={{}}/>;
// @ts-expect-error Explicit-binding types do not accept context
export const contextOnStaticType = <View id="root" kind="state" type={Empty} context={editorContext}/>;
// @ts-expect-error A context View handle cannot supply an explicit bindings map
createView(Editor, { id: 'editor', kind: 'state', render: () => ({ body: 'Content', context: editorContext, bindings: {} }) });
// @ts-expect-error Contextual declarations require each execute implementation
defineViewType<EditorContext>()({ name: 'Invalid', tools: { clear: { description: 'Clear', inputSchema: Type.Object({}) } } });
// @ts-expect-error Executable callbacks are private to the SDK
Editor.tools.replace.execute;

const LegacyEmpty = defineViewType({ name: 'LegacyEmpty', tools: { close: { description: 'Close a View' } } });
export const legacyClose = <View id="legacy" kind="state" type={LegacyEmpty} bindings={{ close: { execute(args) {
    // @ts-expect-error The explicit-binding entry also infers an empty input
    args.view_id;
    return { success: true };
} } }}/>;
// @ts-expect-error Context handlers take one named invocation object
defineViewType<EditorContext>()({ name: 'OldPrototype', tools: { clear: { description: 'Clear', execute(_input: object, _context: EditorContext) { return { success: true }; } } } });
// @ts-expect-error The receiver field is reserved in the business Schema
defineViewType({ name: 'InvalidReceiver', tools: { send: { description: 'Send', inputSchema: Type.Object({ view_id: Type.String() }) } } });
// @ts-expect-error The receiver field is reserved for contextual declarations as well
defineViewType<EditorContext>()({ name: 'InvalidReceiver', tools: { send: { description: 'Send', inputSchema: Type.Object({ view_id: Type.String() }), execute() { return { success: true }; } } } });
