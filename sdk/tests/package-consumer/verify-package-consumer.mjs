import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [consumerDirectory, evidence, profile = 'full'] = process.argv.slice(2);
assert.ok(consumerDirectory && evidence, 'Consumer directory and evidence path are required');
assert.ok(['plain', 'full'].includes(profile), 'Select the plain or full package profile');

const consumer = path.resolve(consumerDirectory);
const plain = profile === 'plain';
const output = path.join(consumer, 'package-checks');
const sdkRoot = path.join(consumer, 'node_modules/@aotui/sdk');
const runtimeRoot = path.join(consumer, 'node_modules/@aotui/runtime');
const sdkFixtures = new URL('../fixtures/', import.meta.url);
const runtimeFixtures = new URL('../../../runtime/tests/fixtures/', import.meta.url);
const facts = { consumer, profile, passed: false, commands: [] };

await fs.mkdir(output, { recursive: true });
for (const root of [sdkRoot, runtimeRoot]) {
  await fs.access(path.join(root, 'README.md'));
  await assert.rejects(fs.access(path.join(root, 'docs')), { code: 'ENOENT' });
}
if (plain) {
  const resolve = createRequire(path.join(consumer, 'package.json')).resolve;
  for (const name of ['preact', 'better-sqlite3']) {
    assert.throws(() => resolve(name), { code: 'MODULE_NOT_FOUND' });
  }
}

async function checked(kind, args) {
  const command = [process.execPath, ...args];
  try {
    const result = await execute(process.execPath, args, { cwd: consumer, maxBuffer: 8 * 1024 * 1024 });
    facts.commands.push({ kind, command, exitCode: 0, ...result });
    return result.stdout;
  } catch (error) {
    facts.commands.push({ kind, command, exitCode: error.code, stdout: error.stdout, stderr: error.stderr });
    throw error;
  } finally {
    await fs.writeFile(evidence, JSON.stringify(facts, null, 2) + '\n');
  }
}

async function stageFixtures(from, names) {
  for (const name of names) await fs.copyFile(new URL(name, from), path.join(output, name));
}

async function stageReadmeExample(root, language, name) {
  const text = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  const source = text.split('```' + language + '\n')[1]?.split('\n```')[0];
  assert.ok(source, 'Missing ' + name + ' in ' + root + '/README.md');
  await fs.writeFile(path.join(output, name), source + '\n');
}

const version = JSON.parse(await fs.readFile(path.join(consumer, 'node_modules/typescript/package.json'), 'utf8')).version;
assert.equal(version, '7.0.2');
facts.typescript = version;
const compiler = path.join(consumer, 'node_modules/typescript/bin/tsc');
const strict = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
  strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false };

async function compile(kind, options, files) {
  const config = path.join(output, `tsconfig-${kind}.json`);
  await fs.writeFile(config, JSON.stringify({ compilerOptions: { ...strict, ...options }, files }, null, 2));
  await checked(kind + '-compile', [compiler, '-p', config, '--pretty', 'false']);
}

await stageFixtures(sdkFixtures, ['work-items.ts', 'work-items-plain.ts', 'worker-app-contracts.mjs']);
await stageFixtures(runtimeFixtures, ['public-core.ts']);
await compile('core', { lib: ['ES2022'], types: [], outDir: './core-out' },
  ['public-core.ts', 'work-items-plain.ts']);

if (!plain) {
  await stageFixtures(sdkFixtures, ['file-app.tsx', 'file-tools.ts', 'ref-app.tsx', 'work-items-preact.tsx', 'source-host.mjs', 'assembly-consumer.mjs']);
  await stageFixtures(runtimeFixtures, ['managed-host.ts', 'managed-host-app.mjs']);
  await stageReadmeExample(sdkRoot, 'tsx', 'readme-app.tsx');
  await stageReadmeExample(runtimeRoot, 'js', 'readme-host.mjs');
  await compile('full', { lib: ['ES2022', 'DOM'], types: ['node'], jsx: 'react-jsx', jsxImportSource: 'preact', outDir: './full-out' },
    ['readme-app.tsx', 'file-app.tsx', 'ref-app.tsx', 'work-items-preact.tsx', 'managed-host.ts']);
  const readme = await checked('readme-execution', [path.join(output, 'readme-host.mjs'), path.join(output, 'full-out/readme-app.js')]);
  assert.match(readme, /\bCount: 1\b/);
  facts.readmeCounter = true;
}

const lastJson = stdout => JSON.parse(stdout.trim().split('\n').at(-1));
facts.workerApps = lastJson(await checked('worker-execution', [path.join(output, 'worker-app-contracts.mjs'), profile]));
if (!plain) {
  const app = path.join(output, 'source-host-app');
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'index.mjs'), "import { workItemsApp } from '../core-out/work-items-plain.js';\nexport default workItemsApp('work_items');\n");
  await fs.writeFile(path.join(app, 'aoapp.json'), JSON.stringify({
    app_name: 'work_items', version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v6',
    appLifecycleSupport: 'app-lifecycle-v2', entry: { main: './index.mjs' },
  }));
  const { receipt, workspace } = lastJson(await checked('source-host-execution', [path.join(output, 'source-host.mjs'), app]));
  assert.equal(receipt.outcomeStatus, 'succeeded');
  assert.match(workspace, /Inspections: 1\b/);
  assert.match(workspace, /"selected":null/);
  assert.doesNotMatch(JSON.stringify(receipt), /Inspections:/);
  facts.sourceHost = { receipt, workspace, resourcesReleased: true };

  const archive = fileURLToPath(new URL('./baselines/work-items-sdk-0.9.0.tgz', import.meta.url));
  const archiveSHA256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  assert.equal(archiveSHA256, '01e700d0db0394a247e7f97683ade6453605ea31d3cd9e0b466660f71a0c07b1');
  const baseline = await fs.mkdtemp(path.join(output, 'work-items-baseline-'));
  await execute('tar', ['-xzf', archive, '-C', baseline, '--strip-components', '1']);
  const assembly = await checked('assembly-provider-execution', [
    '--experimental-import-meta-resolve', path.join(output, 'assembly-consumer.mjs'), baseline,
  ]);
  facts.assembly = { archiveSHA256, ...lastJson(assembly) };

  const commitFixture = path.join(output, 'verify-preact-commit.mjs');
  await fs.copyFile(new URL('./verify-preact-commit.mjs', import.meta.url), commitFixture);
  const commit = lastJson(await checked('preact-commit-execution', [commitFixture]));
  const sdkPackage = JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
  assert.equal(commit.version, sdkPackage.peerDependencies.preact);
  facts.preactCommit = commit;
}

facts.passed = true;
await fs.writeFile(evidence, JSON.stringify(facts, null, 2) + '\n');
console.log(`Installed packages (${profile}): strict TypeScript ${version}, pure Core and real Worker scenarios passed.`);
