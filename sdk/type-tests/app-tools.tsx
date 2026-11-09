import Type from 'typebox';
import { AppTools, ToolRef, ToolCatalog, View, defineToolSet, defineViewTypeTool } from '../src/index.js';
import type { ArgsOf, SchemaOf, ToolBindings, ToolSetMap, AppToolsProps } from '../src/index.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const schema = Type.Object({ path: Type.String(), mode: Type.Enum(['append', 'replace']), count: Type.Number(), tags: Type.Array(Type.String()), note: Type.Optional(Type.String()) });
const tools = defineToolSet({ edit: defineViewTypeTool({ viewType: 'File', name: 'edit', description: 'Edit.', inputSchema: schema }) });
type Expected = { readonly path: string; readonly mode: 'append' | 'replace'; readonly count: number; readonly tags: readonly string[]; readonly note?: string };
type _Schema = Assert<Equal<SchemaOf<typeof tools.edit>, typeof schema>>;
type _Args = Assert<Equal<ArgsOf<typeof tools.edit>, Expected>>;
export const jsx = <AppTools definition={tools} bindings={{ edit: { execute: args => {
    type _Exact = Assert<Equal<typeof args, Expected>>;
    type _Any = Assert<Equal<IsAny<typeof args>, false>>;
    return { success: true, data: { path: args.path } };
} } }}><View kind="state" id="file" type="File"><ToolRef tool={tools.edit} /></View><ToolCatalog definition={tools} /></AppTools>;
const bindings: ToolBindings<ToolSetMap<typeof tools>> = { edit: { enabled: false, execute: args => ({ success: true, data: { path: args.path } }) } };
const props: AppToolsProps<typeof tools> = { definition: tools, bindings };
export const forwarded = <AppTools {...props} />;
