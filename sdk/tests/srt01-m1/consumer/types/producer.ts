import Type from 'typebox';
import { defineViewTypeTool, defineToolSet } from '@aotui/sdk/tools';

export const input = Type.Object({
  filePath: Type.String(),
  mode: Type.Enum(['append', 'replace']),
  tags: Type.Readonly(Type.Array(Type.Number())),
  note: Type.Optional(Type.String()),
  revision: Type.Optional(Type.Readonly(Type.Number())),
}, { additionalProperties: false });
const declaration = { viewType: 'File', name: 'edit', description: 'Edit an opened file.', inputSchema: input };
export const edit = defineViewTypeTool(declaration);
export const tools = defineToolSet({ edit });
