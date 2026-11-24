import pkg from '../package.json' with { type: 'json' };
import { createTUIApp } from '@aotui/sdk';
import { ideViewTypes } from './tui/ide-tool-contracts.js';
import { ScopedIDEApp } from './tui/ScopedIDEApp.js';
/** Standard package entry: Semantic tools belong to the currently mounted View instance. */
const ideApp: ReturnType<typeof createTUIApp> = createTUIApp({ ...pkg.aotui, component: ScopedIDEApp, viewTypes: ideViewTypes });

export default ideApp;
