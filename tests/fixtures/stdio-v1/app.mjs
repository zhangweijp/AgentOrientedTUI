import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { arrayRef, createApp, createView, defineViewType, formatRef, ref } from '@aotui/sdk';

const string = { type: 'string' };
const people = { type: 'array', items: {
    type: 'object', properties: { 'display.name': string }, required: ['display.name'], additionalProperties: false,
} };
const Index = defineViewType({ name: 'Index', multiplicity: 'single', region: 'static' });
const File = defineViewType()({
    name: 'File', multiplicity: 'multiple', region: 'dynamic',
    tools: {
        edit: {
            description: 'Write an exact string to the selected file.',
            inputSchema: { type: 'object', properties: {
                text: string, wait: { type: 'boolean' },
            }, required: ['text'] },
            execute: ({ input, context }) => context.save(input),
        },
    },
});
const ok = { success: true };

export default createApp({
    app_name: 'stdio_files',
    viewTypes: [Index, File],
    initialize({ launchConfig, prepareProjection, requestAttention, registerCleanup }) {
        const { folder } = launchConfig;
        const path = name => join(folder, name);
        const existed = name => existsSync(path(name));
        const mark = name => writeFileSync(path(name), '');
        async function waitFor(name) {
            const limit = Date.now() + 8_000;
            while (!existed(name)) {
                if (Date.now() >= limit) throw new Error('Fixture gate was never opened: ' + name);
                await delay(8);
            }
        }
        const catalog = createView(Index, { render: () => ({ body: '# Files' }) });
        const files = new Map(['A', 'B'].map(key => {
            const name = key + '.txt';
            const view = createView(File, { idPrefix: key, name, render() {
                const text = readFileSync(path(name), 'utf8');
                const item = arrayRef('people', [{ 'display.name': '小梅 & Team' }], {
                    schema: people, scope: 'public', itemType: 'Person',
                });
                return { body: text + '\n' + formatRef('小梅', item, 0), refs: [
                    ref('content', text, { schema: string, scope: 'public' }), item,
                ], context: {
                    async save({ text, wait }) {
                        if (wait) {
                            mark('edit-entered');
                            await waitFor('edit-release');
                        }
                        writeFileSync(path(name), text);
                        appendFileSync(path('writes.jsonl'), JSON.stringify({ name, text }) + '\n');
                        render();
                        return { success: true, data: { saved: name } };
                    },
                } };
            }, onClose() { files.delete(key); render(); return ok; } });
            return [key, view];
        }));
        function render() { return prepareProjection({ views: [catalog, ...files.values()] }); }
        render();
        const buffer = new Int32Array(new SharedArrayBuffer(4));
        const watching = setInterval(() => {
            if (existed('attention') && !existed('attention-sent')) {
                requestAttention();
                mark('attention-sent');
            }
            if (existed('projection-hold') && !existed('projection-entered')) {
                mark('projection-entered');
                const limit = Date.now() + 8_000;
                while (!existed('projection-release') && Date.now() < limit) Atomics.wait(buffer, 0, 0, 8);
                render();
            }
        }, 12);
        registerCleanup({
            stop() { clearInterval(watching); },
            async close() {
                if (existed('close-hold')) {
                    mark('close-entered');
                    await waitFor('close-release');
                }
                mark('close-finished');
            },
        });
    },
});
