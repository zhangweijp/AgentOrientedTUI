import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { factsFile, facts, working, modules, apps, start, fileView, viewText, invoke, close, runCase } from './ide-test-harness.mjs';

// Inject only an inability to inspect a process group. Healthy release must
// still be earned by the unmodified OS probe; this fixture never invents ESRCH.
const bootstrap = path.join(working, 'permission-probe-worker.mjs');
await fs.writeFile(bootstrap, `
import { parentPort, workerData } from 'node:worker_threads';
const nativeKill = process.kill, counts = new Map();
process.kill = function (target, signal) {
    if (target >= 0) return nativeKill.call(process, target, signal);
    const count = counts.get(target) ?? 0;
    if (signal === 0 && (workerData.mode === 'persistent' || count < 3)) {
        counts.set(target, count + 1);
        parentPort.postMessage({ type: 'TEST_GROUP_PROBE', target, signal, injected: true, code: 'EPERM' });
        throw Object.assign(Error('fixture permission denial'), { code: 'EPERM' });
    }
    try {
        const result = nativeKill.call(process, target, signal);
        parentPort.postMessage({ type: 'TEST_GROUP_PROBE', target, signal, injected: false, result });
        return result;
    } catch (error) {
        parentPort.postMessage({ type: 'TEST_GROUP_PROBE', target, signal, injected: false, code: error.code });
        throw error;
    }
};
await import(workerData.entry);
`);
facts.profile = 'w10-app-close-permission-v1';
facts.probes = [];
facts.processes = [];
async function proveGone(target) {
    const until = Date.now() + 5000, codes = [];
    while (true) {
        try { process.kill(target, 0); codes.push('exists'); }
        catch (error) {
            codes.push(error.code);
            if (error.code === 'ESRCH') return codes;
            if (error.code !== 'EPERM') throw error;
        }
        assert.ok(Date.now() < until, 'Real PID/group did not become absent: ' + target);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}
try {
    for (const mode of ['transient', 'persistent']) await runCase(mode + ' group denial travels through real TS, IDE owner and Host release', async () => {
        const root = path.join(working, mode); await fs.mkdir(root);
        const file = path.join(root, 'file.ts'); await fs.writeFile(file, 'export const value = 42;\n');
        await fs.writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
        const worker = new Worker(bootstrap, { stdout: true, stderr: true, workerData: {
            mode, entry: pathToFileURL(path.join(modules, '@aotui/runtime/dist/worker-runtime/index.js')).href,
        } });
        const probes = [], pendingBoundaries = []; let app;
        worker.on('message', message => {
            if (message.type !== 'TEST_GROUP_PROBE') return;
            probes.push(message);
            if (message.injected && pendingBoundaries.length === 0) pendingBoundaries.push({ report: app?.host.getResourceReport(), workerThreadId: worker.threadId });
        });
        facts.probes.push({ mode, probes });
        app = await start(root, mode, { worker });
        await invoke(app, 'multi_open_file', { filePaths: [file] });
        const query = await invoke(app, 'lsp_hover', { file_path: file, line: 1, character: 15 }, { view: fileView(app, file).id });
        const detail = fileView(app, file);
        assert.ok(detail, 'The FileDetail View remains projected after the hover query');
        assert.equal(query.value.data.view_id, detail.id);
        assert.equal(query.value.data.value, undefined, 'The Tool result is a receipt; hover data belongs to the View');
        const hoverJson = viewText(app, detail.id).split('### hover\n')[1]?.match(/```[^\n]*\n([\s\S]*?)\n```/);
        assert.ok(hoverJson, 'The current FileDetail View contains the structured hover panel');
        const hoverValue = JSON.parse(hoverJson[1]).value;
        assert.ok(hoverValue, 'The current hover panel contains actual LSP data');
        assert.match(JSON.stringify(hoverValue), /42/);
        if (mode === 'transient') {
            await close(app);
            assert.equal(worker.threadId, -1);
            const groupsAtRelease = [...new Set(probes.map(probe => probe.target))];
            assert.equal(groupsAtRelease.length, 1);
            for (const target of groupsAtRelease) assert.ok(probes.some(probe => probe.target === target && !probe.injected && probe.signal === 0 && probe.code === 'ESRCH'));
            facts.releaseBoundary = { probeCount: probes.length, nativeAbsentGroups: groupsAtRelease, verifiedByCloseCompletion: true };
            const reopened = await start(root, 'transient-reopened', { data: app.data, sessionKey: mode });
            assert.notEqual(reopened.worker, worker);
            assert.ok(fileView(reopened, file));
            await close(reopened);
        } else {
            await assert.rejects(app.host.close(), /APP_CLEANUP_FAILED/);
            const report = await app.host.waitForResourceRelease();
            facts.cleanup.push({ id: app.id, report });
            assert.equal(report.resourcesReleased, true);
            assert.equal(report.appCleanup.report.state, 'failed');
            assert.ok(report.appCleanup.report.issues.length > 0);
            assert.equal(worker.threadId, -1);
            app.closed = true;
        }
        assert.equal(pendingBoundaries.length, 1);
        assert.notEqual(pendingBoundaries[0].report.appCleanup.report?.state, 'completed');
        assert.equal(pendingBoundaries[0].report.resourcesReleased, false);
        assert.ok(pendingBoundaries[0].workerThreadId > 0);
        facts.probes.at(-1).pendingBoundaries = pendingBoundaries;
        const groups = [...new Set(probes.map(probe => probe.target))]; assert.equal(groups.length, 1);
        for (const target of groups) {
            const group = probes.filter(probe => probe.target === target);
            if (mode === 'transient') {
                assert.equal(group.filter(probe => probe.injected && probe.signal === 0).length, 3);
                assert.ok(group.some(probe => !probe.injected && probe.signal === 0 && probe.code === 'ESRCH'));
                assert.equal(group.some(probe => probe.signal !== 0), false, 'Normal release needs no forced signal');
            } else {
                assert.ok(group.filter(probe => probe.signal === 0).length > 3);
                assert.deepEqual(group.filter(probe => probe.signal !== 0).map(probe => probe.signal), ['SIGTERM', 'SIGKILL']);
                assert.ok(group.filter(probe => probe.signal !== 0).every(probe => !probe.injected));
                assert.equal(group.some(probe => probe.signal === 0 && probe.code === 'ESRCH'), false);
            }
            facts.processes.push({ mode, pid: -target, pidProbes: await proveGone(-target), groupProbes: await proveGone(target) });
        }
    });
    facts.passed = true;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally {
    for (const app of apps) if (!app.closed) {
        try { await app.host.close(); } catch (error) { facts.cleanup.push({ id: app.id, failedCleanup: String(error), report: app.host.getResourceReport() }); }
        app.host.terminate(); await app.host.waitForResourceRelease();
    }
    // A failed assertion must not conceal live fixture-owned processes.
    for (const target of new Set(facts.probes.flatMap(item => item.probes.map(probe => probe.target)))) {
        try { await proveGone(-target); await proveGone(target); }
        catch (error) { facts.cleanupFailure = String(error); process.exitCode = 1; }
    }
    facts.resourceLogs = apps.map(app => ({ id: app.id, logs: app.logs }));
    facts.working = working; facts.finishedAt = new Date().toISOString();
    if (factsFile) await fs.writeFile(factsFile, JSON.stringify(facts, null, 2));
    console.log('CLOSE_FACTS', JSON.stringify({ passed: facts.passed, cases: facts.cases.length, factsFile }));
}
