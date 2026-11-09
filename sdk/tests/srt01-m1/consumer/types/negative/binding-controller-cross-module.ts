import { wideController, passNarrow } from '../variance-producer.js';
const narrowed = passNarrow(wideController);
narrowed.commit({ edit: { execute: (args: { readonly mode: 'append' }) => ({ success: true, data: { mode: args.mode } }) } });
