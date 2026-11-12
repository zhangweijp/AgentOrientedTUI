import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { buildAoappManifest, writeAoappManifest } from './generate-aoapp.mjs';

test('buildAoappManifest derives aoapp.json from the configured built entry and its metadata', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aotui-generate-aoapp-'));

  try {
    await mkdir(path.join(tempDir, 'dist'), { recursive: true });

    await writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify(
        {
          name: '@agentina/system-ide',
          version: '1.2.3',
          description: 'IDE app',
          main: './dist/custom.js',
          types: './dist/index.d.ts',
        },
        null,
        2
      )
    );

    await writeFile(
      path.join(tempDir, 'dist/custom.js'),
      `
      export default {
        toolAuthoringProtocol: 'view-type-tools-v4',
        displayName: 'system_ide',
        persistenceSupport: 'state-session-v1',
        appLifecycleSupport: 'app-lifecycle-v2',
        initialize() {},
        kernelConfig: {
          appName: 'system_ide',
          description: 'IDE app',
          whatItIs: 'IDE',
          whenToUse: 'Use for code work'
        }
      };
      `
    );

    const manifest = await buildAoappManifest(tempDir);

    assert.equal(manifest.app_name, 'system_ide');
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.description, 'IDE app');
    assert.deepEqual(manifest.entry, {
      main: './dist/custom.js',
      types: './dist/index.d.ts',
    });
    assert.equal('name' in manifest, false);
    assert.equal('displayName' in manifest, false);

    await writeAoappManifest(tempDir, manifest);
    const written = JSON.parse(await readFile(path.join(tempDir, 'aoapp.json'), 'utf-8'));
    assert.equal(written.app_name, 'system_ide');
    assert.equal(written.version, '1.2.3');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('buildAoappManifest rejects the retired manifest/create factory shape', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aotui-generate-aoapp-'));

  try {
    await mkdir(path.join(tempDir, 'dist'), { recursive: true });
    await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'old-app' }));
    await writeFile(
      path.join(tempDir, 'dist/index.js'),
      `export default { manifest: { app_name: 'old_app', version: '1.0.0', entry: { main: './dist/index.js' } }, create() {} };`,
    );

    await assert.rejects(buildAoappManifest(tempDir), { code: 'APP_INVALID_EXPORT' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('buildAoappManifest rejects a kernelConfig-shaped non-factory export', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aotui-generate-aoapp-'));

  try {
    await mkdir(path.join(tempDir, 'dist'), { recursive: true });
    await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'incomplete-app' }));
    await writeFile(
      path.join(tempDir, 'dist/index.js'),
      `export default { displayName: 'incomplete_app', persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', toolAuthoringProtocol: 'view-type-tools-v4', kernelConfig: { appName: 'incomplete_app' } };`,
    );

    await assert.rejects(buildAoappManifest(tempDir), { code: 'APP_INVALID_EXPORT' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('buildAoappManifest rejects named and nested factories instead of resolving a fallback export', async () => {
  for (const source of [
      `const f = { displayName: 'named_app', persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', toolAuthoringProtocol: 'view-type-tools-v4', kernelConfig: { appName: 'named_app' }, initialize() {} }; export const factory = f;`,
    `export default { factory: { displayName: 'nested_app', persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', toolAuthoringProtocol: 'view-type-tools-v4', kernelConfig: { appName: 'nested_app' }, initialize() {} } };`,
  ]) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aotui-generate-aoapp-'));

    try {
      await mkdir(path.join(tempDir, 'dist'), { recursive: true });
      await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'alternate-export' }));
      await writeFile(path.join(tempDir, 'dist/index.js'), source);

      await assert.rejects(buildAoappManifest(tempDir), { code: 'APP_INVALID_EXPORT' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test('buildAoappManifest requires a nonempty displayName and appName on the default factory', async () => {
  for (const [displayName, appName, expectedError] of [
    ['', 'missing_display', { code: 'APP_INVALID_EXPORT' }],
    ['missing_app', '', { code: 'APP_INVALID_EXPORT' }],
  ]) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aotui-generate-aoapp-'));

    try {
      await mkdir(path.join(tempDir, 'dist'), { recursive: true });
      await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'invalid-metadata' }));
      await writeFile(path.join(tempDir, 'dist/index.js'),
      `export default { displayName: ${JSON.stringify(displayName)}, persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', toolAuthoringProtocol: 'view-type-tools-v4', kernelConfig: { appName: ${JSON.stringify(appName)} }, initialize() {} };`);

      await assert.rejects(buildAoappManifest(tempDir), expectedError);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});
