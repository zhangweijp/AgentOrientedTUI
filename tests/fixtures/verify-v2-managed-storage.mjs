import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const folder = resolve(process.argv[2]);
const trace = process.env.AOTUI_BATCH_THREE_MODULES;
assert.ok(trace, 'Set AOTUI_BATCH_THREE_MODULES and preload trace-batch-three-worker.mjs.');
await mkdir(folder, { recursive: true });
const main = [];
registerHooks({ load(url, context, next) { main.push(url); return next(url, context); } });
const { createRuntime, readAppManifest } = await import('@aotui/runtime');
const runtimePath = new URL(import.meta.resolve('@aotui/runtime'));
const fileApp = fileURLToPath(new URL('../examples/files/', runtimePath));
const notesPackage = fileURLToPath(new URL('./node_modules/aotui-storage-draft-plain/', import.meta.url));
const generate = fileURLToPath(new URL('./node_modules/.bin/generate-aoapp', import.meta.url));
const installed = dirname(fileURLToPath(import.meta.url));
const evidence = {}, sqliteWorkers = new Map();
const post = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (message, ...args) {
    if (typeof message?.id === 'number' && message.operation?.type) {
        let worker = sqliteWorkers.get(this.threadId);
        if (!worker) {
            worker = { operations: [], exited: false };
            sqliteWorkers.set(this.threadId, worker);
            this.once('exit', () => { worker.exited = true; });
        }
        worker.operations.push(message.operation.type);
    }
    return Reflect.apply(post, this, [message, ...args]);
};
const storageModule = /(?:\/core\/dist\/persistence(?:\/|\.js)|\/(?:state-storage-host|sqlite-state-storage|state-storage-proxy|state-persistence)\.js)$/;
const modulesByWorker = async () => new Map(await Promise.all((await readdir(trace)).map(async name => [name,
    (await readFile(join(trace, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
])));
const ordinary = rows => [...rows.values()].filter(modules => modules.some(url => url.endsWith('/examples/files/app.mjs')));
const storageRows = modules => modules.filter(url => storageModule.test(url) || url.includes('/core/dist/persistence/'));
const noStorage = modules => assert.deepEqual(storageRows(modules), []);
const scope = () => createRuntime({ worker: { timeoutMs: 4000 } });
const register = async (desktop, installationId, localPath, config) => {
    await desktop.registerPendingApp({ installationId, localPath, config });
    return desktop.openApp(installationId);
};
let nextInvocation = 0;
async function call(desktop, app, name, input = {}) {
    const observed = await app.observe();
    assert.equal(observed.status, 'prepared', JSON.stringify(observed));
    const { candidate } = observed, { observation } = candidate;
    const tool = observation.tools.find(item => item.name === name);
    assert.ok(tool, name);
    const adopted = desktop.adoptTurn({ apps: [{ candidate }] });
    assert.equal(adopted.status, 'adopted');
    try {
        const invoked = await adopted.turn.invoke(app.appId, { observationId: observation.observationId,
            invocationId: String(++nextInvocation), toolId: tool.id, input });
        assert.equal(invoked.kind, 'receipt', JSON.stringify(invoked));
        return invoked.receipt;
    } finally { adopted.turn.release(); }
}

try {
    const sandbox = await mkdtemp(join(installed, 'manifest-controls-'));
    for (const [name, manifest, factory] of [['static', false, null], ['missing-in-manifest', false, true], ['extra-in-manifest', true, false]]) {
        const app = join(sandbox, name);
        const entryRan = join(app, 'entry-ran'), initialized = join(app, 'initialized');
        await mkdir(app);
        await writeFile(join(app, 'package.json'), JSON.stringify({ name, version: '0.1.0', type: 'module', main: './app.mjs',
            aotui: { app_name: 'control', ...(manifest ? { persistence: true } : {}) } }));
        await writeFile(join(app, 'app.mjs'), `import { writeFileSync } from 'node:fs';
import { createApp } from '@aotui/sdk/app';
writeFileSync(${JSON.stringify(entryRan)}, 'entered');
${factory === null ? 'throw Error("Entry must not run during discovery");' : `export default createApp({ app_name: 'control', viewTypes: [], persistence: ${factory},
    initialize() { writeFileSync(${JSON.stringify(initialized)}, 'initialized'); } });`}`);
        execFileSync(generate, [app]);
        const discovered = await readAppManifest(app);
        assert.equal(discovered.persistenceSupport, manifest ? 'state-session-v2' : null);
        assert.equal(existsSync(entryRan), false);
        if (factory === null) { evidence.static = { generated: true, discovered, entryRan: false }; continue; }
        const runtime = scope();
        try {
            const desktop = await runtime.createDesktop(name);
            await desktop.registerPendingApp({ installationId: name, localPath: app });
            assert.equal(existsSync(entryRan), false);
            const error = await desktop.openApp(name).then(() => undefined, reason => reason);
            assert.equal(error?.cause?.code, 'PERSISTENCE_UNAVAILABLE', String(error?.cause));
            assert.equal(existsSync(entryRan), true);
            assert.equal(existsSync(initialized), false);
            evidence[name] = { code: error.cause.code, message: error.cause.message, initialized: false };
        } finally { assert.equal((await runtime.beginClose().completion).resourcesReleased, true); }
    }

    const solo = scope(), input = join(folder, 'files');
    await mkdir(input);
    try {
        const desktop = await solo.createDesktop('ordinary-alone');
        const app = await register(desktop, 'files', fileApp, { folder: input });
        assert.equal((await app.preview()).status, 'previewed');
        const closed = await app.beginClose().completion;
        assert.equal(closed.ok, true);
        assert.equal(closed.worker, 'exited');
        assert.equal(Object.hasOwn(closed, 'persistence'), false);
        noStorage(main);
        const rows = ordinary(await modulesByWorker());
        assert.equal(rows.length, 1);
        noStorage(rows[0]);
        evidence.ordinaryAlone = { closed, mainStorageLoads: 0, workerStorageLoads: 0 };
    } finally { assert.equal((await solo.beginClose().completion).resourcesReleased, true); }

    const a = scope(), b = scope(), data = join(folder, 'shared'), alias = join(folder, 'same-directory');
    await mkdir(data);
    await symlink(data, alias, 'dir');
    try {
        const first = await a.createDesktop('shared-notes'), second = await b.createDesktop('shared-notes');
        const configuration = directory => ({ AOTUI_DATA_DIR: directory });
        const noteA = await register(first, 'notes', notesPackage, configuration(data));
        const noteB = await register(second, 'notes', notesPackage, configuration(alias));
        const ordinaryApp = await register(second, 'files', fileApp, { folder: input });
        const saved = async (desktop, app, value) => {
            assert.equal((await call(desktop, app, 'edit', { text: value })).outcome.status, 'succeeded');
            return call(desktop, app, 'save');
        };
        assert.equal((await saved(first, noteA, 'first writer')).outcome.status, 'succeeded');
        const busy = await saved(second, noteB, 'blocked writer');
        assert.equal(busy.outcome.status, 'failed');
        assert.match(JSON.stringify(busy), /NAMESPACE_BUSY/);
        assert.deepEqual([...sqliteWorkers.values()], [{ operations: ['replace'], exited: false }]);
        const releasedA = await a.beginClose().completion;
        assert.equal(releasedA.ok, true);
        assert.deepEqual([...sqliteWorkers.values()], [{ operations: ['replace'], exited: false }]);
        assert.equal((await ordinaryApp.preview()).status, 'previewed');
        assert.equal((await call(second, noteB, 'load', { adopt: true })).outcome.status, 'succeeded');
        const after = await noteB.preview();
        assert.match(after.views[0].content.value, /Draft: first writer/);
        const takeover = await saved(second, noteB, 'second writer');
        assert.equal(takeover.outcome.status, 'succeeded');
        const closedOrdinary = await ordinaryApp.beginClose().completion;
        assert.equal(closedOrdinary.worker, 'exited');
        assert.equal(Object.hasOwn(closedOrdinary, 'persistence'), false);
        const releasedB = await b.beginClose().completion;
        assert.equal(releasedB.resourcesReleased, true);
        const rows = await modulesByWorker();
        const files = ordinary(rows);
        assert.equal(files.length, 2);
        for (const modules of files) noStorage(modules);
        assert.ok(storageRows(main).some(url => url.endsWith('/sqlite-state-storage.js')));
        assert.deepEqual([...sqliteWorkers.values()], [{ operations: ['replace', 'read', 'replace', 'close'], exited: true }]);
        evidence.shared = { busy, after, takeover, releasedA, releasedB, ordinaryStorageLoads: 0, sqliteWorkers: [...sqliteWorkers] };
    } finally { await Promise.all([a.beginClose().completion, b.beginClose().completion]); }
} finally { Worker.prototype.postMessage = post; await writeFile(join(folder, 'managed-storage.json'), JSON.stringify(evidence, null, 2) + '\n'); }
