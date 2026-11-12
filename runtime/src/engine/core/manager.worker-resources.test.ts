import { expect, it } from 'vitest';
import { createRuntime } from '../../facades/facades.js';
import { defineRuntimeConfig } from '../../spi/config/index.js';
import { AppManager } from '../app/manager.js';
import { WorkerCapacity } from '../app/worker-capacity.js';

it('C1-01/08 actual createRuntime owners are cold, independent, and shared only across their own Desktops', async () => {
    const a = createRuntime({ worker: { maxWorkers: 2 } }) as any;
    const b = createRuntime({ worker: { maxWorkers: 1 } }) as any;
    const ma = a.desktopManager, mb = b.desktopManager;
    expect(ma.workerCapacity).not.toBe(mb.workerCapacity);
    const first = await a.createDesktop(), second = await a.createDesktop();
    for (const id of [first, second]) {
        const apps = ma.get(id).appManager;
        expect(apps.workerCapacity).toBe(ma.workerCapacity);
        expect(apps.options.runtimeConfig).toBe(ma.config);
    }

    const reportA = await a.beginShutdown().completion;
    const reportB = await b.beginShutdown().completion;
    expect(reportA.workers).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0, limit: 2 } });
    expect(reportB.workers).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0, limit: 1 } });
});

it('C1-01 standalone AppManager closes only its owned pool and leaves a borrowed pool to its owner', async () => {
    const runtimeConfig = defineRuntimeConfig({ worker: { maxWorkers: 3, timeoutMs: 1234 } });
    const standalone = new AppManager({} as any, { runtimeConfig });
    const ownedReport = await standalone.cleanupAsync();
    expect(ownedReport.workers).toMatchObject({ ownership: 'owned', report: { state: 'closed', total: 0, limit: 3 } });

    const capacity = new WorkerCapacity(1);
    const borrowed = new AppManager({} as any, { runtimeConfig, workerCapacity: capacity });
    const borrowedReport = await borrowed.cleanupAsync();
    expect(borrowedReport.workers).toMatchObject({ ownership: 'not-owned', report: null });
    expect(capacity.getReport()).toMatchObject({ state: 'open', limit: 1, total: 0 });
    await capacity.close();
});
