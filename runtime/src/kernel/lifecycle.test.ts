import { describe, it, expect } from 'vitest';
import { createRuntime } from '../index.js';

describe('Kernel Lifecycle Management', () => {
    describe('runtime shutdown', () => {
        it('shutdown is idempotent and rejects further Runtime requests', async () => {
            const kernel = createRuntime();
            const id1 = await kernel.createDesktop();
            const id2 = await kernel.createDesktop();

            expect(kernel.getDesktop(id1)).toBeDefined();
            expect(kernel.getDesktop(id2)).toBeDefined();

            await kernel.shutdown();
            await kernel.shutdown();

            expect(() => kernel.getDesktop(id1)).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));
            expect(() => kernel.getDesktop(id2)).toThrow(expect.objectContaining({ code: 'DESKTOP_NOT_FOUND' }));

            await expect(kernel.createDesktop()).rejects.toThrow(/Runtime has been shut down|RUNTIME_SHUTDOWN/);
        });
    });
});
