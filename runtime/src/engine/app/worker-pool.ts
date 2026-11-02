import { Worker } from 'worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WORKER_DEFAULTS, type WorkerPoolConfig as SPIWorkerPoolConfig } from '../../spi/config/index.js';

export interface WorkerPoolConfig extends Partial<SPIWorkerPoolConfig> { workerScript?: string }
export interface WorkerPoolReport {
    readonly state: 'open' | 'closing' | 'closed'; readonly limit: number; readonly total: number;
    readonly reserved: number; readonly idle: number; readonly leased: number; readonly retiring: number;
    readonly issues: readonly ('WORKER_ERROR' | 'WORKER_TERMINATION_FAILED')[];
}
export interface WorkerLeaseReleaseReport {
    readonly disposition: 'pooled' | 'exited';
    readonly issue?: 'WORKER_ERROR' | 'WORKER_EXITED_UNEXPECTEDLY' | 'WORKER_TERMINATION_FAILED';
}
export interface WorkerLease { readonly worker: Worker; release(healthy?: boolean): Promise<WorkerLeaseReleaseReport> }
const defaultScript = resolve(dirname(fileURLToPath(import.meta.url)), '../../worker-runtime/index.js');
const error = (code: 'CONFIG_INVALID' | 'WORKER_POOL_CLOSED' | 'WORKER_POOL_CAPACITY_EXCEEDED' | 'WORKER_CREATE_FAILED') => Object.assign(new Error(code), { code });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;const promise = new Promise<T>((yes, no) => { resolve = yes;reject = no; });return { promise, resolve, reject }; };
type Slot = {
    script: string; state: 'reserved' | 'idle' | 'leased' | 'retiring'; worker?: Worker;
    exit: ReturnType<typeof deferred<void>>; exited: boolean; expectedExit: boolean; replacing: boolean;
    token?: object; timer?: ReturnType<typeof setTimeout>; issue?: WorkerLeaseReleaseReport['issue'];
};

