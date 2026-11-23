import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { createApp, createView, defineViewType, type ToolResult } from '@aotui/sdk/app';

const Draft = defineViewType<{ write(to: string): ToolResult }>()({
    name: 'draft', multiplicity: 'single', region: 'dynamic',
    tools: {
        set_recipients: {
            description: 'Set the email address on the local draft.',
            inputSchema: Type.Object({ to: Type.String() }, { additionalProperties: false }),
            execute: ({ context, input }) => context.write(input.to),
        },
    },
});

export default createApp({
    app_name: 'mail',
    viewTypes: [Draft],
    initialize({ launchConfig, prepareProjection, registerCleanup }) {
        const configured = launchConfig?.folder;
        if (typeof configured !== 'string') throw new Error('Missing draft folder');
        const folder: string = configured;
        const lifecycle = join(folder, 'mail-lifecycle.jsonl');
        let to = '', mount = 1;
        let draft = makeDraft(mount);
        function makeDraft(generation: number) {
            return createView(Draft, { id: 'draft', render: () => ({
                body: '# Draft\nRevision ' + generation + '\nTo: ' + to,
                context: { write(email) {
                    appendFileSync(join(folder, 'draft-handler.jsonl'), JSON.stringify({ to: email, generation, threadId }) + '\n');
                    to = email;
                    writeFileSync(join(folder, 'draft.json'), JSON.stringify({ to }));
                    appendFileSync(join(folder, 'draft-writes.jsonl'), JSON.stringify({ to, generation, threadId }) + '\n');
                    publish();
                    return { success: true, data: { saved: true } };
                } },
            }) });
        }
        function publish() { prepareProjection({ views: [draft] }); }
        publish();
        appendFileSync(lifecycle, JSON.stringify({ event: 'start', threadId }) + '\n');
        const watcher = setInterval(() => {
            if (mount !== 1 || !existsSync(join(folder, 'replace-draft'))) return;
            draft = makeDraft(++mount);
            publish();
        }, 15);
        registerCleanup({ stop: () => {
            clearInterval(watcher);
            appendFileSync(lifecycle, JSON.stringify({ event: 'stop', threadId }) + '\n');
        } });
    },
});
