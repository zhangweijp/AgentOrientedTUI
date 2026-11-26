import { Worker } from 'node:worker_threads';
import { normalizeProjectionLimits } from '@aotui/core';
import { connectNodeWorker } from '../../../adapters/node-worker-transport.js';
import type { TransportEvents } from '../../../adapters/execution-transport.js';
import { RUNTIME_DEFAULTS } from '../../../spi/config/index.js';
import type { AppWorkerHost, AppWorkerHostConfig } from '../worker-host.js';

/** A fixture can control the real Node transport without adding a production launch mode. */
export function fixtureHost<T extends AppWorkerHost>(
    Host: new (options: AppWorkerHostConfig) => T,
    options: Omit<AppWorkerHostConfig, 'toolsEnabled' | 'projectionLimits'> & {
        toolsEnabled?: boolean;
        projectionLimits?: Parameters<typeof normalizeProjectionLimits>[0];
    },
    { worker, script, timeoutMs, attach = false }: { worker?: Worker; script?: string; timeoutMs?: number; attach?: boolean } = {},
): T {
    const host = new Host({
        ...options,
        toolsEnabled: options.toolsEnabled !== false,
        projectionLimits: normalizeProjectionLimits(options.projectionLimits),
        runtimeConfig: options.runtimeConfig ?? { worker: { ...RUNTIME_DEFAULTS.worker, timeoutMs: timeoutMs ?? RUNTIME_DEFAULTS.worker.timeoutMs } },
    });
    const internals = host as unknown as {
        startExecution: (emit: TransportEvents) => ReturnType<typeof connectNodeWorker>;
        bindExecution: (start: (emit: TransportEvents) => ReturnType<typeof connectNodeWorker>) => void;
    };
    if (worker || script) {
        const start = (emit: TransportEvents) => connectNodeWorker(worker ?? new Worker(script!), emit);
        if (attach) internals.bindExecution(start);
        else internals.startExecution = start;
    }
    return host;
}

// Transport tests assert the actual committed Core state and capture wire frames separately.
export function committedState(host: AppWorkerHost) {
    return host['snapshotReceiver']['core'].store.readLatest(host.appId);
}

export function committedSnapshot(host: AppWorkerHost) {
    const state = committedState(host);
    if (state.status !== 'ready') throw new Error('Expected a ready snapshot, received ' + state.status);
    return state.snapshot;
}
