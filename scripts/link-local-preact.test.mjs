import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { linkLocalPreact } from './link-local-preact.mjs';

const installedPreact = realpathSync(fileURLToPath(new URL('../sdk/node_modules/preact', import.meta.url)));
const importer = `
import * as preact from 'preact';
import * as hooks from 'preact/hooks';
import * as jsx from 'preact/jsx-runtime';
import * as jsxDev from 'preact/jsx-dev-runtime';
export { preact, hooks, jsx, jsxDev };
`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aotui preact links '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sdk = join(directory, 'sdk');
  const app = join(directory, 'app');
  mkdirSync(join(sdk, 'node_modules'), { recursive: true });
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  cpSync(installedPreact, join(sdk, 'node_modules/preact'), { recursive: true });
  cpSync(installedPreact, join(app, 'node_modules/.pnpm/preact/node_modules/preact'), { recursive: true });
  symlinkSync('.pnpm/preact/node_modules/preact', join(app, 'node_modules/preact'), 'dir');
  for (const target of [sdk, app]) {
    writeFileSync(join(target, 'package.json'), JSON.stringify({ type: 'module', dependencies: { preact: '^10.0.0' } }));
    writeFileSync(join(target, 'importer.mjs'), importer);
  }
  return { directory, sdk, app };
}

// Each probe starts a new Worker: Node's resolver/module caches must not hide a
// split installation, or keep a pre-repair instance alive after relinking.
function moduleIdentity(sdk, app) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const [sdk, app] = await Promise.all([import(workerData.sdk), import(workerData.app)]);
        parentPort.postMessage({
          preact: sdk.preact === app.preact,
          options: sdk.preact.options === app.preact.options,
          hooks: sdk.hooks === app.hooks,
          jsx: sdk.jsx === app.jsx,
          jsxDev: sdk.jsxDev === app.jsxDev,
        });
      })().catch(error => { throw error; });
    `, { eval: true, workerData: {
      sdk: pathToFileURL(join(sdk, 'importer.mjs')).href,
      app: pathToFileURL(join(app, 'importer.mjs')).href,
    } });
    let result;
    worker.once('message', value => { result = value; });
    worker.once('error', reject);
    worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error('Identity Worker exited without a result: ' + code)));
  });
}

const unified = { preact: true, options: true, hooks: true, jsx: true, jsxDev: true };
const split = { preact: false, options: false, hooks: false, jsx: false, jsxDev: false };

test('local SDK consumers share Preact and all rendering entry points in a real Worker', async t => {
  const { sdk, app } = fixture(t);
  assert.deepEqual(await moduleIdentity(sdk, app), split);
  linkLocalPreact(app, sdk);
  assert.deepEqual(await moduleIdentity(sdk, app), unified);
  const link = readlinkSync(join(app, 'node_modules/preact'));
  linkLocalPreact(app, sdk);
  assert.equal(readlinkSync(join(app, 'node_modules/preact')), link);
  assert.deepEqual(await moduleIdentity(sdk, app), unified);
});

test('relinking restores shared Preact after a dependency install replaces the link', async t => {
  const { sdk, app } = fixture(t);
  linkLocalPreact(app, sdk);
  rmSync(join(app, 'node_modules/preact'));
  cpSync(installedPreact, join(app, 'node_modules/preact'), { recursive: true });
  assert.deepEqual(await moduleIdentity(sdk, app), split);
  linkLocalPreact(app, sdk);
  assert.deepEqual(await moduleIdentity(sdk, app), unified);
});

test('a missing SDK Preact leaves the consumer installation intact', t => {
  const { sdk, app } = fixture(t);
  const before = realpathSync(join(app, 'node_modules/preact'));
  rmSync(join(sdk, 'node_modules/preact'), { recursive: true });
  assert.throws(() => linkLocalPreact(app, sdk), { code: 'ENOENT' });
  assert.equal(realpathSync(join(app, 'node_modules/preact')), before);
});

test('consumers without Preact do not gain a dependency or require SDK Preact', t => {
  const { directory } = fixture(t);
  const host = join(directory, 'host');
  mkdirSync(host);
  writeFileSync(join(host, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
  linkLocalPreact(host, join(directory, 'missing-sdk'));
  assert.equal(existsSync(join(host, 'node_modules')), false);
});
