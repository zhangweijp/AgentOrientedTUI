import type { ToolBindings, ToolSetMap } from '@aotui/sdk/tools';
import { fileTools } from './m2-producer.js';
export const bindings: ToolBindings<ToolSetMap<typeof fileTools>> = {
  readFile: { execute: args => ({ success: true, data: { path: args.filePath } }) },
  editFile: { execute: args => ({ success: true, data: { mode: args.mode } }) },
};
