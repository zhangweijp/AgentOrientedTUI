import { createTUIApp } from '@aotui/sdk';
import { ScopedIDEApp } from './tui/ScopedIDEApp.js';
/** Standard package entry: Semantic tools belong to the currently mounted View instance. */
export default createTUIApp({ app_name: 'system_ide', component: ScopedIDEApp, experimentalAppLifecycle: true,
    whatItIs: 'An IDE with file operations, per-App sessions and language servers, and scoped View-owned tools.',
    whenToUse: 'Explore authorized workspaces, read and change loaded files, search source, and inspect language information.' });
