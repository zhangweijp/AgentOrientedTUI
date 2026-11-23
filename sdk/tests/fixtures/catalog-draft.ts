import { appendFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { createApp, createView, defineViewType } from '@aotui/sdk/app';

const journal = new URL('./catalog-effects.jsonl', import.meta.url);
function record(event: string, data: object = {}) {
    appendFileSync(journal, JSON.stringify({ event, threadId, ...data }) + '\n');
}

record('import');
const success = { success: true } as const;
const Draft = defineViewType<{ save(text: string): Promise<typeof success>; lookup(): Promise<typeof success> }>()({
    name: 'Draft', region: 'dynamic', multiplicity: 'single',
    tools: {
        save: { description: 'Save one draft', inputSchema: Type.Object({ text: Type.String() }),
            execute: ({ input, context }) => context.save(input.text) },
        lookup: { description: 'Read this installation’s saved draft', inputSchema: Type.Object({}),
            execute: ({ context }) => context.lookup() },
    },
});

export default createApp({
    app_name: 'catalog_draft', whatItIs: 'A small draft with its own storage namespace.',
    persistence: true, viewTypes: [Draft],
    initialize({ launchConfig, persistence, prepareProjection, registerCleanup }) {
        if (!persistence) throw Error('Draft storage is unavailable');
        const storage = persistence;
        const storageKey = launchConfig?.AOTUI_APP_KEY;
        record('initialize', { storageKey });
        let text = 'empty';
        const draft = createView(Draft, {
            id: 'draft', render: () => ({ body: 'Draft: ' + text, context: {
                async save(next) {
                    await storage.save('draft', next);
                    record('save', { storageKey, text: next });
                    text = next;
                    publish();
                    return success;
                },
                async lookup() {
                    const saved = await storage.load('draft');
                    text = typeof saved === 'string' ? saved : 'missing';
                    record('lookup', { storageKey });
                    publish();
                    return success;
                },
            } }),
        });
        function publish() { return prepareProjection({ views: [draft] }); }
        registerCleanup({ close() { record('close', { storageKey }); } });
        publish();
    },
});
