import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const factsFile = process.argv[2];
const facts = { profile: 'scoped-ide-ordinary-v2', startedAt: new Date().toISOString(), cases: [], calls: [], cleanup: [], passed: false };
const working = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-full-ide-')));
const consumer = process.env.AOTUI_IDE_CONSUMER ?? path.join(working, 'consumer'), modules = path.join(consumer, 'node_modules');
const apps = [];
let Host, entry, sequence = 0;
async function setup() {
    if (!process.env.AOTUI_IDE_CONSUMER) {
    await fs.mkdir(path.join(modules, '@aotui'), { recursive: true });
    await fs.mkdir(path.join(modules, '@agentina'), { recursive: true });
    for (const [source, target] of [['runtime', '@aotui/runtime'], ['sdk', '@aotui/sdk'], ['demo-apps/aotui-ide', '@agentina/aotui-ide']]) {
        const base = path.join(modules, target); await fs.mkdir(base);
        await fs.copyFile(path.join(repo, source, 'package.json'), path.join(base, 'package.json'));
        await fs.cp(path.join(repo, source, 'dist'), path.join(base, 'dist'), { recursive: true });
    }
    for (const source of ['runtime', 'sdk', 'demo-apps/aotui-ide']) {
        const deps = path.join(repo, source, 'node_modules');
        for (const name of await fs.readdir(deps)) {
            if (name.startsWith('.') || name === '@aotui' || name === '@agentina') continue;
            try { await fs.symlink(path.join(deps, name), path.join(modules, name), 'dir'); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
    }
    }
    Host = (await import(pathToFileURL(path.join(modules, '@aotui/runtime/dist/engine/app/worker-host.js')))).AppWorkerHost;
    entry = (await import(pathToFileURL(path.join(modules, '@agentina/aotui-ide/dist/index.js')))).ideEntryForRoute;
}
async function eventually(read, label, ms = 15000) {
    const end = Date.now() + ms;
    while (true) {
        const value = read(); if (value) return value;
        if (Date.now() >= end) throw Error('Barrier expired: ' + label);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
const snapshot = x => x.host.shadowReceiver?.core.store.readLatest(x.id)?.snapshot;
const toolNames = x => Object.values(snapshot(x)?.tools ?? {}).map(tool => tool.name);
const viewText = (x, id) => snapshot(x)?.views.find(view => view.id === id)?.content.value ?? '';
function fileView(x, file) { return snapshot(x)?.views.find(view => view.type === 'FileDetail' && view.content.value.includes(file)); }
async function start(root, id, options = {}) {
    const data = options.data ?? path.join(working, id, 'data'); await fs.mkdir(data, { recursive: true });
    const worker = options.worker ?? new Worker(process.env.AOTUI_IDE_WORKER_SCRIPT ?? path.join(modules, '@aotui/runtime/dist/worker-runtime/index.js'), { stdout: true, stderr: true });
    const logs = [], messages = [];
    worker.stdout?.on('data', buffer => { logs.push(String(buffer)); if (logs.length > 30) logs.shift(); });
    worker.stderr?.on('data', buffer => { logs.push(String(buffer)); if (logs.length > 30) logs.shift(); });
    worker.on('message', message => { if (message.type !== 'SNAPSHOT_PREPARED') messages.push(message.type); });
    const route = options.route ?? 'scoped';
    const host = new Host({ appId: id, desktopId: 'test', appModulePath: entry(route).href, existingWorker: worker,
        snapshotShadow: true, experimentalReadOnlyViewTools: true,
        experimentalInteractionModes: ['ordinary-v2', 'ordinary-v1', 'create-if-absent-v1'], timeout: 45000,
        config: { ideToolRoute: route, projectPath: root, ideSessionKey: options.sessionKey ?? id,
            ideHistoryPath: options.historyPath ?? path.join(working, 'history', id + '.json'),
            ideLegacyDatabasePath: path.join(working, 'legacy', id + '.json'), ideLegacyImportPath: options.legacy,
            enableDiagnosticsRead: options.slices !== false, enableWorkspaceCreate: options.slices !== false, AOTUI_DATA_DIR: data },
    });
    const x = { id, host, worker, logs, messages, data, closed: false }; apps.push(x);
    await host.start(); await host.open();
    try { await eventually(() => toolNames(x).includes('multi_open_file'), id + ' ready'); }
    catch (error) { console.error('APP DEBUG', logs, host.getSnapshotFragment(), host.getSnapshotShadowReport()); throw error; }
    return x;
}
function scope(x) {
    const opened = x.host.createInteractionScope({ project: ({ source, selection }) => {
        const ids = new Set(selection.viewIds), selected = source.views.filter(view => ids.has(view.id));
        return { views: selected.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
            refs: [],
            targets: Object.values(source.tools).flatMap(tool => tool.targets.filter(target => ids.has(target.viewId)).map(target => ({ toolId: tool.id, target }))),
            content: selected.map(view => ({ view: { viewId: view.id, viewInstanceId: view.viewInstanceId }, decision: 'retain' })) };
    }, authorize: () => true, canReadReceipt: () => true });
    assert.equal(opened.status, 'opened', JSON.stringify(opened)); return opened.client;
}
async function invoke(x, name, args, { view = 'workspace', status = 'succeeded', changes = true, observation, client } = {}) {
    const owned = !client, c = client ?? scope(x);
    const observed = observation ?? (await c.observe({ viewIds: [view] })).observation;
    assert.ok(observed, 'Observation exists for ' + name);
    const tool = observed.tools.find(tool => tool.name === name); assert.ok(tool, 'Tool exists: ' + name);
    const binding = observed.bindings.find(binding => binding.toolId === tool.id && binding.target.viewId === view); assert.ok(binding);
    const beforeRevision = snapshot(x).revision;
    const started = performance.now();
    try {
        const reply = await c.invoke({ invocationId: 'ide-' + ++sequence, observationId: observed.observationId, bindingId: binding.bindingId, input: args });
        assert.equal(reply.kind, 'receipt', name + ': ' + JSON.stringify(reply));
        const outcome = reply.receipt.outcome;
        facts.calls.push({ name, view, status: outcome.status, elapsedMs: performance.now() - started, outcome });
        assert.equal(outcome.status, status, name + ': ' + JSON.stringify(outcome));
        // Callers disable this for operations whose displayed state is unchanged.
        // A Tool receipt completes its handler; rendering may publish afterwards.
        if (changes && status === 'succeeded') await eventually(() => snapshot(x).revision > beforeRevision, name + ' published snapshot');
        return outcome;
    } finally { if (owned) c.close(); }
}
async function close(x, transfer = false) {
    await x.host.close();
    const worker = await x.host.releaseWorker(); assert.equal(worker, x.worker, 'Only a successful close returns its Worker');
    const report = await x.host.waitForResourceRelease(); facts.cleanup.push({ id: x.id, report });
    if (report.appCleanup?.support === 'managed') assert.deepEqual([report.appCleanup.report.state, report.appCleanup.report.issues], ['completed', []]);
    assert.equal(report.resourcesReleased, true); x.closed = true;
    if (!transfer) await worker.terminate();
    return worker;
}
async function runCase(name, run) { const started = performance.now(); await run(); facts.cases.push({ name, elapsedMs: performance.now() - started, passed: true }); console.log('PASS', name); }
await setup();
export { repo, factsFile, facts, working, consumer, modules, apps, start, scope, snapshot, toolNames, viewText, fileView, invoke, close, eventually, runCase };
