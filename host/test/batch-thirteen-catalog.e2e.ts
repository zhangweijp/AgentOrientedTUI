import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { createRuntime, readAppManifest } from '@aotui/runtime';
import type { LLMConfig } from '@aotui/agent-driver-v2';
import type { GuiUpdateEvent } from '../src/types/session.js';
import { fixtureProvider, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';
import { llmConfig } from '../../tests/fixtures/batch-ten-delivery.mjs';
import { appEffects, appName, artifactFacts, autoEntry, disabledEntry, draftText, exerciseCatalog, manualEntry,
    recordCatalogWorkers } from '../../tests/fixtures/batch-thirteen-catalog.mjs';

const [archive, installed, evidence] = process.argv.slice(2);
const state = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'aotui-b13-product-')));
const home = join(state, 'home');
const configPath = join(home, '.agentina/config.json');
const runtimeData = join(state, 'runtime');
await fs.mkdir(join(home, '.agentina'), { recursive: true });
const preload = join(state, 'cli-home.mjs');
await fs.writeFile(preload, "import os from 'node:os'; os.homedir = () => process.env.CATALOG_TEST_HOME;\n");
const npmConfig = join(state, 'npmrc');
await fs.writeFile(npmConfig, '');
const cliEnv = { ...process.env, CATALOG_TEST_HOME: home, AOTUI_DATA_DIR: runtimeData,
    npm_config_userconfig: npmConfig, npm_config_globalconfig: npmConfig + '.global',
    npm_config_cache: join(state, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_fetch_retries: '0', npm_config_offline: 'false' };
delete cliEnv.AOTUI_APP_CATALOG_URL;
delete cliEnv.AOTUI_SYSTEM_INSTRUCTION_PATH;
const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../dist/app-distribution/cli.js', import.meta.url));
const cli = (args: string[], env = cliEnv) =>
    execute(process.execPath, ['--import', preload, cliPath, ...args], { cwd: state, env, timeout: 15_000 });

mock.method(os, 'homedir', () => home);
process.env.DB_PATH = join(state, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = runtimeData;
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const { Config } = await import('../src/config/config.js');
const { DesktopManager } = await import('../src/core/desktop-manager.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const db = await import('../src/db/index.js');
const provider = await fixtureProvider();
const runtime = createRuntime();
const desktops = new DesktopManager({ kernel: runtime });
const id = 'catalog-topic';
const host = new HostManagerV2(id, {} as ConstructorParameters<typeof HostManagerV2>[1]);
const { inputBudget: _, ...llm } = llmConfig(provider.url);
const limitKey = llm.provider.id + ':' + llm.model + '@' + provider.url;
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async () => llm as LLMConfig);
mock.method(Config, 'get', async () => ({ agents: { list: [{ id, prompt: 'Use the draft.', enabledApps: [
    autoEntry, manualEntry, disabledEntry,
] }] } }));
const workers = recordCatalogWorkers();
const delivered: GuiUpdateEvent[] = [];
const unsubscribe = host.onGuiUpdate(event => {
    if (event.topicId !== id || !event.message) return;
    if (event.type === 'tool') { delivered.push(event); host.pauseAgent(id); }
    if (event.type === 'assistant' && typeof event.message.content === 'string') host.pauseAgent(id);
});
const facts: Record<string, unknown> = { wire: provider.requests, workerEvents: workers.events, passed: false };

async function runLocalApp() {
    const child = spawn(process.execPath, ['--import', preload, cliPath, 'run', appName], { cwd: state, env: cliEnv });
    const close = once(child, 'close');
    let output = '', errors = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    try {
        await watchUntil(() => output.includes('Runtime ready.'));
        child.stdin.write('snapshot\n');
        await watchUntil(() => output.includes('Draft: empty'));
        child.stdin.end('exit\n');
        assert.deepEqual(await close, [0, null], errors);
        return { output, errors };
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await close;
    }
}

async function verifyNpm() {
    const name = 'aotui-catalog-npm-fixture', version = '0.1.0', directory = join(state, 'npm-app');
    await fs.mkdir(directory);
    await fs.writeFile(join(directory, 'package.json'), JSON.stringify({ name, version, type: 'module', main: './main.mjs' }));
    await fs.writeFile(join(directory, 'main.mjs'), "throw Error('The npm catalog should not import this App');\n");
    await fs.writeFile(join(directory, 'aoapp.json'), JSON.stringify({ app_name: 'npm_catalog_fixture', version,
        entry: { main: './main.mjs' }, toolAuthoringProtocol: 'view-type-tools-v7', appLifecycleSupport: 'app-lifecycle-v2' }));
    const packed = await execute('npm', ['pack', '--ignore-scripts', '--json'], { cwd: directory,
        env: { ...cliEnv, npm_config_cache: join(state, 'npm-pack-cache') } });
    const tarball = await fs.readFile(join(directory, JSON.parse(packed.stdout)[0].filename));
    const requests: string[] = [];
    const server = createServer((request, response) => {
        requests.push(request.url ?? '');
        if (request.url === '/' + name) {
            const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: {
                name, version, dist: { tarball: base + '/artifact.tgz',
                    integrity: 'sha512-' + createHash('sha512').update(tarball).digest('base64') },
            } } }));
        } else if (request.url === '/artifact.tgz') {
            response.end(tarball);
        } else response.writeHead(404).end();
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    try {
        const registry = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
        const result = await cli(['install', name + '@' + version, '--no-autostart'], { ...cliEnv, npm_config_registry: registry });
        assert.match(result.stdout, /Successfully installed npm app: npm_catalog_fixture/);
        const entry = await host.getAppDetail('npm_catalog_fixture');
        assert.equal(entry.autoStart, false);
        assert.equal(entry.originalSource, 'npm:' + name + '@' + version);
        assert.equal(entry.distribution?.resolvedVersion, version);
        const packageDirectory = entry.distribution?.installedPath;
        const installRoot = entry.distribution?.installRoot;
        assert.ok(packageDirectory && installRoot && existsSync(packageDirectory));
        await host.removeApp('npm_catalog_fixture');
        assert.equal(existsSync(installRoot), false);
        assert.ok(!(await host.getAppsConfig()).npm_catalog_fixture);
        assert.ok(requests.includes('/' + name) && requests.includes('/artifact.tgz'), JSON.stringify(requests));
        return { requests, entry, removed: true };
    } finally {
        await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    }
}

