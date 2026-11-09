import { describe, expect, it } from 'vitest';
import { Kernel } from './index.js';
import { DesktopManager } from '../engine/core/manager.js';

describe('Kernel lifecycle entry points', () => {
    it('creates and destroys Desktops through the manager', async () => {
        const manager = new DesktopManager();
        const kernel = new Kernel(manager);
        const id = await kernel.createDesktop('kernel-test');

        expect(kernel.getDesktop(id).id).toBe(id);
        await kernel.destroyDesktop(id);
        expect(manager.get(id)).toBeUndefined();
        await kernel.shutdown();
    });

    it('does not expose the retired snapshot, lock, or dispatcher Kernel APIs', () => {
        const kernel = new Kernel(new DesktopManager());
        expect(kernel).toHaveProperty('createAppScope');

        for (const name of [
            'acquireSnapshot',
            'releaseSnapshot',
            'execute',
            'getSystemToolDefinitions',
            'acquireLock',
            'releaseLock',
            'experimentalCreateAppScope',
        ]) {
            expect(kernel).not.toHaveProperty(name);
        }
    });
});
