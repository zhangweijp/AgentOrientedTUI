import { appendFileSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, createView, defineViewType, formatRef, ref } from '@aotui/sdk';

const names = ['A.txt', 'B.txt'];
const text = { type: 'string' };
const Directory = defineViewType()({ name: 'directory', region: 'static', multiplicity: 'single', tools: {
    list: { description: 'List the names of the files in this workspace.', execute: () => ({ success: true, data: { names } }) },
} });
const File = defineViewType()({ onClose: { enabled: context => !!context.close, execute: ({ context }) => context.close() },  name: 'file', region: 'dynamic', multiplicity: 'multiple', tools: {
    edit: { description: 'Write exact text to the selected file if its current text matches expected.',
        inputSchema: { type: 'object', properties: { expected: text, text }, required: ['expected', 'text'], additionalProperties: false },
        execute: ({ context, input }) => context.write(input),
    },
} });

export default createApp({ app_name: 'responses_files', viewTypes: [Directory, File],
    initialize({ launchConfig: { folder }, publish: commit, registerLifecycle }) {
        const opened = new Set();
        const directory = (() => { const handle = createView(Directory); return { handle, frame: () => handle.frame({ body: 'A.txt and B.txt. Edit a file from its own page.', context: {} }) }; })();
        const frame = () => ({ views: [directory, ...[...opened].map(name => files.get(name))] });
        const files = new Map(names.map(name => [name, (() => { const handle = createView(File, { idPrefix: 'doc' }); const displayName = name; const closeAction = function() {
                opened.delete(name);
                commit(() => frame().views.map(page => page.frame()));
                return { success: true };
            }; return { handle, frame: () => {
                const path = join(folder, name), contents = readFileSync(path, 'utf8');
                const value = ref('contents', contents, { scope: 'public', schema: text });
                return handle.frame({ name: displayName, body: `# ${name}\n\n${contents}\n\n${formatRef('Current text', value)}`, refs: [value], context: { ...({
                    write({ expected, text: next }) {
                        if (readFileSync(path, 'utf8') !== expected) return { success: false, error: { code: 'FILE_CHANGED', message: 'Read the current text first.' } };
                        writeFileSync(path, next);
                        appendFileSync(join(folder, 'edits.jsonl'), JSON.stringify({ name, next }) + '\n');
                        commit(() => ((frame()).views).map(page => page.frame()));
                        return { success: true, data: { edited: name } };
                    },
                }), close: closeAction } });
            } }; })()]));
        // The fixture changes open pages from a background event, independent of any tool result.
        const watcher = watch(folder, (_, file) => {
            if (file !== 'open.json') return;
            const newNames = JSON.parse(readFileSync(join(folder, file), 'utf8'));
            if (newNames.every(name => opened.has(name))) return;
            for (const name of newNames) opened.add(name);
            const result = commit(() => ((frame()).views).map(page => page.frame()), { mode: 'candidate' });
            if (!result.ok) throw Error(result.issue.code);
        });
        registerLifecycle({ close: () => watcher.close() });
        commit(() => ((frame()).views).map(page => page.frame()));
    },
});
