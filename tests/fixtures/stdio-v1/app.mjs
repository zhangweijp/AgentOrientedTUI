import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { arrayRef, createApp, createView, defineViewType, formatRef, ref } from '@aotui/sdk';

const string = { type: 'string' };
const people = { type: 'array', items: {
    type: 'object', properties: { 'display.name': string }, required: ['display.name'], additionalProperties: false,
} };
const Index = defineViewType({ name: 'Index', multiplicity: 'single', region: 'static' });
const File = defineViewType()({ onClose: { enabled: context => !!context.close, execute: ({ context }) => context.close() },
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
    initialize({ launchConfig, publish: commit, requestAttention, registerLifecycle }) {
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
        const catalog = (() => { const handle = createView(Index); return { handle, frame: () => handle.frame({ body: '# Files' }) }; })();
        const files = new Map(['A', 'B'].map(key => {
            const name = key + '.txt';
            const view = (() => { const handle = createView(File, { idPrefix: key }); const displayName = name; const closeAction = function() { files.delete(key); render(); return ok; }; return { handle, frame: () => {
                const text = readFileSync(path(name), 'utf8');
                const item = arrayRef('people', [{ 'display.name': '小梅 & Team' }], {
                    schema: people, scope: 'public', itemType: 'Person',
                });
                return handle.frame({ name: displayName, body: text + '\n' + formatRef('小梅', item, 0), refs: [
                    ref('content', text, { schema: string, scope: 'public' }), item,
                ], context: { ...({
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
                }), close: closeAction } });
            } }; })();
            return [key, view];
        }));
        function render() { return commit(() => ([catalog, ...files.values()]).map(page => page.frame())); }
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
        registerLifecycle({
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
