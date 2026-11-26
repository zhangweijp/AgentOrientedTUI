export interface WorkerConfig {
    /** Execution request timeout and App graceful close budget, 1000–300000 ms. */
    readonly timeoutMs: number;
    /** Maximum simultaneous App executions across all backends, including those waiting for exit. */
    readonly maxWorkers: number;
}

export const WORKER_DEFAULTS: WorkerConfig = {
    timeoutMs: 30_000,
    maxWorkers: Number.POSITIVE_INFINITY,
};
