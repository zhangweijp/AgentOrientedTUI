import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { APP_LIFECYCLE_PROTOCOL, VIEW_TYPE_TOOL_PROTOCOL } from '@aotui/core';
import { buildAoappManifest, writeAoappManifest } from '../sdk/bin/generate-aoapp.mjs';

async function fixture(t, fields = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aotui-generate-aoapp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3',
    description: 'IDE app', main: './dist/custom.mjs', types: './dist/index.d.ts',
    aotui: { app_name: 'system_ide', whatItIs: 'IDE', whenToUse: 'Use for code work' }, ...fields }));
  await writeFile(join(directory, 'dist/index.d.ts'), 'export {};');
  await writeFile(join(directory, 'dist/custom.mjs'), 'throw new Error("Manifest generation executed the entry");');
  return directory;
}

test('generates the manifest from package.json without executing the App entry', async t => {
  const directory = await fixture(t);
  const manifest = await buildAoappManifest(directory);
  assert.deepEqual(manifest, { app_name: 'system_ide', description: 'IDE app', whatItIs: 'IDE', whenToUse: 'Use for code work',
    version: '1.2.3', entry: { main: './dist/custom.mjs', types: './dist/index.d.ts' },
    toolAuthoringProtocol: VIEW_TYPE_TOOL_PROTOCOL, appLifecycleSupport: APP_LIFECYCLE_PROTOCOL });
  await writeAoappManifest(directory, manifest);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'aoapp.json'), 'utf8')), manifest);
});

test('omits optional metadata and types when not declared', async t => {
  const directory = await fixture(t, { aotui: { app_name: 'system_ide' }, types: undefined });
  const manifest = await buildAoappManifest(directory);
  assert.equal('persistenceSupport' in manifest, false);
  assert.deepEqual(manifest.entry, { main: './dist/custom.mjs' });
});

for (const [fields, field] of [
  [{ aotui: undefined }, 'aotui'],
  [{ main: './dist/missing.mjs' }, 'main'],
  [{ types: './dist' }, 'types'],
  [{ version: '' }, 'version'],
]) test(`rejects invalid ${field} in package.json`, async t => {
  await assert.rejects(buildAoappManifest(await fixture(t, fields)), { code: 'APP_MANIFEST_INVALID', path: field });
});
