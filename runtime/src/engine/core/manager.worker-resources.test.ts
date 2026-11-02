import { expect, it } from 'vitest';
import { createRuntime } from '../../facades/facades.js';
import { defineRuntimeConfig } from '../../spi/config/index.js';
import { AppManager } from '../app/manager.js';
import { WorkerPool } from '../app/worker-pool.js';

it('C1-01/08 actual createRuntime owners are cold, independent, and shared only across their own Desktops', async () => {
    const a = createRuntime({ worker: { pool: { initialSize: 2, maxSize: 2 } } }) as any;
    const b = createRuntime({ worker: { pool: { initialSize: 0, maxSize: 1 } } }) as any;
    const ma = a.desktopManager, mb = b.desktopManager;
    expect(ma.workerPool).not.toBe(mb.workerPool);
    const first = await a.createDesktop(), second = await a.createDesktop();
    for (const id of [first, second]) {
        const apps = ma.get(id).appManager;
        expect(apps.workerPool).toBe(ma.workerPool);
        expect(apps.options.runtimeConfig).toBe(ma.config);
    }

    const reportA = await a.beginShutdown().completion;
    const reportB = await b.beginShutdown().completion;
    expect(reportA.pool).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0, limit: 2 } });
    expect(reportB.pool).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0, limit: 1 } });
});

it('C1-01 standalone AppManager closes only its owned pool and leaves a borrowed pool to its owner', async () => {
    const runtimeConfig = defineRuntimeConfig({ worker: { pool: { initialSize: 0, maxSize: 3 }, timeoutMs: 1234 } });
    const standalone = new AppManager({} as any, { runtimeConfig });
    const ownedReport = await standalone.cleanupAsync();
    expect(ownedReport.pool).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0, limit: 3 } });

    const pool = new WorkerPool({ initialSize: 0, maxSize: 1 });
    const borrowed = new AppManager({} as any, { runtimeConfig, workerPool: pool });
    const borrowedReport = await borrowed.cleanupAsync();
    expect(borrowedReport.pool).toMatchObject({ ownership: 'not-owned', report: null });
    expect(pool.getReport()).toMatchObject({ state: 'open', limit: 1, total: 0 });
    await pool.destroy();
});
