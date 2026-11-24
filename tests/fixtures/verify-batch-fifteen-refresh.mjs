import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [releaseDir, destination] = process.argv.slice(2);
assert.ok(releaseDir && destination, 'Pass release-local output and a new evidence directory.');
const release = resolve(releaseDir), output = resolve(destination);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(release, 'release-manifest.json'), 'utf8'));
assert.equal(manifest.status, 'pass');
await mkdir(output);
const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH,
    npm_config_userconfig: join(output, 'npmrc') };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
await writeFile(env.npm_config_userconfig, '');
const file = name => 'file:' + join(release, manifest.packages[name].tar);
const packages = names => Object.fromEntries(names.map(name => [manifest.packages[name].name, file(name)]));
const command = (cwd, exe, args) => execFileSync(exe, args, { cwd, env, encoding: 'utf8', stdio: 'inherit' });
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function install(name, dependencies, overrides = {}) {
    const cwd = join(output, name);
    await mkdir(cwd);
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ type: 'module', private: true, dependencies, overrides }));
    command(cwd, 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
    await writeFile(join(output, name + '-tree.json'), execFileSync('npm', ['ls', '--all', '--json'], { cwd, env }));
    return cwd;
}
const sdk = packages(['sdk', 'core']);
const author = await install('author', { ...sdk, typebox: '1.4.3', preact: '10.29.1', typescript: '7.0.2', '@types/node': '24.19.2' });
await assert.rejects(readFile(join(author, 'node_modules/@aotui/runtime/package.json')), { code: 'ENOENT' });
async function authorApp(name, source, jsx, appName) {
    const cwd = join(author, name);
    await mkdir(cwd);
    const deps = { '@aotui/sdk': manifest.packages.sdk.version, typebox: '1.4.3', ...(jsx ? { preact: '10.29.1' } : {}) };
    const entry = 'dist/' + source.replace(/\.tsx?$/, '.js');
    await writeFile(join(cwd, 'package.json'), JSON.stringify({
        name, type: 'module', version: '0.1.0', main: './' + entry, aotui: { app_name: appName }, files: ['dist', 'aoapp.json'], dependencies: deps,
    }));
    await copyFile(join(repository, 'sdk/tests/fixtures', source), join(cwd, source));
    command(cwd, join(author, 'node_modules/.bin/tsc'), ['--strict', '--exactOptionalPropertyTypes', '--skipLibCheck', 'false',
        '--target', 'ES2022', '--module', 'NodeNext', '--types', 'node', '--outDir', 'dist',
        '--lib', jsx ? 'ES2022,DOM' : 'ES2022', ...(jsx ? ['--jsx', 'react-jsx', '--jsxImportSource', 'preact'] : []), source]);
    command(cwd, join(author, 'node_modules/.bin/generate-aoapp'), [cwd]);
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', output], { cwd, env }));
    const tar = join(output, pack.filename);
    return { name, entry, tar, sha256: await sha(tar), entrySha256: await sha(join(cwd, entry)) };
}
const files = await authorApp('aotui-refresh-files', 'batch-fifteen-files.ts', false, 'refresh_files');
const todo = await authorApp('aotui-todo-prepare', 'batch-twelve-todo.tsx', true, 'tasks');
const apps = { [files.name]: 'file:' + files.tar, [todo.name]: 'file:' + todo.tar };
const publicHost = await install('independent', { ...sdk, ...packages(['runtime', 'agent-driver-v2', 'agent-driver-adapter']), ...apps }, sdk);
const topicApps = await install('topic-apps', apps, sdk);
for (const name of ['batch-fifteen-refresh.mjs', 'batch-fifteen-public-host.mjs', 'batch-twelve-prepare.mjs',
    'batch-twelve-public-host.mjs', 'batch-ten-delivery.mjs', 'batch-two-support.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(publicHost, name));
}
const results = {};
for (const [kind, app] of [['refresh', files], ['prepare', todo]]) {
    const installed = cwd => join(cwd, 'node_modules', app.name);
    for (const cwd of [publicHost, topicApps]) assert.equal(await sha(join(installed(cwd), app.entry)), app.entrySha256);
    const topic = join(output, kind + '-topic.json'), independent = join(output, kind + '-independent.json');
    const batch = kind === 'refresh' ? 'batch-fifteen' : 'batch-twelve';
    command(join(repository, 'host'), process.execPath,
        ['--import', 'tsx', 'test/' + batch + '-' + kind + '.e2e.ts', installed(topicApps), topic]);
    command(publicHost, process.execPath, [batch + '-public-host.mjs', installed(publicHost), independent]);
    const reports = await Promise.all([topic, independent].map(async file => JSON.parse(await readFile(file, 'utf8'))));
    assert.ok(reports.every(report => report.passed && report.shutdown.ok && report.shutdown.resourcesReleased));
    assert.deepEqual(reports[0].wire.map(request => request.label), reports[1].wire.map(request => request.label));
    if (kind === 'refresh') assert.strictEqual(reports[0].file, reports[1].file);
    else assert.deepEqual(reports[0].scenario.results, reports[1].scenario.results);
    results[kind] = { topic, independent, calls: reports.map(report => report.wire.length) };
}
await writeFile(join(output, 'summary.json'), JSON.stringify({ apps: [files, todo], results }, null, 2));
