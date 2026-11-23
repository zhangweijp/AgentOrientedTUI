import Type from 'typebox';
import { defineViewType, type ToolResult } from '@aotui/sdk/app';

export const RootType = defineViewType({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'Root' });

type WorkspaceContext = {
    hasOpenFiles: boolean;
    openFile(path: string): Promise<ToolResult>;
    closeFile(path: string): ToolResult;
};
export const WorkspaceType = defineViewType<WorkspaceContext>()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'Workspace', tools: {
        open_file: { description: 'Open a demo file and read its FileDetail View.',
            inputSchema: Type.Object({ filePath: Type.String() }, { additionalProperties: false }),
            execute: ({ input, context }) => context.openFile(input.filePath),
        },
        close_file: { description: 'Close an opened demo file.',
            inputSchema: Type.Object({ filePath: Type.String() }, { additionalProperties: false }),
            enabled: ({ hasOpenFiles }) => hasOpenFiles,
            execute: ({ input, context }) => context.closeFile(input.filePath),
        },
} });

export const FileDetailType = defineViewType<{ edit(content: string): Promise<ToolResult> }>()({ multiplicity: 'multiple', createId: ({ prefix }) => prefix, name: 'FileDetail', tools: {
        edit_file: { description: 'Edit an opened demo file and read its updated View.',
            inputSchema: Type.Object({ content: Type.String() }, { additionalProperties: false }),
            execute: ({ input, context }) => context.edit(input.content),
        },
} });

export const fileViewTypes = [RootType, WorkspaceType, FileDetailType] as const;
