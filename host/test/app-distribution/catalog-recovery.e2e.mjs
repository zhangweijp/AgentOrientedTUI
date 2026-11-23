import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRuntime } from '@aotui/runtime';
import { watchUntil } from '../../../tests/fixtures/batch-two-support.mjs';

const [author, evidence] = process.argv.slice(2);
assert.ok(author && evidence, 'Pass a clean author install containing @aotui/sdk and an evidence path.');
const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'agentina-catalog-recovery-')));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cliEntry = new URL('../../dist/app-distribution/cli.js', import.meta.url);
const catalogEntry = new URL('../../dist/app-distribution/app-catalog.js', import.meta.url);
const run = promisify(execFile);
const preload = join(root, 'preload.mjs');
const service = join(root, 'catalog-service.mjs');
await fs.writeFile(preload, `
import fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const home = process.env.CATALOG_RECOVERY_HOME;
if (!home) throw Error('A test-owned catalog root is required');
os.homedir = () => home;
const mode = process.env.CATALOG_RECOVERY_MODE;
if (mode) {
    const rename = fs.rename.bind(fs);
    fs.rename = async (from, to) => {
        if (to === join(home, '.agentina', 'config.json')) {
            if (mode === 'exit') process.exit(73);
            if (mode === 'deny') throw Object.assign(Error('refused replacement'), { code: 'EACCES' });
            const gate = process.env.CATALOG_RECOVERY_GATE;
            await fs.writeFile(join(gate, 'before-replace'), String(process.pid));
            for (let ready = false; !ready;) {
                ready = await fs.stat(join(gate, 'continue')).then(() => true, error => {
                    if (error.code !== 'ENOENT') throw error;
                    return false;
                });
                if (!ready) await sleep(10);
            }
        }
        return rename(from, to);
    };
}
`);
await fs.writeFile(service, `
import { AppCatalog } from ${JSON.stringify(catalogEntry.href)};
try {
    const [name, action] = process.argv.slice(2);
    const catalog = new AppCatalog();
    const result = action === 'remove' ? await catalog.remove(name) : await catalog.update(name);
    if (result) console.log(JSON.stringify(result));
} catch (error) {
    console.error(error.code, error.message);
    process.exitCode = 1;
}
`);

const environment = { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH };
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
delete environment.CATALOG_RECOVERY_MODE;
delete environment.CATALOG_RECOVERY_GATE;
async function withProgram(entry, args, home, extra = {}) {
    const env = { ...environment, CATALOG_RECOVERY_HOME: home, AOTUI_DATA_DIR: join(home, 'runtime'), ...extra };
    const file = entry instanceof URL ? fileURLToPath(entry) : entry;
    const result = await run(process.execPath, ['--import', preload, file, ...args], { cwd: root, env, timeout: 20_000 })
        .then(reply => ({ ...reply, code: 0 }), error => error);
    return { code: result.code, stdout: result.stdout?.trim(), stderr: result.stderr?.trim() };
}
const cli = (args, home, env) => withProgram(cliEntry, args, home, env);
const configPath = home => join(home, '.agentina', 'config.json');
const configBytes = home => fs.readFile(configPath(home), 'utf8');
const readConfig = async home => JSON.parse(await configBytes(home));
const createFile = (file, content = '') => fs.writeFile(file, content);
function checkConflict(result, home) {
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.match(result.stderr, /CONFIG_CONFLICT/);
    assert.ok(result.stderr.includes(configPath(home)), result.stderr);
}

