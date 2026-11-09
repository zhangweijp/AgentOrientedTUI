import { createToolBindings } from '@aotui/sdk/tools';
import { createToolBindings as rootCreate } from '@aotui/sdk';
import type { ArgsOf, ToolBinding, ToolBindings, ToolSetMap, ToolBindingController } from '@aotui/sdk/tools';
import type { IAppTypeToolPort } from '@aotui/runtime/spi';
import { fileTools } from './m2-producer.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Expected = { readonly filePath: string; readonly mode: 'append' | 'replace'; readonly tags: readonly number[]; readonly note?: string; readonly revision?: number };
declare const port: IAppTypeToolPort;
export const controller = createToolBindings({ definition: fileTools, appTypeTools: port });
export const rootController: ToolBindingController<ToolSetMap<typeof fileTools>> = rootCreate({ definition: fileTools, appTypeTools: port });
controller.commit({
  readFile: { execute: args => {
    type _Exact = Assert<Equal<typeof args, { readonly filePath: string }>>;
    type _Any = Assert<Equal<IsAny<typeof args>, false>>;
    return { success: true, data: { filePath: args.filePath } };
  } },
  editFile: { enabled: false, execute: args => {
    type _Exact = Assert<Equal<typeof args, Expected>>;
    type _Any = Assert<Equal<IsAny<typeof args>, false>>;
    const mode: 'append' | 'replace' = args.mode;
    const note: string | undefined = args.note;
    const revision: number | undefined = args.revision;
    const tags: readonly number[] = args.tags;
    return { success: true, data: { mode, note, revision, tags } };
  } },
});
export const bindings: ToolBindings<ToolSetMap<typeof fileTools>> = {
  readFile: { enabled: true, execute: args => ({ success: true, data: { filePath: args.filePath } }) },
  editFile: { execute: args => ({ success: true, data: { mode: args.mode } }) },
};
export const individual: ToolBinding<typeof fileTools.editFile> = bindings.editFile;
type _DefinitionArgs = Assert<Equal<ArgsOf<typeof fileTools.editFile>, Expected>>;
controller.commit(bindings);
rootController.commit(bindings);
controller.dispose();
