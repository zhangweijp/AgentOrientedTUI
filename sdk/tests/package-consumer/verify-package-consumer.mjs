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
assert.ok(['plain', 'full', 'author-plain', 'core'].includes(profile), 'Select a package profile');

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
const corePackageAnchor = await fs.realpath(path.join(profile === 'core' ? path.join(consumer, 'node_modules/@aotui/core') : sdkRoot, 'package.json'));
assert.throws(() => createRequire(corePackageAnchor).resolve('@aotui/core/internal'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
facts.internalBlocked = true;
{
  const resolve = createRequire(path.join(consumer, 'package.json')).resolve;
  for (const name of ['preact', 'linkedom', 'better-sqlite3', ...(!host ? ['typebox', 'zod'] : [])]) {
    assert.throws(() => resolve(name), { code: 'MODULE_NOT_FOUND' });
  }
  if (profile !== 'core') {
    assert.throws(() => resolve('@aotui/sdk/app'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
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
  const target = root === sdkRoot ? path.join('readme-src', name) : name;
  if (root === sdkRoot) {
    await fs.mkdir(path.join(output, 'readme-src'), { recursive: true });
    await fs.writeFile(path.join(output, 'package.json'), JSON.stringify({ type: 'module' }));
  }
  await fs.writeFile(path.join(output, target), source + '\n');
  return target;
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
  const guardedLoad = `
    import assert from 'node:assert/strict';
    import { registerHooks, builtinModules } from 'node:module';
    const loaded = [], loadedFiles = [];
    const native = new Set(builtinModules);
    registerHooks({ resolve(specifier, context, next) {
      loaded.push(specifier);
      if ((specifier === 'typebox' || specifier.startsWith('typebox/')) && !context.parentURL?.includes('/@aotui/core/dist/'))
        throw new Error('Optional schema dependency outside Core: ' + specifier);
      if (specifier.startsWith('@aotui/runtime') || /^(?:preact|linkedom|zod)(?:\\/|$)/.test(specifier) ||
          specifier.startsWith('node:') || native.has(specifier)) throw new Error('Unexpected import: ' + specifier);
      const resolved = next(specifier, context);
      if (resolved?.url) loadedFiles.push(resolved.url);
      return resolved;
    } });
    assert.equal(typeof globalThis.document, 'undefined');
    const actual = await import(process.argv[1]);
    assert.equal(typeof globalThis.document, 'undefined');
    let definedViewType = false, builtApp = false;
    if (${profile !== 'core'}) {
      const WorkItem = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
      const Board = actual.defineViewType()({
        name: 'Board',
        multiplicity: 'single',
        tools: {
          pick: {
            description: 'Select one item.',
            inputSchema: { type: 'object', properties: { item: actual.refParam('WorkItem', WorkItem) }, required: ['item'] },
            execute: () => ({ success: true }),
          },
        },
      });
      definedViewType = Board.tools.pick.inputSchema.properties.item['x-aotui-ref-kind'] === 'WorkItem' &&
        !Object.hasOwn(Board.tools.pick.inputSchema.properties.item, 'type');
      const factory = actual.createApp({ app_name: 'consumer_check', viewTypes: [Board], initialize() {} });
      builtApp = typeof factory?.app_name === 'string' && typeof factory.initialize === 'function';
    }
    console.log(JSON.stringify({ loaded, loadedFiles, definedViewType, builtApp, core: actual.coreFixtureFacts, factory: typeof actual.createApp,
      componentFactory: typeof actual.createTUIApp }));`;
  const specifier = profile === 'core' ? pathToFileURL(path.join(output, 'core-out/public-core.js')).href
    : '@aotui/sdk';
  facts.load = lastJson(await checked(`${profile}-load`, ['--input-type=module', '--eval', guardedLoad, specifier]));
  if (profile !== 'core') {
    const forbiddenUrls = facts.load.loadedFiles.filter(url =>
      /\/@aotui\/core\/dist\/(?:host|producer|persistence)\b|\/@aotui\/core\/dist\/(?:projection|invocation|snapshot\/store|tool\/tool-projection\.js)|\/node_modules\/acorn\//.test(url) ||
      /\/node_modules\/(?:preact|linkedom|zod)\//.test(url));
    assert.deepEqual(forbiddenUrls, [], `Forbidden transitive files loaded for ${profile}: ${JSON.stringify(forbiddenUrls)}`);
  }
  if (profile === 'core') {
    const { handlerEntries, leases, bindings, observationSlots, witness } = facts.load.core;
    assert.deepEqual([handlerEntries, leases, bindings, observationSlots], [3, 0, 0, 0]);
    assert.deepEqual(witness.map(entry => entry.text), ['old!', 'new!']);
  } else {
    assert.equal(facts.load.definedViewType, true);
    assert.equal(facts.load.builtApp, true);
    assert.equal(facts.load.factory, 'function');
    assert.equal(facts.load.componentFactory, 'undefined');
    await fs.copyFile(new URL('../../type-tests/canonical-declarations.ts', import.meta.url), path.join(output, 'canonical-declarations.ts'));
    await compile(`${profile}-canonical-declarations`, { lib: ['ES2022'], types: [], noEmit: true }, ['canonical-declarations.ts']);
    const readme = await stageReadmeExample(sdkRoot, 'ts', 'readme-app.ts');
    await compile(`${profile}-readme`, { lib: ['ES2022'], types: [], declaration: true, rootDir: './readme-src', outDir: './readme-out' }, [readme]);
    const app = path.join(output, 'app');
    await fs.mkdir(app, { recursive: true });
    const names = ['author-plain.ts', 'files.ts', 'file-io.mjs', 'file-io.d.mts'];
    for (const name of names) await fs.copyFile(path.join(sdkRoot, 'examples', 'files', name), path.join(app, name));
    const sdk = JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    const metadata = { name: 'aotui-delivered-files', version: '0.1.0', type: 'module',
      main: './dist/author-plain.js', types: './dist/author-plain.d.ts',
      files: ['dist', 'aoapp.json'], aotui: { app_name: 'delivered_files' }, dependencies: { [sdk.name]: sdk.version } };
    await fs.writeFile(path.join(app, 'package.json'), JSON.stringify(metadata, null, 2));
    const config = path.join(app, 'tsconfig.json');
    await fs.writeFile(config, JSON.stringify({ compilerOptions: { ...strict, lib: ['ES2022'],
      types: [], outDir: './dist', rootDir: '.', declaration: true, allowJs: true }, files: names }));
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
await compile('core', { lib: ['ES2022'], types: [], outDir: './core-out' },
  ['public-core.ts', 'work-items-plain.ts']);

if (!plain) {
  // Install a second physical copy of the delivered SDK and Core for the descriptor and diagnostic checks.
  const sdkCopy = path.join(consumer, 'node_modules/@aotui/sdk-copy');
  const realSdk = await fs.realpath(sdkRoot);
  await fs.cp(realSdk, sdkCopy, { recursive: true });
  const realCore = await fs.realpath(path.join(consumer, 'node_modules/@aotui/core'));
  const acorn = createRequire(path.join(realCore, 'dist/index.js')).resolve('acorn/package.json');
  await fs.mkdir(path.join(sdkCopy, 'node_modules/@aotui'), { recursive: true });
  await fs.cp(realCore, path.join(sdkCopy, 'node_modules/@aotui/core'), { recursive: true });
  await fs.cp(path.dirname(acorn), path.join(sdkCopy, 'node_modules/acorn'), { recursive: true });
  await stageFixtures(sdkFixtures, ['file-app.ts', 'file-tools.ts', 'ref-app.ts', 'source-host.mjs', 'assembly-consumer.mjs',
    'sdk-copies.ts', 'ref-prompt-app.ts', 'ref-prompt-consumer.mjs', 'scripted-provider-turn.mjs']);
  await stageFixtures(runtimeFixtures, ['managed-host.ts', 'managed-host-app.mjs']);
  await stageReadmeExample(runtimeRoot, 'js', 'readme-host.mjs');
  await compile('full', { lib: ['ES2022'], types: ['node'], outDir: './full-out' },
    ['file-app.ts', 'ref-app.ts', 'ref-prompt-app.ts', 'sdk-copies.ts', 'managed-host.ts']);
  const readmeSource = await stageReadmeExample(sdkRoot, 'ts', 'app.ts');
  await compile('readme-notes', { lib: ['ES2022'], types: [], rootDir: './readme-src', outDir: './readme-notes/dist' }, [readmeSource]);
  const readmeApp = path.join(output, 'readme-notes');
  await fs.writeFile(path.join(readmeApp, 'package.json'), JSON.stringify({ name: 'aotui-readme-notes',
    version: '0.1.0', type: 'module', main: './dist/app.js', aotui: { app_name: 'notes' } }));
  await checked('readme-manifest', [readmeApp], path.join(consumer, 'node_modules/.bin/generate-aoapp'));
  const readme = await checked('readme-execution', [path.join(output, 'readme-host.mjs'), readmeApp]);
  const note = lastJson(readme);
  assert.deepEqual([note.before, note.after], ['Draft', 'Reviewed']);
  assert.equal(note.receipt.invocationId, 'edit-1');
  assert.equal(note.receipt.outcome.status, 'succeeded');
  assert.equal(note.resourcesReleased, true);
  facts.readmeNote = note;
}

facts.workerApps = lastJson(await checked('worker-execution', ['--experimental-import-meta-resolve', path.join(output, 'worker-app-contracts.mjs'), profile]));
if (!plain) {
  const app = path.join(output, 'source-host-app');
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'index.mjs'), "import { workItemsApp } from '../core-out/work-items-plain.js';\nexport default workItemsApp('work_items');\n");
  await fs.writeFile(path.join(app, 'aoapp.json'), JSON.stringify({
    app_name: 'work_items', version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v9',
    appLifecycleSupport: 'app-lifecycle-v3', entry: { main: './index.mjs' },
  }));
  const { receipt, workspace } = lastJson(await checked('source-host-execution', [path.join(output, 'source-host.mjs'), app]));
  assert.equal(receipt.outcomeStatus, 'succeeded');
  assert.match(workspace, /Inspections: 1\b/);
  assert.match(workspace, /"selected":null/);
  assert.doesNotMatch(JSON.stringify(receipt), /Inspections:/);
  facts.sourceHost = { receipt, workspace, resourcesReleased: true };

  const assemblyApp = path.join(output, 'assembly-host-app');
  await fs.mkdir(assemblyApp, { recursive: true });
  await fs.writeFile(path.join(assemblyApp, 'index.mjs'), "import { workItemsApp } from '../core-out/work-items-plain.js';\nexport default workItemsApp('work_items');\n");
  await fs.writeFile(path.join(assemblyApp, 'aoapp.json'), JSON.stringify({
    app_name: 'work_items', version: '0.1.0', toolAuthoringProtocol: 'view-type-tools-v9',
    appLifecycleSupport: 'app-lifecycle-v3', entry: { main: './index.mjs' },
  }));
  const assembly = await checked('assembly-provider-execution', [
    '--experimental-import-meta-resolve', path.join(output, 'assembly-consumer.mjs'), assemblyApp,
  ]);
  facts.assembly = lastJson(assembly);

  const refPrompt = await checked('ref-prompt-provider-execution', [
    path.join(output, 'ref-prompt-consumer.mjs'), '--assert-hints', '--assert-list-words',
  ]);
  facts.refPrompt = lastJson(refPrompt);


}

facts.passed = true;
await fs.writeFile(evidence, JSON.stringify(facts, null, 2) + '\n');
console.log(`Installed packages (${profile}): strict TypeScript ${version}, pure Core and real Worker scenarios passed.`);
