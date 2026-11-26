import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { createApp, createView, defineViewType, formatRef, ref, type ToolResult } from '@aotui/sdk';

const Options = defineViewType({ name: 'options', multiplicity: 'single', region: 'static' });
const Draft = defineViewType<{ save(field: string, value: unknown): ToolResult }>()({
    name: 'draft', multiplicity: 'single', region: 'dynamic',
    tools: {
        set_count: { description: 'Save an integer count.',
            inputSchema: Type.Object({ count: Type.Integer() }, { additionalProperties: false }),
            execute: ({ input, context }) => context.save('count', input.count) },
        set_mode: { description: 'Choose fast or accurate.',
            inputSchema: Type.Object({ mode: Type.String({ enum: ['fast', 'accurate'] }) }, { additionalProperties: false }),
            execute: ({ input, context }) => context.save('mode', input.mode) },
        set_exact: { description: 'Save the fast mode.',
            inputSchema: Type.Object({ exact: Type.Literal('fast') }, { additionalProperties: false }),
            execute: ({ input, context }) => context.save('exact', input.exact) },
        set_recipients: { description: 'Set the recipients on this draft.',
            inputSchema: Type.Object({ to: Type.Array(Type.String()) }, { additionalProperties: false }),
            execute: ({ input, context }) => context.save('to', input.to) },
        set_text: { description: 'Store the exact text.',
            inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
            execute: ({ input, context }) => context.save('text', input.text) },
    },
});

export default createApp({
    app_name: 'reference_draft', viewTypes: [Options, Draft],
    initialize({ launchConfig, prepareProjection }) {
        const configured = launchConfig?.folder;
        if (typeof configured !== 'string') throw new Error('A fixture folder is required');
        const folder = configured;
        const options = createView(Options, { render() {
            const mode = ref('mode', 'fast', { scope: 'protected', schema: Type.String() });
            return { body: 'Preferred mode: ' + formatRef('fast', mode), refs: [mode] };
        } });
        let content = 'Untouched draft';
        const draft = createView(Draft, { render: () => ({ body: content, context: { save(field, value) {
            content = JSON.stringify({ field, value });
            writeFileSync(join(folder, 'ref-draft.json'), content);
            appendFileSync(join(folder, 'ref-writes.jsonl'), JSON.stringify({ field, value, threadId }) + '\n');
            publish();
            return { success: true };
        } } }) });
        function publish() { prepareProjection({ views: [options, draft] }); }
        publish();
    },
});
