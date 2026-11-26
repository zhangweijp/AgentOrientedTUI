import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [release, destination, seedMode] = process.argv.slice(2);
assert.ok(release && destination && (seedMode === undefined || seedMode === '--offline'),
    'Pass the release-local output, a new evidence directory and optionally --offline to seed from the npm cache.');
const output = resolve(destination);
const manifest = JSON.parse(await readFile(join(release, 'release-manifest.json'), 'utf8'));
assert.equal(manifest.status, 'pass');
const releaseTar = name => resolve(release, manifest.packages[name].tar);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const facts = { passed: false, links: {}, requests: [], commands: [], cases: {} };
await mkdir(output);
const emptyConfig = join(output, 'empty-npmrc');
const globalConfig = join(output, 'empty-global-npmrc');
await Promise.all([writeFile(emptyConfig, ''), writeFile(globalConfig, '')]);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')));
Object.assign(env, { PATH: dirname(process.execPath) + delimiter + env.PATH, npm_config_userconfig: emptyConfig,
    npm_config_globalconfig: globalConfig, npm_config_ignore_scripts: 'true', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_fetch_retries: '0', npm_config_update_notifier: 'false' });

async function run(cwd, executable, args, overrides = {}) {
    const command = { cwd, argv: [executable, ...args] };
    facts.commands.push(command);
    try {
        const result = await execute(executable, args, { cwd, env: { ...env, ...overrides }, maxBuffer: 16 * 1024 * 1024 });
        Object.assign(command, { ...result, exitCode: 0 });
        return result.stdout;
    } catch (error) {
        Object.assign(command, { exitCode: error.code, stdout: error.stdout, stderr: error.stderr });
        throw error;
    }
}

