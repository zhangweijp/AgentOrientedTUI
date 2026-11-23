import { describe, expect, it } from 'vitest';
import { createRuntime, createDesktopId } from '../index.js';

describe('Kernel lifecycle entry points', () => {
    it('creates registered Desktops with default and supplied IDs', async () => {
        const kernel = createRuntime();
        const generated = await kernel.createDesktop();
        expect(generated).toMatch(/^dt_/);
        expect(kernel.getDesktop(generated).id).toBe(generated);
        const id = await kernel.createDesktop(createDesktopId('kernel-test'));
        expect(id).toBe('kernel-test');

        expect(kernel.getDesktop(id).id).toBe(id);
        await kernel.destroyDesktop(id);
        expect(() => kernel.getDesktop(id)).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
        await kernel.shutdown();
    });

    it('does not expose the retired snapshot, lock, or dispatcher Kernel APIs', () => {
        const kernel = createRuntime();
        expect(kernel).toHaveProperty('getAppInteraction');

        for (const name of [
            'acquireSnapshot',
            'releaseSnapshot',
            'execute',
            'getSystemToolDefinitions',
            'acquireLock',
            'releaseLock',
            'experimentalCreateAppScope',
            'desktopManager',
        ]) {
            expect(kernel).not.toHaveProperty(name);
        }
    });
});
