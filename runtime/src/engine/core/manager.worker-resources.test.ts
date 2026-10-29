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
    expect(ma.getWorkerPoolReport()).toMatchObject({ state: 'open', total: 0, limit: 2 });
    expect(mb.getWorkerPoolReport()).toMatchObject({ state: 'open', total: 0, limit: 1 });
    const first = await a.createDesktop(), second = await a.createDesktop();
    for (const id of [first, second]) {
        const apps = ma.get(id).appManager;
        expect(apps.workerPool).toBe(ma.workerPool);
        expect(apps.options.runtimeConfig).toBe(ma.config);
        expect(apps.getWorkerPoolReport()).toBeNull();expect(await apps.closeWorkerPool()).toBeNull();
    }
    await ma.closeWorkerPool();expect(mb.getWorkerPoolReport().state).toBe('open');
    await mb.closeWorkerPool();await a.shutdown();await b.shutdown();
});

it('C1-01 standalone AppManager owns a cold pool with construction-time config; injected pool remains borrowed', async () => {
    const runtimeConfig = defineRuntimeConfig({ worker: { pool: { initialSize: 0, maxSize: 3 }, timeoutMs: 1234 } });
    const standalone = new AppManager({} as any, { runtimeConfig });
    expect(standalone.getWorkerPoolReport()).toMatchObject({ limit: 3, total: 0 });
    const pool = new WorkerPool({ initialSize: 0, maxSize: 1 });
    const borrowed = new AppManager({} as any, { runtimeConfig, workerPool: pool });
    expect(borrowed.getWorkerPoolReport()).toBeNull();expect(await borrowed.closeWorkerPool()).toBeNull();
    expect(pool.getReport()).toMatchObject({ state: 'open', limit: 1, total: 0 });
    expect(await standalone.closeWorkerPool()).toMatchObject({ state: 'closed', total: 0 });await pool.destroy();
});
