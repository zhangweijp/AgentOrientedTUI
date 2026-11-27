import assert from 'node:assert/strict';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeScopedConsoleExecutor } from '@aotui/agent-driver-adapter';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { createRuntime } from '@aotui/runtime';
import { createScopedSource } from './batch-nine-readme.mjs';
import { consolePolicy, installConsoleFixtures, savedResult, TASKS } from './batch-eight-support.mjs';
import { appClient, fixtureProvider, journal, watchUntil } from './batch-two-support.mjs';
import { exerciseScope, output, scopedCall } from './batch-nine-support.mjs';

const evidence = process.argv[2], folder = join(dirname(evidence), 'scope-files');
const consumer = fileURLToPath(new URL('.', import.meta.url));
const runtime = createRuntime({ worker: { timeoutMs: 25_000 } });
const provider = await fixtureProvider(), calls = [], pending = new Map();
const hooks = { authorized: [], receipts: [] }, policy = consolePolicy(hooks);
const facts = { requests: provider.requests, calls, hooks, passed: false };
const owned = [];
function pidGone(pid) { assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); }

async function session(id, track = false) {
    const desktop = await runtime.createDesktop({ id: id, policyForApp: () => policy });
    const executor = track ? createNodeScopedConsoleExecutor({ timeoutMs: 1_800 }) : undefined;
    const source = createScopedSource(desktop, {
        ...(executor ? { consoleExecutor: Object.assign(async program => {
            const result = await executor(program);
            calls.push(result);
            return result;
        }, { mode: 'scoped', settlesOnAbort: executor.settlesOnAbort, dispose: () => executor.dispose() }) } : {}),
        onReceiptPending: (locator, result, subcall) => pending.set(JSON.stringify([result.toolCallId, subcall]), locator),
    });
    const history = [], delivered = [];
    const driver = new AgentDriverV2({
        sources: [source, { name: 'History', getContext: async () => ({ messages: history.slice(), tools: {} }),onUpdate: () => () => {} }],
        llm: { provider: { id: 'scope-local', baseURL: provider.url }, model: 'scope', apiKey: 'test-only',
            inputBudget: () => ({ contextWindow: 200_000, maxOutputTokens: 1_000 }) },
        onAssistantMessage(message) { history.push({ ...message, timestamp: Date.now(), region: 'session' }); },
        onToolResult(message) { delivered.push(message);history.push({ ...message, timestamp: Date.now(), region: 'session' });driver.pause(); },
    });
    driver.pause();
    const turn = async (label, call, beforeReply) => {
        const index = delivered.length;
        provider.replyNext({ label, calls: [call], beforeReply });
        history.push({ role: 'user', content: label, timestamp: Date.now(), region: 'session' });
        driver.resume();await driver.trigger();
        const message = await watchUntil(() => delivered[index], 12_000);
        await watchUntil(() => driver.getState() === 'idle');
        return { message, body: provider.requests.find(entry => entry.label === label).body };
    };
    const close = async () => {
        await driver.closeToolTurn();
        driver.dispose();
        await source.dispose();
        await desktop.beginClose().completion;
    };
    owned.push(close);
    return { desktop, source, turn, close };
}

try {
    await mkdir(folder, { recursive: true });
    const a = await session('scope-a', true), b = await session('scope-b');
    a.source.setAppsEnabled(false);
    b.source.setAppsEnabled(false);
    const other = scopedCall('other-start', 'let x = "other session"; inspect(typeof varStr);');
    assert.deepEqual(savedResult((await b.turn('other Agent starts', other)).message, other.id).output, ['undefined']);
    facts.main = await exerciseScope({ turn: a.turn, namespace: 'portable', runtime, desktop: a.desktop, folder, consumer,
        install: async () => { await installConsoleFixtures(a.desktop, consumer, folder);a.source.setAppsEnabled(true); } });

    // The same adopted request and identical call ID may be delivered twice. It runs the code once.
    const context = await a.source.getContext();
    await context.adopt();
    await context.executeTool('run_code', { code: 'let duplicated = 0;', imports: [] }, 'seed');
    const args = { code: 'duplicated += 1; inspect(duplicated);', imports: [] };
    const previousCount = calls.length;
    const [left, right] = await Promise.all(['same', 'same'].map(id => context.executeTool('run_code', args, id)));
    assert.strictEqual(left, right);
    assert.deepEqual(left.result.output, ['1']);
    assert.equal(calls.length, previousCount + 1);
    const conflict = await context.executeTool('run_code', { code: 'duplicated += 9;', imports: [] }, 'same');
    assert.equal(conflict.error.code, 'INVOCATION_ID_CONFLICT');
    await context.release();
    facts.duplicate = { left, conflict };

    await writeFile(join(folder, 'park'), '');
    try {
        const call = scopedCall('scope-timeout', 'inspect("before timeout"); const discarded = 99; ' +
            'const first = tools["console_tasks-workspace-accept"]({items:[],literal:"park"}); ' +
            'const second = tools["console_tasks-workspace-accept"]({items:[],literal:"after timeout"}); await Promise.all([first,second]);');
        const result = savedResult((await a.turn('timeout preserves the original child receipt', call)).message, call.id);
        assert.equal(result.code, 'CONSOLE_TIMEOUT');
        assert.match(result.message, /local variables and closures were lost/);
        assert.equal(output(result).scope, 'lost');
        assert.deepEqual(output(result).output, ['before timeout']);
        assert.deepEqual(output(result).subcalls.map(row => row.phase), ['unknown', 'not-dispatched']);
        const timed = calls.at(-1);
        pidGone(timed.process.pid);
        await unlink(join(folder, 'park'));
        const childId = output(result).subcalls[0].invocationId;
        const locator = pending.get(JSON.stringify([call.id, childId]));
        assert.ok(locator);
        const { client } = appClient(a.desktop, TASKS);
        const receipt = await client.readReceipt({ observationId: locator.observationId, invocationId: locator.invocationId });
        assert.equal(receipt.kind, 'receipt');
        assert.equal(receipt.receipt.outcome.status, 'succeeded');
        assert.deepEqual((await journal(folder, 'writes')).map(row => row.value.literal), [...facts.main.writes.map(row => row.value.literal), 'park']);
        facts.timeout = { result, receipt, timed };
    } finally { await unlink(join(folder, 'park')).catch(() => {}); }
    const fresh = scopedCall('after-timeout', 'inspect(typeof marker); inspect(typeof discarded);');
    assert.deepEqual(savedResult((await a.turn('locals lost after timeout', fresh)).message, fresh.id).output, ['undefined', 'undefined']);
    const still = scopedCall('other-after-timeout', 'inspect(x);');
    assert.deepEqual(savedResult((await b.turn('other Agent retains x', still)).message, still.id).output, ['other session']);
    const trackedPid = calls.at(-1).environmentPid;
    await a.close();
    pidGone(trackedPid);
    const reopened = await session('scope-a', true);
    const start = scopedCall('reopened', 'inspect(typeof duplicated);');
    assert.deepEqual(savedResult((await reopened.turn('same-name public Agent starts fresh', start)).message, start.id).output, ['undefined']);
    facts.reopened = { old: trackedPid, new: calls.at(-1).environmentPid };
    assert.notEqual(facts.reopened.old, facts.reopened.new);
    await reopened.close();
    pidGone(facts.reopened.new);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    await Promise.all(owned.map(close => close()));
    facts.shutdown = await runtime.beginClose().completion;
    await provider.close();
    await writeFile(evidence, JSON.stringify(facts, null, 2));
}
assert.equal(facts.shutdown.resourcesReleased, true);