const tarText = async (archive, entry) => (await execute('tar', ['-xOf', archive, 'package/' + entry])).stdout;
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
function block(readme, heading, language) {
    const section = readme.split(`\n${heading}\n`)[1]?.split(/\n#{1,6} /)[0];
    const content = section?.split('```' + language + '\n')[1]?.split('\n```')[0];
    assert.ok(content, `${heading} must contain a ${language} example`);
    return content + '\n';
}

async function installedReadme(packageRoot, name) {
    const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');
    const prose = readme.replace(/^```[\s\S]*?^```[ \t]*$/gm, '').replace(/`[^`\n]+`/g, '');
    const links = [];
    for (const [, href] of prose.matchAll(/\[[^\]\n]+\]\(([^()\s]+)\)/g)) {
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
        const [file, anchor] = href.split('#').map(decodeURIComponent);
        const target = resolve(packageRoot, file || 'README.md');
        assert.ok(target.startsWith(packageRoot + sep), `${name} README link leaves the package: ${href}`);
        if (anchor) {
            const markdown = await readFile(target, 'utf8');
            const headings = [...markdown.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
                heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-'));
            assert.ok(headings.includes(anchor), `${name} README anchor is missing: ${href}`);
        } else {
            await readFile(target);
        }
        links.push(href);
    }
    facts.links[name] = links;
    return readme;
}

const files = new Map(), packages = new Map();
async function index(archive) {
    const metadata = JSON.parse(await tarText(archive, 'package.json'));
    const bytes = await readFile(archive);
    const path = `tar/${basename(archive)}`;
    files.set(path, bytes);
    const versions = packages.get(metadata.name) ?? [];
    versions.push({ metadata, path, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') });
    packages.set(metadata.name, versions);
}

const server = createServer((request, response) => {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const key = decodeURIComponent(new URL(request.url, registry).pathname.slice(1));
    facts.requests.push(key);
    if (files.has(key)) {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(files.get(key));
        return;
    }
    const entries = packages.get(key);
    if (!entries) { response.writeHead(404).end('{}'); return; }
    const versions = Object.fromEntries(entries.map(({ metadata, path, integrity }) =>
        [metadata.version, { ...metadata, dist: { tarball: `${registry}/${path}`, integrity } }]));
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: key,
        'dist-tags': { latest: Object.keys(versions).sort().at(-1) }, versions }));
});
await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
const registry = 'http://127.0.0.1:' + server.address().port;
const npmEnv = folder => ({ npm_config_registry: registry, npm_config_cache: join(folder, '.npm-cache'),
    NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' });
const npmInstall = folder => run(folder, 'npm', ['install'], npmEnv(folder));

try {
    const graphLog = manifest.commands.find(command => command.label === 'author-plain-first-dependency-graph');
    const log = await readFile(join(release, graphLog.log), 'utf8');
    const [graph] = JSON.parse(log.slice(log.indexOf('\n') + 1));
    const urls = new Set();
    const nativeCompiler = `@typescript/typescript-${process.platform}-${process.arch}`;
    function collect(node) {
        for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            for (const [name, item] of Object.entries(node[group] ?? {})) {
                if (!name.startsWith('@aotui/') && (!name.startsWith('@typescript/typescript-') || name === nativeCompiler)) {
                    assert.equal(new URL(item.resolved).origin, 'https://registry.npmjs.org');
                    urls.add(item.resolved);
                }
                collect(item);
            }
        }
    }
    collect(graph);
    const seed = join(output, 'registry-packages');
    await mkdir(seed);
    const seeded = JSON.parse(await run(seed, 'npm', ['pack', '--json', seedMode ?? '--prefer-offline', ...urls]));
    for (const artifact of seeded) await index(join(seed, artifact.filename));
    for (const name of ['sdk', 'core', 'runtime']) {
        const archive = releaseTar(name);
        assert.equal(sha(await readFile(archive)), manifest.packages[name].sha256);
        await index(archive);
    }

    const sdk = JSON.parse(await tarText(releaseTar('sdk'), 'package.json'));
    const guide = await tarText(releaseTar('sdk'), 'README.md');
    const host = join(output, 'host');
    await mkdir(host);
    await writeJson(join(host, 'package.json'), { private: true, type: 'module',
        dependencies: { '@aotui/runtime': manifest.packages.runtime.version } });
    await npmInstall(host);
    await installedReadme(join(host, 'node_modules/@aotui/runtime'), 'runtime');
    await installedReadme(join(host, 'node_modules/@aotui/core'), 'core');
    const hostScript = join(host, 'host.mjs');
    await copyFile(new URL('../fixtures/readme-notes-host.mjs', import.meta.url), hostScript);
    const dependencyTars = ['sdk', 'core'].map(name => 'tar/' + basename(releaseTar(name)));

    for (const route of ['registry', 'tarball']) {
        const name = `notes-${route}`;
        const author = join(output, 'authors', name);
        await mkdir(author, { recursive: true });
        const authorEnv = npmEnv(author);
        const authorManifest = { name, version: '0.1.0', type: 'module', main: './dist/app.js', types: './dist/app.d.ts',
            files: ['dist', 'aoapp.json'], aotui: { app_name: 'notes' }, dependencies: { '@aotui/sdk': sdk.version },
            devDependencies: { typescript: '7.0.2' } };
        await writeJson(join(author, 'package.json'), authorManifest);
        const firstRequest = facts.requests.length;
        if (route === 'registry') await npmInstall(author);
        else await run(author, 'npm', ['install', '--no-save', releaseTar('core'), releaseTar('sdk')], authorEnv);
        const authorRequests = facts.requests.slice(firstRequest);
        for (const tar of dependencyTars) assert.equal(authorRequests.includes(tar), route === 'registry');
        const authorGuide = await installedReadme(join(author, 'node_modules/@aotui/sdk'), 'sdk');
        assert.equal(authorGuide, guide);
        await mkdir(join(author, 'src'));
        await writeFile(join(author, 'src', 'app.ts'), block(authorGuide, '## 声明页面与工具', 'ts'));
        const compilerOptions = { target: 'ES2022', module: 'NodeNext', lib: ['ES2022'], types: [], strict: true,
            exactOptionalPropertyTypes: true, skipLibCheck: false, declaration: true, rootDir: './src', outDir: './dist' };
        await writeJson(join(author, 'tsconfig.json'), { compilerOptions, files: ['src/app.ts'] });
        await run(author, 'npm', ['exec', '--', 'tsc', '-p', 'tsconfig.json'], authorEnv);
        await run(author, 'npm', ['exec', '--', 'generate-aoapp', '.'], authorEnv);
        const [packed] = JSON.parse(await run(author, 'npm', ['pack', '--json'], authorEnv));
        const archive = join(author, packed.filename);
        const metadata = JSON.parse(await tarText(archive, 'package.json'));
        const app = JSON.parse(await tarText(archive, 'aoapp.json'));
        assert.equal(metadata.name, name);
        assert.deepEqual(metadata.dependencies, authorManifest.dependencies);
        assert.equal(metadata.overrides, undefined);
        assert.equal(app.app_name, 'notes');
        assert.equal(app.entry.main, './dist/app.js');
        const contents = (await execute('tar', ['-tf', archive])).stdout.trim().split('\n').sort();
        assert.deepEqual(contents, ['package/aoapp.json', 'package/dist/app.d.ts', 'package/dist/app.js', 'package/package.json']);
        const { dependencies: production } = JSON.parse(await run(author, 'npm', ['ls', '--omit=dev', '--json'], authorEnv));
        assert.deepEqual(Object.keys(production), ['@aotui/sdk']);
        for (const dependency of ['@aotui/runtime', 'preact', 'linkedom', 'zod'])
            await assert.rejects(readFile(join(author, 'node_modules', dependency, 'package.json')), { code: 'ENOENT' });
        if (route === 'tarball') {
            await writeFile(join(author, 'src', 'ref.ts'), block(authorGuide, '## 声明业务参数和 Ref 值', 'ts'));
            await writeJson(join(author, 'tsconfig.ref.json'), { compilerOptions, files: ['src/ref.ts'] });
            await run(author, 'npm', ['exec', '--', 'tsc', '-p', 'tsconfig.ref.json', '--noEmit'], authorEnv);
        }

        const receiver = join(output, 'receivers', route);
        await mkdir(receiver, { recursive: true });
        const received = join(receiver, 'received-app.tgz');
        await copyFile(archive, received);
        const hash = sha(await readFile(archive));
        assert.equal(sha(await readFile(received)), hash);
        const receiverManifest = { private: true, dependencies: { [name]: 'file:./received-app.tgz' } };
        await writeJson(join(receiver, 'package.json'), receiverManifest);
        const firstReceiverRequest = facts.requests.length;
        await npmInstall(receiver);
        const receiverRequests = facts.requests.slice(firstReceiverRequest);
        for (const tar of dependencyTars) assert.ok(receiverRequests.includes(tar), `${route} must resolve ${tar} from its registry`);
        assert.deepEqual(await readJson(join(receiver, 'package.json')), receiverManifest);
        const installed = join(receiver, 'node_modules', name);
        assert.deepEqual(await readJson(join(installed, 'package.json')), metadata);
        assert.deepEqual(await readJson(join(installed, 'aoapp.json')), app);
        const entry = join(installed, app.entry.main);
        assert.equal(await readFile(entry, 'utf8'), await tarText(received, app.entry.main.slice(2)));
        const note = JSON.parse((await run(host, process.execPath, [hostScript, installed],
            { AOTUI_DATA_DIR: join(host, 'state', route) })).trim().split('\n').at(-1));
        const { before, after, receipt, resourcesReleased } = note;
        assert.deepEqual([before, after], ['Draft', 'Reviewed']);
        assert.equal(receipt.invocationId, 'edit-1');
        assert.equal(receipt.executionPhase, 'entered-returned');
        assert.equal(receipt.outcome.status, 'succeeded');
        assert.equal(resourcesReleased, true);
        facts.cases[route] = { archive, sha256: hash, contents, metadata, app,
            authorRequests, receiverManifest, receiverRequests, note };
    }
    facts.passed = true;
} finally {
    await new Promise(done => server.close(done));
    await writeJson(join(output, 'evidence.json'), facts);
}
console.log(`Installed SDK README App passed through registry and local tarball installs. Evidence at ${output}`);
