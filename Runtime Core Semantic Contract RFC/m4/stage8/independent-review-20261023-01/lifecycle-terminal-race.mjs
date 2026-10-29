import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { AppWorkerHost } = await import(pathToFileURL(resolve('runtime/dist/engine/app/worker-host.js')));

// Tests the real Host's sendRequest/handleMessage path. Only the OS Worker
// transport is an EventEmitter, to control response vs microtask ordering.
const cases = [];
for (const method of ['start', 'open', 'pause', 'resume', 'reinitialize']) {
  for (const terminal of ['terminate', 'exit']) {
    const sent = [];
    const worker = Object.assign(new EventEmitter(), {
      postMessage(message) { sent.push(message); },
      terminate() { return Promise.resolve(0); },
    });
    const host = new AppWorkerHost({
      appId: 'review_app', desktopId: 'review_desktop', appModulePath: 'not-loaded',
      existingWorker: worker, timeout: 1000,
    });
    host.status = 'running';
    const pending = host[method]().then(
      () => ({ kind: 'resolved' }),
      error => ({ kind: 'rejected', message: String(error.message) }),
    );
    const request = sent[0];
    assert.ok(request?.requestId);
    // Fulfil the actual transport Promise but do NOT let its continuation run.
    worker.emit('message', {
      type: method === 'start' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE',
      requestId: request.requestId, success: true,
    });
    if (terminal === 'terminate') host.terminate();
    else worker.emit('exit', 0);
    const atTermination = host.getStatus();
    const result = await pending;
    const afterContinuation = host.getStatus();
    const row = { method, terminal, atTermination, afterContinuation,
      workerIsNull: host.worker === null, lifecyclePromise: result.kind,
      violated: afterContinuation !== atTermination || result.kind !== 'rejected' };
    cases.push(row);
    console.log(JSON.stringify(row));
    host.terminate();
  }
}
const violations = cases.filter(row => row.violated);
console.log('REVIEW_ASSERTION: terminal Host must not revive, and invalidated lifecycle must reject');
console.log('VIOLATIONS=' + violations.length + '/' + cases.length);
assert.equal(violations.length, 0, 'Terminal lifecycle invariant violated by fulfilled transport continuation');
