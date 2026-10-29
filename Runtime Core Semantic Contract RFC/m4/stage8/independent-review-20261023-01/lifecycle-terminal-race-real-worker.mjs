import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { AppWorkerHost } = await import(pathToFileURL(resolve('runtime/dist/engine/app/worker-host.js')));

const results = [];
for (const method of ['start', 'open', 'pause', 'resume']) {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    parentPort.on('message', message => {
      if (message.type === 'TERMINATE') return process.exit(0);
      parentPort.postMessage({
        type: message.type === 'INIT' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE',
        requestId: message.requestId, success: true,
      });
    });
  `, { eval: true });
  const host = new AppWorkerHost({
    appId: 'review_app', desktopId: 'review_desktop', appModulePath: 'not-loaded',
    existingWorker: worker, timeout: 2000,
  });
  host.status = 'running';
  // start() binds its listeners synchronously. Attach external observers only
  // after starting the operation but before the asynchronous response arrives.
  const operation = host[method]();
  const actualExit = new Promise(resolve => worker.once('exit', resolve));
  let atTermination;
  // Host resolves the transport first; a later caller listener then terminates
  // the real Worker BEFORE the lifecycle Promise continuation can run.
  worker.once('message', () => {
    host.terminate();
    atTermination = host.getStatus();
  });
  const result = await operation.then(
    () => 'resolved', error => 'rejected: ' + error.message,
  );
  const afterContinuation = host.getStatus();
  await actualExit;
  const row = { method, realWorker: true, atTermination, afterContinuation,
    workerIsNull: host.worker === null, result,
    violated: afterContinuation !== 'closed' || result === 'resolved' };
  results.push(row);
  console.log(JSON.stringify(row));
  host.terminate();
}
console.log('REAL_WORKER_VIOLATIONS=' + results.filter(r => r.violated).length + '/' + results.length);
assert.equal(results.filter(r => r.violated).length, 0,
  'Real Worker termination must invalidate the resolved-but-not-resumed lifecycle continuation');
