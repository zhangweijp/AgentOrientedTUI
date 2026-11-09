import type { ToolBindingController } from '@aotui/sdk/tools';
import { narrowController } from '../variance-producer.js';
import type { WideMap } from '../variance-producer.js';
// Contract: fixed declaration maps are invariant in both directions.
const widened: ToolBindingController<WideMap> = narrowController;
widened.commit({ edit: { execute: (args: { readonly mode: 'append' | 'replace' }) => ({ success: true, data: { mode: args.mode } }) } });
