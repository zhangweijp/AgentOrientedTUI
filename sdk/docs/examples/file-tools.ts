import Type from 'typebox';
import { defineToolSet, defineViewTypeTool } from '@aotui/sdk/app';

export const fileTools = defineToolSet({
  open: defineViewTypeTool({
    viewType: 'Workspace', name: 'open_file', description: 'Open a demo file and read its FileDetail View.',
    inputSchema: Type.Object({ filePath: Type.String() }, { additionalProperties: false }),
  }),
  close: defineViewTypeTool({
    viewType: 'Workspace', name: 'close_file', description: 'Close an opened demo file.',
    inputSchema: Type.Object({ filePath: Type.String() }, { additionalProperties: false }),
  }),
  edit: defineViewTypeTool({
    viewType: 'FileDetail', name: 'edit_file', description: 'Edit an opened demo file and read its updated View.',
    inputSchema: Type.Object({ filePath: Type.String(), content: Type.String() }, { additionalProperties: false }),
  }),
});