async function runWriters(facts) {
    const home = join(root, 'writer-home');
    const gate = join(root, 'writer-gate');
    await fs.mkdir(gate);
    await fs.mkdir(dirname(configPath(home)), { recursive: true });
    const shared = { source: 'local:' + root, enabled: true, autoStart: true };
    await createFile(configPath(home), JSON.stringify({ version: 2,
        apps: { left: shared, right: { ...shared, enabled: false } },
        modelInputLimits: { sample: { contextWindow: 64_000 } }, unknown: 'preserve' }));
    facts.previouslyConfirmed = await cli(['autostart', 'right', 'off'], home);
    assert.equal(facts.previouslyConfirmed.code, 0);

    const beforeActive = await configBytes(home);
    const active = cli(['autostart', 'left', 'off'], home, { CATALOG_RECOVERY_MODE: 'hold', CATALOG_RECOVERY_GATE: gate });
    try {
        const entered = await watchUntil(() => fs.readFile(join(gate, 'before-replace'), 'utf8').catch(error => {
            if (error.code === 'ENOENT') return false;
            throw error;
        }));
        facts.activePID = Number(entered);
        assert.ok(facts.activePID > 0);
        facts.conflict = await cli(['enable', 'right'], home);
        checkConflict(facts.conflict, home);
        assert.equal(await configBytes(home), beforeActive);
    } finally {
        await createFile(join(gate, 'continue'));
        facts.activeResult = await active;
    }
    assert.equal(facts.activeResult.code, 0, JSON.stringify(facts.activeResult));

    const confirmedBytes = await configBytes(home);
    facts.crash = await cli(['disable', 'left'], home, { CATALOG_RECOVERY_MODE: 'exit' });
    assert.equal(facts.crash.code, 73);
    facts.sameBytesAfterCrash = (await configBytes(home)) === confirmedBytes;
    assert.ok(facts.sameBytesAfterCrash);
    const actions = [['disable', 'left'], ['enable', 'right']];
    facts.successors = await Promise.all(actions.map(args => cli(args, home)));
    const after = await readConfig(home);
    facts.afterSimultaneous = after;
    assert.ok(facts.successors.some(reply => reply.code === 0));
    assert.equal(after.apps.left.enabled, facts.successors[0].code !== 0);
    assert.equal(after.apps.right.enabled, facts.successors[1].code === 0);
    facts.retries = [];
    for (const [index, result] of facts.successors.entries()) {
        if (result.code === 0) continue;
        checkConflict(result, home);
        const retry = await cli(actions[index], home);
        assert.equal(retry.code, 0, JSON.stringify(retry));
        facts.retries.push(retry);
    }
    facts.final = await readConfig(home);
    assert.deepEqual(facts.final, { version: 2, apps: { left: { ...shared, enabled: false, autoStart: false },
        right: { ...shared, enabled: true, autoStart: false } },
        modelInputLimits: { sample: { contextWindow: 64_000 } }, unknown: 'preserve' });
    facts.lockSidecarBytes = (await fs.stat(configPath(home) + '.lock')).size;
    assert.equal(facts.lockSidecarBytes, 0);
}

