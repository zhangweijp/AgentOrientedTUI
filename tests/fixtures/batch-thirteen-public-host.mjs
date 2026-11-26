import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fixtureProvider, modelCall, watchUntil } from './batch-two-support.mjs';
import { llmConfig, savedParts } from './batch-ten-delivery.mjs';
import { appEffects, appName, artifactFacts, autoEntry, checkPendingRequest, draftText, exerciseCatalog,
    explicitStorageKey, manualEntry, recordCatalogWorkers } from './batch-thirteen-catalog.mjs';

const [archive, installed, evidence] = process.argv.slice(2);
const state = await fsp.mkdtemp(join(os.tmpdir(), 'aotui-b13-independent-'));
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const productAccesses = [];
mock.method(os, 'homedir', () => state);
function guard(module, methods) {
    for (const method of methods) {
        const original = module[method];
        mock.method(module, method, function (file, ...args) {
            if (String(file).includes('/.agentina/')) {
                productAccesses.push({ method, path: String(file) });
                throw Error('The independent Host attempted to access product configuration or cache');
            }
            return original.call(this, file, ...args);
        });
    }
}
guard(fs, ['accessSync', 'existsSync', 'openSync', 'readFileSync', 'statSync', 'readdirSync']);
guard(fsp, ['access', 'mkdir', 'open', 'readFile', 'stat', 'readdir', 'writeFile']);
syncBuiltinESMExports();

const { createRuntime, readAppManifest } = await import('@aotui/runtime');
const { AgentDriverV2 } = await import('@aotui/agent-driver-v2');
const { SemanticAOTUIDrivenSource } = await import('@aotui/agent-driver-adapter');
const runtime = createRuntime();
const desktop = await runtime.createDesktop('catalog-public');
const provider = await fixtureProvider();
const history = [], delivered = [], errors = [];
const source = new SemanticAOTUIDrivenSource(desktop);
const driver = new AgentDriverV2({ sources: [source, { name: 'History', onUpdate: () => () => {},
    async getContext() { return { messages: history.slice(), tools: {} }; } }], llm: llmConfig(provider.url),
    onAssistantMessage(message) {
        history.push({ ...message, timestamp: history.length + 1, region: 'session' });
        if (typeof message.content === 'string') driver.pause();
    },
    onToolResult(message) {
        history.push({ ...message, timestamp: history.length + 1, region: 'session' });
        delivered.push(message); driver.pause();
    },
    onRunError(error) { errors.push(String(error)); },
});
driver.pause();
const workers = recordCatalogWorkers();
const facts = { wire: provider.requests, workerEvents: workers.events, errors, productAccesses, passed: false };

async function turn(label, calls, beforeReply) {
    const count = delivered.length;
    provider.replyNext({ label, calls, beforeReply });
    history.push({ role: 'user', content: label, timestamp: history.length + 1, region: 'session' });
    driver.resume(); await driver.trigger();
    const request = await watchUntil(() => provider.requests.find(item => item.label === label));
    const message = calls.length ? await watchUntil(() => delivered[count]) : undefined;
    await watchUntil(() => driver.getState() === 'idle');
    driver.pause();
    return { body: request.body, message };
}

