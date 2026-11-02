import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { facts, factsFile, working, apps, start, scope, snapshot, fileView, invoke, close } from './ide-test-harness.mjs';
const execute = promisify(execFile), MiB = 1024 * 1024, samplerPIDs = new Set();
facts.profile = 'scoped-ide-ordinary-v2'; facts.rounds = []; facts.node = process.version; facts.platform = process.platform;
const budgets = { smallObserve: 250, typicalObserve: 750, smallCall: 750, typicalOpen: 3000, search: 3000, warmLSP: 3000, boundaryObserve: 3000, close: 5000, coldLSP: 15000 };
let phase = 'setup';
const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
async function memory() {
    const phaseAtStart = phase, startedAt = performance.now();
    const pending = execute('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,comm=']);
    samplerPIDs.add(pending.child.pid); assert.ok(samplerPIDs.size <= 10000, 'Finite measurement helpers');
    const { stdout } = await pending;
    const all = stdout.trim().split('\n').map(line => { const m = line.trim().split(/\s+/); return { pid: +m[0], parent: +m[1], pgid: +m[2], rss: +m[3] * 1024, command: m.slice(4).join(' ') }; });
    const owned = new Set([process.pid]); let changed = true;
    while (changed) { changed = false; for (const item of all) if (!samplerPIDs.has(item.pid) && owned.has(item.parent) && !owned.has(item.pid)) { owned.add(item.pid); changed = true; } }
    const processes = all.filter(item => owned.has(item.pid)); return { at: performance.now(), startedAt, phaseAtStart, phaseAtEnd: phase, threadMemory: process.memoryUsage(), rss: processes.reduce((sum, item) => sum + item.rss, 0), processes,
        excludedSamplingProcesses: all.filter(item => samplerPIDs.has(item.pid)).map(item => ({ pid: item.pid, pgid: item.pgid, command: item.command })) };
}
function verifyClosed(round, before, scenario) {
    const driver = before.processes.find(item => item.pid === process.pid); assert.ok(driver);
    const record = { scenario, driverGroup: driver.pgid, before: before.processes, checks: [] }; round.processChecks.push(record);
    for (const item of before.processes.filter(item => item.pid !== process.pid)) {
        const processGone = gone(item.pid), ownedGroup = item.pgid !== driver.pgid;
        const groupGone = ownedGroup ? gone(-item.pgid) : undefined;
        record.checks.push({ pid: item.pid, pgid: item.pgid, processGone, ownedGroup, groupGone });
        assert.ok(processGone, `Child ${item.pid} still running after close`);
        if (ownedGroup) assert.ok(groupGone, `Owned process group ${item.pgid} still running after close`);
        round.closedProcesses.push({ ...item, gone: processGone, groupGone, ownedGroup });
    }
    assert.ok(record.checks.some(item => item.ownedGroup), 'Actual detached TS process group was observed');
}
function distribution(values) { const sorted = [...values].sort((a, b) => a - b); return { count: values.length, p50: sorted[Math.ceil(values.length * .5) - 1], p95: sorted[Math.ceil(values.length * .95) - 1], max: sorted.at(-1), values }; }
async function samples(round, name, action) {
    phase = name; round.phases.push({ phase, at: performance.now() });
    const values = [];
    for (let i = 0; i < 12; i++) { const time = performance.now(); await action(i); if (i >= 2) values.push(performance.now() - time); }
    round.metrics[name] = distribution(values); assert.ok(round.metrics[name].p95 <= budgets[name], `${name} p95 ${round.metrics[name].p95} > ${budgets[name]}`);
}
// Core retains its existing 256 KiB observation and 256-binding limits. A
// complete large workspace is traversed with explicit four-View selections.
// The measured duration covers every page, including full content and tools.
async function observe(x) {
    const selected = snapshot(x).views.filter(view => view.type !== 'Root'), seen = new Set(), pages = [];
    for (let offset = 0; offset < selected.length; offset += 4) {
        const views = selected.slice(offset, offset + 4), c = scope(x);
        try {
            const result = await c.observe({ viewIds: views.map(view => view.id) });
            assert.equal(result.status, 'observed', JSON.stringify(result));
            const observed = result.observation;
            assert.deepEqual(observed.views.map(view => view.id), views.map(view => view.id));
            for (const view of observed.views) {
                assert.ok(!seen.has(view.id)); seen.add(view.id);
                assert.deepEqual(view.content, views.find(source => source.id === view.id).content, 'Complete retained View content');
            }
            pages.push({ views: observed.views.length, tools: observed.tools.length, bindings: observed.bindings.length,
                bytes: Buffer.byteLength(JSON.stringify(observed)), contentBytes: views.reduce((sum, view) => sum + Buffer.byteLength(view.content.value), 0) });
        } finally { c.close(); }
    }
    assert.equal(seen.size, selected.length);
    return { viewIds: [...seen], pages, contentBytes: pages.reduce((sum, page) => sum + page.contentBytes, 0) };
}
function composition(x) { const s = snapshot(x); return { views: s.views.filter(view => view.type !== 'Root').length, instructionViews: s.views.filter(view => view.type === 'Root').length, tools: Object.keys(s.tools).length, refs: Object.keys(s.refs).length,
    contentBytes: s.views.reduce((sum, view) => sum + Buffer.byteLength(view.content.value), 0), refBytes: Buffer.byteLength(JSON.stringify(s.refs)) }; }
