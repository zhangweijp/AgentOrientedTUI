import { defineViewType, type ToolResult } from '@aotui/sdk';

type DirectoryContext = {
    open(name: string): ToolResult;
    reload(): ToolResult;
    disable(): ToolResult;
};
type FileContext = { writable: boolean; write(text: string): ToolResult };
export const fileUnavailable = {
    success: false, error: { code: 'FILE_UNAVAILABLE', message: 'Choose an available regular file in the configured folder.' },
} as const;
export const textSchema = { type: 'string' } as const;
const textInput = {
    type: 'object', properties: { text: textSchema }, required: ['text'], additionalProperties: false,
} as const;

export const Directory = defineViewType<DirectoryContext>()({
    name: 'directory', region: 'static', multiplicity: 'single',
    tools: {
        open_file: {
            description: 'Open a file by its name in the directory.',
            inputSchema: { type: 'object', properties: { name: textSchema },
                required: ['name'], additionalProperties: false },
            execute: ({ context, input }) => context.open(input.name),
        },
        reload_a: { description: 'Read A.txt again.', execute: ({ context }) => context.reload() },
        disable_a: { description: 'Make A.txt read-only and restrict its Ref to its own page.', execute: ({ context }) => context.disable() },
    },
});

export const File = defineViewType<FileContext>()({
    name: 'file', region: 'dynamic', multiplicity: 'multiple',
    tools: {
        edit: { description: 'Write exact text to the selected file.', inputSchema: textInput,
            enabled: ({ writable }) => writable, execute: ({ context, input }) => context.write(input.text) },
        inspect_text: { description: 'Report the selected text value.', inputSchema: textInput,
            execute: ({ input }) => ({ success: true, data: { text: input.text } }) },
    },
});
