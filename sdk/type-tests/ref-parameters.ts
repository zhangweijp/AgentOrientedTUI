import Type from 'typebox';
import { defineToolSet, defineViewTypeTool, refParam,
    type AppAuthorContext, type ArgsOf, type SchemaOf, type ToolSetMap } from '../src/app.js';

const Item = Type.Object({ id: Type.String(), mode: Type.Enum(['append', 'replace']),
    nested: Type.Object({ enabled: Type.Boolean() }) }, { additionalProperties: false });
const input = Type.Object({
    one: refParam('Item', Item),
    whole: refParam('Item', Type.Array(Item)),
    many: Type.Array(refParam('Item', Item)),
    maybe: Type.Optional(Type.Array(refParam('Item', Item))),
    optional: Type.Optional(refParam('Item', Item)),
    message: Type.String(),
}, { additionalProperties: false });
const choose = defineViewTypeTool({ viewType: 'Items', name: 'choose', description: 'Choose Items.', inputSchema: input });
const definition = defineToolSet({ choose });
type Args = ArgsOf<typeof choose>;
type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
export type ExactRefWitnesses = [
    Assert<NotAny<Args>>, Assert<NotAny<Args['many'][number]>>,
    Assert<Args['many'][number]['mode'] extends 'append' | 'replace' ? true : false>,
    Assert<'append' | 'replace' extends Args['one']['mode'] ? true : false>,
    Assert<SchemaOf<typeof choose> extends typeof input ? true : false>,
    Assert<typeof input extends SchemaOf<typeof choose> ? true : false>,
];
declare const publish: AppAuthorContext<ToolSetMap<typeof definition>>['publish'];
publish({ views: [], bindings: { choose: { execute(args) {
    const id: string = args.many[0]!.id;
    const mode: 'append' | 'replace' = args.one.mode;
    const optional: string | undefined = args.optional?.id;
    const list: readonly { readonly id: string }[] | undefined = args.maybe;
    // @ts-expect-error Ref name arrays resolve to business objects, not strings.
    const raw: readonly string[] = args.many;
    // @ts-expect-error Whole-array payloads are deeply readonly.
    args.whole[0]!.nested.enabled = false;
    // @ts-expect-error Selection arrays are readonly too.
    args.many.push(args.one);
    // @ts-expect-error Payload types must not become any.
    const wrong: number = args.many[0]!.id;
    void id; void mode; void optional; void list; void raw; void wrong;
    return { success: true };
} } } });
publish({ views: [], bindings: { choose: {
    // @ts-expect-error A handler cannot accept fewer legal enum values through an array.
    execute: (_args: { readonly many: readonly { readonly mode: 'append' }[] }) => ({ success: true }),
} } });
publish({ views: [], bindings: { choose: {
    // @ts-expect-error Raw Ref strings are not the resolved handler parameters.
    execute: (_args: { readonly many: readonly string[] }) => ({ success: true }),
} } });
