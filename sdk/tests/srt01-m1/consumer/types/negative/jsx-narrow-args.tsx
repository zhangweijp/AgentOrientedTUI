import { AppTools } from '@aotui/sdk';
import { fileTools } from '../m2-producer.js';
import { bindings } from '../jsx-bindings.js';
export const bad = <AppTools definition={fileTools} bindings={{ ...bindings, editFile: { execute: (args: { readonly filePath: string; readonly mode: 'append'; readonly tags: readonly number[] }) => ({ success: true, data: { mode: args.mode } }) } }} />;
