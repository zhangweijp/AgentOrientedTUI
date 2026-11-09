import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { IDESession } from '../dist/core/ide-session.js';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function main() {
  const session = new IDESession({}, {
    sessionKey: 'workspace-create-close-test',
    historyPath: path.join(os.tmpdir(), 'aotui-workspace-create-close-test.jsonl'),
  }, () => {});
  session.ready = true;
  session.roots = [{
    path: '/work', identity: 'root',
    creator: async () => ({ status: 'succeeded', value: { filePath: '/work/new.txt', bytesWritten: 4 } }),
  }];

  const refreshEntered = deferred();
  const releaseRefresh = deferred();
  session.readTree = async (_roots, _expanded, guard) => {
    refreshEntered.resolve();
    await releaseRefresh.promise;
    guard();
    return new Map();
  };

  const createFile = session.createWorkspaceFile('/work', 'new.txt', 'body');
  await refreshEntered.promise;
  let closeFinished = false;
  const closing = session.close().then(() => { closeFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closeFinished, false, 'close must await the create-and-refresh call');

  releaseRefresh.resolve();
  await closing;
  const result = await createFile;
  assert.equal(result.success, true, 'the already-created file remains a success');
  assert.equal(result.data.filePath, '/work/new.txt');
  assert.equal(result.data.workspaceRefreshWarning, 'WORKSPACE_TREE_REFRESH_FAILED');
  assert.equal(session.inspect().pending, 0);
  console.log('workspace create/close lifecycle: 1 passed');
}

await main();
