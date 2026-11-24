import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Type from 'typebox';
import { arrayRef, createApp, createView, defineViewType, formatRef, ref, refParam, type ToolResult } from '@aotui/sdk/app';

type FileName = 'A.txt' | 'B.txt';
type FileContext = {
    name: FileName;
    writable: boolean;
    write(text: string): ToolResult;
    close(): ToolResult;
};
const File = defineViewType<FileContext>()({
    name: 'file', multiplicity: 'multiple', region: 'dynamic',
    tools: {
        edit: {
            description: 'Write exact text to this file.',
            inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
            enabled: ({ writable }) => writable,
            execute: ({ context, input }) => context.write(input.text),
        },
        close: {
            description: 'Close this file.',
            execute: ({ context }) => context.close(),
        },
        inspect: {
            description: 'Return the supplied values.',
            inputSchema: Type.Object({
                texts: Type.Array(Type.String()),
                selected: Type.Optional(refParam('Line', Type.String())),
                count: Type.Optional(Type.Integer()),
                exact: Type.Optional(Type.String({ maxLength: 6 })),
                options: Type.Optional(Type.Object({ $ref: Type.String() }, { additionalProperties: true })),
            }, { additionalProperties: false }),
            execute: ({ input }) => ({ success: true, data: { ...input } }),
        },
    },
});
const Workspace = defineViewType<{
    open(name: FileName): ToolResult;
    reload(): ToolResult;
    disable(): ToolResult;
    replaceOnSignal(): ToolResult;
}>()({
    name: 'workspace', multiplicity: 'single', region: 'static',
    tools: {
        open_file: {
            description: 'Open one of the files listed in the workspace.',
            inputSchema: Type.Object({ name: Type.Union([Type.Literal('A.txt'), Type.Literal('B.txt')]) }),
            execute: ({ context, input }) => context.open(input.name),
        },
        reload_source: { description: 'Read A.txt again.', execute: ({ context }) => context.reload() },
        mark_a_readonly: { description: 'Disable edits to A.txt.', execute: ({ context }) => context.disable() },
        replace_b_on_signal: { description: 'Replace the B.txt page after the test signal arrives.',
            execute: ({ context }) => context.replaceOnSignal() },
    },
});
const Guide = defineViewType({ name: 'guide', multiplicity: 'single', region: 'static' });
const Status = defineViewType({ name: 'status', multiplicity: 'single', region: 'dynamic' });
const Marker = defineViewType({ name: 'marker', multiplicity: 'multiple' });
const completed = () => ({ success: true as const });

export default createApp({
    app_name: 'batch_files',
    viewTypes: [Guide, Workspace, File, Marker, Status],
    initialize({ launchConfig, prepareProjection, registerCleanup }) {
        const configuredFolder = launchConfig?.folder;
        if (typeof configuredFolder !== 'string') throw new Error('Missing test folder');
        const folder: string = configuredFolder;
        const text: Record<FileName, string> = { 'A.txt': '', 'B.txt': '' };
        const files = new Map<FileName, ReturnType<typeof mount>>();
        let aWritable = true;
        let watcher: ReturnType<typeof setInterval> | undefined;
        const guide = createView(Guide, { render: () => ({ body: '# File instructions' }) });
        const status = createView(Status, { render: () => ({ body: files.size + ' files open.' }) });
        const marker = createView(Marker, { region: 'static', idPrefix: '2note', render: () => ({ body: 'Static marker' }) });
        const workspace = createView(Workspace, { id: 'main', render: () => ({
            body: 'Files A.txt and B.txt.',
            context: {
                open(name) {
                    text[name] = readFileSync(join(folder, name), 'utf8');
                    if (!files.has(name)) files.set(name, mount(name));
                    publish();
                    return completed();
                },
                reload() {
                    text['A.txt'] = readFileSync(join(folder, 'A.txt'), 'utf8');
                    publish();
                    return completed();
                },
                disable() {
                    aWritable = false;
                    publish();
                    return completed();
                },
                replaceOnSignal() {
                    if (!watcher) watcher = setInterval(() => {
                        try { readFileSync(join(folder, 'replace-b')); }
                        catch (error) {
                            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                            throw error;
                        }
                        clearInterval(watcher);
                        watcher = undefined;
                        files.set('B.txt', mount('B.txt'));
                        publish();
                    }, 20);
                    return completed();
                },
            },
        }) });
        const ready = createView(Marker, { region: 'dynamic', render: () => ({ body: 'Dynamic marker' }) });
        registerCleanup({ stop: () => { clearInterval(watcher); } });
        function publish() { prepareProjection({ views: [guide, workspace, marker, ...files.values(), ready, status] }); }
        function mount(name: FileName) {
            return createView(File, { idPrefix: 'doc', render: () => {
                const content = ref('content', text[name], { scope: 'protected', schema: Type.String() });
                const hidden = ref('hidden', 'private data', { scope: 'private', schema: Type.String() });
                const lines = arrayRef('lines', Array.from({ length: 100 }, (_, i) => 'line ' + i),
                    { schema: Type.Array(Type.String()), scope: 'protected', itemType: 'Line' });
                const quoted = ref('lines[0]', 'literal bracket name', { scope: 'protected', schema: Type.String() });
                const count = ref('count', 7, { scope: 'protected', schema: Type.Integer() });
                return {
                    body: [name, formatRef(text[name], content), formatRef('Line list', lines), formatRef('First line', lines, 0),
                        formatRef('Other value', quoted)].join('\n'),
                    refs: [content, hidden, lines, quoted, count],
                    context: {
                        name, writable: name === 'B.txt' || aWritable,
                        write(next: string) {
                            writeFileSync(join(folder, name), next);
                            appendFileSync(join(folder, 'writes.jsonl'), JSON.stringify({ name, text: next }) + '\n');
                            text[name] = next;
                            publish();
                            return completed();
                        },
                        close() { files.delete(name); publish(); return completed(); },
                    },
                };
            } });
        }
        publish();
    },
});
