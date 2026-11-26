import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { ExecutionConnection, TransportEvents } from './execution-transport.js';
import type { WorkerToMainMessage } from '../spi/worker-protocol/index.js';

const claimedWorkers = new WeakSet<Worker>();

export function connectNodeWorker(worker: Worker, emit: TransportEvents): ExecutionConnection {
    if (claimedWorkers.has(worker))
        throw Object.assign(new Error('Create a new Worker for each App execution'), { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' });
    claimedWorkers.add(worker);
    let exited = false;
    const message = (message: WorkerToMainMessage) => { if (!exited) emit({ kind: 'message', message }); };
    const error = (error: Error) => { if (!exited) emit({ kind: 'error', error }); };
    const finish = (code?: number) => {
        if (exited) return;
        exited = true;
        worker.off('message', message);
        worker.off('error', error);
        worker.off('exit', finish);
        emit({ kind: 'channelEnded' });
        emit({ kind: 'exited', ...(code ? { issue: { code: 'WORKER_EXITED_UNEXPECTEDLY', message: 'The Worker exited with code ' + code } } : {}) });
    };
    worker.on('message', message);
    worker.on('error', error);
    worker.once('exit', finish);
    if (worker.threadId < 0) finish();
    return { transport: worker, terminate() {
        const termination = Promise.resolve(worker.terminate());
        void termination.then(finish, () => {});
        return termination;
    } };
}

export function startNodeWorker(script: string | undefined,
    workerData: { appId: string; desktopId: string; appModulePath: string }, emit: TransportEvents): ExecutionConnection {
    const filename = script === undefined ? fileURLToPath(new URL('../worker-runtime/index.js', import.meta.url)) : resolve(script);
    return connectNodeWorker(new Worker(filename, { workerData }), emit);
}