/** One owner, bounded physical slots, and one immutable capability per checkout. Construction is cold. */
export class WorkerPool {
    private readonly config: Required<WorkerPoolConfig>;
    private readonly slots = new Set<Slot>();
    private state: WorkerPoolReport['state'] = 'open';
    private readonly issues = new Set<'WORKER_ERROR' | 'WORKER_TERMINATION_FAILED'>();
    private warmupCompletion?: ReturnType<typeof deferred<void>>;
    private destroyCompletion?: ReturnType<typeof deferred<WorkerPoolReport>>;
    constructor(config: WorkerPoolConfig = {}) {
        if (!config || typeof config !== 'object' || config.workerScript !== undefined && typeof config.workerScript !== 'string') throw error('CONFIG_INVALID');
        this.config = { ...WORKER_DEFAULTS.pool, ...config, workerScript: config.workerScript || defaultScript };
        const c = this.config;
        if (!Number.isSafeInteger(c.initialSize) || c.initialSize < 0 || c.initialSize > 100 ||
            !Number.isSafeInteger(c.maxSize) || c.maxSize < 1 || c.maxSize > 100 || c.initialSize > c.maxSize ||
            !Number.isSafeInteger(c.idleTimeoutMs) || c.idleTimeoutMs < 5000 || c.idleTimeoutMs > 600000 || typeof c.workerScript !== 'string') throw error('CONFIG_INVALID');
    }
    getReport(): WorkerPoolReport {
        const count = (state: Slot['state']) => [...this.slots].filter(s => s.state === state).length;
        return Object.freeze({ state: this.state, limit: this.config.maxSize, total: this.slots.size,
            reserved: count('reserved'), idle: count('idle'), leased: count('leased'), retiring: count('retiring'), issues: Object.freeze([...this.issues]) });
    }
    private path(script?: string): string { return resolve(script || this.config.workerScript); }
    private cancelTimer(slot: Slot): void { if (slot.timer) clearTimeout(slot.timer);slot.timer = undefined; }
    private checkDestroyed(): void {
        if (this.state === 'closing' && this.slots.size === 0) { this.state = 'closed';this.destroyCompletion!.resolve(this.getReport()); }
    }
    private makeIdle(slot: Slot): void {
        slot.state = 'idle';this.cancelTimer(slot);
        const token = slot.token;
        const timer = setTimeout(() => {
            if (slot.timer !== timer || !this.slots.has(slot) || slot.state !== 'idle' || slot.token !== token) return;
            slot.timer = undefined;this.retire(slot);
        }, this.config.idleTimeoutMs);
        slot.timer = timer;timer.unref();
    }
    private create(script: string, reservation?: Slot): Slot {
        if (this.state !== 'open') throw error('WORKER_POOL_CLOSED');
        if (!reservation && this.slots.size >= this.config.maxSize) throw error('WORKER_POOL_CAPACITY_EXCEEDED');
        const slot: Slot = reservation ?? { script, state: 'reserved', exit: deferred<void>(), exited: false, expectedExit: false, replacing: false };
        Object.assign(slot, { script, state: 'reserved', exit: deferred<void>(), exited: false, expectedExit: false, replacing: false, token: undefined, issue: undefined });
        this.slots.add(slot);
        let worker: Worker;
        try { worker = new Worker(script, { workerData: {} }); }
        catch { this.slots.delete(slot);this.checkDestroyed();throw error('WORKER_CREATE_FAILED'); }
        slot.worker = worker;
        const onError = () => { if (slot.worker !== worker || slot.exited) return;slot.issue = 'WORKER_ERROR';this.issues.add('WORKER_ERROR');if (slot.state === 'idle') this.retire(slot); };
        const onExit = () => {
            if (slot.worker !== worker || slot.exited) return;
            this.cancelTimer(slot);slot.exited = true;
            if (!slot.expectedExit) slot.issue ??= 'WORKER_EXITED_UNEXPECTEDLY';
            worker.off('error', onError);
            if (slot.replacing && this.state === 'open') { slot.state = 'reserved';slot.worker = undefined; }
            else this.slots.delete(slot);
            slot.exit.resolve();this.checkDestroyed();
        };
        worker.on('error', onError);worker.once('exit', onExit);
        if (this.state === 'open') this.makeIdle(slot);else this.retire(slot);
        return slot;
    }
    private retire(slot: Slot): void {
        if (slot.exited || slot.state === 'retiring') return;
        this.cancelTimer(slot);slot.state = 'retiring';slot.expectedExit = true;
        try { void Promise.resolve(slot.worker!.terminate()).catch(() => { slot.issue = 'WORKER_TERMINATION_FAILED';this.issues.add('WORKER_TERMINATION_FAILED'); }); }
        catch { slot.issue = 'WORKER_TERMINATION_FAILED';this.issues.add('WORKER_TERMINATION_FAILED'); }
    }
    private beginWarmup(script: string): Promise<void> {
        if (this.warmupCompletion) return this.warmupCompletion.promise;
        const completion = this.warmupCompletion = deferred<void>();void completion.promise.catch(() => {});
        try {
            for (let i = this.slots.size; i < this.config.initialSize; i++) this.create(script);
            completion.resolve();
        } catch (failure) { completion.reject(failure); }
        return completion.promise;
    }
    acquireLease(scriptPath?: string): Promise<WorkerLease> {
        if (this.state !== 'open') return Promise.reject(error('WORKER_POOL_CLOSED'));
        const script = this.path(scriptPath), first = !this.warmupCompletion;
        if (first) return this.beginWarmup(script).then(() => this.acquireReady(script));
        return this.acquireReady(script);
    }
    private acquireReady(script: string): Promise<WorkerLease> {
        if (this.state !== 'open') return Promise.reject(error('WORKER_POOL_CLOSED'));
        let slot = [...this.slots].find(s => s.state === 'idle' && s.script === script);
        if (!slot && this.slots.size < this.config.maxSize) {
            try { slot = this.create(script); } catch (failure) { return Promise.reject(failure); }
        }
        if (!slot) {
            const wrong = [...this.slots].find(s => s.state === 'idle');
            if (!wrong) return Promise.reject(error('WORKER_POOL_CAPACITY_EXCEEDED'));
            wrong.replacing = true;this.retire(wrong);
            return wrong.exit.promise.then(() => {
                if (this.state !== 'open') throw error('WORKER_POOL_CLOSED');
                const created = this.create(script, wrong);return this.checkout(created);
            });
        }
        return Promise.resolve(this.checkout(slot));
    }
    private checkout(slot: Slot): WorkerLease {
        this.cancelTimer(slot);slot.state = 'leased';const token = Object.freeze({});slot.token = token;
        let completion: Promise<WorkerLeaseReleaseReport> | undefined;
        const result = (disposition: 'pooled' | 'exited'): WorkerLeaseReleaseReport => Object.freeze({ disposition, ...(slot.issue ? { issue: slot.issue } : {}) });
        return Object.freeze({ worker: slot.worker!, release: (healthy = true) => {
            if (completion) return completion;
            const done = deferred<WorkerLeaseReleaseReport>();completion = done.promise;
            if (slot.exited) done.resolve(result('exited'));
            else if (healthy === true && this.state === 'open' && !slot.issue && slot.token === token) { this.makeIdle(slot);done.resolve(result('pooled')); }
            else { this.retire(slot);void slot.exit.promise.then(() => done.resolve(result('exited'))); }
            return completion;
        } });
    }
    destroy(): Promise<WorkerPoolReport> {
        if (this.destroyCompletion) return this.destroyCompletion.promise;
        this.destroyCompletion = deferred<WorkerPoolReport>();this.state = 'closing';
        for (const slot of this.slots) { this.cancelTimer(slot);if (slot.state === 'reserved' && slot.exited) this.slots.delete(slot);else if (slot.state !== 'leased') this.retire(slot); }
        this.checkDestroyed();return this.destroyCompletion.promise;
    }
}
