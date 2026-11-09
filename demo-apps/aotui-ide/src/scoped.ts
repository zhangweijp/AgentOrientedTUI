import { createTUIApp } from '@aotui/sdk';
import { ScopedIDEApp } from './tui/ScopedIDEApp.js';
/** Standard package entry: Semantic tools belong to the currently mounted View instance. */
const ideApp: ReturnType<typeof createTUIApp> = createTUIApp({ app_name: 'system_ide', component: ScopedIDEApp,
    whatItIs: 'An IDE with file actions, per-App sessions and language servers, and scoped View-owned tools.',
    whenToUse: 'Explore authorized workspaces, read and change loaded files, search source, and inspect language information.' });

export default ideApp;
