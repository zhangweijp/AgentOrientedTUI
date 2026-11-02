
import { describe, it, expect } from 'vitest';
import { createRuntime, defineRuntimeConfig } from '../../../src/facades/index.js'; // Use facades which exports everything now
import { DesktopManager } from '../../../src/engine/core/manager.js';

// Mock dependencies if needed, but we want to test propagation
// We might need to inspect private properties or use public getters

describe('Runtime Config Integration', () => {

    it('should propagate new RuntimeConfig to components', async () => {
        const config = defineRuntimeConfig({
            worker: { timeoutMs: 44444 }
        });

        const runtime = createRuntime(config);
        const desktopManager = (runtime as any).desktopManager as DesktopManager;

        // Create a desktop to verify config propagation
        const desktopId = await runtime.createDesktop();
        const desktop = desktopManager.get(desktopId);

        expect(desktop).toBeDefined();
        // Check Desktop private config
        expect((desktop as any).config.worker.timeoutMs).toBe(44444);

        const appManager = (desktop as any).appManager;
        expect(appManager).toBeDefined();
        await runtime.shutdown();
    });

    it('should use defaults when no config provided', async () => {
        const runtime = createRuntime();
        const desktopManager = (runtime as any).desktopManager as DesktopManager;
        await runtime.createDesktop();
        expect((desktopManager as any).config.worker.timeoutMs).toBe(30_000);
        await runtime.shutdown();
    });
});
