import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createRuntime } from '../../../runtime/dist/index.js';
import { apps, close, eventuallyProjected, facts, factsFile, fileView, invoke, modules, runCase, scope, start, viewText, working } from './ide-test-harness.mjs';

const entry = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../dist/index.js');

const delayRenameBootstrap = path.join(working, 'delay-session-rename-worker.mjs');
await fs.writeFile(delayRenameBootstrap, `
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parentPort, workerData } from 'node:worker_threads';

if (workerData.expectedTmpdir && tmpdir() !== workerData.expectedTmpdir) {
    throw new Error('Worker did not use its configured temporary directory.');
}
const origRename = fs.rename.bind(fs);
fs.rename = async function (from, to) {
    if (String(to) === workerData.sessionPath && workerData.mode === 'hang') {
        parentPort.postMessage({ type: 'TEST_SESSION_RENAME_HANGING' });
        await new Promise(() => {});
    }
    if (String(to) === workerData.sessionPath && workerData.mode === 'delay') {
        parentPort.postMessage({ type: 'TEST_SESSION_RENAME_DELAYED' });
        await new Promise(r => setTimeout(r, workerData.delayMs ?? 120));
    }
    if (String(to) === workerData.pauseToolReceiptPath) await new Promise(() => {});
    if (workerData.mode === 'pause-path' && String(to) === workerData.targetPath) {
        parentPort.postMessage({ type: 'TEST_RENAME_PAUSED' });
        Atomics.wait(new Int32Array(workerData.releaseRename ?? new SharedArrayBuffer(4)), 0, 0);
    }
    return origRename(from, to);
};
await import(workerData.entry);
`);

async function callWorkspaceTool(desktop, running, toolName, input) {
    const observed = await running.observe();
    assert.equal(observed.status, 'prepared', JSON.stringify(observed));
    const tool = observed.candidate.observation.tools.find(item => item.name === toolName);
    assert.ok(tool, `Missing tool ${toolName}`);
    const adopted = desktop.adoptTurn({ apps: [{ candidate: observed.candidate }] });
    assert.equal(adopted.status, 'adopted');
    try {
        return await adopted.turn.invoke(running.appId, {
            observationId: observed.candidate.observation.observationId,
            invocationId: `${toolName}-${Date.now()}-${Math.random()}`,
            toolId: tool.id,
            input,
        });
    } finally {
        adopted.turn.release();
    }
}

async function settleAfterWorkerExit(app, pending, locator) {
    await app.worker.terminate();
    const reply = await pending;
    assert.equal(reply.kind, 'receipt');
    assert.equal(reply.receipt.observationId, locator.observationId);
    assert.equal(reply.receipt.invocationId, locator.invocationId);
    assert.equal(reply.receipt.executionPhase, 'unknown');
    assert.equal(reply.receipt.outcome.status, 'unknown');
    assert.equal(reply.receipt.outcome.code, 'ACTION_OUTCOME_UNKNOWN');
    const opened = app.host.getAppInteraction();
    assert.equal(opened.status, 'ready');
    assert.deepEqual(await opened.interaction.readReceipt(locator), reply);

    await app.host.close();
    const report = await app.host.waitForResourceRelease();
    assert.equal(report.worker, 'exited');
    assert.equal(app.worker.threadId, -1);
    assert.equal(report.resourcesReleased, true);
    assert.ok(report.issues.includes('WORKER_EXITED_UNEXPECTEDLY'));
    assert.notEqual(report.appCleanup?.report?.state, 'completed');
    app.closed = true;
    return { report, reply };
}

