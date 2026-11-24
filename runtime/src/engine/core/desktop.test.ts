import { it, expect } from 'vitest';
import { Desktop } from './desktop.js';

it('does not expose the retired snapshot-fragment or dispatcher entry points', async () => {
    const desktop = new Desktop('desktop');
    try {
        expect(desktop).toHaveProperty('getRunningApp');
        for (const name of ['getSnapshotFragments', 'dismountView', 'hideView', 'showView', 'mountViewByLink', 'experimentalCreateAppScope']) {
            expect(desktop).not.toHaveProperty(name);
        }
    } finally { await desktop.beginClose().completion; }
});
