import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { createRuntime, defineRuntimeConfig } from '../../../src/index.js';

const localPath = fileURLToPath(new URL('../../fixtures/pending-app/', import.meta.url));

describe('Runtime Config Integration', () => {
    it('applies one configured Worker limit and the Desktop log bound', async () => {
        const config = defineRuntimeConfig({ worker: { maxWorkers: 3 }, logger: { maxSystemLogs: 10 } });
        const runtime = createRuntime(config);
        const desktop = await runtime.createDesktop();
        const second = await runtime.createDesktop();
        for (let index = 0; index < 11; index++) {
            await desktop.registerPendingApp({ installationId: 'item_' + index, localPath });
        }
        const logs = desktop.getSystemLogs?.();
        expect(logs).toHaveLength(10);
        expect(logs?.some(entry => entry.message.includes('installation: item_10'))).toBe(true);
        expect(second.getSystemLogs?.()).toHaveLength(1);
        expect(await runtime.beginClose().completion).toMatchObject({
            desktops: { accepted: 2, settled: 2 },
            workers: { ownership: 'owned', report: { state: 'closed', limit: 3, total: 0 } },
        });
    });

    it('uses the default Worker limit with no supplied configuration', async () => {
        const runtime = createRuntime();
        await runtime.createDesktop();
        expect(await runtime.beginClose().completion).toMatchObject({
            workers: { ownership: 'owned', report: { state: 'closed', limit: Number.POSITIVE_INFINITY, total: 0 } },
        });
    });
});
