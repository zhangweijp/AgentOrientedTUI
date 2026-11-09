import assert from 'node:assert/strict';
import { realpath, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const specs = ['@aotui/sdk', '@aotui/sdk/tools', '@aotui/runtime/core', '@aotui/runtime/spi', '@aotui/agent-driver-v2'];
const resolutions = {};
for (const spec of specs) resolutions[spec] = await realpath(fileURLToPath(import.meta.resolve(spec)));
const sdkParent = import.meta.resolve('@aotui/sdk');
const runtimeParent = import.meta.resolve('@aotui/runtime/core');
resolutions.sdkRuntimeCore = await realpath(fileURLToPath(import.meta.resolve('@aotui/runtime/core', sdkParent)));
resolutions.sdkRuntimeSpi = await realpath(fileURLToPath(import.meta.resolve('@aotui/runtime/spi', sdkParent)));
resolutions.runtimeDriver = await realpath(fileURLToPath(import.meta.resolve('@aotui/agent-driver-v2', runtimeParent)));
assert.equal(resolutions.sdkRuntimeCore, resolutions['@aotui/runtime/core']);
assert.equal(resolutions.sdkRuntimeSpi, resolutions['@aotui/runtime/spi']);
assert.equal(resolutions.runtimeDriver, resolutions['@aotui/agent-driver-v2']);
const packages = {};
for (const name of ['@aotui/sdk', '@aotui/runtime', '@aotui/agent-driver-v2']) {
  const root = await realpath(new URL('../node_modules/' + name, import.meta.url));
  const pkg = JSON.parse(await readFile(root + '/package.json', 'utf8'));
  packages[name] = { root, name: pkg.name, version: pkg.version };
  assert.ok(root.includes('/consumer/node_modules/.pnpm/'));
}
assert.equal(packages['@aotui/sdk'].version, '0.4.0-srt01-m4.3');
assert.equal(packages['@aotui/runtime'].version, '3.0.0');
assert.equal(packages['@aotui/agent-driver-v2'].version, '0.3.0');
const facts = { packages, resolutions, transitiveIdentity: 'passed', workspaceSymlinks: false, sourceAliases: false };
await writeFile(new URL('../results/installed-identity.json', import.meta.url), JSON.stringify(facts, null, 2) + '\n');
console.log(JSON.stringify(facts, null, 2));
