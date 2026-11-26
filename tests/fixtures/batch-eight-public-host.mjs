import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { createNodeConsoleExecutor, SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { createRuntime } from '@aotui/runtime';
import { createConsoleSource } from './batch-eight-readme.mjs';
import { catalogState, CATALOG, changed, codeCall, consolePolicy, exerciseConsole, installConsoleFixtures, itemAddress, original,
    peopleAddress, savedResult, TASKS, tool } from './batch-eight-support.mjs';
import { appClient, consoleBindings, fixtureProvider, journal, watchUntil } from './batch-two-support.mjs';

const evidence = process.argv[2];
const folder = join(dirname(evidence), 'public-state');
const consumer = fileURLToPath(new URL('.', import.meta.url));
await mkdir(folder, { recursive: true });
const runtime = createRuntime({ worker: { timeoutMs: 25_000 } });
const provider = await fixtureProvider();
const hooks = { authorized: [], receipts: [] };
const policy = consolePolicy(hooks);
const facts = { requests: provider.requests, hooks, passed: false };
const desktop = await runtime.createDesktop({ id: 'public-console', policyForApp: () => policy });
const pending = new Map();
const source = createConsoleSource(desktop, { timeoutMs: 1_800,
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
            const { client, app } = appClient(desktop, locator.appId);
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
    assert.equal(appClient(desktop, TASKS).app.status, 'running');
    history.length = 0;
    const consoleOnly = await turn('public Console with Apps disabled', codeCall('public-no-apps',
        'inspect(1+2); inspect(Object.keys(refs).length); inspect(Object.keys(tools).length);'));
    assert.deepEqual(consoleOnly.body.tools.map(entry => entry.function.name), ['run_code']);
    assert.doesNotMatch(JSON.stringify(consoleOnly.body.messages), /<view |<desktop>|console_catalog|console_tasks/);
    assert.deepEqual(savedResult(consoleOnly.message, 'public-no-apps').output, ['3', '0', '0']);
    assert.equal((await journal(folder, 'writes')).length, 5);
    facts.consoleOnly = { result: savedResult(consoleOnly.message, 'public-no-apps'), old, management };
    assert.equal((await appClient(desktop, TASKS).running.beginClose().completion).ok, true);
    source.setAppsEnabled(true);

    async function publish(revision, items, narrowed) {
        await catalogState(folder, revision, items, narrowed);
        await watchUntil(async () => (await appClient(desktop, CATALOG).client.preview()).views?.[0]?.content.value.includes(revision));
    }
    async function bind(hint = false) {
        const { running } = appClient(desktop, CATALOG);
        const result = await running.observe();
        assert.equal(result.status, 'prepared');
        const { candidate } = result;
        const layout = hint ? { activeViews: [] } : undefined;
        const adopted = desktop.adoptTurn({ apps: [{ candidate, windows: layout }] });
        assert.equal(adopted.status, 'adopted');
        return { inputs: adopted.turn, release: () => adopted.turn.release() };
    }
    const full = await bind();
    const before = await full.inputs.readPublicRefs();
    assert.equal(before.status, 'ready');
    assert.deepEqual(JSON.parse(JSON.stringify(before.refs.find(entry => entry.appId === CATALOG && entry.refId === 'people'))), {
        appId: CATALOG, viewId: 'list', refId: 'people', path: [], value: [{ email: 'selected@example.test' }, { email: 'sibling@example.test' }],
    });
    const selected = await full.inputs.readPublicRefs([peopleAddress + '[0].email']);
    assert.deepEqual(JSON.parse(JSON.stringify(selected)), { status: 'ready', refs: [
        { appId: CATALOG, viewId: 'list', refId: 'people', path: [0, 'email'], value: 'selected@example.test' },
    ] });
    await publish('direct background reorder', changed, false);
    const reordered = await full.inputs.readPublicRefs();
    assert.deepEqual(reordered, before);
    await publish('direct scope revoked', changed, true);
    const rejected = await full.inputs.readPublicRefs();
    assert.equal(rejected.issue.code, 'REF_VALUE_PRIVATE');
    assert.equal((await full.inputs.readPublicRefs([peopleAddress + '[0].email'])).issue.code, 'REF_VALUE_PRIVATE');
    assert.deepEqual((await full.inputs.readPublicRefs([])).refs, []);
    const retained = await full.inputs.readPublicRefs([itemAddress]);
    assert.equal(retained.status, 'ready');
    assert.equal(JSON.stringify(retained.refs[0].value), JSON.stringify(original));
    assert.equal((await appClient(desktop, CATALOG).running.beginClose().completion).ok, true);
    await catalogState(folder, 'public restored', changed);
    await desktop.openApp(CATALOG);
    const stale = await full.inputs.readPublicRefs();
    assert.equal(stale.issue.code, 'REF_NOT_VISIBLE');
    full.release();
    const hintBinding = await bind(true);
    const hintedInputs = await hintBinding.inputs.readPublicRefs();
    assert.equal(hintedInputs.status, 'ready');
    assert.deepEqual(hintedInputs.refs, []);
    assert.equal((await hintBinding.inputs.readPublicRefs([itemAddress])).issue.code, 'REF_NOT_VISIBLE');
    hintBinding.release();
    facts.publicRuntime = { before, selected, reordered, rejected, retained, stale, hintedInputs };

    await desktop.openApp(TASKS);
    const writesBefore = await journal(folder, 'writes');
    const authorizedBefore = hooks.authorized.length;
    const executor = createNodeConsoleExecutor({ timeoutMs: 2_000 });
    let processResult;
    const delayed = new SemanticAOTUIDrivenSource(desktop, {
        async consoleExecutor(program) {
            assert.equal(program.inputs.refs.console_catalog.list.people[0].email, 'updated@example.test');
            await publish('after preparation before begin', changed, true);
            return processResult = await executor(program);
        },
    });
    try {
        const context = await delayed.getContext();
        await context.adopt();
        const code = 'inspect(refs.console_catalog.list.people[0].email); ' +
            'await tools["console_tasks-accept"]({ items: [], literal: "should never be saved" });';
        const result = await context.executeTool('run_code', { code }, 'before-begin');
        assert.equal(result.error.code, 'REF_VALUE_PRIVATE');
        assert.deepEqual(result.result, { output: [], subcalls: [] });
        assert.throws(() => process.kill(processResult.process.pid, 0), { code: 'ESRCH' });
        const writesAfter = await journal(folder, 'writes');
        assert.deepEqual(writesAfter, writesBefore);
        assert.equal(hooks.authorized.length, authorizedBefore);
        facts.beforeBegin = { result: result.error, output: result.result.output, subcalls: result.result.subcalls,
            process: processResult.process, writesBefore: writesBefore.length, writesAfter: writesAfter.length,
            businessAuthorizations: hooks.authorized.length - authorizedBefore };
        await context.release();
    } finally {
        await delayed.dispose();
        assert.equal((await appClient(desktop, TASKS).running.beginClose().completion).ok, true);
    }

    await catalogState(folder, 'over budget', original, false, '\n' + 'x'.repeat(25_000));
    await watchUntil(async () => (await appClient(desktop, CATALOG).client.preview()).views?.[0]?.content.value.includes('over budget'));
    // Independently capture a fresh request under a smaller model budget.
    history.length = 0;
    inputLimit = 15_000;
    const hinted = await turn('budget hint with Console', codeCall('hint', 'inspect("should not start")', [itemAddress]));
    const hintPage = hinted.body.messages.find(message => typeof message.content === 'string' &&
        message.content.startsWith('<view ') && message.content.includes('app_id="console_catalog"'));
    assert.match(hintPage?.content, /Its body does not fit the current model request/);
    assert.ok(!consoleBindings(hinted.body).includes('readonly todos:'));
    assert.equal(savedResult(hinted.message, 'hint').code, 'REF_NOT_VISIBLE');
    const hintedDefault = await turn('hidden budget page is not a required import', codeCall('hint-default', 'inspect(Object.keys(refs).length);'));
    const omitted = savedResult(hintedDefault.message, 'hint-default');
    assert.equal(omitted.window_budget.mode, 'window_hints');
    assert.deepEqual(omitted.result.output, ['0']);
    facts.hint = { result: savedResult(hinted.message, 'hint'), omitted };
    assert.equal((await appClient(desktop, CATALOG).running.beginClose().completion).ok, true);

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
    facts.shutdown = await runtime.beginClose().completion;
    await provider.close();
    await writeFile(evidence, JSON.stringify(facts, null, 2));
}
assert.equal(facts.shutdown.resourcesReleased, true);