try {
    await runCase('real Worker restart recovery and explicit empty arrays preserved', async () => {
        const root = path.join(working, 'restart-ws');
        const sub = path.join(root, 'sub');
        const file = path.join(sub, 'a.txt');
        await fs.mkdir(sub, { recursive: true });
        await fs.writeFile(file, 'hello restart\n', 'utf8');

        const data = path.join(working, 'restart-data');
        const historyPath = path.join(working, 'restart-history.json');
        const first = await start(root, 'restart-1', { data, sessionKey: 'restart-key', historyPath });
        await invoke(first, 'multi_open_dirs', { dirPaths: [sub] });
        await invoke(first, 'multi_open_file', { filePaths: [file] });
        await close(first);

        const second = await start(root, 'restart-2', { data, sessionKey: 'restart-key', historyPath });
        assert.ok(fileView(second, file), 'activeFiles must be restored on restart');
        assert.ok(viewText(second, 'workspace').includes('a.txt'), 'expandedDirs must be restored on restart');

        await invoke(second, 'multi_close_dirs', { dirPaths: [root, sub] });
        await invoke(second, 'multi_close_file', { filePaths: [file] });
        await close(second);

        const third = await start(root, 'restart-3', { data, sessionKey: 'restart-key', historyPath });
        assert.equal(fileView(third, file), undefined, 'explicitly closed activeFiles must stay empty');
        assert.ok(!viewText(third, 'workspace').includes('a.txt'), 'explicitly collapsed expandedDirs: [] must stay collapsed');
        await close(third);
    });

    await runCase('dual-Desktop concurrent same-sessionPath writers protect committed data and report SESSION_UPDATE_FAILED', async () => {
        const root = path.join(working, 'dual-ws');
        const fileA = path.join(root, 'a.txt');
        const fileB = path.join(root, 'b.txt');
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(fileA, 'file A', 'utf8');
        await fs.writeFile(fileB, 'file B', 'utf8');

        const sessionPath = path.join(working, 'dual-shared', 'session.json');
        const runtime = createRuntime({ worker: { timeoutMs: 10000 } });
        try {
            const d1 = await runtime.createDesktop('d1');
            const d2 = await runtime.createDesktop('d2');
            const app1 = await d1.installDynamicWorkerApp(pathToFileURL(entry).href, {
                installationId: 'ide1',
                config: { projectPath: root, ideSessionKey: 'dual', ideSessionPath: sessionPath, ideHistoryPath: path.join(working, 'dual-shared', 'h1.json') },
            });
            const app2 = await d2.installDynamicWorkerApp(pathToFileURL(entry).href, {
                installationId: 'ide2',
                config: { projectPath: root, ideSessionKey: 'dual', ideSessionPath: sessionPath, ideHistoryPath: path.join(working, 'dual-shared', 'h2.json') },
            });

            // Wait until both are ready (workspace tools projected)
            for (const app of [app1, app2]) {
                for (let i = 0; i < 40; i++) {
                    const obs = await app.observe();
                    if (obs.status === 'prepared') {
                        const ready = obs.candidate.observation.tools.some(t => t.name === 'multi_open_file');
                        obs.candidate.discard();
                        if (ready) break;
                    }
                    await new Promise(r => setTimeout(r, 25));
                }
            }

            const r1 = await callWorkspaceTool(d1, app1, 'multi_open_file', { filePaths: [fileA] });
            assert.equal(r1.receipt.outcome.status, 'succeeded');
            // Let writer 1 finish persisting before writer 2 triggers its save.
            await new Promise(r => setTimeout(r, 80));

            const r2 = await callWorkspaceTool(d2, app2, 'multi_open_file', { filePaths: [fileB] });
            assert.equal(r2.receipt.outcome.status, 'succeeded');
            await new Promise(r => setTimeout(r, 80));

            // Writer 2's Root View must warn SESSION_UPDATE_FAILED and disk must retain writer 1's committed activeFiles.
            const preview2 = await app2.preview();
            assert.equal(preview2.status, 'previewed');
            const rootView2 = preview2.views.find(v => v.id === 'root')?.content.value ?? '';
            assert.match(rootView2, /SESSION_UPDATE_FAILED/);
            assert.deepEqual(JSON.parse(await fs.readFile(sessionPath, 'utf8')).activeFiles, [fileA]);

            const close1 = await app1.beginClose().completion;
            assert.equal(close1.ok, true);
            assert.equal(close1.appCleanup?.completedApps, 1);

            const close2 = await app2.beginClose().completion;
            assert.equal(close2.ok, false);
            assert.equal(close2.resourcesReleased, true);
            assert.equal(close2.worker, 'exited');
            assert.equal(close2.appCleanup?.failedApps, 1);
        } finally {
            await runtime.beginClose().completion;
        }
    });

    await runCase('close state 1: in-flight session save completes during close and is restored on restart', async () => {
        const root = path.join(working, 'delay-ws');
        const file = path.join(root, 'delayed.txt');
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(file, 'delayed body', 'utf8');

        const data = path.join(working, 'delay-data');
        const sessionPath = path.join(data, 'ide-sessions', 'delay-key', 'session.json');
        const historyPath = path.join(working, 'delay-history.json');
        const worker = new Worker(delayRenameBootstrap, {
            stdout: true, stderr: true,
            workerData: {
                mode: 'delay', delayMs: 120, sessionPath,
                entry: pathToFileURL(path.join(modules, '@aotui/runtime/dist/worker-runtime/index.js')).href,
            },
        });
        let renameDelayed = false;
        worker.on('message', m => { if (m?.type === 'TEST_SESSION_RENAME_DELAYED') renameDelayed = true; });
        const app = await start(root, 'delay-app', { data, sessionKey: 'delay-key', historyPath, worker });
        await invoke(app, 'multi_open_file', { filePaths: [file] });
        assert.equal(renameDelayed, true);
        await close(app);
        assert.equal(worker.threadId, -1);

        const reopened = await start(root, 'delay-reopened', { data, sessionKey: 'delay-key', historyPath });
        assert.ok(fileView(reopened, file), 'delayed in-flight save must be completed during close and restored');
        await close(reopened);
    });

    await runCase('close state 2: diskCommitted true with corrupt session.json warns SESSION_UPDATE_FAILED and fails appCleanup', async () => {
        const root = path.join(working, 'corrupt-ws');
        await fs.mkdir(root, { recursive: true });
        const data = path.join(working, 'corrupt-data');
        const sessionPath = path.join(data, 'ide-sessions', 'corrupt-key', 'session.json');
        const historyPath = path.join(working, 'corrupt-history.json');
        const app = await start(root, 'corrupt-app', { data, sessionKey: 'corrupt-key', historyPath });

        // Corrupt session.json on disk, then create a file (changes activeFiles -> triggers session save).
        await fs.writeFile(sessionPath, '{corrupted', 'utf8');
        const created = await invoke(app, 'create_file', { filePath: path.join(root, 'created.txt'), content: 'committed disk text' });
        assert.equal(created.value.data.diskCommitted, true);
        assert.equal(await fs.readFile(path.join(root, 'created.txt'), 'utf8'), 'committed disk text');

        await new Promise(r => setTimeout(r, 80));
        const preview = await scope(app).preview();
        assert.equal(preview.status, 'previewed');
        const rootText = preview.views.find(v => v.id === 'root')?.content.value ?? '';
        assert.match(rootText, /SESSION_UPDATE_FAILED/);

        await assert.rejects(app.host.close(), /APP_CLEANUP_FAILED|APP_UNMOUNT_FAILED/);
        const report = await app.host.waitForResourceRelease();
        assert.equal(report.resourcesReleased, true);
        assert.equal(report.worker, 'exited');
        assert.equal(report.appCleanup?.report?.state, 'failed');
        app.closed = true;
    });

    await runCase('close state 3: hanging session save hits close deadline without falsely reporting completed cleanup', async () => {
        const root = path.join(working, 'hang-ws');
        const file = path.join(root, 'hang.txt');
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(file, 'hang body', 'utf8');

        const data = path.join(working, 'hang-data');
        const sessionPath = path.join(data, 'ide-sessions', 'hang-key', 'session.json');
        const historyPath = path.join(working, 'hang-history.json');
        const worker = new Worker(delayRenameBootstrap, {
            stdout: true, stderr: true,
            workerData: {
                mode: 'hang', sessionPath,
                entry: pathToFileURL(path.join(modules, '@aotui/runtime/dist/worker-runtime/index.js')).href,
            },
        });
        let renameHanging = false;
        worker.on('message', m => { if (m?.type === 'TEST_SESSION_RENAME_HANGING') renameHanging = true; });
        const app = await start(root, 'hang-app', { data, sessionKey: 'hang-key', historyPath, worker });
        // Starting with a new session queues the first save in the background.
        for (let i = 0; i < 40 && !renameHanging; i++) await new Promise(r => setTimeout(r, 25));
        assert.equal(renameHanging, true);

        const created = await invoke(app, 'create_file', { filePath: path.join(root, 'created-while-hanging.txt'), content: 'saved' });
        assert.equal(created.value.data.diskCommitted, true);

        // Lower host timeout for fast deadline verification
        app.host.timeout = 250;
        await assert.rejects(app.host.close(), /APP_CLOSE_DEADLINE_EXCEEDED/);
        const report = await app.host.waitForResourceRelease();
        assert.equal(report.resourcesReleased, true);
        assert.equal(report.worker, 'exited');
        assert.notEqual(report.appCleanup?.report?.state, 'completed');
        app.closed = true;
    });

    await runCase('session.json lock blocks live concurrent writer and recovers cleanly after Worker termination', async () => {
        const root = path.join(working, 'recover-session-ws');
        const fileA = path.join(root, 'a.txt');
        const fileB = path.join(root, 'b.txt');
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(fileA, 'A', 'utf8');
        await fs.writeFile(fileB, 'B', 'utf8');

        const data = path.join(working, 'recover-session-data');
        const sessionPath = path.join(data, 'ide-sessions', 'recover-key', 'session.json');
        await fs.mkdir(path.dirname(sessionPath), { recursive: true });
        await fs.writeFile(sessionPath, JSON.stringify({
            version: 1,
            workspaceFolders: [root],
            activeFiles: [],
            expandedDirs: [root],
        }), 'utf8');

        // The session save runs in the background. Also gate the history write that the
        // open handler awaits so forced termination exercises an in-flight receipt deterministically.
        const historyPath = path.join(working, 'recover-session-h1.json');
        await fs.writeFile(historyPath, JSON.stringify({ version: 1, workspaces: {} }), 'utf8');
        const worker1 = new Worker(delayRenameBootstrap, {
            stdout: true, stderr: true,
            workerData: {
                mode: 'pause-path', targetPath: sessionPath, pauseToolReceiptPath: historyPath,
                entry: pathToFileURL(path.join(modules, '@aotui/runtime/dist/worker-runtime/index.js')).href,
            },
        });
        let renamePaused = false, openingFinished = false;
        worker1.on('message', m => { if (m?.type === 'TEST_RENAME_PAUSED') renamePaused = true; });
        const app1 = await start(root, 'recover-s1', {
            data, sessionKey: 'recover-key',
            historyPath,
            worker: worker1,
        });

        const client = scope(app1);
        const prepared = await client.prepare();
        assert.equal(prepared.status, 'prepared');
        const observation = prepared.candidate.observation;
        const tool = observation.tools.find(t => t.name === 'multi_open_file');
        assert.ok(tool);
        const turn = client.adopt(prepared.candidate);
        const opening = turn.invoke(app1.id, {
            observationId: observation.observationId,
            invocationId: 'open-with-paused-background-save',
            toolId: tool.id,
            input: { filePaths: [fileA] },
        }).finally(() => { openingFinished = true; });
        for (let i = 0; i < 80 && !renamePaused; i++) await new Promise(r => setTimeout(r, 25));
        assert.equal(renamePaused, true);

        const app2 = await start(root, 'recover-s2', {
            data, sessionKey: 'recover-key',
            historyPath: path.join(working, 'recover-session-h2.json'),
        });
        await invoke(app2, 'multi_open_file', { filePaths: [fileB] });
        await eventuallyProjected(app2, () => viewText(app2, 'root').includes('SESSION_UPDATE_FAILED'), 'app2 SESSION_UPDATE_FAILED');
        assert.deepEqual(JSON.parse(await fs.readFile(sessionPath, 'utf8')).activeFiles, []);
        await assert.rejects(app2.host.close(), /APP_CLEANUP_FAILED|APP_UNMOUNT_FAILED/);
        const report2 = await app2.host.waitForResourceRelease();
        assert.equal(report2.resourcesReleased, true);
        assert.equal(report2.appCleanup.report.state, 'failed');
        app2.closed = true;

        assert.equal(openingFinished, false);
        const { report: report1, reply: openResult } = await settleAfterWorkerExit(app1, opening, {
            observationId: observation.observationId, invocationId: 'open-with-paused-background-save',
        });
        turn.release();
        facts.pausedSessionSave = { report: report1, openResult };

        const app3 = await start(root, 'recover-s3', {
            data, sessionKey: 'recover-key',
            historyPath: path.join(working, 'recover-session-h3.json'),
        });
        await invoke(app3, 'multi_open_file', { filePaths: [fileB] });
        await close(app3);
        assert.ok(!viewText(app3, 'root').includes('SESSION_UPDATE_FAILED'));
        assert.deepEqual(JSON.parse(await fs.readFile(sessionPath, 'utf8')).activeFiles, [fileB]);

        const app4 = await start(root, 'recover-s4', {
            data, sessionKey: 'recover-key',
            historyPath: path.join(working, 'recover-session-h4.json'),
        });
        assert.ok(fileView(app4, fileB), 'saved fileB must be restored after lock release');
        assert.equal(fileView(app4, fileA), undefined);
        await close(app4);
    });

    await runCase('rename_file lock blocks live writer, reports an unknown outcome on Worker termination, and recovers after owner exit', async () => {
        const root = path.join(working, 'recover-rename-ws');
        const src = path.join(root, 'src.txt');
        const dst = path.join(root, 'dst.txt');
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(src, 'hello rename', 'utf8');

        const worker1 = new Worker(delayRenameBootstrap, {
            stdout: true, stderr: true,
            workerData: {
                mode: 'pause-path', targetPath: dst,
                entry: pathToFileURL(path.join(modules, '@aotui/runtime/dist/worker-runtime/index.js')).href,
            },
        });
        let renamePaused = false;
        worker1.on('message', m => { if (m?.type === 'TEST_RENAME_PAUSED') renamePaused = true; });
        const app1 = await start(root, 'recover-r1', { worker: worker1 });
        const app2 = await start(root, 'recover-r2');

        await invoke(app1, 'multi_open_file', { filePaths: [src] });
        await invoke(app2, 'multi_open_file', { filePaths: [src] });
        const view1 = fileView(app1, src);
        const view2 = fileView(app2, src);
        assert.ok(view1 && view2);

        const client1 = scope(app1);
        const prepared1 = await client1.prepare();
        assert.equal(prepared1.status, 'prepared');
        const obs1 = prepared1.candidate.observation;
        const renameTool1 = obs1.tools.find(t => t.name === 'rename_file');
        assert.ok(renameTool1);
        const turn1 = client1.adopt(prepared1.candidate);
        const pendingRename1 = turn1.invoke(app1.id, {
            invocationId: 'ide-rename-hang-1',
            observationId: obs1.observationId,
            toolId: renameTool1.id,
            viewId: view1.id,
            input: { newPath: dst },
        });

        for (let i = 0; i < 80 && !renamePaused; i++) await new Promise(r => setTimeout(r, 25));
        assert.equal(renamePaused, true);

        await new Promise(r => setTimeout(r, 750));
        const liveContention = await invoke(app2, 'rename_file', { newPath: dst }, { view: view2.id, status: 'failed', changes: false });
        assert.equal(liveContention.details?.result.error.code, 'RESOURCE_BUSY');
        assert.equal(await fs.readFile(src, 'utf8'), 'hello rename');
        await assert.rejects(fs.lstat(dst), { code: 'ENOENT' });

        const { report: report1, reply: reply1 } = await settleAfterWorkerExit(app1, pendingRename1, {
            observationId: obs1.observationId, invocationId: 'ide-rename-hang-1',
        });
        turn1.release();
        facts.pausedWorkspaceRename = { report: report1, interrupted: reply1, liveContention };

        await invoke(app2, 'rename_file', { newPath: dst }, { view: view2.id, status: 'succeeded' });
        assert.equal(await fs.readFile(dst, 'utf8'), 'hello rename');
        await assert.rejects(fs.lstat(src), { code: 'ENOENT' });
        await close(app2);

        const app3 = await start(root, 'recover-r3');
        assert.ok(viewText(app3, 'workspace').includes('dst.txt'));
        assert.ok(!viewText(app3, 'workspace').includes('src.txt'));
        await close(app3);
    });

    await runCase('write_file reserves the same file across distinct Worker temporary directories', async () => {
        const root = path.join(working, 'shared-file');
        const file = path.join(root, 'Shared.txt');
        const alias = path.join(root, 'shared.txt');
        const firstTmpdir = path.join(working, 'first-tmp');
        const otherTmpdir = path.join(working, 'other-tmp');
        await Promise.all([root, firstTmpdir, otherTmpdir].map(directory => fs.mkdir(directory)));
        await fs.writeFile(file, 'original');
        // Exercise the alternate spelling on filesystems that map it to the same file.
        const otherFile = await fs.realpath(alias).then(() => alias, error => {
            if (error.code !== 'ENOENT') throw error;
            return file;
        });

        const workerEntry = pathToFileURL(path.join(modules, '@aotui/runtime/dist/worker-runtime/index.js')).href;
        const releaseRename = new Int32Array(new SharedArrayBuffer(4));
        const spawn = (directory, options = {}) => new Worker(delayRenameBootstrap, {
            env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
            stdout: true, stderr: true,
            workerData: { entry: workerEntry, expectedTmpdir: directory, ...options },
        });
        const firstWorker = spawn(firstTmpdir, { mode: 'pause-path', targetPath: file, releaseRename: releaseRename.buffer });
        const paused = new Promise(resolve => firstWorker.on('message', message => {
            if (message?.type === 'TEST_RENAME_PAUSED') resolve();
        }));
        const first = await start(root, 'shared-file-first', { worker: firstWorker });
        const other = await start(root, 'shared-file-other', { worker: spawn(otherTmpdir) });
        await invoke(first, 'multi_open_file', { filePaths: [file] });
        await invoke(other, 'multi_open_file', { filePaths: [otherFile] });
        const writing = invoke(first, 'write_file', { content: 'first writer' }, { view: fileView(first, file).id });
        let written;
        try {
            await Promise.race([paused, writing.then(() => { throw new Error('First writer did not pause before rename.'); })]);
            const refused = await invoke(other, 'write_file', { content: 'other writer' }, {
                view: fileView(other, otherFile).id, status: 'failed', changes: false,
            });
            assert.equal(refused.details.result.error.code, 'RESOURCE_BUSY');
            assert.equal(await fs.readFile(file, 'utf8'), 'original');
            facts.distinctTemporaryDirectories = { firstTmpdir, otherTmpdir, file, otherFile, refused };
        } finally {
            Atomics.store(releaseRename, 0, 1);
            Atomics.notify(releaseRename, 0);
            written = await writing;
        }

        assert.equal(written.value.data.diskCommitted, true);
        const diskContent = await fs.readFile(file, 'utf8');
        assert.equal(diskContent, 'first writer');
        Object.assign(facts.distinctTemporaryDirectories, { written, diskContent });
        if (otherFile !== file) {
            const aliasRename = await invoke(first, 'rename_file', { newPath: otherFile }, {
                view: fileView(first, file).id, status: 'failed', changes: false,
            });
            assert.equal(aliasRename.details.result.error.code, 'RESOURCE_ALREADY_EXISTS');
            assert.equal(await fs.readFile(file, 'utf8'), diskContent);
            facts.distinctTemporaryDirectories.aliasRename = aliasRename;
        }
        await close(first);
        await close(other);
    });

    facts.passed = true;
} catch (error) {
    facts.failure = { message: String(error), stack: error.stack };
    console.error(error);
    process.exitCode = 1;
} finally {
    for (const app of apps) if (!app.closed) {
        try { await app.host.close(); } catch {}
        app.host.terminate();
        await app.host.waitForResourceRelease();
    }
    facts.working = working;
    facts.finishedAt = new Date().toISOString();
    if (factsFile) await fs.writeFile(factsFile, JSON.stringify(facts, null, 2));
}
