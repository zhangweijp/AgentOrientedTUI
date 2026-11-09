import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const consumer = resolve(process.argv[2] ?? '.');
const results = resolve(consumer, 'results');
await mkdir(resolve(results, 'types'), { recursive: true });
const commands = [];
async function run(name, args) {
  const child = spawnSync(process.execPath, args, { cwd: consumer, encoding: 'utf8' });
  if (child.error) throw child.error;
  const output = (child.stdout ?? '') + (child.stderr ?? '');
  const result = { name, command: [process.execPath, ...args], node: process.version, cwd: consumer, exitCode: child.status ?? 1, output };
  commands.push(result);
  await writeFile(resolve(results, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
  await writeFile(resolve(results, name + '.log'), output);
  return result;
}

const negativeCases = [
  ['execute-inline', [2322], /is not assignable to type '(?:never|undefined)'/],
  ['execute-variable', [2345], /Types of property ['"]execute['"] are incompatible/],
  ['execute-cross-module', [2345], /Types of property ['"]execute['"] are incompatible/],
  ['execute-spread', [2345], /Types of property ['"]execute['"] are incompatible/],
  ['invalid-root', [2322, 2345]],
  ['readonly-args', [2540, 2339]],
  ['binding-missing', [2322, 2345, 2375]],
  ['binding-extra-inline', [2322, 2345, 2375]],
  ['binding-extra-variable', [2322, 2345, 2375]],
  ['binding-wrong-args', [2322, 2345, 2375]],
  ['binding-narrow-args', [2322, 2345, 2375]],
  ['binding-enabled', [2322, 2345, 2375]],
  ['binding-enabled-undefined', [2322, 2345, 2375]],
  ['binding-disabled-handler', [2741]],
  ['binding-entry-extra', [2322, 2345, 2375]],
  ['binding-readonly', [2540, 2339]],
  ['binding-controller-variable', [2322, 2345], /not assignable/],
  ['binding-controller-cross-module', [2322, 2345], /not assignable/],
  ['binding-controller-spread', [2322, 2345], /not assignable/],
  ['binding-controller-reverse', [2322, 2345], /not assignable/],
  ['jsx-missing', [2322, 2345, 2741]],
  ['jsx-extra-inline', [2322, 2345, 2741]],
  ['jsx-extra-variable', [2322, 2345, 2741]],
  ['jsx-extra-spread', [2322, 2345, 2741]],
  ['jsx-member-extra', [2322, 2345, 2741]],
  ['jsx-wrong-args', [2322, 2345, 2741]],
  ['jsx-narrow-args', [2322, 2345, 2741]],
  ['jsx-enabled', [2322, 2345, 2741]],
  ['jsx-enabled-undefined', [2375]],
  ['jsx-disabled-handler', [2322, 2345, 2741]],
  ['jsx-readonly', [2540, 2339]],



];

for (const [alias, version] of [['typescript', '7.0.2']]) {
  const compiler = resolve(consumer, 'node_modules', alias, 'bin/tsc');
  const checkVersion = await run('version-' + version, [compiler, '--version']);
  assert.equal(checkVersion.exitCode, 0);
  assert.equal(checkVersion.output.trim(), 'Version ' + version);
  const positive = await run('positive-' + version, [compiler, '--pretty', 'false', '-p', resolve(consumer, 'tsconfig.json')]);
  assert.equal(positive.exitCode, 0, positive.output);
  const cases = [];
  for (const [name, codes, message] of negativeCases) {
    const config = resolve(results, 'types', name + '.json');
    await writeFile(config, JSON.stringify({ extends: '../../tsconfig.json', files: ['../../types/negative/' + name + (name.startsWith('jsx-') ? '.tsx' : '.ts')] }, null, 2) + '\n');
    const result = await run(name + '-' + version, [compiler, '--pretty', 'false', '-p', config]);
    assert.notEqual(result.exitCode, 0, name + ' unexpectedly compiled');
    assert.doesNotMatch(result.output, /error TS(?:2307|2688|6053|2305):/, result.output);
    assert.match(result.output, new RegExp(name + '[.]ts'), result.output);
    const diagnostics = [...result.output.matchAll(/error TS(\d+):/g)].map(match => Number(match[1]));
    assert.ok(codes.some(code => diagnostics.includes(code)), result.output);
    if (message) assert.match(result.output, message, result.output);
    cases.push({ case: name, exitCode: result.exitCode, diagnostics, output: result.output });
  }
  await writeFile(resolve(results, 'types-' + version + '.json'), JSON.stringify({ version, positive, negatives: cases }, null, 2) + '\n');
  console.log('TypeScript ' + version + ': positive passed; ' + cases.length + '/' + negativeCases.length + ' independent negatives rejected.');
}
const compileRuntime = await run('compile-runtime', [resolve(consumer, 'node_modules/typescript/bin/tsc'),
  '--pretty', 'false', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
  '--strict', '--exactOptionalPropertyTypes', 'true', '--skipLibCheck', 'false', '--types', 'node', '--lib', 'ES2022,DOM',
  '--jsx', 'react-jsx', '--jsxImportSource', 'preact',
  '--rootDir', consumer, '--outDir', resolve(results, 'runtime-build'), resolve(consumer, 'types/m2-producer.ts'), resolve(consumer, 'types/jsx-runtime.tsx')]);
assert.equal(compileRuntime.exitCode, 0, compileRuntime.output);
const binding = await run('binding-runtime', ['--test', '--test-reporter=spec', resolve(consumer, 'runtime/binding-contract.mjs')]);
assert.equal(binding.exitCode, 0, binding.output);
assert.match(binding.output, /skipped 0\b/);
console.log(binding.output.trimEnd());
const runtime = await run('runtime', ['--test', '--test-reporter=spec', resolve(consumer, 'runtime/static-contract.mjs')]);
assert.equal(runtime.exitCode, 0, runtime.output);
assert.match(runtime.output, /skipped 0\b/);
const components = await run('components', [resolve(consumer, 'runtime/components.mjs')]);
assert.equal(components.exitCode, 0, components.output);
console.log(components.output.trimEnd());
const identity = await run('installed-identity', ['--experimental-import-meta-resolve', resolve(consumer, 'runtime/identity.mjs')]);
assert.equal(identity.exitCode, 0, identity.output);
const pure = await run('pure-entry', [resolve(consumer, 'runtime/pure-entry.mjs')]);
assert.equal(pure.exitCode, 0, pure.output);
console.log(runtime.output.trimEnd());
console.log(pure.output.trimEnd());
