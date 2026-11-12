import Type from 'typebox';
import { defineViewTypeTool, defineToolSet, getToolCatalog } from '../src/app.js';
import type { ArgsOf, SchemaOf } from '../src/app.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
const input = Type.Object({ path: Type.String(), count: Type.Number(), mode: Type.Enum(['a', 'b']) });
const declaration = { viewType: 'File', name: 'inspect', description: 'Inspect.', inputSchema: input };
const definition = defineViewTypeTool(declaration);
type _Schema = Assert<Equal<SchemaOf<typeof definition>, typeof input>>;
type _Args = Assert<Equal<ArgsOf<typeof definition>, { readonly path: string; readonly count: number; readonly mode: 'a' | 'b' }>>;
export const catalog = getToolCatalog(defineToolSet({ definition }));
const old = { ...declaration, execute: () => ({ success: true }) };
// @ts-expect-error Static definitions cannot carry old execution callbacks.
defineViewTypeTool(old);
// @ts-expect-error Effect classification is no longer part of a Tool declaration.
defineViewTypeTool({ ...declaration, isMutating: true });
