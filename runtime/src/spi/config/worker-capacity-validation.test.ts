import { expect, it } from 'vitest';
import { defineRuntimeConfig, WORKER_DEFAULTS } from './index.js';
import { WorkerCapacity } from '../../engine/app/worker-capacity.js';

it('enforces the same safe Worker capacity range at both entry points', async () => {
    for (const value of [0, -1, 101, NaN, Infinity, 1.5, '2']) {
        expect(() => new WorkerCapacity(value as number)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
        expect(() => defineRuntimeConfig({ worker: { maxWorkers: value as number } })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
    for (const limit of [1, 100]) {
        expect(defineRuntimeConfig({ worker: { maxWorkers: limit } }).worker.maxWorkers).toBe(limit);
        const capacity = new WorkerCapacity(limit);
        expect(capacity.getReport()).toEqual({ state: 'open', limit, total: 0 });
        await capacity.close();
    }
    expect(defineRuntimeConfig().worker).toEqual(WORKER_DEFAULTS);
});
