import { AppTools, ToolRef, ToolCatalog, View } from '@aotui/sdk';
import type { AppToolsProps, ArgsOf, SchemaOf } from '@aotui/sdk';
import { fileTools } from './m2-producer.js';
import { bindings } from './jsx-bindings.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Expected = { readonly filePath: string; readonly mode: 'append' | 'replace'; readonly tags: readonly number[]; readonly note?: string; readonly revision?: number };
type _Args = Assert<Equal<ArgsOf<typeof fileTools.editFile>, Expected>>;
type _Schema = Assert<Equal<IsAny<SchemaOf<typeof fileTools.editFile>>, false>>;
export const direct = <AppTools definition={fileTools} bindings={{
  readFile: { execute: args => {
    type _Exact = Assert<Equal<typeof args, { readonly filePath: string }>>;
    type _Any = Assert<Equal<IsAny<typeof args>, false>>;
    return { success: true, data: { path: args.filePath } };
  } },
  editFile: { enabled: false, execute: args => {
    type _Exact = Assert<Equal<typeof args, Expected>>;
    type _Any = Assert<Equal<IsAny<typeof args>, false>>;
    return { success: true, data: { mode: args.mode, tags: args.tags, note: args.note } };
  } },
}}><View kind="state" id="files" type="FileDetail"><ToolRef tool={fileTools.readFile}>Read</ToolRef></View><ToolCatalog definition={fileTools} /></AppTools>;
const props: AppToolsProps<typeof fileTools> = { definition: fileTools, bindings };
export const forwarded = <AppTools {...props} />;
export const crossModule = <AppTools definition={fileTools} bindings={bindings} />;
export const wider = <AppTools definition={fileTools} bindings={{ ...bindings,
  editFile: { execute: (args: { readonly filePath: string; readonly mode: string; readonly tags: readonly number[] }) => ({ success: true, data: { mode: args.mode } }) },
}} />;
