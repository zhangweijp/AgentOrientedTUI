import { describe, it, expect, beforeEach } from 'vitest';
import { Kernel } from './index.js';
import { DesktopManager } from '../engine/core/manager.js'; // Use real Manager
import { createDesktopId } from '../spi/index.js';

describe('Kernel Lifecycle Management', () => {
    let kernel: Kernel;
    let desktopManager: DesktopManager;

    beforeEach(() => {
        // Use REAL DesktopManager for integration testing
        desktopManager = new DesktopManager();
        kernel = new Kernel(desktopManager);
    });

    describe('runtime shutdown', () => {
        it('shutdown is idempotent and rejects further Runtime requests', async () => {
            const id1 = await kernel.createDesktop();
            const id2 = await kernel.createDesktop();

            expect(desktopManager.get(id1)).toBeDefined();
            expect(desktopManager.get(id2)).toBeDefined();

            await kernel.shutdown();
            await kernel.shutdown();

            expect(desktopManager.get(id1)).toBeUndefined();
            expect(desktopManager.get(id2)).toBeUndefined();

            await expect(kernel.createDesktop()).rejects.toThrow(/Runtime has been shut down|RUNTIME_SHUTDOWN/);
        });
    });
});
