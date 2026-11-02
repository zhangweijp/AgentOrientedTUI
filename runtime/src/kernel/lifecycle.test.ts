import { describe, it, expect, beforeEach } from 'vitest';
import { Kernel } from './index.js';
import { DesktopManager } from '../engine/core/manager.js'; // Use real Manager
import { DesktopState, createDesktopId } from '../spi/index.js';

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

    describe('serialize/restore', () => {
        it('serialize throws NOT_FOUND for non-existent desktop', () => {
            expect(() => kernel.serialize(createDesktopId('non_existent'))).toThrow(/not found/);
        });

        // [Worker-Only Migration] Tests removed:
        // - 'serialize returns DesktopState with correct structure' - requires installApp
        // - 'restore creates new desktop from state' - requires installApp
        // - 'restore preserves app configuration' - requires installApp
        //
        // In Worker-Only architecture, use installDynamicWorkerApp instead.
        // State serialization for Worker apps is handled differently.
    });

    // [Worker-Only Migration] 'integration: full lifecycle' test removed
    // The old lifecycle (install static HTML -> serialize -> restore) is no longer supported.
    // Worker-Only apps have different lifecycle patterns.

    describe('runtime shutdown', () => {
        it('shutdown is idempotent and rejects further runtime operations', async () => {
            const id1 = await kernel.createDesktop();
            const id2 = await kernel.createDesktop();

            expect(desktopManager.has(id1)).toBe(true);
            expect(desktopManager.has(id2)).toBe(true);

            await kernel.shutdown('service_stop');
            await kernel.shutdown('service_stop');

            expect(desktopManager.has(id1)).toBe(false);
            expect(desktopManager.has(id2)).toBe(false);

            await expect(kernel.createDesktop()).rejects.toThrow(/Runtime has been shut down|RUNTIME_SHUTDOWN/);
        });
    });
});
