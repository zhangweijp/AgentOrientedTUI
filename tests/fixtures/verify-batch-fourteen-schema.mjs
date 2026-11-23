import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const packages = names => Object.fromEntries(names.map(name => [manifest.packages[name].name, file(name)]));
const npm = (cwd, args, ls = false) => execFileSync('npm', args, { cwd, env, stdio: ls ? undefined : 'inherit' });
const tsc = ['--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false', '--target', 'ES2022', '--module', 'NodeNext'];
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');

await mkdir(output);
env.npm_config_userconfig = join(output, 'npmrc');
await writeFile(env.npm_config_userconfig, '');
async function install(name, dependencies, overrides = {}) {
    const folder = join(output, name);
    await mkdir(folder);
    await writeFile(join(folder, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies, overrides }));
    npm(folder, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
    const tree = npm(folder, ['ls', '--all', '--omit=dev', '--json'], true);
    await writeFile(join(output, name + '-tree.json'), tree);
    return folder;
}
const author = await install('author', { ...packages(['core', 'sdk']), typebox: '1.4.3', typescript: '7.0.2', '@types/node': '24.19.2' });
for (const dependency of ['preact', '@aotui/runtime'])
    await assert.rejects(readFile(join(author, 'node_modules', dependency, 'package.json')), { code: 'ENOENT' });
async function appArtifact(name, fixture) {
    const folder = join(author, name);
    await mkdir(folder);
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name, type: 'module', version: '0.1.0', main: './dist/app.js',
        files: ['dist/app.js', 'aoapp.json'], dependencies: { '@aotui/sdk': manifest.packages.sdk.version, typebox: '1.4.3' } }));
    await copyFile(join(repo, 'sdk/tests/fixtures', fixture), join(folder, 'app.ts'));
    execFileSync(join(author, 'node_modules/.bin/tsc'), [...tsc, '--types', 'node', '--outDir', 'dist', 'app.ts'], { cwd: folder, env, stdio: 'inherit' });
    execFileSync(join(author, 'node_modules/.bin/generate-aoapp'), [folder], { cwd: folder, env, stdio: 'inherit' });
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: folder, env }));
    return { name, path: join(output, packed.filename), entryHash: await sha(join(folder, 'dist/app.js')) };
}
const cinema = await appArtifact('aotui-schema-cinema', 'cinema-schema.ts');
const healthy = await appArtifact('aotui-schema-healthy', 'cinema-healthy.ts');
const theatre = await appArtifact('aotui-schema-policy', 'schema-policy-app.ts');
const testApps = [cinema, healthy, theatre];
const appInputs = Object.fromEntries(testApps.map(app => [app.name, 'file:' + app.path]));
const productApps = await install('product-apps', appInputs, packages(['core', 'sdk']));
const independent = await install('independent', { ...packages(['core', 'runtime', 'agent-driver-v2', 'agent-driver-adapter']), ...appInputs }, packages(['core', 'sdk']));
for (const name of ['batch-fourteen-public-host.mjs', 'batch-fourteen-schema.mjs', 'batch-fourteen-provider-repair.mjs',
    'batch-ten-delivery.mjs', 'batch-two-support.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(independent, name));
}

async function exercise(name, commands, cwd, apps) {
    const entries = testApps.map(app => join(apps, 'node_modules', app.name));
    for (const [app, entry] of testApps.map((app, index) => [app, entries[index]]))
        assert.equal(await sha(join(entry, 'dist/app.js')), app.entryHash);
    const report = join(output, name + '.json');
    execFileSync(process.execPath, [...commands, ...entries, report], { cwd, env, stdio: 'inherit' });
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.ok(result.passed && result.shutdown.resourcesReleased);
    assert.deepEqual(result.workers.filter(w => w.event === 'start').map(w => w.threadId).sort(),
        result.workers.filter(w => w.event === 'exit').map(w => w.threadId).sort());
    return result;
}
const product = await exercise('product', ['--import', 'tsx', 'test/batch-fourteen-schema.e2e.ts'], join(repo, 'host'), productApps);
const external = await exercise('independent', ['batch-fourteen-public-host.mjs'], independent, independent);
assert.deepEqual(product.native.comparison, external.native.comparison);
assert.deepEqual(product.native.results, external.native.results);
assert.deepEqual(product.native.effects, external.native.effects);
assert.deepEqual(product.native.observationSchema, external.native.observationSchema);
for (const scenario of ['at', 'over', 'split-over', 'empty', 'ordinary']) assert.deepEqual(product.repair[scenario], external.repair[scenario]);
for (const scenario of ['window', 'twins']) {
    const { notes: _productMounts, ...productResult } = product.repair[scenario];
    const { notes: _externalMounts, ...externalResult } = external.repair[scenario];
    assert.deepEqual(productResult, externalResult);
}
const declaration = external.native.codes.declaration;
assert.equal(declaration, product.native.codes.declaration);
const typeProbe = join(output, 'model-console.ts');
await writeFile(typeProbe, declaration + `
tools['cinema-lookup']({ seat: ['A', 12] });
tools['cinema-selection']({ seat: '$cinema.hall.seat' });
tools['cinema-lookup_at']({ seat: refs.cinema.hall.seat, view_id: 'west', label: '$literal', tags: [] });
const seat0: string = refs.cinema.hall.seat[0];
const seat1: number = refs.cinema.hall.seat[1];
// @ts-expect-error Wrong type at the seat position.
tools['cinema-lookup']({ seat: ['A', '12'] });
// @ts-expect-error Multiple View tool requires its receiving view_id.
tools['cinema-lookup_at']({ seat: ['A', 12], label: 'wrong', tags: [] });
// @ts-expect-error Nominal selection requires an address.
tools['cinema-selection']({ seat: ['A', 12] });
// @ts-expect-error Published tuples are read-only.
refs.cinema.hall.seat[0] = 'B';
`);
execFileSync(join(author, 'node_modules/.bin/tsc'), [...tsc, '--noEmit', typeProbe], { cwd: output, env, stdio: 'inherit' });
const counts = data => ({ requests: data.wire.length, adoptions: data.adoptions.length,
    cinemaHandlers: data.native.effects.length, workersExited: data.workers.filter(item => item.event === 'exit').length });
await writeFile(join(output, 'comparison.json'), JSON.stringify({ product: counts(product), independent: counts(external),
    artifacts: { cinema: await sha(cinema.path), healthy: await sha(healthy.path), theatre: await sha(theatre.path), cinemaEntry: cinema.entryHash },
    packages: Object.fromEntries(Object.entries(manifest.packages).map(([pkg, spec]) => [pkg, spec.sha256])),
    sameNativeRequestsAndResults: true, sameStrictWindowAndStationResults: true, consoleTypeProbe: 'passed',
}, null, 2) + '\n');
