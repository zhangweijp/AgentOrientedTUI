import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [release, destination] = process.argv.slice(2);
assert.ok(release && destination, 'Pass the release-local output and a new evidence directory.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(destination);
const manifest = JSON.parse(await readFile(join(release, 'release-manifest.json'), 'utf8'));
assert.equal(manifest.status, 'pass');
const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH };
const file = name => 'file:' + resolve(release, manifest.packages[name].tar);

async function install(name, dependencies, overrides = {}) {
    const folder = join(output, name);
    await mkdir(folder);
    await writeFile(join(folder, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies, overrides }));
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: folder, env, stdio: 'inherit' });
    await writeFile(join(output, name + '-tree.json'), execFileSync('npm', ['ls', '--all', '--omit=dev', '--json'], { cwd: folder, env }));
    return folder;
}

await mkdir(output);
const independent = await install('independent', Object.fromEntries(['core', 'runtime', 'agent-driver-v2', 'agent-driver-adapter']
    .map(name => [manifest.packages[name].name, file(name)])));
for (const name of ['batch-two-support.mjs', 'batch-ten-delivery.mjs', 'batch-ten-public-host.mjs'])
    await copyFile(new URL(name, import.meta.url), join(independent, name));

const facts = {};
for (const kind of ['plain', 'jsx']) {
    const packageName = 'aotui-delivered-files-' + kind;
    const archive = resolve(release, 'artifacts', packageName + '-0.1.0.tgz');
    async function exercise(host, cwd, entry) {
        const app = await install(`${host}-${kind}-app`, { [packageName]: 'file:' + archive },
            { '@aotui/sdk': file('sdk'), '@aotui/core': file('core') });
        const evidence = join(output, `${host}-${kind}.json`);
        execFileSync(process.execPath, ['--experimental-import-meta-resolve', ...entry, archive,
            join(app, 'node_modules', packageName), evidence], { cwd, env, stdio: 'inherit' });
        return JSON.parse(await readFile(evidence, 'utf8'));
    }
    const product = await exercise('product', join(root, 'host'), ['--import', 'tsx', 'test/batch-ten-package-delivery.e2e.ts']);
    const external = await exercise('independent', independent, ['batch-ten-public-host.mjs']);
    assert.ok(product.passed && external.passed);
    assert.equal(product.artifact.packageHash, external.artifact.packageHash);
    assert.equal(product.artifact.moduleHash, external.artifact.moduleHash);
    assert.deepEqual(product.artifact.manifest, external.artifact.manifest);
    const observed = result => Object.entries(result.delivery.requests).map(([turn, { pages, tools }]) =>
        [turn, pages, tools.filter(tool => tool.name !== 'context_compact')]);
    assert.deepEqual(observed(product), observed(external));
    assert.equal(product.wire.length, 8);
    assert.equal(external.wire.length, 8);
    facts[kind] = { sha256: product.artifact.packageHash, requestsPerHost: 8, writesPerHost: 1, pagesAndToolsMatch: true };
}
await writeFile(join(output, 'comparison.json'), JSON.stringify(facts, null, 2) + '\n');
