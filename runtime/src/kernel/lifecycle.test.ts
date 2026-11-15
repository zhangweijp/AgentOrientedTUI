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

    describe('suspend/resume', () => {
        // [H3 FIX] Tests updated for async suspend/resume
        it('suspend throws NOT_FOUND for non-existent desktop', async () => {
            await expect(kernel.suspend(createDesktopId('non_existent'))).rejects.toThrow(/not found/);
        });

        it('resume throws NOT_FOUND for non-existent desktop', async () => {
            await expect(kernel.resume(createDesktopId('non_existent'))).rejects.toThrow(/not found/);
        });

        it('suspend and resume work on valid desktop', async () => {
            const id = await kernel.createDesktop();

            // Should not throw (now async)
            await expect(kernel.suspend(id)).resolves.not.toThrow();
            await expect(kernel.resume(id)).resolves.not.toThrow();
        });
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
