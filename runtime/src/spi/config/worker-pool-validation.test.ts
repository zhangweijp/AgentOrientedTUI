import { expect, it } from 'vitest';
import { defineRuntimeConfig, WORKER_DEFAULTS } from './index.js';
import { WorkerPool } from '../../engine/app/worker-pool.js';
it('C1-01 both entry points enforce existing safe-integer ranges and initial<=max', async () => {
    const valid = { initialSize: 0, maxSize: 1, idleTimeoutMs: 5000 };
    for (const [field, values] of Object.entries({ initialSize: [-1, 101, NaN, Infinity, 0.5, '1'], maxSize: [0, -1, 101, NaN, Infinity, 1.5, '2'], idleTimeoutMs: [0, 4999, 600001, NaN, Infinity, 5000.5, '5000'] })) {
        for (const value of values) {
            const pool = { ...valid, [field]: value };
            expect(() => new WorkerPool(pool as any)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
            expect(() => defineRuntimeConfig({ worker: { pool } } as any)).toThrow();
        }
    }
    expect(() => new WorkerPool({ ...valid, initialSize: 2 })).toThrow();expect(() => defineRuntimeConfig({ worker: { pool: { ...valid, initialSize: 2 } } })).toThrow();
    for (const pool of [valid, { initialSize: 100, maxSize: 100, idleTimeoutMs: 600000 }, { initialSize: 2, maxSize: 10, idleTimeoutMs: 60000 }]) {
        expect(defineRuntimeConfig({ worker: { pool } }).worker.pool).toEqual(pool);const object = new WorkerPool(pool);expect(object.getReport()).toMatchObject({ total: 0, limit: pool.maxSize });await object.destroy();
    }
    expect(defineRuntimeConfig().worker).toEqual(WORKER_DEFAULTS);
});
