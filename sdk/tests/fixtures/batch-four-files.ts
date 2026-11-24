import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { createApp, createView, defineViewType, ref, type ToolResult, type ViewHandle } from '@aotui/sdk/app';

type Name = 'A' | 'B' | 'C' | 'D' | 'E';
const largeText = 'B-LATEST ' + 'b'.repeat(8_000);
const succeeded = () => ({ success: true as const, data: { saved: true } });
const File = defineViewType<{
    name: Name; edit(mode: 'large' | 'short' | 'late'): Promise<ToolResult>;
}>()({ name: 'file', multiplicity: 'multiple', region: 'dynamic',
    tools: {
        edit: { description: 'Apply the selected editing operation to this open file.',
            inputSchema: Type.Object({ mode: Type.Union([Type.Literal('large'), Type.Literal('short'), Type.Literal('late')]) }),
            execute: ({ context, input }) => context.edit(input.mode) },
        echo: { description: 'Return a string or a selected file value without changing a file.',
            inputSchema: Type.Object({ value: Type.String(), countOnly: Type.Optional(Type.Boolean()) }),
            execute: ({ input }) => ({ success: true,
                data: input.countOnly ? { characters: input.value.length } : { value: input.value } }) },
    },
});
const Workspace = defineViewType<{ open(names: readonly Name[]): ToolResult }>()({ name: 'workspace', multiplicity: 'single', region: 'static',
    tools: { open_file: { description: 'Open files by their names from the workspace.',
        inputSchema: Type.Object({ names: Type.Array(Type.Union([
            Type.Literal('A'), Type.Literal('B'), Type.Literal('C'), Type.Literal('D'), Type.Literal('E'),
        ])) }),
        execute: ({ context, input }) => context.open(input.names) } },
});

export default createApp({
    app_name: 'window_files', viewTypes: [Workspace, File],
    initialize({ launchConfig, prepareProjection, prepareOpeningProjection, registerCleanup }) {
        const folder = launchConfig?.folder;
        if (typeof folder !== 'string') throw new Error('Missing file fixture directory');
        const dir: string = folder;
        const files = new Map<Name, ViewHandle>();
        const text = new Map<Name, string>();
        const generations = new Map<Name, number>();
        const writeLog = (name: string, value: object) => appendFileSync(join(dir, name + '.jsonl'), JSON.stringify(value) + '\n');
        const disk = (name: Name) => join(dir, name + '.txt');
        const workspace = createView(Workspace, { render: () => ({ body: 'Workspace files A, B, C, D and E.',
            context: { open(requested) {
                const added: Name[] = [];
                try {
                    for (const name of requested) {
                        if (files.has(name)) continue;
                        text.set(name, readFileSync(disk(name), 'utf8'));
                        files.set(name, mount(name));
                        added.push(name);
                    }
                    prepareOpeningProjection(frame());
                    return { success: true, data: { opened: added } };
                } catch (error) {
                    for (const name of added) files.delete(name);
                    prepareProjection(frame());
                    return { success: false, error: { code: (error as { code?: string }).code ?? 'OPEN_FAILED',
                        message: error instanceof Error ? error.message : 'Open failed' } };
                }
            } },
        }) });
        const frame = () => ({ views: [workspace, ...files.values()] });
        const publish = () => prepareProjection(frame());
        function mount(name: Name): ViewHandle {
            const generation = (generations.get(name) ?? 0) + 1;
            generations.set(name, generation);
            function close(): ToolResult {
                writeLog('closes', { name, generation, threadId });
                if (name === 'D') return { success: false, error: { code: 'UNSAVED', message: 'Save the file before closing.' } };
                if (name === 'E') return { success: true, data: { deferred: true } };
                files.delete(name);
                publish();
                return { success: true };
            }
            return createView(File, {
                idPrefix: 'file_' + name,
                region: name === 'A' || (name === 'B' && launchConfig?.staticB === true) ? 'static' : 'dynamic',
                ...(name === 'C' ? {} : { onClose: close }),
                render: () => ({ body: name + '.txt generation ' + generation + '\n' + text.get(name),
                    refs: [ref('content', text.get(name) ?? '', { scope: 'protected', schema: Type.String() })],
                    context: { name, async edit(mode) {
                        const value = mode === 'large' ? largeText : name + '-EDITED';
                        writeFileSync(disk(name), value);
                        writeLog('writes', { name, generation, size: value.length, threadId });
                        text.set(name, value);
                        publish();
                        if (mode === 'late') await new Promise(resolve => setTimeout(resolve, 240));
                        return succeeded();
                    } },
                }),
            });
        }
        publish();
        writeLog('lifecycle', { event: 'start', threadId });
        let seen = '';
        const command = join(dir, 'fixture-update.json');
        const watcher = setInterval(() => {
            if (!existsSync(command)) return;
            const raw = readFileSync(command, 'utf8');
            if (raw === seen) return;
            seen = raw;
            const { name, remount } = JSON.parse(raw) as { name: Name; remount?: boolean };
            if (!files.has(name)) return;
            text.set(name, readFileSync(disk(name), 'utf8'));
            if (remount) files.set(name, mount(name));
            publish();
        }, 20);
        registerCleanup({ stop: () => { clearInterval(watcher); writeLog('lifecycle', { event: 'stop', threadId }); } });
    },
});
