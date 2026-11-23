import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const [consumerDirectory, evidence, profile = 'full'] = process.argv.slice(2);
assert.ok(consumerDirectory && evidence, 'Consumer directory and evidence path are required');
assert.ok(['plain', 'full', 'author-plain', 'author-jsx', 'core'].includes(profile), 'Select a package profile');

const consumer = path.resolve(consumerDirectory);
const plain = profile === 'plain';
const host = plain || profile === 'full';
const output = path.join(consumer, 'package-checks');
const coreExample = path.join(consumer, 'node_modules/@aotui/core/examples/public-core.ts');
const sdkRoot = path.join(consumer, 'node_modules/@aotui/sdk');
const runtimeRoot = path.join(consumer, 'node_modules/@aotui/runtime');
const sdkFixtures = new URL('../fixtures/', import.meta.url);
const runtimeFixtures = new URL('../../../runtime/tests/fixtures/', import.meta.url);
const facts = { consumer, profile, passed: false, commands: [] };

await fs.mkdir(output, { recursive: true });
for (const root of host ? [sdkRoot, runtimeRoot] : profile === 'core' ? [path.join(consumer, 'node_modules/@aotui/core')] : [sdkRoot]) {
  await fs.access(path.join(root, 'README.md'));
  await assert.rejects(fs.access(path.join(root, 'docs')), { code: 'ENOENT' });
}
if (plain || profile === 'author-plain') {
  const resolve = createRequire(path.join(consumer, 'package.json')).resolve;
  for (const name of ['preact', 'better-sqlite3']) {
    assert.throws(() => resolve(name), { code: 'MODULE_NOT_FOUND' });
  }
}

