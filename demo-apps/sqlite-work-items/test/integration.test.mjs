import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AppRegistry, createDesktopId, createRuntime } from '@aotui/runtime';

const execute = promisify(execFile);
const appDir = fileURLToPath(new URL('../', import.meta.url));
const sqlite = process.env.AOTUI_TEST_SQLITE ?? 'sqlite3';
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function fixture(t, timeoutMs = 5_000) {
    const dir = await mkdtemp(join(tmpdir(), 'aotui-sqlite-'));
    const db = join(dir, 'work # items.sqlite');
    const executable = join(dir, 'sqlite-fixture');
    const trace = join(dir, 'commands');
    const gate = join(dir, 'hold-select');
    const started = join(dir, 'started');
    const heldOutput = join(dir, 'held-output.json');
    const runtime = createRuntime({ worker: { maxWorkers: 1, timeoutMs } });
    let lock;
    let lockClosed;
    let ownedPid;

    async function commands() {
        const log = await readFile(trace, 'utf8');
        return log.trim().split('\n').map(line => line.split(' '));
    }

    function unlock() {
        if (lock && !lock.stdin.destroyed && !lock.stdin.writableEnded) lock.stdin.end('ROLLBACK;\n');
        return lockClosed;
    }

    t.after(async () => {
        await unlock();
        if (ownedPid && alive(ownedPid)) {
            try { process.kill(ownedPid, 'SIGKILL'); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await runtime.beginShutdown().completion;
        await rm(dir, { recursive: true, force: true });
    });

    async function sql(statement) {
        const { stdout } = await execute(sqlite, ['-batch', '-bail', '-json', '-init', devNull, db, statement]);
        return stdout.trim() ? JSON.parse(stdout) : [];
    }
    await sql(await readFile(join(appDir, 'work-items.sql'), 'utf8'));
    // Test-only wrapper records argv class and execs the real CLI in the same PID.
    // An independent SQLite transaction holds the read when the gate is present.
    await writeFile(executable, `#!/bin/sh
for arg do sql=$arg; done
kind=SELECT
case "$sql" in 'UPDATE '*) kind=UPDATE ;; esac
printf '%s %s\n' "$kind" "$$" >> ${shellQuote(trace)}
if [ "$kind" = SELECT ] && [ -f ${shellQuote(gate)} ]; then
    read -r mode < ${shellQuote(gate)}
    if [ "$mode" = hold ]; then trap '' TERM; fi
    exec ${shellQuote(sqlite)} -cmd '.timeout 30000' -cmd ${shellQuote('.once ' + JSON.stringify(started))} -cmd '.print sqlite-started' -cmd ${shellQuote('.output ' + JSON.stringify(heldOutput))} "$@"
fi
exec ${shellQuote(sqlite)} "$@"
`, { mode: 0o700 });

    const registry = new AppRegistry({ configPath: join(dir, 'registry.json') });
    assert.equal(await registry.registerTransient('local:' + appDir), 'sqlite_work_items');
    const desktopId = createDesktopId('sqlite');
    await runtime.createDesktop(desktopId);
    const desktop = runtime.getDesktop(desktopId);
    const [installation] = await registry.installAll(desktop, {
        dynamicConfig: { databasePath: db, sqliteExecutable: executable, AOTUI_DATA_DIR: join(dir, 'app-data') },
    });
    assert.equal(installation?.status, 'installed', JSON.stringify(installation));
    const [app] = desktop.getInstalledApps();
    const opened = runtime.getAppInteraction(desktopId, app.appId, app.appInstanceId);
    assert.equal(opened.status, 'ready', JSON.stringify(opened));
    const client = opened.interaction;
    let sequence = 0;

    async function observe() {
        const result = await client.observe({ all: true });
        assert.equal(result.status, 'observed', JSON.stringify(result));
        assert.equal(client.adoptObservation(result.observation.observationId).status, 'adopted');
        return result.observation;
    }
    function request(observation, name, input = {}) {
        const tool = observation.tools.find(tool => tool.name === name);
        const binding = observation.bindings.find(binding => binding.toolId === tool?.id);
        assert.ok(binding, `No observed binding for ${name}`);
        return { invocationId: `call-${++sequence}`, observationId: observation.observationId, bindingId: binding.bindingId, input };
    }

    async function startHeldRead(observation, ignoreTerminate = true) {
        await writeFile(gate, ignoreTerminate ? 'hold\n' : 'cancel\n');
        lock = spawn(sqlite, ['-batch', '-bail', '-init', devNull, db], { stdio: ['pipe', 'pipe', 'inherit'] });
        lockClosed = new Promise(resolve => lock.once('close', resolve));
        lock.stdin.on('error', () => {});
        await new Promise((resolve, reject) => {
            let output = '';
            lock.once('error', reject);
            lock.once('close', code => reject(new Error(`SQLite lock closed before ready (${code})`)));
            lock.stdout.on('data', data => {
                output += data.toString();
                if (output.includes('locked\n')) resolve();
            });
            lock.stdin.write('BEGIN EXCLUSIVE;\n.print locked\n');
        });
        const pending = client.invoke(request(observation, 'refresh'), 100);
        ownedPid = await waitFor(async () => {
            if (!(await readFile(started, 'utf8').catch(error => {
                if (error.code !== 'ENOENT') throw error;
            }))?.includes('sqlite-started')) return;
            const [kind, pid] = (await commands()).at(-1);
            assert.equal(kind, 'SELECT');
            return Number(pid);
        });
        assert.equal(alive(ownedPid), true);
        return { pending, pid: ownedPid };
    }

    async function heldReadResult() {
        const output = (await readFile(heldOutput, 'utf8')).trim();
        if (output.endsWith(']')) return JSON.parse(output);
    }

    const call = (observation, name, input) => client.invoke(request(observation, name, input));
    return { client, runtime, observe, request, call, sql, commands, executable, startHeldRead, heldReadResult, unlock };
}

async function waitFor(check) {
    const deadline = Date.now() + 3_000;
    do {
        const result = await check();
        if (result) return result;
        await delay(10);
    } while (Date.now() < deadline);
    assert.fail('Timed out waiting for the SQLite test barrier');
}

function alive(pid) {
    try { return process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function outcome(result) {
    assert.equal(result.kind, 'receipt', JSON.stringify(result));
    return result.receipt.outcome;
}
function success(result, data) {
    const end = outcome(result);
    assert.equal(end.status, 'succeeded', JSON.stringify(end));
    assert.deepEqual(JSON.parse(JSON.stringify(end.value)), data === undefined ? { success: true } : { success: true, data });
}
function toolError(result, status, code) {
    const end = outcome(result);
    assert.equal(end.status, status, JSON.stringify(end));
    assert.equal(end.details?.result.error.code, code);
    return end;
}
const view = (observation, id) => observation.views.find(view => view.id === id);
const body = (observation, id) => view(observation, id)?.content?.value;
const toolNames = observation => observation.tools.map(tool => tool.name).sort();
const updates = async fixture => (await fixture.commands()).filter(([kind]) => kind === 'UPDATE').length;
const currentItem = "SELECT status, revision FROM work_items WHERE id = 101;";

test('real Worker opens, conditionally writes, recovers a failed refresh, and closes detail', { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    let frame = await f.observe();
    assert.deepEqual(toolNames(frame), ['open_item', 'refresh']);
    assert.match(body(frame, 'items'), /\[Review SDK guide\]\(WorkItem:items\[0\]\)/);
    assert.doesNotMatch(body(frame, 'items'), /\b101\b/);
    assert.equal(view(frame, 'detail'), undefined);

    success(await f.call(frame, 'open_item', { item: 'items.items[0]' }));
    frame = await f.observe();
    const detailInstance = view(frame, 'detail').viewInstanceId;
    assert.deepEqual(toolNames(frame), ['close_item', 'open_item', 'refresh', 'set_status']);
    assert.match(body(frame, 'detail'), /\(WorkItem:current\) · open · revision 0/);
    assert.match(body(frame, 'detail'), /Check the public App and Host examples/);

    const wrongItem = toolError(await f.call(frame, 'set_status', { item: 'items.items[1]', status: 'done' }), 'failed', 'WORK_ITEM_NOT_SELECTED');
    assert.equal(wrongItem.effects, 'none');
    const invalid = await f.call(frame, 'set_status', { item: 'detail.current', status: "done'; SELECT 1; --" });
    assert.equal(outcome(invalid).status, 'rejected');
    assert.equal(await updates(f), 0);

    const old = f.request(frame, 'set_status', { item: 'detail.current', status: 'done' });
    success(await f.client.invoke(old), { written: true, refreshed: true });
    assert.deepEqual(await f.sql(currentItem), [{ status: 'done', revision: 1 }]);
    assert.equal(await updates(f), 1);
    frame = await f.observe();
    assert.equal(view(frame, 'detail').viewInstanceId, detailInstance);
    assert.equal(frame.views.filter(view => view.id === 'detail').length, 1);
    assert.match(body(frame, 'detail'), /done · revision 1/);
    assert.equal((await f.client.invoke({ ...old, invocationId: 'unseen-old-observation' })).code, 'OBSERVATION_UNAVAILABLE');

    await f.sql("UPDATE work_items SET status = 'open', revision = revision + 1 WHERE id = 101;");
    const stale = toolError(await f.call(frame, 'set_status', { item: 'detail.current', status: 'done' }), 'failed', 'VERSION_CONFLICT');
    assert.equal(stale.effects, 'none');
    assert.match(stale.details.result.error.message, /Refresh/);
    assert.deepEqual(await f.sql(currentItem), [{ status: 'open', revision: 2 }]);
    assert.equal(await updates(f), 2);
    success(await f.call(frame, 'refresh'));
    frame = await f.observe();
    assert.equal(view(frame, 'detail').viewInstanceId, detailInstance);
    assert.match(body(frame, 'detail'), /open · revision 2/);

    await f.sql(`CREATE TRIGGER enlarge_detail AFTER UPDATE OF status ON work_items
        BEGIN UPDATE work_items SET body = printf('%070000d', 1) WHERE id = NEW.id; END;`);
    const write = f.request(frame, 'set_status', { item: 'detail.current', status: 'done' });
    const written = await f.client.invoke(write);
    success(written, { written: true, refreshed: false,
        refreshIssue: { code: 'SQLITE_OUTPUT_LIMIT', message: 'SQLite output exceeded 64 KiB.' } });
    assert.deepEqual(await f.sql(currentItem), [{ status: 'done', revision: 3 }]);
    assert.deepEqual(await f.sql('SELECT length(body) AS length FROM work_items WHERE id = 101;'), [{ length: 70_000 }]);
    frame = await f.observe();
    assert.deepEqual(frame.refs, []);
    assert.deepEqual(toolNames(frame), ['close_item', 'refresh']);
    assert.match(body(frame, 'items'), /SQLITE_OUTPUT_LIMIT.*Use refresh/);
    assert.equal(body(frame, 'detail'), 'Detail unavailable. Use refresh to read it again.');
    assert.deepEqual(await f.client.readReceipt(write), written);
    assert.equal(await updates(f), 3);

    await f.sql("DROP TRIGGER enlarge_detail; UPDATE work_items SET body = 'Repaired body' WHERE id = 101;");
    success(await f.call(frame, 'refresh'));
    assert.equal(await updates(f), 3);
    assert.deepEqual(await f.sql(currentItem), [{ status: 'done', revision: 3 }]);
    frame = await f.observe();
    assert.equal(view(frame, 'detail').viewInstanceId, detailInstance);
    assert.match(body(frame, 'detail'), /Repaired body/);
    success(await f.call(frame, 'close_item'));
    frame = await f.observe();
    assert.equal(view(frame, 'detail'), undefined);
    assert.deepEqual(toolNames(frame), ['open_item', 'refresh']);
    assert.equal((await f.runtime.beginShutdown().completion).ok, true);
});

test('reports partial effects when a real trigger skips the selected update', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    success(await f.call(await f.observe(), 'open_item', { item: 'items.items[0]' }));
    const frame = await f.observe();
    await f.sql(`CREATE TRIGGER skip_selected BEFORE UPDATE OF status ON work_items WHEN OLD.id = 101
        BEGIN
            UPDATE work_items SET title = 'Changed by trigger', revision = revision + 1 WHERE id = 102;
            SELECT RAISE(IGNORE);
        END;`);

    const write = f.request(frame, 'set_status', { item: 'detail.current', status: 'done' });
    const result = await f.client.invoke(write);
    const rowsSql = 'SELECT id, title, status, revision FROM work_items ORDER BY id;';
    const rows = [
        { id: 101, title: 'Review SDK guide', status: 'open', revision: 0 },
        { id: 102, title: 'Changed by trigger', status: 'open', revision: 1 },
    ];
    assert.deepEqual(await f.sql(rowsSql), rows);
    const partial = toolError(result, 'failed', 'SQLITE_WRITE_PARTIAL');
    assert.equal(partial.effects, 'partial');
    assert.match(partial.details.result.error.message, /Use refresh/);
    assert.equal(await updates(f), 1);

    const diagnostic = await f.observe();
    assert.deepEqual(diagnostic.refs, []);
    assert.deepEqual(toolNames(diagnostic), ['close_item', 'refresh']);
    assert.match(body(diagnostic, 'items'), /SQLITE_WRITE_PARTIAL.*Use refresh/);
    assert.doesNotMatch(body(diagnostic, 'items'), /Review SDK guide|Prepare release notes/);
    assert.equal(body(diagnostic, 'detail'), 'Detail unavailable. Use refresh to read it again.');
    assert.deepEqual(await f.client.readReceipt(write), result);
    assert.equal(await updates(f), 1);

    success(await f.call(diagnostic, 'refresh'));
    const refreshed = await f.observe();
    assert.equal(view(refreshed, 'detail').viewInstanceId, view(frame, 'detail').viewInstanceId);
    assert.match(body(refreshed, 'detail'), /open · revision 0/);
    assert.match(body(refreshed, 'items'), /Changed by trigger.*open · revision 1/);
    assert.ok(toolNames(refreshed).includes('set_status'));
    assert.equal(await updates(f), 1);
    assert.deepEqual(await f.sql(rowsSql), rows);
});

test('real SQLite start failure is side-effect free; stderr overflow after writing is unknown', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    success(await f.call(await f.observe(), 'open_item', { item: 'items.items[0]' }));
    const frame = await f.observe();
    await rename(f.executable, f.executable + '.held');
    const input = { item: 'detail.current', status: 'done' };
    const failed = toolError(await f.call(frame, 'set_status', input), 'failed', 'SQLITE_START_FAILED');
    assert.equal(failed.effects, 'none');
    assert.equal(await updates(f), 0);
    assert.deepEqual(await f.sql(currentItem), [{ status: 'open', revision: 0 }]);
    await rename(f.executable + '.held', f.executable);

    // SQLite RAISE(FAIL) keeps the row change even though the CLI exits with an error.
    await f.sql(`CREATE TRIGGER fail_after_write AFTER UPDATE OF status ON work_items
        BEGIN SELECT RAISE(FAIL, '${'x'.repeat(70_000)}'); END;`);
    const uncertain = f.request(frame, 'set_status', input);
    const unknown = await f.client.invoke(uncertain);
    toolError(unknown, 'unknown', 'SQLITE_OUTPUT_LIMIT');
    assert.deepEqual(await f.sql(currentItem), [{ status: 'done', revision: 1 }]);
    const recovery = await f.observe();
    assert.deepEqual(recovery.refs, []);
    assert.match(body(recovery, 'items'), /SQLITE_WRITE_UNCONFIRMED/);
    assert.deepEqual(await f.client.readReceipt(uncertain), unknown);
    success(await f.call(recovery, 'refresh'));
    assert.equal(await updates(f), 1);
    assert.match(body(await f.observe(), 'detail'), /done · revision 1/);
});

test('normal shutdown cancels a real SQLite command and confirms App cleanup', { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const { pending, pid } = await f.startHeldRead(await f.observe(), false);
    const report = await f.runtime.beginShutdown().completion;
    assert.equal(alive(pid), false);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.appCleanup.completedApps, 1);
    assert.equal(report.workers.report.total, 0);
    await pending;
});

for (const force of [false, true]) {
    test(force ? 'forced Worker exit gives no App cleanup evidence' : 'a cancellation request alone does not release an App-owned child',
        { timeout: 10_000 }, async t => {
            const f = await fixture(t, force ? 1_500 : 5_000);
            const { pending, pid } = await f.startHeldRead(await f.observe());
            assert.equal(outcome(await pending).status, 'unknown');
            const close = f.runtime.beginShutdown();
            const waiting = await close.wait({ timeoutMs: 100 });
            assert.equal(waiting.status, 'deadline');
            assert.equal(waiting.report.resourcesReleased, false);
            assert.equal(alive(pid), true);
            if (!force) await f.unlock();
            const report = await close.completion;
            assert.equal(report.resourcesReleased, true, JSON.stringify(report));
            assert.equal(report.workers.report.total, 0);
            if (force) {
                assert.equal(report.hasFailures, true);
                assert.equal(report.appCleanup.completedApps, 0);
                assert.ok(report.failures.some(sample => sample.codes.includes('APP_CLOSE_DEADLINE_EXCEEDED')));
                assert.equal(await f.heldReadResult(), undefined);
                await f.unlock();
                const rows = await waitFor(f.heldReadResult);
                assert.equal(rows[0].title, 'Review SDK guide');
                t.diagnostic('The held SQLite query produced its result after Worker exit.');
            } else {
                assert.equal(report.ok, true, JSON.stringify(report));
                assert.equal(report.appCleanup.completedApps, 1);
                assert.equal(alive(pid), false);
            }
        });
}