try {
    const root = path.join(working, 'workload'); await fs.mkdir(root);
    const files = [];
    for (let i = 0; i < 65; i++) {
        const file = path.join(root, `file-${i}.ts`), body = Array.from({ length: 220 }, (_, row) => `export const value${row} = ${row}; // needle ${'x'.repeat(48)}\n`).join('');
        await fs.writeFile(file, body); files.push(file);
    }
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }));
    facts.workload = { files: files.length, bytesPerFile: (await fs.stat(files[0])).size, linesPerFile: 220, rounds: 3, warmup: 2, samples: 10, budgets,
        observationPolicy: { viewsPerPage: 4, fullTraversalTimed: true, retainedContentCompared: true, coreLimitsUnchanged: true } };
    for (let roundIndex = 0; roundIndex < 3; roundIndex++) {
        const round = { round: roundIndex + 1, metrics: {}, observations: {}, memory: [], phases: [], processChecks: [], closedProcesses: [], complete: false }; facts.rounds.push(round);
        const stage = name => { phase = name; round.phases.push({ phase, at: performance.now() }); };
        stage('startup');
        let sampling, busy = false; const pendingSamples = new Set();
        const sample = async () => { if (busy) return; busy = true; try { round.memory.push(await memory()); } finally { busy = false; } };
        sampling = setInterval(() => { const pending = sample(); pendingSamples.add(pending); void pending.finally(() => pendingSamples.delete(pending)); }, 100);
        try {
            const app = await start(root, 'perf-' + roundIndex, { slices: false });
            await invoke(app, 'multi_open_file', { filePaths: [files[0]] }); round.small = composition(app); assert.equal(round.small.views, 2);
            await samples(round, 'smallObserve', async () => { round.observations.small = await observe(app); });
            const writable = await fs.readFile(files[0], 'utf8');
            await samples(round, 'smallCall', async () => invoke(app, 'write_file', { filePath: files[0], content: writable }, { view: fileView(app, files[0]).id, changes: false }));
            await samples(round, 'typicalOpen', index => invoke(app, 'multi_open_file', { filePaths: files.slice(0, 8) }, { changes: index === 0 })); round.typical = composition(app);
            await samples(round, 'typicalObserve', async () => { round.observations.typical = await observe(app); });
            await samples(round, 'search', () => invoke(app, 'search_files_by_content', { pattern: 'needle', include: 'file-[0-7].ts' }));
            const query = (changes = false) => invoke(app, 'lsp_hover', { file_path: files[0], line: 1, character: 15 }, { view: fileView(app, files[0]).id, changes });
            stage('coldLSP');
            const cold = performance.now(); await query(true); round.metrics.coldLSP = { count: 1, max: performance.now() - cold }; assert.ok(round.metrics.coldLSP.max <= budgets.coldLSP);
            await samples(round, 'warmLSP', () => query());
            stage('boundaryOpen');
            await invoke(app, 'multi_open_file', { filePaths: files.slice(0, 64) }); round.boundary = composition(app); assert.equal(snapshot(app).views.filter(view => view.type === 'FileDetail').length, 64);
            await samples(round, 'boundaryObserve', async () => { round.observations.boundary = await observe(app); });
            await invoke(app, 'multi_open_file', { filePaths: [files[64]] }, { status: 'failed', changes: false }); assert.equal(snapshot(app).views.filter(view => view.type === 'FileDetail').length, 64);
            stage('boundaryClose');
            await invoke(app, 'multi_close_file', { filePaths: files.slice(0, 64) });
            const loopRSS = [];
            for (let i = 0; i < 60; i++) {
                stage('longRun-' + i);
                await invoke(app, 'multi_open_file', { filePaths: [files[i]] });
                await invoke(app, 'lsp_hover', { file_path: files[i], line: 1, character: 15 }, { view: fileView(app, files[i]).id });
                await invoke(app, 'close_file_detail', { view_id: fileView(app, files[i]).id }, { view: fileView(app, files[i]).id });
                assert.equal(snapshot(app).views.filter(view => view.type === 'FileDetail').length, 0); loopRSS.push((await memory()).rss);
            }
            round.longRun = { iterations: 60, first20Median: distribution(loopRSS.slice(0, 20)).p50, last20Median: distribution(loopRSS.slice(-20)).p50, rss: loopRSS };
            assert.ok(round.longRun.last20Median - round.longRun.first20Median <= 128 * MiB);
            stage('longRunClose');
            const owned = await memory(), closing = performance.now(); await close(app);
            round.metrics.close = { count: 1, max: performance.now() - closing }; assert.ok(round.metrics.close.max <= budgets.close);
            verifyClosed(round, owned, 'long-running App');
            const cycleTimes = [];
            for (let i = 0; i < 10; i++) {
                stage('cycle-' + i + '-open');
                const cycle = await start(root, `cycle-${roundIndex}-${i}`, { slices: false }); await invoke(cycle, 'multi_open_file', { filePaths: [files[0]] });
                stage('cycle-' + i + '-query');
                await invoke(cycle, 'lsp_hover', { file_path: files[0], line: 1, character: 15 }, { view: fileView(cycle, files[0]).id });
                stage('cycle-' + i + '-close');
                const current = await memory(), started = performance.now(); await close(cycle); cycleTimes.push(performance.now() - started);
                assert.ok(cycleTimes.at(-1) <= budgets.close); verifyClosed(round, current, 'cycle-' + i);
            }
            round.cycles = distribution(cycleTimes); round.complete = true;
        } finally { clearInterval(sampling); await Promise.allSettled([...pendingSamples]); await sample(); }
        round.peakRSS = Math.max(...round.memory.map(item => item.rss)); assert.ok(round.peakRSS <= 1024 * MiB, `Peak ${round.peakRSS / MiB} MiB`);
        console.log('PERF_ROUND', JSON.stringify({ round: round.round, metrics: round.metrics, cycles: round.cycles, peakMiB: round.peakRSS / MiB, longRunDeltaMiB: (round.longRun.last20Median - round.longRun.first20Median) / MiB }));
    }
    facts.passed = true;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally {
    for (const app of apps) if (!app.closed) { try { await close(app); } catch { app.host.terminate(); await app.host.waitForResourceRelease(); } }
    facts.finishedAt = new Date().toISOString(); if (factsFile) await fs.writeFile(factsFile, JSON.stringify(facts, null, 2));
    console.log('PERF_FACTS', JSON.stringify({ passed: facts.passed, rounds: facts.rounds.length, factsFile, working }));
}
