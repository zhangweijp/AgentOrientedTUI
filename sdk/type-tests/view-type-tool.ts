import Type from 'typebox';
import { defineViewTypeTool, defineToolSet, createToolBindings } from '../src/tools/view-type-tool.js';

const input = Type.Object({
  filePath: Type.String({ description: 'Absolute path.' }),
  replaceAll: Type.Optional(Type.Boolean()),
  mode: Type.Enum(['name', 'content']),
  paths: Type.Array(Type.String()),
}, { additionalProperties: false });

const definition = defineViewTypeTool({
  viewType: 'FileDetail', name: 'edit_file', description: 'Edit a loaded file.', inputSchema: input,
});
declare const port: import('@aotui/runtime/spi').IAppTypeToolPort;
createToolBindings({ definition: defineToolSet({ edit: definition }), appTypeTools: port }).commit({ edit: { execute(args) {
    const path: string = args.filePath;
    const replaceAll: boolean | undefined = args.replaceAll;
    const mode: 'name' | 'content' = args.mode;
    // @ts-expect-error A Tool argument is recursively read-only, including arrays.
    args.paths.push('other');
    // @ts-expect-error The declared string input must not be widened to unknown or any.
    const number: number = args.filePath;
    // @ts-expect-error Unknown properties must not be accepted.
    args.notDeclared;
    void path; void replaceAll; void mode; void number;
    return { success: true };
  } } });

const existing = async (args: { readonly filePath: string; readonly content: string }): Promise<import('@aotui/runtime/spi').ToolResult> => args.filePath.length > 0
  ? { success: true }
  : { success: false, error: { code: 'PATH_REQUIRED', message: 'Choose a path.' }, effects: 'none' };
const write = defineViewTypeTool({
  viewType: 'FileDetail', name: 'write_file', description: 'Replace content.',
  inputSchema: Type.Object({ filePath: Type.String(), content: Type.String() }),
});

createToolBindings({ definition: defineToolSet({ write }), appTypeTools: port }).commit({ write: { execute: existing } });

const invalidHandler = defineViewTypeTool({
  viewType: 'FileDetail', name: 'invalid_handler', description: 'Must fail type checking.', inputSchema: Type.Object({ filePath: Type.String() }),
});
createToolBindings({ definition: defineToolSet({ invalidHandler }), appTypeTools: port }).commit({ invalidHandler: {
  // @ts-expect-error Handler must accept the schema-derived string field.
  execute: async (args: { filePath: number }) => ({ success: true }),
} });

defineViewTypeTool({
  viewType: 'FileDetail', name: 'invalid_root', description: 'Root must be an object.',
  // @ts-expect-error The parameter root must be a TypeBox object schema.
  inputSchema: Type.String(),
});

void definition;
