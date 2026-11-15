import Type from 'typebox';
import { defineViewType } from '@aotui/sdk/app';

export const RootType = defineViewType({ name: 'Root', tools: {} });

export const WorkspaceType = defineViewType({ name: 'Workspace', tools: {
        open_file: { description: 'Open a demo file and read its FileDetail View.',
            inputSchema: Type.Object({ filePath: Type.String() }, { additionalProperties: false }),
        },
        close_file: { description: 'Close an opened demo file.',
            inputSchema: Type.Object({ filePath: Type.String() }, { additionalProperties: false }),
        },
} });

export const FileDetailType = defineViewType({ name: 'FileDetail', tools: {
        edit_file: { description: 'Edit an opened demo file and read its updated View.',
            inputSchema: Type.Object({ content: Type.String() }, { additionalProperties: false }),
        },
} });

export const fileViewTypes = [RootType, WorkspaceType, FileDetailType] as const;
