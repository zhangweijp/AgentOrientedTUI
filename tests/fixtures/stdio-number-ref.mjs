import Type from 'typebox';
import { threadId } from 'node:worker_threads';
import { createApp, createView, defineViewType, ref } from '@aotui/sdk';

const Page = defineViewType()({ name: 'page', multiplicity: 'single', region: 'dynamic', tools: {
    echo: { description: 'Return the selected integer.',
        inputSchema: Type.Object({ value: Type.Integer() }, { additionalProperties: false }),
        execute: ({ input }) => ({ success: true, data: { value: input.value, frozen: Object.isFrozen(input), threadId } }) },
} });

export default createApp({ app_name: 'contract', viewTypes: [Page], initialize({ launchConfig, publish: commit }) {
    const label = launchConfig.compatible ? ref('label', 7, { schema: Type.Integer(), scope: 'public' })
        : ref('label', 'seven', { schema: Type.String(), scope: 'public' });
    const page = (() => { const handle = createView(Page); return { handle, frame: () => handle.frame({ body: 'Reference value', context: {}, refs: [label] }) }; })();
    commit(() => ([page]).map(page => page.frame()));
} });
