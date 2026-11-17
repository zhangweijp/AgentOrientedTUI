export interface WorkerConfig {
    /** Worker RPC timeout and graceful close budget, 1000–300000 ms. */
    readonly timeoutMs: number;
    /** Maximum simultaneous App Workers, including those waiting for exit. Positive Infinity is unlimited. */
    readonly maxWorkers: number;
}

export const WORKER_DEFAULTS: WorkerConfig = {
    timeoutMs: 30_000,
    maxWorkers: Number.POSITIVE_INFINITY,
};
