import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { createNodeConsoleExecutor, SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { createRuntime } from '@aotui/runtime';
import { createConsoleSource } from './batch-eight-readme.mjs';
import { grantEmail } from './dist/batch-eight-runtime-readme.js';
import { catalogState, CATALOG, changed, codeCall, consolePolicy, exerciseConsole, installConsoleFixtures, itemAddress, original,
    peopleAddress, savedResult, TASKS, tool } from './batch-eight-support.mjs';
import { appClient, fixtureProvider, journal, watchUntil } from './batch-two-support.mjs';

const evidence = process.argv[2];
const folder = join(dirname(evidence), 'public-state');
const consumer = fileURLToPath(new URL('.', import.meta.url));
await mkdir(folder, { recursive: true });
const runtime = createRuntime({ worker: { timeoutMs: 25_000 } });
const provider = await fixtureProvider();
const hooks = { authorized: [], receipts: [] };
const policy = consolePolicy(hooks, grantEmail);
const facts = { requests: provider.requests, hooks, passed: false };
const desktop = runtime.getDesktop(await runtime.createDesktop('public-console'));
const pending = new Map();
const source = createConsoleSource(runtime, desktop, { timeoutMs: 1_800, policy: () => policy,
    onReceiptPending: (locator, result, subcall) => pending.set(JSON.stringify([result.toolCallId, subcall]), locator),
});
const history = [];
const delivered = [];
let inputLimit = 139_000;
const driver = new AgentDriverV2({
    sources: [source, {
        name: 'History', async getContext() { return { messages: history.slice(), tools: {} }; },
        onUpdate() { return () => {}; },
    }],
    llm: { provider: { id: 'local-console', baseURL: provider.url }, model: 'public-console', apiKey: 'test-only',
        inputBudget: () => ({ contextWindow: inputLimit + 1_000, maxOutputTokens: 1_000 }) },
    onAssistantMessage(message) {
        history.push({ ...message, timestamp: Date.now(), region: 'session' });
        if (typeof message.content === 'string') driver.pause();
    },
    onToolResult(message) {
        history.push({ ...message, timestamp: Date.now(), region: 'session' });
        delivered.push(message);
        driver.pause();
    },
});
driver.pause();
try {
    async function turn(label, call, beforeReply) {
        const index = delivered.length;
        provider.replyNext({ label, calls: [call], beforeReply });
        history.push({ role: 'user', content: label, timestamp: Date.now(), region: 'session' });
        driver.resume();
        await driver.trigger();
        const message = await watchUntil(() => delivered[index], 12_000);
        await watchUntil(() => driver.getState() === 'idle');
        const request = provider.requests.find(entry => entry.label === label);
        assert.ok(request, label);
        return { body: request.body, message };
    }
    facts.exercise = await exerciseConsole({ turn, runtime, desktop, folder, hooks, declarationFolder: consumer,
        install: () => installConsoleFixtures(desktop, consumer, folder),
        async receipt(_message, parent, subcall) {
            const locator = pending.get(JSON.stringify([parent, subcall]));
            assert.ok(locator, 'Pending child belongs to the original Console result');
            const { client, app } = appClient(runtime, desktop, locator.appId);
            assert.equal(app.appInstanceId, locator.appInstanceId);
            return client.readReceipt({ observationId: locator.observationId, invocationId: locator.invocationId });
        },
    });
    await catalogState(folder, 'original');
    await desktop.openApp(CATALOG);
    await desktop.openApp(TASKS);
    const prior = await source.getContext();
    await prior.adopt();
    assert.ok(prior.tools[tool('accept')]);
    source.setAppsEnabled(false);
    const old = await prior.executeTool(tool('accept'), { items: [], literal: 'must not write' }, 'old-disabled');
    assert.equal(old.error.code, 'SEMANTIC_CONTEXT_RELEASED');
    const management = await prior.executeTool('system-close_app', { app_id: TASKS }, 'old-close');
    assert.equal(management.error.code, 'SEMANTIC_CONTEXT_RELEASED');
    assert.equal(appClient(runtime, desktop, TASKS).app.status, 'running');
    history.length = 0;
    const consoleOnly = await turn('public Console with Apps disabled', codeCall('public-no-apps',
        'inspect(1+2); inspect(Object.keys(refs).length); inspect(Object.keys(tools).length);'));
    assert.deepEqual(consoleOnly.body.tools.map(entry => entry.function.name), ['run_code']);
    assert.doesNotMatch(JSON.stringify(consoleOnly.body.messages), /<view |<desktop>|console_catalog|console_tasks/);
    assert.deepEqual(savedResult(consoleOnly.message, 'public-no-apps').output, ['3', '0', '0']);
    assert.equal((await journal(folder, 'writes')).length, 5);
    facts.consoleOnly = { result: savedResult(consoleOnly.message, 'public-no-apps'), old, management };
    await desktop.closeApp(TASKS, appClient(runtime, desktop, TASKS).app.appInstanceId);
    source.setAppsEnabled(true);

    async function publish(revision, items, narrowed) {
        await catalogState(folder, revision, items, narrowed);
        await watchUntil(async () => (await appClient(runtime, desktop, CATALOG).client.preview()).views?.[0]?.content.value.includes(revision));
    }
    async function bind(hint = false) {
        const { client } = appClient(runtime, desktop, CATALOG, policy);
        const result = await client.observe({ all: true, programTools: true });
        assert.equal(result.status, 'observed');
        const { observationId, views } = result.observation;
        const layout = hint ? { receiverViews: views.map(({ id: viewId, viewInstanceId }) => ({ viewId, viewInstanceId })), refViews: [] } : undefined;
        assert.equal(client.adoptObservation(observationId, layout).status, 'adopted');
        return { inputs: desktop.bindRequestSources({ apps: [{ client, observationId }] }), release: () => client.releaseObservation(observationId) };
    }
    const full = await bind();
    const before = full.inputs.readConsoleInputs();
    assert.equal(before.status, 'ready');
    assert.equal(before.refs.console_catalog.list.people[0].email, 'selected@example.test');
    await publish('direct background reorder', changed, false);
    const reordered = full.inputs.readConsoleInputs();
    assert.deepEqual(reordered, before);
    await publish('direct scope revoked', changed, true);
    const rejected = full.inputs.readConsoleInputs();
    assert.equal(rejected.issue.code, 'CONSOLE_REF_UNAVAILABLE');
    assert.equal(full.inputs.readConsoleInputs([peopleAddress + '[0].email']).issue.code, 'CONSOLE_REF_UNAVAILABLE');
    assert.deepEqual(Object.keys(full.inputs.readConsoleInputs([]).refs), []);
    const retained = full.inputs.readConsoleInputs([itemAddress]);
    assert.equal(retained.status, 'ready');
    assert.equal(JSON.stringify(retained.refs.console_catalog.list.todos), JSON.stringify(original));
    await desktop.closeApp(CATALOG, appClient(runtime, desktop, CATALOG).app.appInstanceId);
    await catalogState(folder, 'public restored', changed);
    await desktop.openApp(CATALOG);
    const stale = full.inputs.readConsoleInputs();
    assert.equal(stale.issue.code, 'CONSOLE_REF_UNAVAILABLE');
    full.release();
    const hintBinding = await bind(true);
    const hintedInputs = hintBinding.inputs.readConsoleInputs();
    assert.equal(hintedInputs.status, 'ready');
    assert.deepEqual(Object.keys(hintedInputs.refs), []);
    assert.equal(hintBinding.inputs.readConsoleInputs([itemAddress]).issue.code, 'CONSOLE_REF_UNAVAILABLE');
    hintBinding.release();
    facts.publicRuntime = { before, reordered, rejected, retained, stale, hintedInputs };

    const executor = createNodeConsoleExecutor({ timeoutMs: 2_000 });
    let processResult;
    const delayed = new SemanticAOTUIDrivenSource(desktop, runtime, { policy: () => policy,
        async consoleExecutor(program) {
            assert.equal(program.inputs.refs.console_catalog.list.people[0].email, 'updated@example.test');
            await publish('after preparation before begin', changed, true);
            return processResult = await executor(program);
        },
    });
    try {
        const context = await delayed.getContext();
        await context.adopt();
        const result = await context.executeTool('run_code', { code: 'inspect("must not run");' }, 'before-begin');
        assert.equal(result.error.code, 'CONSOLE_REF_UNAVAILABLE');
        assert.deepEqual(result.result, { output: [], subcalls: [] });
        assert.throws(() => process.kill(processResult.process.pid, 0), { code: 'ESRCH' });
        facts.beforeBegin = { result: result.error, process: processResult.process };
    } finally { await delayed.dispose(); }

    await catalogState(folder, 'over budget', original, false, '\n' + 'x'.repeat(25_000));
    await watchUntil(async () => (await appClient(runtime, desktop, CATALOG).client.preview()).views?.[0]?.content.value.includes('over budget'));
    // Independently capture a fresh request under a smaller model budget.
    history.length = 0;
    inputLimit = 15_000;
    const hinted = await turn('budget hint with Console', codeCall('hint', 'inspect("should not start")', [itemAddress]));
    const hintPage = hinted.body.messages.find(message => typeof message.content === 'string' &&
        message.content.startsWith('<view ') && message.content.includes('app_id="console_catalog"'));
    assert.match(hintPage?.content, /Its body does not fit the current model request/);
    assert.ok(!hinted.body.tools.find(tool => tool.function.name === 'run_code').function.description.includes('readonly todos:'));
    assert.equal(savedResult(hinted.message, 'hint').code, 'CONSOLE_REF_UNAVAILABLE');
    const hintedDefault = await turn('hidden budget page is not a required import', codeCall('hint-default', 'inspect(Object.keys(refs).length);'));
    const omitted = savedResult(hintedDefault.message, 'hint-default');
    assert.equal(omitted.window_budget.mode, 'window_hints');
    assert.deepEqual(omitted.result.output, ['0']);
    facts.hint = { result: savedResult(hinted.message, 'hint'), omitted };
    const catalog = appClient(runtime, desktop, CATALOG).app;
    await desktop.closeApp(CATALOG, catalog.appInstanceId);

    history.length = 0;
    inputLimit = 3_650;
    provider.replyNext({ label: 'public only management', text: 'Recover the windows.' });
    history.push({ role: 'user', content: 'Keep the available controls.', timestamp: Date.now(), region: 'session' });
    driver.resume();
    await driver.trigger();
    facts.management = await watchUntil(() => provider.requests.find(entry => entry.label === 'public only management'));
    const managementNames = facts.management.body.tools.map(entry => entry.function.name);
    assert.ok(!managementNames.includes('run_code'));
    assert.ok(managementNames.includes('system-open_app'));
    await watchUntil(() => driver.getState() === 'idle');
    assert.ok(provider.requests.every(request => request.label));
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    driver.stop();driver.dispose();await source.dispose();
    facts.shutdown = await runtime.beginShutdown().completion;
    await provider.close();
    await writeFile(evidence, JSON.stringify(facts, null, 2));
}
assert.equal(facts.shutdown.resourcesReleased, true);
