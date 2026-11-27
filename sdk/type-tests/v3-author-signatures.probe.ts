// Strict compile-only B1 contract against the actual package root.
import { createApp, createView, defineViewType, refParam, type ViewFrame, type ViewHandle, type StandardJSONSchemaV1 } from "@aotui/sdk";
import Type from "typebox";
const Root = defineViewType({ name: 'root', multiplicity: 'single', region: 'static' });
const NoRegion = defineViewType({ name: 'other', multiplicity: 'single' });
declare const standard: StandardJSONSchemaV1<{ suffix: string }>;
const Detail = defineViewType<{ text: string }>()({
  name: 'detail', multiplicity: 'multiple', region: 'dynamic',
  tools: {
    read: {
      description: 'Read the item',
      inputSchema: Type.Object({ suffix: Type.String(), selection: refParam('Item', Type.Object({ id: Type.String() })) }),
      execute({ input, context }) {
        const id: string = input.selection.id;
        const suffix: string = input.suffix;
        // @ts-expect-error Resolved input is readonly.
        input.selection.id = 'changed';
        return { success: true, data: { value: context.text + suffix + id } };
      },
    },
    standard: {
      description: 'Read through Standard Schema',
      inputSchema: standard,
      execute({ input, context }) {
        const suffix: string = input.suffix;
        // @ts-expect-error No arbitrary field on typed input.
        input.other;
        return { success: true, data: { value: context.text + suffix } };
      },
    },
  },
  onClose: {
    enabled: context => context.text.length > 0,
    execute({ context }) {
      const text: string = context.text;
      return { success: true, data: { text } };
    },
  },
});
const CloseOnly = defineViewType<{ close(): void }>()({
  name: 'closeOnly', multiplicity: 'single', region: 'dynamic',
  onClose: { execute({ context }) { context.close(); return { success: true }; } },
});
const root = createView(Root);
const detail = createView(Detail, { idPrefix: 'fd' });
const close = createView(CloseOnly);
const frames: ViewFrame[] = [
  root.frame({ body: 'root' }),
  detail.frame({ body: 'file', context: { text: 'A' }, bindingKey: 'A' }),
  close.frame({ body: 'close', context: { close() {} } }),
];
const identity: ViewHandle = detail;
void identity;
createView(NoRegion, { region: 'dynamic' });
// @ts-expect-error No default region.
createView(NoRegion);
// @ts-expect-error Multiple uses idPrefix, not id.
createView(Detail, { id: 'wrong' });
// @ts-expect-error Single uses id, not idPrefix.
createView(Root, { idPrefix: 'wrong' });
// @ts-expect-error Handle options cannot store a render closure.
createView(Root, { render: () => ({ body: 'wrong' }) });
// @ts-expect-error Plain frame cannot carry business context.
root.frame({ body: 'root', context: {} });
// @ts-expect-error Tool frame must carry context.
detail.frame({ body: 'file' });
// @ts-expect-error Wrong context.
detail.frame({ body: 'file', context: { text: 2 } });
// @ts-expect-error Close-only frame must carry context.
close.frame({ body: 'close' });
// @ts-expect-error Frame cannot override region.
root.frame({ body: 'root', region: 'dynamic' });
// @ts-expect-error Frame cannot override route id.
root.frame({ body: 'root', id: 'other' });
// @ts-expect-error Frame cannot define its own close callback.
root.frame({ body: 'root', onClose: () => ({ success: true }) });
// @ts-expect-error Binding key must be string or number.
detail.frame({ body: 'file', context: { text: 'A' }, bindingKey: {} });
// @ts-expect-error Contextual declaration needs tool(s) or close.
defineViewType<{ text: string }>()({ name: 'wrong', multiplicity: 'single' });
// @ts-expect-error Contextual declaration with empty tools is not a business declaration.
defineViewType<{ text: string }>()({ name: 'wrong', multiplicity: 'single', tools: {} });
// @ts-expect-error Plain form cannot declare a close callback.
defineViewType({ name: 'wrong', multiplicity: 'single', onClose: { execute: () => ({ success: true }) } });

declare const maybeRegion: 'static' | undefined;
const MaybeRegion = defineViewType({ name: 'maybe', multiplicity: 'single', region: maybeRegion });
// @ts-expect-error Possibly missing default requires explicit override.
createView(MaybeRegion);
createView(MaybeRegion, { region: 'dynamic' });

createApp({
  app_name: 'static',
  viewTypes: [Root, Detail, CloseOnly],
  initialize(app, [rootType, detailType, closeType]) {
    const result = app.publish(() => [
      createView(rootType).frame({ body: 'root' }),
      createView(detailType).frame({ body: 'file', context: { text: 'A' } }),
      createView(closeType).frame({ body: 'close', context: { close() {} } }),
    ]);
    if (result.ok) {
      const epoch: number = result.epoch;
      const id: string | undefined = result.viewId(detail);
      void [epoch, id];
    } else {
      const state: 'preserved' | 'degraded' = result.state;
      void state;
    }
    const registered: void = app.registerLifecycle({ close() {} });
    void registered;
    // @ts-expect-error Readonly launchConfig.
    if (app.launchConfig) app.launchConfig.foo = 1;
    // @ts-expect-error No imperative createView method.
    app.createView(Root);
    // @ts-expect-error Builder is synchronous.
    app.publish(async () => frames);
    // @ts-expect-error Return an array of frame values, not handles.
    app.publish(() => [root]);
    // @ts-expect-error Only approved modes.
    app.publish(() => frames, { mode: 'opening' });
    // @ts-expect-error Static tuple retains exact context.
    createView(detailType).frame({ body: 'file', context: {} });
  },
});
createApp({
  app_name: 'dynamic',
  viewTypes(config) {
    const tag = typeof config?.tag === 'string' ? config.tag : undefined;
    return tag === undefined ? [Root] as const : [Root, Detail] as const;
  },
  initialize(app, [rootType, detailType]) {
    // @ts-expect-error Dynamic tuple may lack Detail.
    createView(detailType);
    app.publish(() => {
      const views: ViewFrame[] = [createView(rootType).frame({ body: 'root' })];
      if (detailType !== undefined) views.push(createView(detailType).frame({ body: 'detail', context: { text: 'B' } }));
      return views;
    }, { mode: 'candidate' });
  },
});
createApp({
  app_name: 'filtered',
  viewTypes(config) { return [Root, Detail].filter(type => config !== undefined || type === Root); },
  initialize(app, types) {
    const selected = types.find((item): item is typeof Detail => item === Detail);
    if (selected) app.publish(() => [createView(selected).frame({ body: 'selected', context: { text: 'A' } })]);
    // @ts-expect-error An arbitrary union entry cannot be called with guessed context.
    createView(types[0]!).frame({ body: 'guessed' });
  },
});
// @ts-expect-error Async declaration factory not permitted.
createApp({ app_name: 'async', viewTypes: async () => [Root] as const, initialize() {} });
// @ts-expect-error Initializer cannot demand an undeclared tuple item.
createApp({ app_name: 'widen', viewTypes: [Root], initialize(_app, _types: readonly [typeof Root, typeof Detail]) {} });