try {
    assert.deepEqual(desktop.listApps(), []);
    const manifest = await readAppManifest(installed);
    const entryManifest = await readAppManifest(manifest.modulePath);
    assert.deepEqual(entryManifest, manifest);
    assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.metadata));
    facts.artifact = await artifactFacts(archive, manifest);
    const config = { AOTUI_DATA_DIR: state };
    const a = await desktop.registerPendingApp({ installationId: autoEntry, localPath: installed, config });
    const b = await desktop.registerPendingApp({ installationId: manualEntry, localPath: manifest.modulePath,
        config: { ...config, draftKey: explicitStorageKey } });
    await assert.rejects(desktop.registerPendingApp({ installationId: a, localPath: installed }), { code: 'APP_ALREADY_EXISTS' });
    facts.pending = desktop.listApps();
    assert.deepEqual(facts.pending.map(app => [app.installationId, app.name, app.status, app.appId]), [
        [a, appName, 'pending', undefined], [b, appName, 'pending', undefined],
    ]);
    assert.deepEqual(await appEffects(manifest), []);
    assert.deepEqual(workers.events, []);

    const missing = join(state, 'missing'), mismatch = join(state, 'mismatch');
    await fsp.mkdir(missing);
    await fsp.mkdir(mismatch);
    const manifestJSON = JSON.parse(await fsp.readFile(join(installed, 'aoapp.json'), 'utf8'));
    await fsp.writeFile(join(missing, 'aoapp.json'), JSON.stringify({ ...manifestJSON, entry: { main: './not-built.mjs' } }));
    await fsp.writeFile(join(mismatch, 'aoapp.json'), JSON.stringify({ ...manifestJSON, app_name: 'wrong_factory',
        entry: { main: manifest.modulePath } }));
    const issue = await desktop.registerPendingApp({ installationId: 'broken', localPath: missing }).catch(error => error);
    facts.invalidManifest = { code: issue.code, path: issue.context?.path };
    assert.deepEqual(facts.invalidManifest, { code: 'APP_MANIFEST_INVALID', path: join(missing, 'aoapp.json') + '#entry.main' });
    assert.deepEqual(workers.events, []);

    const opening = [modelCall('launch-first', 'system-open_app', { installation_id: a })];
    const first = await turn('launch-first', opening, async body => {
        checkPendingRequest(body);
        assert.deepEqual(await appEffects(manifest), []);
    });
    assert.deepEqual(savedParts(first.message, opening)[0].output, { type: 'json', value: { success: true, app_id: appName } });
    assert.equal((await appEffects(manifest)).filter(item => item.event === 'initialize').length, 1);
    facts.delivery = await exerciseCatalog(turn, desktop, workers.events);
    const catalogEffects = await appEffects(manifest);
    assert.equal(catalogEffects.filter(item => item.event === 'save').length, 1);
    const storage = catalogEffects.filter(item => item.event === 'save' || item.event === 'lookup').map(item =>
        [item.event, item.storageKey]);
    assert.deepEqual(storage, [['save', appName], ['lookup', explicitStorageKey]]);
    facts.storage = storage;

    const bad = await desktop.registerPendingApp({ installationId: 'mismatched', localPath: mismatch, config });
    const failure = await desktop.openApp(bad).catch(error => error);
    const errorChain = [];
    for (let next = failure; next; next = next.cause) errorChain.push({ code: next.code, message: next.message });
    facts.factoryMismatch = errorChain;
    assert.equal(errorChain[0]?.code, 'INSTALL_FAILED');
    assert.ok(errorChain.some(error => error.code === 'APP_IDENTITY_MISMATCH'), JSON.stringify(errorChain));
    const effect = await appEffects(manifest);
    assert.equal(effect.filter(item => item.event === 'initialize').length, 2);
    const wrong = workers.events.find(item => item.type === 'init' && item.appId === 'wrong_factory');
    assert.ok(effect.some(item => item.threadId === wrong?.threadId && item.event === 'import'));
    assert.ok(!effect.some(item => item.threadId === wrong?.threadId && item.event === 'initialize'));
    assert.ok(workers.events.some(item => item.type === 'exit' && item.threadId === wrong?.threadId));

    const bare = join(state, 'bare.mjs');
    await fsp.writeFile(bare, 'export { default } from ' + JSON.stringify(pathToFileURL(manifest.modulePath).href) + ';');
    await assert.rejects(desktop.installDynamicWorkerApp(bare), { code: 'APP_MANIFEST_INVALID' });
    const bareRun = await desktop.installDynamicWorkerApp(bare, { name: appName, installationId: 'trusted_bare', config });
    const bareApp = bareRun.appId;
    assert.notEqual(bareApp, appName);
    assert.equal((await bareRun.beginClose().completion).ok, true);
    const stillRunning = await turn('healthy-after-failures', []);
    assert.ok(stillRunning.body.messages.some(item => item.role === 'user' && item.content.includes(draftText)));
    assert.equal((await appEffects(manifest)).filter(item => item.event === 'save').length, 1);
    facts.effects = await appEffects(manifest);
    assert.deepEqual(productAccesses, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    await driver.closeToolTurn();
    driver.dispose();
    await source.dispose();
    facts.shutdown = await runtime.beginClose().completion;
    workers.restore();
    await provider.close();
    if (facts.passed) {
        facts.persisted = await fsp.readFile(join(state, 'catalog-draft', `${desktop.id}-${appName}.txt`), 'utf8');
    }
    mock.restoreAll();
    syncBuiltinESMExports();
    await fsp.writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await fsp.rm(state, { recursive: true, force: true });
}
assert.ok(facts.shutdown.ok && facts.shutdown.resourcesReleased);
assert.equal(facts.persisted, draftText);
assert.equal(workers.events.filter(item => item.type === 'init').length, workers.events.filter(item => item.type === 'exit').length);
