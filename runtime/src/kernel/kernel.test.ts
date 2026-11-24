import { describe, expect, it } from 'vitest';
import { createRuntime, createDesktopId } from '../index.js';

describe('Kernel lifecycle entry points', () => {
    it('creates registered Desktops with default and supplied IDs', async () => {
        const kernel = createRuntime();
        const generated = (await kernel.createDesktop()).id;
        expect(generated).toMatch(/^dt_/);
        expect(kernel.getDesktop(generated).id).toBe(generated);
        const id = (await kernel.createDesktop(createDesktopId('kernel-test'))).id;
        expect(id).toBe('kernel-test');

        expect(kernel.getDesktop(id).id).toBe(id);
        await kernel.getDesktop(id).beginClose().completion;
        expect(() => kernel.getDesktop(id)).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
        await kernel.beginClose().completion;
    });

    it('does not expose the retired snapshot, lock, or dispatcher Kernel APIs', () => {
        const kernel = createRuntime();

        for (const name of [
            'acquireSnapshot',
            'releaseSnapshot',
            'execute',
            'getSystemToolDefinitions',
            'acquireLock',
            'releaseLock',
            'experimentalCreateAppScope',
            'desktopManager', 'getAppInteraction',
        ]) {
            expect(kernel).not.toHaveProperty(name);
        }
    });
});
