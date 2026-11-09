import { AppTools } from '@aotui/sdk';
import { fileTools } from '../m2-producer.js';
import { bindings } from '../jsx-bindings.js';
export const bad = <AppTools definition={fileTools} bindings={{ ...bindings, editFile: { execute: args => { args.filePath = 'changed'; args.tags.push(1); args.revision = 3; return { success: true }; } } }} />;
