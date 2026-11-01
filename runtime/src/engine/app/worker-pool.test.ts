import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({ workers: [] as any[], attempts: 0, failAt: 0 }));
vi.mock('worker_threads', async () => {
    const { EventEmitter } = await import('node:events');
    return { Worker: class extends EventEmitter {
        threadId: number;terminate = vi.fn(() => Promise.resolve(0));
        constructor(readonly script: string) { super();if (++control.attempts === control.failAt) throw Error('private constructor');this.threadId = control.attempts;control.workers.push(this); }
        exit() { this.threadId = -1;this.emit('exit', 0); }
    } };
});
import { WorkerPool } from './worker-pool.js';
const pool = (extra = {}) => new WorkerPool({ initialSize: 0, maxSize: 1, idleTimeoutMs: 5000, workerScript: '/a.cjs', ...extra });
beforeEach(() => { control.workers = [];control.attempts = 0;control.failAt = 0; });
afterEach(() => { for (const worker of control.workers) if (worker.threadId >= 0) worker.exit();vi.useRealTimers();vi.restoreAllMocks(); });
it('C1-02/03/07 cold, bounded and immutable checkout capabilities; old release cannot affect the next lease', async () => {
    const p = pool();expect(control.attempts).toBe(0);const a = await p.acquireLease();const worker: any = a.worker;
    expect(Object.isFrozen(a)).toBe(true);await expect(p.acquireLease()).rejects.toMatchObject({ code: 'WORKER_POOL_CAPACITY_EXCEEDED' });expect(control.attempts).toBe(1);
    const returned = a.release();expect(a.release(false)).toBe(returned);expect(await returned).toEqual({ disposition: 'pooled' });
    const b = await p.acquireLease();expect(b.worker).toBe(a.worker);expect(b).not.toBe(a);expect(a.release(false)).toBe(returned);expect(worker.terminate).not.toHaveBeenCalled();
    const closing = p.destroy();expect(p.destroy()).toBe(closing);expect(worker.terminate).not.toHaveBeenCalled();
    await expect(p.acquireLease()).rejects.toMatchObject({ code: 'WORKER_POOL_CLOSED' });
    const exiting = b.release();expect(worker.terminate).toHaveBeenCalledTimes(1);await Promise.resolve();expect(p.getReport()).toMatchObject({ state: 'closing', total: 1, retiring: 1 });
    worker.exit();expect(await exiting).toEqual({ disposition: 'exited' });expect(await closing).toMatchObject({ state: 'closed', total: 0 });
});
it('C1-04 wrong-script replacement reserves one slot until actual exit, and has no extra wait queue', async () => {
    const p = pool(), a = await p.acquireLease('/a.cjs');await a.release();
    const replacement = p.acquireLease('/b.cjs'), old: any = a.worker;
    expect(p.getReport()).toMatchObject({ total: 1, retiring: 1 });expect(control.attempts).toBe(1);
    await expect(p.acquireLease('/c.cjs')).rejects.toMatchObject({ code: 'WORKER_POOL_CAPACITY_EXCEEDED' });
    old.exit();const b = await replacement;expect((b.worker as any).script).toBe('/b.cjs');expect(control.attempts).toBe(2);
    const oldResult = await a.release(false);expect(oldResult.disposition).toBe('pooled');expect((b.worker as any).terminate).not.toHaveBeenCalled();
    const close = p.destroy(), returned = b.release();(b.worker as any).exit();await returned;await close;
});
it('C1-04 destroy during the exit/replace handoff cancels creation and frees the reservation', async () => {
    const p = pool(), a = await p.acquireLease();await a.release();const pending = p.acquireLease('/b.cjs');
    let closing!: ReturnType<typeof p.destroy>;(a.worker as any).once('exit', () => { closing = p.destroy(); });
    (a.worker as any).exit();await expect(pending).rejects.toMatchObject({ code: 'WORKER_POOL_CLOSED' });expect(control.attempts).toBe(1);expect((await closing).total).toBe(0);
});
it('C1-05 first checkout includes the initial pool size and retains partial construction for cleanup', async () => {
    const p = pool({ initialSize: 2, maxSize: 3 });const a = await p.acquireLease('/first.cjs');expect(control.attempts).toBe(2);expect(control.workers.every(w => w.script === '/first.cjs')).toBe(true);
    await a.release();const reused = await p.acquireLease('/first.cjs');expect(reused.worker).toBe(a.worker);expect(control.attempts).toBe(2);
    await reused.release();const closing = p.destroy();for (const worker of control.workers) worker.exit();await closing;
    control.failAt = control.attempts + 2;const partial = pool({ initialSize: 2, maxSize: 2 });await expect(partial.acquireLease()).rejects.toMatchObject({ code: 'WORKER_CREATE_FAILED' });
    expect(partial.getReport().total).toBe(1);const done = partial.destroy();control.workers.at(-1).exit();expect((await done).total).toBe(0);
});
it('C1-06 stale timers cannot clear or terminate a later idle generation; all idle may reach zero', async () => {
    vi.useFakeTimers();const timer = vi.spyOn(globalThis, 'setTimeout');const p = pool(), a = await p.acquireLease();await a.release();
    const stale = timer.mock.calls.at(-1)![0] as () => void;const b = await p.acquireLease();stale();expect((a.worker as any).terminate).not.toHaveBeenCalled();
    await b.release();stale();expect(vi.getTimerCount()).toBe(1);await vi.advanceTimersByTimeAsync(5000);
    expect((a.worker as any).terminate).toHaveBeenCalledTimes(1);expect(p.getReport()).toMatchObject({ total: 1, retiring: 1 });
    (a.worker as any).exit();expect(p.getReport().total).toBe(0);expect(vi.getTimerCount()).toBe(0);await p.destroy();
});
it('C1-07 termination rejection is observed, retains capacity, and cannot substitute for actual exit', async () => {
    const p = pool(), lease = await p.acquireLease();const worker: any = lease.worker;
    worker.terminate.mockImplementation(() => Promise.reject(Error('private termination')));const result = lease.release(false);
    await Promise.resolve();expect(p.getReport()).toMatchObject({ total: 1, retiring: 1, issues: ['WORKER_TERMINATION_FAILED'] });
    await expect(p.acquireLease()).rejects.toMatchObject({ code: 'WORKER_POOL_CAPACITY_EXCEEDED' });
    const closed = p.destroy();worker.exit();expect(await result).toMatchObject({ disposition: 'exited', issue: 'WORKER_TERMINATION_FAILED' });
    expect((await closed).state).toBe('closed');expect(JSON.stringify(p.getReport())).not.toContain('private');
});
it('C1-07 actual exit releases quota even for a leased worker, but its old lease only reports its own terminal', async () => {
    const p = pool(), first = await p.acquireLease();(first.worker as any).emit('error', Error('private'));(first.worker as any).exit();
    const second = await p.acquireLease();expect(second.worker).not.toBe(first.worker);expect(await first.release()).toEqual({ disposition: 'exited', issue: 'WORKER_ERROR' });
    expect(p.getReport().leased).toBe(1);const closing = p.destroy();const ended = second.release(false);(second.worker as any).exit();await ended;await closing;
});
it('C1-05 a failed on-demand constructor frees its reserved slot and preserves a fixed failure', async () => {
    control.failAt = 1;const p = pool();await expect(p.acquireLease()).rejects.toMatchObject({ code: 'WORKER_CREATE_FAILED', message: 'WORKER_CREATE_FAILED' });
    expect(p.getReport()).toMatchObject({ total: 0, reserved: 0 });expect((await p.destroy()).state).toBe('closed');
});
it('C1-06/19 idle errors retire once, reports stay finite, and completed checkouts are not retained', async () => {
    const p = pool();let lease = await p.acquireLease();
    for (let i = 0; i < 50; i++) { await lease.release();lease = await p.acquireLease(); }
    expect(p.getReport()).toMatchObject({ total: 1, leased: 1, idle: 0 });await lease.release();
    const worker: any = lease.worker;worker.emit('error', Error('private one'));worker.emit('error', Error('private two'));
    expect(worker.terminate).toHaveBeenCalledTimes(1);const report = p.getReport();expect(report.issues).toEqual(['WORKER_ERROR']);
    expect(Object.isFrozen(report)).toBe(true);expect(Object.isFrozen(report.issues)).toBe(true);
    expect(Object.keys(report)).toEqual(['state', 'limit', 'total', 'reserved', 'idle', 'leased', 'retiring', 'issues']);
    const closing = p.destroy();worker.exit();expect((await closing).total).toBe(0);
});
