import { expect, it } from 'vitest';
import { WorkerCapacity } from './worker-capacity.js';

it('bounds physical admission and closes only after every reserved slot is released', async () => {
    const capacity = new WorkerCapacity(2);
    expect(capacity.getReport()).toEqual({ state: 'open', limit: 2, total: 0 });
    const releaseFirst = capacity.reserve();
    const releaseSecond = capacity.reserve();
    expect(() => capacity.reserve()).toThrow(expect.objectContaining({ code: 'WORKER_CAPACITY_EXCEEDED' }));

    const closing = capacity.close();
    expect(capacity.close()).toBe(closing);
    expect(() => capacity.reserve()).toThrow(expect.objectContaining({ code: 'WORKER_CAPACITY_CLOSED' }));
    releaseFirst();
    releaseFirst();
    expect(capacity.getReport()).toEqual({ state: 'closing', limit: 2, total: 1 });
    releaseSecond();
    await closing;
    expect(capacity.getReport()).toEqual({ state: 'closed', limit: 2, total: 0 });
    expect(Object.isFrozen(capacity.getReport())).toBe(true);
});

it('a late release cannot decrement the slot of a later App instance', () => {
    const capacity = new WorkerCapacity(1);
    const old = capacity.reserve();
    old();
    const current = capacity.reserve();
    old();
    expect(capacity.getReport().total).toBe(1);
    current();
    expect(capacity.getReport().total).toBe(0);
});
