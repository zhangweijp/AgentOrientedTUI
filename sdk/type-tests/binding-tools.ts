import Type from 'typebox';
import { createToolBindings, defineToolSet, defineViewTypeTool } from '../src/tools.js';
import type { ArgsOf, ToolBindings, ToolSetMap } from '../src/tools.js';
import type { IAppTypeToolPort } from '@aotui/runtime/spi';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const definition = defineToolSet({ edit: defineViewTypeTool({ viewType: 'File', name: 'edit', description: 'Edit.',
    inputSchema: Type.Object({ path: Type.String(), count: Type.Number(), mode: Type.Enum(['a', 'b']), note: Type.Optional(Type.String()) }) }) });
declare const port: IAppTypeToolPort;
const controller = createToolBindings({ definition, appTypeTools: port });
controller.commit({ edit: { execute: args => {
    type _Args = Assert<Equal<typeof args, { readonly path: string; readonly count: number; readonly mode: 'a' | 'b'; readonly note?: string }>>;
    type _Any = Assert<Equal<IsAny<typeof args>, false>>;
    return { success: true, data: { path: args.path } };
} } });
const bindings: ToolBindings<ToolSetMap<typeof definition>> = { edit: { execute: args => ({ success: true, data: { count: args.count } }) } };
controller.commit(bindings);
const extra = { ...bindings, other: bindings.edit };
// @ts-expect-error Variables cannot carry extra bindings.
controller.commit(extra);
// @ts-expect-error Narrow handlers cannot constrain the declaration's enum.
controller.commit({ edit: { execute: (args: ArgsOf<typeof definition.edit> & { mode: 'a' }) => ({ success: true }) } });
// @ts-expect-error Disabled declarations still need their implementation.
controller.commit({ edit: { enabled: false } });