async function runNpm(facts) {
    const home = join(root, 'npm-home');
    const rc = join(root, 'npmrc');
    await createFile(rc);
    await createFile(rc + '.global');
    const packageName = 'aotui-catalog-recovery', appName = 'recovery_notes', aliasName = 'confirmed_alias';
    const cache = join(home, '.agentina', 'apps', 'npm');
    const env = { ...environment, npm_config_userconfig: rc, npm_config_globalconfig: rc + '.global',
        npm_config_cache: join(root, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false',
        npm_config_fetch_retries: '0', npm_config_offline: 'false', npm_config_prefer_online: 'true', npm_config_update_notifier: 'false' };
    const sdk = join(resolve(author), 'node_modules', '@aotui', 'sdk');
    const sdkPackage = JSON.parse(await fs.readFile(join(sdk, 'package.json'), 'utf8'));
    const sdkEntry = resolve(sdk, sdkPackage.exports['./app'].import);
    const bundleCommand = join(repo, 'node_modules', '.bin', 'esbuild');
    const bundles = new Map();
    for (const [version, body, entry] of [
        ['1.0.0', 'First working edition', './app.js'],
        ['1.1.0', 'Incomplete edition', './unbuilt.js'],
        ['1.2.0', 'New working edition', './app.js'],
    ]) {
        const folder = join(root, version);
        await fs.mkdir(folder);
        await createFile(join(folder, 'package.json'), JSON.stringify({
            name: packageName, version, type: 'module', main: './app.js', files: ['app.js', 'aoapp.json'],
        }));
        await createFile(join(folder, 'aoapp.json'), JSON.stringify({ app_name: appName, version, entry: { main: entry },
            toolAuthoringProtocol: 'view-type-tools-v7', appLifecycleSupport: 'app-lifecycle-v2' }));
        await createFile(join(folder, 'entry.mjs'), `
import { createApp, createView, defineViewType } from ${JSON.stringify(sdkEntry)};
const Notes = defineViewType({ name: 'Notes', multiplicity: 'single', region: 'dynamic' });
export default createApp({ app_name: ${JSON.stringify(appName)}, viewTypes: [Notes],
    initialize({ prepareProjection }) {
        const note = createView(Notes, { render: () => ({ body: ${JSON.stringify(body)} }) });
        prepareProjection({ views: [note] });
    },
});
`);
        await run(bundleCommand, ['entry.mjs', '--bundle', '--platform=node', '--format=esm', '--target=node24', '--outfile=app.js'], { cwd: folder, env });
        const { stdout } = await run('npm', ['pack', '--offline', '--ignore-scripts', '--json'],
            { cwd: folder, env: { ...env, npm_config_cache: join(root, 'pack-cache') } });
        const tar = await fs.readFile(join(folder, JSON.parse(stdout)[0].filename));
        bundles.set(version, { tar, integrity: 'sha512-' + createHash('sha512').update(tar).digest('base64') });
    }
    let latest = '1.0.0';
    let paused;
    facts.requests = [];
    const server = createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        facts.requests.push({ path: pathname, latest });
        response.setHeader('cache-control', 'no-store');
        if (pathname === '/' + packageName) {
            if (paused) {
                const gate = paused;
                paused = undefined;
                gate.arrived.resolve();
                await gate.finish.promise;
            }
            const versions = {};
            for (const [version, { integrity }] of bundles) if (version <= latest) {
                versions[version] = { name: packageName, version, dist: { integrity, tarball: `${registry}/${version}.tgz` } };
            }
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ name: packageName, 'dist-tags': { latest }, versions }));
            return;
        }
        const bundle = bundles.get(pathname.slice(1, -4));
        if (bundle && pathname.endsWith('.tgz')) response.end(bundle.tar);
        else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const registry = 'http://127.0.0.1:' + server.address().port;
    env.npm_config_registry = registry;
    const install = options => cli(['install', packageName + '@latest', ...options], home, env);
    const update = (mode, options = {}) => withProgram(service, [appName], home, {
        ...env, ...options, ...(mode ? { CATALOG_RECOVERY_MODE: mode } : {}),
    });
    const remove = name => withProgram(service, [name, 'remove'], home, env);
    const hash = value => createHash('sha256').update(value).digest('hex');
    async function confirmPages(entries, expected) {
        const runtime = createRuntime();
        const desktop = runtime.getDesktop(await runtime.createDesktop());
        const facts = [];
        try {
            for (const [installationId, entry] of Object.entries(entries)) {
                const packageInfo = JSON.parse(await fs.readFile(join(entry.distribution.installedPath, 'package.json'), 'utf8'));
                const registered = await desktop.registerPendingApp({ installationId, localPath: entry.distribution.installedPath,
                    config: { AOTUI_DATA_DIR: join(home, 'runtime') } });
                assert.equal(registered, installationId);
                const appId = await desktop.openApp(installationId);
                const instance = desktop.getInstalledApps().find(item => item.appId === appId);
                const access = runtime.getAppInteraction(desktop.id, appId, instance.appInstanceId);
                assert.equal(access.status, 'ready');
                const result = await access.interaction.observe({ all: true });
                assert.equal(result.status, 'observed');
                const body = result.observation.views[0].content.value;
                assert.equal(body, expected[installationId]);
                access.interaction.releaseObservation(result.observation.observationId);
                facts.push({ installationId, appId, body, packageVersion: packageInfo.version, path: entry.distribution.installedPath });
            }
        } finally {
            const closed = await runtime.beginShutdown().completion;
            assert.ok(closed.ok && closed.resourcesReleased, JSON.stringify(closed));
        }
        return facts;
    }

    const older = 'First working edition';
    try {
        const initial = await install(['--no-autostart']);
        assert.equal(initial.code, 0, JSON.stringify(initial));
        const original = await readConfig(home);
        const first = original.apps[appName];
        original.apps[aliasName] = { ...first, autoStart: true };
        await createFile(configPath(home), JSON.stringify(original));
        const bytes = await configBytes(home);
        const oldRoots = await fs.readdir(cache);
        assert.equal(oldRoots.length, 1);
        facts.first = { sha256: hash(bytes), pages: await confirmPages(original.apps, { [appName]: older, [aliasName]: older }) };
        for (const attempt of [
            { key: 'badManifest', version: '1.1.0', run: () => update(undefined), diagnostic: /APP_MANIFEST_INVALID.*entry\.main/ },
            { key: 'badCLIForce', version: '1.1.0', run: () => install(['--force']), diagnostic: /Invalid App manifest.*entry\.main/ },
            { key: 'writeDenied', version: '1.2.0', run: () => update('deny'), diagnostic: /CONFIG_WRITE_FAILED.*config\.json/ },
        ]) {
            latest = attempt.version;
            const failed = await attempt.run();
            assert.equal(failed.code, 1, JSON.stringify(failed));
            assert.match(failed.stderr, attempt.diagnostic);
            assert.equal(await configBytes(home), bytes);
            assert.deepEqual(await fs.readdir(cache), oldRoots, 'The unpublished workspace was removed');
            facts[attempt.key] = { result: failed, sha256: hash(await configBytes(home)),
                pages: await confirmPages((await readConfig(home)).apps, { [appName]: older, [aliasName]: older }) };
        }

        const gate = { arrived: Promise.withResolvers(), finish: Promise.withResolvers() };
        paused = gate;
        const staleUpdate = update(undefined, { npm_config_cache: join(root, 'stale-cache') });
        try {
            await Promise.race([gate.arrived.promise, staleUpdate.then(result => { throw Error('Update ended before HTTP gate: ' + JSON.stringify(result)); })]);
            const flags = await cli(['autostart', aliasName, 'off'], home);
            assert.equal(flags.code, 0, JSON.stringify(flags));
            facts.flagWhileDownloading = flags;
            const before = await readConfig(home);
            assert.equal(before.apps[appName].source, first.source);
            facts.validCLIForce = await install(['--force']);
            assert.equal(facts.validCLIForce.code, 0, JSON.stringify(facts.validCLIForce));
        } finally {
            gate.finish.resolve();
            facts.staleUpdate = await staleUpdate;
        }
        checkConflict(facts.staleUpdate, home);
        assert.match(facts.staleUpdate.stderr, /Installation "recovery_notes" changed/);
        const confirmed = await readConfig(home);
        assert.deepEqual(Object.keys(confirmed.apps).sort(), [aliasName, appName].sort());
        assert.equal(confirmed.apps[appName].autoStart, false);
        assert.equal(confirmed.apps[aliasName].autoStart, false);
        assert.equal(confirmed.apps[aliasName].source, first.source);
        assert.notEqual(confirmed.apps[appName].source, first.source);
        assert.equal((await fs.readdir(cache)).length, 2);
        facts.confirmed = { entries: confirmed.apps, pages: await confirmPages(confirmed.apps, {
            [appName]: 'New working edition', [aliasName]: older,
        }) };
        assert.ok(facts.requests.some(item => item.path === '/1.0.0.tgz'));
        assert.ok(facts.requests.some(item => item.path === '/1.1.0.tgz'));
        assert.ok(facts.requests.some(item => item.path === '/1.2.0.tgz'));
        assert.equal((await remove(appName)).code, 0);
        await assert.rejects(fs.stat(confirmed.apps[appName].distribution.installRoot), { code: 'ENOENT' });
        facts.aliasAfterRemoval = await confirmPages({ [aliasName]: confirmed.apps[aliasName] }, { [aliasName]: older });
        assert.equal((await remove(aliasName)).code, 0);
        assert.deepEqual(await fs.readdir(cache), []);
    } finally {
        paused?.finish.resolve();
        await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
    }
}

const facts = { writers: {}, npm: {}, passed: false };
try {
    await runWriters(facts.writers);
    await runNpm(facts.npm);
    facts.passed = true;
    console.log('PASS catalog process recovery and npm publication with real Workers');
} finally {
    await fs.writeFile(resolve(evidence), JSON.stringify(facts, null, 2) + '\n');
    await fs.rm(root, { recursive: true, force: true });
}
