export interface WorkerConfig {
    /** Worker RPC timeout and graceful close budget, 1000–300000 ms. */
    readonly timeoutMs: number;
    /** Maximum simultaneous Worker instances, including those waiting for exit. */
    readonly maxWorkers: number;
}

export const WORKER_DEFAULTS: WorkerConfig = {
    timeoutMs: 30_000,
    maxWorkers: 10,
};
