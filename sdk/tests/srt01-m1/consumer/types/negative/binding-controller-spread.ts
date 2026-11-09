import type { ToolBindingController } from '@aotui/sdk/tools';
import { wideController } from '../variance-producer.js';
import type { NarrowMap } from '../variance-producer.js';
const copied = { ...wideController };
const narrowed: ToolBindingController<NarrowMap> = copied;
narrowed.commit({ edit: { execute: (args: { readonly mode: 'append' }) => ({ success: true, data: { mode: args.mode } }) } });
