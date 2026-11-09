import Type from 'typebox';
import { defineToolSet, defineViewTypeTool } from '@aotui/sdk/tools';

const readFileDeclaration = {
  viewType: 'FileDetail',
  name: 'read_file',
  description: 'Read the currently selected file.',
  inputSchema: Type.Object({
    filePath: Type.String(),
  }, { additionalProperties: false }),
};
const readFile = defineViewTypeTool(readFileDeclaration);

export const fileTools = defineToolSet({
  readFile,
  editFile: defineViewTypeTool({
    viewType: 'FileDetail',
    name: 'edit_file',
    description: 'Edit the currently selected file.',
    inputSchema: Type.Object({
      filePath: Type.String(),
      mode: Type.Enum(['append', 'replace']),
      tags: Type.Readonly(Type.Array(Type.Number())),
      note: Type.Optional(Type.String()),
      revision: Type.Optional(Type.Readonly(Type.Number())),
    }, { additionalProperties: false }),
  }),
});
