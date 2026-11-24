import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [releaseDir, destination] = process.argv.slice(2);
assert.ok(releaseDir && destination, 'Pass the release-local output and a new evidence directory.');
const release = resolve(releaseDir), output = resolve(destination);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(release, 'release-manifest.json'), 'utf8'));
assert.equal(manifest.status, 'pass');
const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
const file = name => 'file:' + join(release, manifest.packages[name].tar);
const installInput = names => Object.fromEntries(names.map(name => [manifest.packages[name].name, file(name)]));

async function install(name, dependencies, overrides = {}) {
    const folder = join(output, name);
    await mkdir(folder);
    await writeFile(join(folder, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies, overrides }));
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: folder, env, stdio: 'inherit' });
    await writeFile(join(output, name + '-tree.json'), execFileSync('npm', ['ls', '--all', '--omit=dev', '--json'], { cwd: folder, env }));
    return folder;
}

await mkdir(output);
const author = await install('author', { ...installInput(['core', 'sdk']), typebox: '1.4.3', typescript: '7.0.2', '@types/node': '24.19.2' });
const draft = join(author, 'draft');
await mkdir(draft);
const name = 'aotui-catalog-draft';
await writeFile(join(draft, 'package.json'), JSON.stringify({ name, type: 'module', version: '0.1.0', main: './dist/catalog-draft.js',
    aotui: { app_name: 'catalog_draft', whatItIs: 'A small draft with its own storage namespace.', persistence: true },
    files: ['dist/catalog-draft.js', 'aoapp.json'], dependencies: { '@aotui/sdk': manifest.packages.sdk.version, typebox: '1.4.3' } }));
await copyFile(join(repo, 'sdk/tests/fixtures/catalog-draft.ts'), join(draft, 'catalog-draft.ts'));
execFileSync(join(author, 'node_modules/.bin/tsc'), ['--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false', '--target', 'ES2022',
    '--module', 'NodeNext', '--types', 'node', '--outDir', 'dist', 'catalog-draft.ts'], { cwd: draft, env, stdio: 'inherit' });
execFileSync(join(author, 'node_modules/.bin/generate-aoapp'), [draft], { cwd: draft, env, stdio: 'inherit' });
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: draft, env }));
const artifact = join(output, pack.filename);

const external = await install('independent', installInput(['core', 'runtime', 'agent-driver-v2', 'agent-driver-adapter']));
for (const fixture of ['batch-two-support.mjs', 'batch-ten-delivery.mjs', 'batch-thirteen-catalog.mjs', 'batch-thirteen-public-host.mjs']) {
    await copyFile(new URL(fixture, import.meta.url), join(external, fixture));
}

async function exercise(host, cwd, args) {
    const receiver = await install(host + '-app', { [name]: 'file:' + artifact }, installInput(['core', 'sdk']));
    const evidence = join(output, host + '.json');
    execFileSync(process.execPath, [...args, artifact, join(receiver, 'node_modules', name), evidence], { cwd, env, stdio: 'inherit' });
    return JSON.parse(await readFile(evidence, 'utf8'));
}
const product = await exercise('product', join(repo, 'host'), ['--import', 'tsx', 'test/batch-thirteen-catalog.e2e.ts']);
const independent = await exercise('independent', external, ['batch-thirteen-public-host.mjs']);
assert.ok(product.passed && independent.passed);
assert.deepEqual(product.artifact, independent.artifact);
assert.deepEqual(product.delivery.viewsAndTools, independent.delivery.viewsAndTools);
const counts = result => ({
    HTTPRequests: result.wire.length,
    writes: result.effects.filter(item => item.event === 'save').length,
    workersExited: result.workerEvents.filter(item => item.type === 'exit').length,
});
await writeFile(join(output, 'comparison.json'), JSON.stringify({ artifact: product.artifact,
    product: counts(product), independent: counts(independent), productFileAccesses: independent.productAccesses.length,
    sameModelViewsAndNativeTools: true, packageHashes: Object.fromEntries(Object.entries(manifest.packages).map(([key, value]) => [key, value.sha256])),
}, null, 2) + '\n');
