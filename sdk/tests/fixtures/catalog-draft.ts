import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { createApp, createView, defineViewType } from '@aotui/sdk';

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
    app_name: 'catalog_draft',
    viewTypes: [Draft],
    initialize({ appId, desktopId, launchConfig, prepareProjection, registerCleanup }) {
        const dataDir = typeof launchConfig?.AOTUI_DATA_DIR === 'string' && launchConfig.AOTUI_DATA_DIR.length > 0
            ? launchConfig.AOTUI_DATA_DIR : undefined;
        if (!dataDir) throw Error('Draft data directory is unavailable');
        const storageKey = typeof launchConfig?.draftKey === 'string' && launchConfig.draftKey.length > 0
            ? launchConfig.draftKey : appId;
        const draftFile = join(dataDir, 'catalog-draft', `${desktopId}-${storageKey}.txt`);
        record('initialize', { storageKey, dataDir });
        let text = 'empty';
        const draft = createView(Draft, {
            id: 'draft', render: () => ({ body: 'Draft: ' + text, context: {
                async save(next) {
                    await mkdir(join(dataDir, 'catalog-draft'), { recursive: true });
                    await writeFile(draftFile, next, 'utf8');
                    record('save', { storageKey, text: next });
                    text = next;
                    publish();
                    return success;
                },
                async lookup() {
                    try {
                        text = await readFile(draftFile, 'utf8');
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
                        text = 'missing';
                    }
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