async function checked(kind, args, executable = process.execPath) {
  const command = [executable, ...args];
  try {
    const result = await execute(executable, args, { cwd: consumer, maxBuffer: 8 * 1024 * 1024 });
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
const lastJson = stdout => JSON.parse(stdout.trim().split('\n').at(-1));

async function compile(kind, options, files) {
  const config = path.join(output, `tsconfig-${kind}.json`);
  await fs.writeFile(config, JSON.stringify({ compilerOptions: { ...strict, ...options }, files }, null, 2));
  await checked(kind + '-compile', [compiler, '-p', config, '--pretty', 'false']);
}

if (!host) {
  if (profile === 'core') {
    await fs.copyFile(coreExample, path.join(output, 'public-core.ts'));
    await compile('portable-core', { lib: ['ES2022'], types: [], outDir: './core-out' }, ['public-core.ts']);
  }
  // Check both the actual load and its transitive imports with no ambient renderer.
  const jsx = profile === 'author-jsx';
  const guardedLoad = `
    import assert from 'node:assert/strict';
    import { registerHooks, builtinModules } from 'node:module';
    const loaded = [];
    const native = new Set(builtinModules);
    registerHooks({ resolve(specifier, context, next) {
      loaded.push(specifier);
      if (specifier.startsWith('@aotui/runtime') || ${!jsx} && /^(?:preact|linkedom)(?:\\/|$)/.test(specifier) ||
          ${!jsx} && (specifier.startsWith('node:') || native.has(specifier))) throw new Error('Unexpected import: ' + specifier);
      return next(specifier, context);
    } });
    assert.equal(typeof globalThis.document, 'undefined');
    const actual = await import(process.argv[1]);
    assert.equal(typeof globalThis.document, 'undefined');
    console.log(JSON.stringify({ loaded, core: actual.coreFixtureFacts, factory: typeof actual.createApp,
      componentFactory: typeof actual.createTUIApp }));`;
  const specifier = profile === 'core' ? pathToFileURL(path.join(output, 'core-out/public-core.js')).href
    : jsx ? '@aotui/sdk' : '@aotui/sdk/app';
  facts.load = lastJson(await checked(`${profile}-load`, ['--input-type=module', '--eval', guardedLoad, specifier]));
  if (profile === 'core') {
    const { handlerEntries, logicalBytes, leases, bindings, observationSlots, witness } = facts.load.core;
    assert.deepEqual([handlerEntries, logicalBytes, leases, bindings, observationSlots], [3, 0, 0, 0, 0]);
    assert.deepEqual(witness.map(entry => entry.text), ['old!', 'new!']);
  } else {
    assert.equal(jsx ? facts.load.componentFactory : facts.load.factory, 'function');
    const readme = jsx ? 'readme-app.tsx' : 'readme-app.ts';
    await stageReadmeExample(sdkRoot, jsx ? 'tsx' : 'ts', readme);
    await compile(`${profile}-readme`, { lib: jsx ? ['ES2022', 'DOM'] : ['ES2022'], types: [], declaration: true,
      outDir: './readme-out', ...(jsx ? { jsx: 'react-jsx', jsxImportSource: 'preact' } : {}) }, [readme]);
    const app = path.join(output, 'app');
    await fs.mkdir(app, { recursive: true });
    const names = [jsx ? 'author-jsx.tsx' : 'author-plain.ts', 'files.ts', 'file-io.mjs', 'file-io.d.mts'];
    for (const name of names) await fs.copyFile(new URL('delivery/' + name, sdkFixtures), path.join(app, name));
    const sdk = JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    const metadata = { name: `aotui-delivered-files-${jsx ? 'jsx' : 'plain'}`, version: '0.1.0', type: 'module',
      main: `./dist/${jsx ? 'author-jsx' : 'author-plain'}.js`, types: `./dist/${jsx ? 'author-jsx' : 'author-plain'}.d.ts`,
      files: ['dist', 'aoapp.json'], dependencies: { [sdk.name]: sdk.version, typebox: sdk.peerDependencies.typebox,
        ...(jsx ? { preact: sdk.peerDependencies.preact } : {}) } };
    await fs.writeFile(path.join(app, 'package.json'), JSON.stringify(metadata, null, 2));
    const config = path.join(app, 'tsconfig.json');
    await fs.writeFile(config, JSON.stringify({ compilerOptions: { ...strict, lib: jsx ? ['ES2022', 'DOM'] : ['ES2022'],
      types: [], outDir: './dist', rootDir: '.', declaration: true, allowJs: true,
      ...(jsx ? { jsx: 'react-jsx', jsxImportSource: 'preact' } : {}) }, files: names }));
    await checked(`${profile}-compile`, [compiler, '-p', config, '--pretty', 'false']);
    await checked(`${profile}-manifest`, [app], path.join(consumer, 'node_modules/.bin/generate-aoapp'));
    facts.manifest = JSON.parse(await fs.readFile(path.join(app, 'aoapp.json'), 'utf8'));
    assert.equal(facts.manifest.app_name, 'delivered_files');
    assert.equal(facts.manifest.entry.main, metadata.main);
    const [archive] = JSON.parse(await checked(`${profile}-pack`, ['pack', '--json', '--ignore-scripts', '--pack-destination', output, app], 'npm'));
    const file = path.join(output, archive.filename);
    facts.artifact = { file, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex'), dependencies: metadata.dependencies };
  }
  facts.passed = true;
  await fs.writeFile(evidence, JSON.stringify(facts, null, 2) + '\n');
  process.exit(0);
}

await stageFixtures(sdkFixtures, ['work-items.ts', 'work-items-plain.ts', 'worker-app-contracts.mjs']);
await fs.copyFile(coreExample, path.join(output, 'public-core.ts'));
await stageFixtures(runtimeFixtures, ['public-memory-state.ts']);
await compile('core', { lib: ['ES2022'], types: [], outDir: './core-out' },
  ['public-core.ts', 'public-memory-state.ts', 'work-items-plain.ts']);

if (!plain) {
  // Copy the installed bytes rather than the package manager's symlink. Both SDKs resolve the consumer's Preact.
  const sdkCopy = path.join(consumer, 'node_modules/@aotui/sdk-copy');
  const realSdk = await fs.realpath(sdkRoot);
  await fs.cp(realSdk, sdkCopy, { recursive: true });
  const realCore = await fs.realpath(path.join(consumer, 'node_modules/@aotui/core'));
  const acorn = createRequire(path.join(realCore, 'dist/index.js')).resolve('acorn/package.json');
  const linkedom = createRequire(path.join(realSdk, 'dist/index.js')).resolve('linkedom/package.json');
  await fs.mkdir(path.join(sdkCopy, 'node_modules/@aotui'), { recursive: true });
  await fs.cp(realCore, path.join(sdkCopy, 'node_modules/@aotui/core'), { recursive: true });
  await fs.cp(path.dirname(acorn), path.join(sdkCopy, 'node_modules/acorn'), { recursive: true });
  await fs.symlink(path.dirname(linkedom), path.join(sdkCopy, 'node_modules/linkedom'), 'dir');
  await stageFixtures(sdkFixtures, ['file-app.tsx', 'file-tools.ts', 'ref-app.tsx', 'work-items-preact.tsx', 'source-host.mjs', 'assembly-consumer.mjs']);
  await stageFixtures(sdkFixtures, ['preact-sdk-copies.tsx']);
  await stageFixtures(sdkFixtures, ['ref-prompt-app.tsx', 'ref-prompt-consumer.mjs', 'scripted-provider-turn.mjs']);
  await stageFixtures(runtimeFixtures, ['managed-host.ts', 'managed-host-app.mjs']);
  await stageReadmeExample(sdkRoot, 'tsx', 'readme-app.tsx');
  await stageReadmeExample(runtimeRoot, 'js', 'readme-host.mjs');
  await compile('full', { lib: ['ES2022', 'DOM'], types: ['node'], jsx: 'react-jsx', jsxImportSource: 'preact', outDir: './full-out' },
    ['readme-app.tsx', 'file-app.tsx', 'ref-app.tsx', 'ref-prompt-app.tsx', 'work-items-preact.tsx', 'preact-sdk-copies.tsx', 'managed-host.ts']);
  const readmeApp = path.join(output, 'readme-counter');
  await fs.mkdir(path.join(readmeApp, 'dist'), { recursive: true });
  await fs.copyFile(path.join(output, 'full-out/readme-app.js'), path.join(readmeApp, 'dist/app.js'));
  await fs.writeFile(path.join(readmeApp, 'package.json'), JSON.stringify({ name: 'aotui-readme-counter',
    version: '0.1.0', type: 'module', main: './dist/app.js' }));
  await checked('readme-manifest', [readmeApp], path.join(consumer, 'node_modules/.bin/generate-aoapp'));
  const readme = await checked('readme-execution', [path.join(output, 'readme-host.mjs'), readmeApp]);
  const counter = lastJson(readme);
  assert.match(counter.before, /\bCount 0\b/);
  assert.match(counter.after, /\bCount 1\b/);
  assert.equal(counter.receipt.outcome.status, 'succeeded');
  facts.readmeCounter = counter;
}

facts.workerApps = lastJson(await checked('worker-execution', ['--experimental-import-meta-resolve', path.join(output, 'worker-app-contracts.mjs'), profile]));
if (!plain) {
  const app = path.join(output, 'source-host-app');
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'index.mjs'), "import { workItemsApp } from '../core-out/work-items-plain.js';\nexport default workItemsApp('work_items');\n");
  await fs.writeFile(path.join(app, 'aoapp.json'), JSON.stringify({
    app_name: 'work_items', version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v7',
    appLifecycleSupport: 'app-lifecycle-v2', entry: { main: './index.mjs' },
  }));
  const { receipt, workspace } = lastJson(await checked('source-host-execution', [path.join(output, 'source-host.mjs'), app]));
  assert.equal(receipt.outcomeStatus, 'succeeded');
  assert.match(workspace, /Inspections: 1\b/);
  assert.match(workspace, /"selected":null/);
  assert.doesNotMatch(JSON.stringify(receipt), /Inspections:/);
  facts.sourceHost = { receipt, workspace, resourcesReleased: true };

  const assemblyApp = path.join(output, 'assembly-host-app');
  await fs.mkdir(assemblyApp, { recursive: true });
  await fs.writeFile(path.join(assemblyApp, 'index.mjs'), "import { workItemsApp } from '../full-out/work-items-preact.js';\nexport default workItemsApp('work_items');\n");
  await fs.writeFile(path.join(assemblyApp, 'aoapp.json'), JSON.stringify({
    app_name: 'work_items', version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v7',
    appLifecycleSupport: 'app-lifecycle-v2', entry: { main: './index.mjs' },
  }));
  const assembly = await checked('assembly-provider-execution', [
    '--experimental-import-meta-resolve', path.join(output, 'assembly-consumer.mjs'), assemblyApp,
  ]);
  facts.assembly = lastJson(assembly);

  const refPrompt = await checked('ref-prompt-provider-execution', [
    path.join(output, 'ref-prompt-consumer.mjs'), '--assert-hints', '--assert-list-words',
  ]);
  facts.refPrompt = lastJson(refPrompt);

  const commitFixture = path.join(output, 'verify-preact-commit.mjs');
  await fs.copyFile(new URL('./verify-preact-commit.mjs', import.meta.url), commitFixture);
  const commit = lastJson(await checked('preact-commit-execution', [commitFixture, '--assert-prepare-diagnostic']));
  const sdkPackage = JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
  assert.equal(commit.version, sdkPackage.peerDependencies.preact);
  facts.preactCommit = commit;
}

facts.passed = true;
await fs.writeFile(evidence, JSON.stringify(facts, null, 2) + '\n');
console.log(`Installed packages (${profile}): strict TypeScript ${version}, pure Core and real Worker scenarios passed.`);
