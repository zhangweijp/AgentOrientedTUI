import { createToolBindings } from '@aotui/sdk/tools';
import type { IAppTypeToolPort } from '@aotui/runtime/spi';
import type { ArgsOf } from '@aotui/sdk/tools';
import { fileTools } from '../m2-producer.js';
declare const port: IAppTypeToolPort;
const controller = createToolBindings({ definition: fileTools, appTypeTools: port });
const ok = { readFile: { execute: (args: ArgsOf<typeof fileTools.readFile>) => ({ success: true, data: { filePath: args.filePath } }) }, editFile: { execute: (args: ArgsOf<typeof fileTools.editFile>) => ({ success: true, data: { mode: args.mode } }) } };
controller.commit({ ...ok, editFile: { execute: (args: { filePath: string; mode: 'append'; tags: readonly number[] }) => ({ success: true, data: { mode: args.mode } }) } });