try {
    const manifest = await readAppManifest(installed);
    facts.artifact = await artifactFacts(archive, manifest);
    const app = { enabled: true, source: 'local:' + installed };
    const initial = {
        version: 2,
        modelInputLimits: { [limitKey]: { contextWindow: 32_000, maxOutputTokens: 1_000 } },
        catalog: { mode: 'builtin', extra: 'old' },
        otherFeature: { revision: 1 },
        apps: {
            [autoEntry]: { ...app, futurePerAppField: 'keep auto' },
            [manualEntry]: { ...app, autoStart: true },
            [disabledEntry]: { ...app },
            bad: { enabled: 'not a boolean', source: 'local:' + join(state, 'never-used') },
        },
    };
    const jsonc = (value: object) => '// Test-owned catalog settings\n' + JSON.stringify(value, null, 2) + '\n/* end */\n';
    await fs.writeFile(configPath, jsonc(initial));
    await db.initDatabase();
    await desktops.initialize();
    await host.initAgentDriver(runtime, desktops);
    assert.equal((await Config.getTuiConfig()).modelInputLimits?.[limitKey].contextWindow, 32_000);
    const discovered = JSON.parse((await cli(['list', '--json'])).stdout);
    assert.deepEqual(discovered.map(item => [item.name, item.status]), [
        [autoEntry, 'loaded'], [manualEntry, 'loaded'], [disabledEntry, 'loaded'], ['bad', 'failed'],
    ]);
    assert.equal(discovered.at(-1).issue.path, 'apps.bad');
    assert.deepEqual(await appEffects(manifest), []);
    facts.jsonc = { modelWindow: 32_000, discovered };

    // An independent writer commits unrelated changes while the GUI service is already available.
    const latest = { ...initial, modelInputLimits: { [limitKey]: { contextWindow: 64_000, maxOutputTokens: 1_000 } },
        catalog: { mode: 'builtin', extra: 'new' }, otherFeature: { revision: 2 },
        apps: { ...initial.apps, [autoEntry]: { ...initial.apps[autoEntry], futurePerAppField: 'keep latest auto' } } };
    await fs.writeFile(configPath, jsonc(latest));
    const rename = fs.rename.bind(fs);
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const gated = mock.method(fs, 'rename', async (from, to) => {
        if (to === configPath) { entered.resolve(); await finish.promise; }
        return rename(from, to);
    });
    const guiChange = host.setAppEnabled(disabledEntry, false);
    try {
        await Promise.race([entered.promise, guiChange.then(() => { throw Error('Host did not enter the configuration replacement'); })]);
        const conflict = await cli(['autostart', manualEntry, 'off']).then(() => undefined, error => error);
        assert.equal(conflict?.code, 1);
        assert.match(conflict?.stderr ?? '', /CONFIG_CONFLICT/);
        assert.ok(conflict.stderr.includes(configPath));
        assert.equal(await fs.readFile(configPath, 'utf8'), jsonc(latest));
        facts.conflict = { exitCode: conflict.code, stderr: conflict.stderr, originalUnchanged: true };
    } finally {
        finish.resolve();
        await guiChange;
        gated.mock.restore();
    }
    const changed = await cli(['autostart', manualEntry, 'off']);
    const final = await Config.getTuiConfig();
    assert.deepEqual(final, { ...latest, apps: { ...latest.apps, [manualEntry]: { ...latest.apps[manualEntry], autoStart: false },
        [disabledEntry]: { ...latest.apps[disabledEntry], enabled: false } } });
    const readThroughGui = await host.getAppsConfig();
    assert.equal(readThroughGui[manualEntry].autoStart, false);
    assert.equal(readThroughGui[disabledEntry].enabled, false);
    assert.equal((await host.getLLMConfigService().withModelInputBudget(llm as LLMConfig).inputBudget?.({
        providerId: llm.provider.id, modelId: llm.model,
    }))?.contextWindow, 64_000);
    facts.latest = { final, cli: changed.stdout, gui: readThroughGui };

    const valid = await fs.readFile(configPath, 'utf8');
    const badConfig = '/* unclosed\n' + valid;
    await fs.writeFile(configPath, badConfig);
    await assert.rejects(host.setAppEnabled(disabledEntry, true), { code: 'CONFIG_INVALID', path: configPath });
    await assert.rejects(cli(['autostart', manualEntry, 'on']), error => {
        const reason = error as { stderr: string; code: number };
        return reason.code === 1 && reason.stderr.includes('CONFIG_INVALID') && reason.stderr.includes(configPath);
    });
    assert.equal(await fs.readFile(configPath, 'utf8'), badConfig);
    await fs.writeFile(configPath, valid);
    const failed = mock.method(fs, 'rename', async () => { throw Object.assign(Error('simulated rename refusal'), { code: 'EACCES' }); });
    try {
        await assert.rejects(host.setAppEnabled(disabledEntry, true), { code: 'CONFIG_WRITE_FAILED', path: configPath });
        assert.equal(await fs.readFile(configPath, 'utf8'), valid);
        assert.deepEqual((await fs.readdir(join(home, '.agentina'))).sort(), ['config.json', 'config.json.lock']);
    } finally { failed.mock.restore(); }
    facts.invalidWrites = { corruptCode: 'CONFIG_INVALID', renameCode: 'CONFIG_WRITE_FAILED', path: configPath, filePreserved: true };
    facts.npm = await verifyNpm();

    const local = await cli(['install', installed, '--no-autostart']);
    assert.match(local.stdout, /Successfully linked local app: catalog_draft/);
    assert.equal((await host.getAppDetail(appName)).source, 'local:' + installed);
    assert.deepEqual(await appEffects(manifest), []);
    const cliRun = await runLocalApp();
    const cliEffects = await appEffects(manifest);
    assert.deepEqual(cliEffects.map(item => item.event), ['import', 'initialize', 'close']);
    assert.ok(cliEffects.every(item => item.threadId > 0));
    await fs.unlink(join(dirname(manifest.modulePath), 'catalog-effects.jsonl'));
    await host.removeApp(appName);
    assert.ok(existsSync(manifest.modulePath));
    facts.local = { install: local.stdout, cliRun, cliEffects, removed: true, appFilesPreserved: true };

    const now = Date.now();
    db.createTopic({ id, agentId: id, title: id, status: 'hot', createdAt: now, updatedAt: now });
    await host.ensureSessionForTopic(id);
    host.pauseAgent(id);
    const session = host.getSessionManager()!.getSession(id)!;
    const desktop = session.desktop;
    facts.directory = desktop.listApps();
    assert.deepEqual(desktop.listApps().map(item => [item.installationId, item.appId, item.status]), [
        [autoEntry, appName, 'running'], [manualEntry, undefined, 'pending'],
    ]);
    assert.equal((await appEffects(manifest)).filter(item => item.event === 'import').length, 1);
    facts.delivery = await exerciseCatalog(async (label, calls, beforeReply) => {
        const count = delivered.length;
        provider.replyNext({ label, calls, beforeReply });
        await host.sendUserMessage(label, id);
        host.resumeAgent(id);
        const request = await watchUntil(() => provider.requests.find(item => item.label === label));
        const event = calls.length ? await watchUntil(() => delivered[count]) : undefined;
        await watchUntil(() => session.agentDriver.getState() === 'idle');
        return { body: request.body, message: event?.message };
    }, runtime, desktop, workers.events);
    const disk = new Database(join(runtimeData, 'app-state/state.sqlite3'), { readonly: true, fileMustExist: true });
    try {
        facts.persisted = disk.prepare('select namespace, key, record from aotui_state').all().map(row => {
            const entry = row as { namespace: string; key: string; record: string };
            return [JSON.parse(entry.namespace), entry.key, JSON.parse(entry.record).value];
        });
        assert.deepEqual(facts.persisted, [[[id, autoEntry], 'draft', draftText]]);
    } finally { disk.close(); }
    const effects = await appEffects(manifest);
    facts.effects = effects;
    assert.equal(effects.filter(item => item.event === 'save').length, 1);
    assert.deepEqual(workers.events.filter(item => item.type === 'storage' && item.address).map(item =>
        [item.action, JSON.parse(item.address.namespace), item.address.key]), [
        ['replace', [id, autoEntry], 'draft'], ['read', [id, manualEntry], 'draft'],
    ]);
    await host.shutdownSession(id);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    unsubscribe();
    await host.dispose();
    facts.shutdown = await runtime.beginClose().completion;
    workers.restore();
    await provider.close();
    db.closeDatabase();
    mock.restoreAll();
    await fs.writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await fs.rm(state, { recursive: true, force: true });
}
assert.ok((facts.shutdown as { ok: boolean; resourcesReleased: boolean }).ok);
assert.ok((facts.shutdown as { ok: boolean; resourcesReleased: boolean }).resourcesReleased);
assert.equal(workers.events.filter(item => item.type === 'init').length, workers.events.filter(item => item.type === 'exit').length);
