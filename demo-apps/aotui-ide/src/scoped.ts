import pkg from '../package.json' with { type: 'json' };
import { createApp } from '@aotui/sdk';
import { ideViewTypes } from './tui/ide-tool-contracts.js';
import { initializeIDE } from './tui/ScopedIDEApp.js';
/** Standard package entry: Semantic tools belong to the currently mounted View instance. */
const ideApp: ReturnType<typeof createApp> = createApp({ ...pkg.aotui, initialize: initializeIDE, viewTypes: ideViewTypes });

export default ideApp;
