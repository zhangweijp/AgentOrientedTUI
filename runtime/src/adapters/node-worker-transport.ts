import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { ExecutionConnection, TransportEvents } from './execution-transport.js';
import type { WorkerToMainMessage } from '../spi/worker-protocol/index.js';

export function connectNodeWorker(worker: Worker, emit: TransportEvents): ExecutionConnection {
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

export function startNodeWorker(emit: TransportEvents): ExecutionConnection {
    const filename = fileURLToPath(new URL('../worker-runtime/index.js', import.meta.url));
    return connectNodeWorker(new Worker(filename), emit);
}
