import { appendFileSync } from 'node:fs';
import Type from 'typebox';
import { createApp, createView, defineViewType } from '@aotui/sdk';

const Ready = defineViewType<object>()({ name: 'Ready', region: 'dynamic', multiplicity: 'single', tools: {
    confirm: { description: 'Record a confirmation',
        inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
        execute({ input }) {
            appendFileSync(new URL('./healthy-effects.jsonl', import.meta.url), JSON.stringify(input) + '\n');
            return { success: true, data: { confirmed: true } };
        } },
} });

export default createApp({ app_name: 'healthy', viewTypes: [Ready],
    initialize({ prepareProjection }) {
        const view = createView(Ready, { render: () => ({ body: 'Healthy app is ready', context: {} }) });
        prepareProjection({ views: [view] });
    },
});
