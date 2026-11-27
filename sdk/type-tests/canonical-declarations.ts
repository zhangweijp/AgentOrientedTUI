import { createApp, createView, defineViewType } from '@aotui/sdk';
const Root = defineViewType({ name: 'root', multiplicity: 'single', region: 'static' });
const Detail = defineViewType<{ text: string }>()({
    name: 'detail', multiplicity: 'multiple', region: 'dynamic',
    tools: { read: { description: 'Read', execute({ context }) { return { success: true, data: { value: context.text } }; } } },
});

createApp({ app_name: 'static_tuple', viewTypes: [Root, Detail],
    initialize(app, types) {
        const [root, detail] = types;
        const page = createView(root);
        const file = createView(detail);
        app.publish(() => [page.frame({ body: 'root' }), file.frame({ body: 'file', context: { text: 'A' } })]);
        // @ts-expect-error canonical tuple is readonly
        types[0] = Root;
        // @ts-expect-error context is required
        file.frame({ body: 'file' });
        // @ts-expect-error captured config is readonly
        if (app.launchConfig) app.launchConfig.tag = 'changed';
    },
});
createApp({ app_name: 'optional_tuple',
    viewTypes(config) { return config === undefined ? [Root] as const : [Root, Detail] as const; },
    initialize(app, [root, detail]) {
        const page = createView(root);
        // @ts-expect-error optional tuple item must be narrowed
        createView(detail).frame({ body: 'detail', context: { text: 'B' } });
        if (detail) app.publish(() => [page.frame({body: 'root'}), createView(detail).frame({ body: 'detail', context: { text: 'B' } })]);
    },
});
createApp({ app_name: 'filter',
    viewTypes(config) { return [Root, Detail].filter(type => config !== undefined || type === Root); },
    initialize(app, types) {
        const detail = types.find((type): type is typeof Detail => type === Detail);
        if (detail) app.publish(() => [createView(detail).frame({ body: 'detail', context: { text: 'C' } })]);
    },
});
// @ts-expect-error asynchronous declarations are unsupported
createApp({ app_name: 'async', viewTypes: async () => [Root], initialize() {} });
// @ts-expect-error initializer may not require an undeclared item
createApp({ app_name: 'widen', viewTypes: [Root], initialize(_app, _types: readonly [typeof Root, typeof Detail]) {} });

// An optional region property is not evidence that the type has a default.
declare const optionalRegion: { name: string; multiplicity: 'single'; region?: 'static' };
declare const uncertainRegion: 'dynamic' | undefined;
const OptionalRegion = defineViewType(optionalRegion);
const UncertainRegion = defineViewType({ name: 'uncertain', multiplicity: 'single', region: uncertainRegion });
const OptionalContextRegion = defineViewType<{ text: string }>()({
    ...optionalRegion,
    tools: { read: { description: 'Read', execute: ({ context }) => ({ success: true, data: { value: context.text } }) } },
});
const UncertainContextRegion = defineViewType<{ text: string }>()({
    name: 'uncertain_context', multiplicity: 'single', region: uncertainRegion,
    tools: { read: { description: 'Read', execute: ({ context }) => ({ success: true, data: { value: context.text } }) } },
});
// @ts-expect-error Optional defaults require a concrete placement.
createView(OptionalRegion);
// @ts-expect-error A default whose value may be undefined requires a concrete placement.
createView(UncertainRegion);
// @ts-expect-error The same guarantee applies to contextual declarations.
createView(OptionalContextRegion);
// @ts-expect-error A contextual default whose value may be undefined requires placement.
createView(UncertainContextRegion);
createView(OptionalRegion, { region: 'dynamic' }).frame({ body: 'x' });
createView(UncertainRegion, { region: 'static' }).frame({ body: 'x' });
createView(OptionalContextRegion, { region: 'dynamic' }).frame({ body: 'x', context: { text: 'x' } });
createView(UncertainContextRegion, { region: 'static' }).frame({ body: 'x', context: { text: 'x' } });
