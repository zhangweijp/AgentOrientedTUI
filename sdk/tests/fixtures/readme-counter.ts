import { createApp, createView, defineViewType } from '@aotui/sdk';

const Counter = defineViewType<{ add(by: number): void }>()({
  name: 'Counter', multiplicity: 'single', region: 'dynamic',
  tools: {
    add: {
      description: 'Increment the counter.',
      inputSchema: { type: 'object', properties: { by: { type: 'integer' } }, required: ['by'] },
      execute({ input, context }) { context.add(input.by); return { success: true }; },
    },
  },
});

export default createApp({
  app_name: 'counter', viewTypes: [Counter],
  initialize({ prepareProjection }) {
    let count = 0;
    const view = createView(Counter, { id: 'counter', render: () => ({
      body: 'Count ' + count,
      context: { add(by) { count += by; prepareProjection({ views: [view] }); } },
    }) });
    prepareProjection({ views: [view] });
  },
});
