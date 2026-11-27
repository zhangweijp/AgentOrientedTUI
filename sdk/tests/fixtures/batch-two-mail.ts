import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { createApp, createView, defineViewType, type ToolResult } from '@aotui/sdk';

const Draft = defineViewType<{ setRecipients(to: readonly string[]): Promise<ToolResult> }>()({
    name: 'draft',
    multiplicity: 'single',
    region: 'dynamic',
    tools: {
        set_recipients: {
            description: 'Set the To recipients on the local mail draft.',
            inputSchema: Type.Object({ to: Type.Array(Type.String()) }, { additionalProperties: false }),
            execute: ({ input, context }) => context.setRecipients(input.to),
        },
    },
});

export default createApp({
    app_name: 'mail',
    viewTypes: [Draft],
    initialize({ launchConfig, publish: commit, registerLifecycle }) {
        const configured = launchConfig?.folder;
        if (typeof configured !== 'string') throw new Error('Missing draft folder');
        const folder = configured;
        let recipients: string[] = [];
        const entered = join(folder, 'draft-handler.jsonl');
        const writes = join(folder, 'draft-writes.jsonl');
        const witness = join(folder, 'mail-lifecycle.jsonl');
        const draft = (() => { const handle = createView(Draft); return { handle, frame: () => handle.frame({ body: '# Mail draft\nTo: ' + recipients.join(', '), context: { async setRecipients(to) {
                appendFileSync(entered, JSON.stringify({ to, threadId }) + '\n');
                const expires = Date.now() + 15000;
                while (existsSync(join(folder, 'park-draft'))) {
                    if (Date.now() >= expires) return { success: false, error: { code: 'FIXTURE_TIMEOUT', message: 'Draft was never released.' } };
                    await delay(10);
                }
                recipients = to.slice();
                writeFileSync(join(folder, 'draft.json'), JSON.stringify({ to }));
                appendFileSync(writes, JSON.stringify({ to, threadId }) + '\n');
                commit(() => ([draft]).map(page => page.frame()));
                return { success: true, data: { saved: true } };
            } } }) }; })();
        commit(() => ([draft]).map(page => page.frame()));
        appendFileSync(witness, JSON.stringify({ event: 'start', threadId }) + '\n');
        registerLifecycle({ stop: () => { appendFileSync(witness, JSON.stringify({ event: 'stop', threadId }) + '\n'); } });
    },
});
