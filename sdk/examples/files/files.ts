import Type from 'typebox';
import { defineViewType, type ToolResult } from '@aotui/sdk/app';
import { fileIO } from './file-io.mjs';

export type FileName = 'A.txt' | 'B.txt';
export const names: readonly FileName[] = ['A.txt', 'B.txt'];
const success = { success: true } as const;

type DirectoryContext = {
    open(name: FileName): Promise<ToolResult>;
    reload(): Promise<ToolResult>;
    disable(): Promise<typeof success>;
};
type FileContext = { name: FileName; writable: boolean; write(text: string): Promise<typeof success> };

export const Directory = defineViewType<DirectoryContext>()({
    name: 'directory', region: 'static', multiplicity: 'single', tools: {
        open_file: { description: 'Open a file.', inputSchema: Type.Object({ name: Type.Union([Type.Literal('A.txt'), Type.Literal('B.txt')]) }),
            execute: ({ context, input }) => context.open(input.name) },
        reload_a: { description: 'Read A.txt again.', execute: ({ context }) => context.reload() },
        disable_a: { description: 'Make A.txt read-only and restrict its Ref to its own page.', execute: ({ context }) => context.disable() },
    },
});
export const File = defineViewType<FileContext>()({
    name: 'file', region: 'dynamic', multiplicity: 'multiple',
    tools: {
        edit: { description: 'Write exact text to the selected file.', inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
            enabled: ({ writable }) => writable, execute: ({ context, input }) => context.write(input.text) },
        inspect_text: { description: 'Report the selected text value.', inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
            execute: ({ input }) => ({ success: true, data: { text: input.text } }) },
    },
});

export const directoryBody = 'Files A.txt and B.txt.';
export const fileBody = (name: FileName, text: string) => `${name}\n${text}\n`;
const contentSchema = Type.String();
export const refOptions = (writable: boolean) => ({ scope: writable ? 'public' : 'private', schema: contentSchema } as const);

export function files(folder: unknown, publish: () => void | Promise<unknown>,
    prepareOpen: (open: () => void, undo: () => void) => void | Promise<unknown>) {
    if (typeof folder !== 'string') throw new Error('A fixture folder is required');
    const io = fileIO(folder);
    const contents = new Map<FileName, string>();
    let aWritable = true;
    const directory: DirectoryContext = {
        async open(name) {
            if (contents.has(name)) return success;
            const text = io.read(name);
            try { await prepareOpen(() => { contents.set(name, text); }, () => { contents.delete(name); }); }
            catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'OBSERVATION_CAPACITY')
                    return { success: false, error: { code: error.code, message: 'Close one file before opening another.' } };
                throw error;
            }
            return success;
        },
        async reload() {
            if (!contents.has('A.txt')) return directory.open('A.txt');
            contents.set('A.txt', io.read('A.txt'));
            await publish();
            return success;
        },
        async disable() { aWritable = false; await publish(); return success; },
    };
    return {
        directory, contents,
        async close(name: FileName) { contents.delete(name); await publish(); return success; },
        context(name: FileName): FileContext {
            return { name, writable: name !== 'A.txt' || aWritable,
                async write(text) { io.write(name, text); contents.set(name, text); await publish(); return success; } };
        },
    };
}
