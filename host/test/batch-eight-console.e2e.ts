import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { createRuntime, type DesktopID } from '@aotui/runtime';
import type { AgentDriverV2, LLMConfig } from '@aotui/agent-driver-v2';
import type { DesktopManager } from '../src/core/desktop-manager.js';
import type { GuiUpdateEvent } from '../src/types/session.js';
import { fixtureProvider, journal, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';
import { consolePolicy, CATALOG, codeCall, exerciseConsole, installConsoleFixtures, savedResult, system, TASKS } from '../../tests/fixtures/batch-eight-support.mjs';

const [consumer, evidence] = process.argv.slice(2);
assert.ok(consumer, 'Provide the installed batch-eight consumer directory.');
const project = await mkdtemp(join(tmpdir(), 'aotui-b8-product-'));
process.env.DB_PATH = join(project, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(project, 'state');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const db = await import('../src/db/index.js');
const { Config } = await import('../src/config/config.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const { listIMMessages } = await import('../src/im/message-store.js');
const configuration = mock.method(Config, 'get', async () => ({
    agents: { list: [{ id: 'console', prompt: 'Use the tools from this request.', enabledApps: [CATALOG, TASKS] },
        { id: 'blank', prompt: 'Use the tools from this request.', enabledApps: [] }] },
}));
const runtime = createRuntime({ worker: { timeoutMs: 25_000 } });
const provider = await fixtureProvider();
const hooks = { authorized: [], receipts: [] };
const policy = consolePolicy(hooks);
const facts: Record<string, unknown> = { requests: provider.requests, hooks, passed: false };
const folders = new Map<string, string>();
const desktops = {
    async createDesktop(id: DesktopID) {
        const folder = join(project, 'desktop-' + folders.size);
        folders.set(id, folder);
        const desktop = await runtime.createDesktop({ id: id, policyForApp: () => policy });
        const hidden = id === 'console-hidden-topic' || id.startsWith('agent:blank:');
        if (id.startsWith('agent:') || hidden) await installConsoleFixtures(desktop, consumer, folder);
        else await mkdir(folder, { recursive: true });
        if (hidden) {
            await desktop.openApp(CATALOG);
            await desktop.openApp(TASKS);
        }
        return { desktop, thirdPartyAppCount: id.startsWith('agent:') || hidden ? 2 : 0 };
    },
    async getAppsConfig() { return { [CATALOG]: {}, [TASKS]: {} }; },
} as DesktopManager;
let inputLimit = 150_000;
const llm: LLMConfig = { provider: { id: 'local-console', baseURL: provider.url }, model: 'product-console', apiKey: 'synthetic-only',
    inputBudget: () => ({ contextWindow: inputLimit + 750, maxOutputTokens: 750 }) };
const host = new HostManagerV2('console-topic', {} as ConstructorParameters<typeof HostManagerV2>[1]);
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async () => llm);
mock.method(host.getLLMConfigService(), 'withModelInputBudget', (value: LLMConfig) => value);
await host.initAgentDriver(runtime, desktops);
await db.initDatabase();
const sessions = host.getSessionManager()!;
function topic(id: string) {
    db.createTopic({ id, agentId: 'console', title: id, status: 'hot', createdAt: Date.now(), updatedAt: Date.now(),
        sourceControls: { apps: { enabled: true, disabledItems: [] },
            mcp: { enabled: false, disabledItems: [], allowedServers: [] }, skill: { enabled: false, disabledItems: [] } } });
}
const delivered = new Map<string, NonNullable<GuiUpdateEvent['message']>>();
const unsubscribe = host.onGuiUpdate((event: GuiUpdateEvent) => {
    if (event.type !== 'tool' || !event.message) return;
    const parts = event.message.content;
    if (!Array.isArray(parts) || parts[0]?.type !== 'tool-result') return;
    delivered.set(parts[0].toolCallId, event.message);
    if (event.topicId.startsWith('agent:')) (host['imSessionManager']?.getSession(event.topicId)?.agentDriver as AgentDriverV2).pause();
    else host.pauseAgent(event.topicId);
});
try {
    const hiddenTopicId = 'console-hidden-topic', hiddenIM = 'agent:blank:local:direct:hidden';
    const now = Date.now();
    db.createTopic({ id: hiddenTopicId, agentId: 'blank', title: hiddenTopicId, status: 'hot', createdAt: now, updatedAt: now });
    await host.ensureSessionForTopic(hiddenTopicId);
    const hiddenTopic = sessions.getSession(hiddenTopicId)!;
    host.pauseAgent(hiddenTopicId);
    const disabledCode = 'inspect(1+2); inspect(Object.keys(refs).length); inspect(Object.keys(tools).length);';
    const hiddenCases = [];
    for (const id of [hiddenTopicId, hiddenIM]) {
        const call = codeCall(id, disabledCode);
        provider.replyNext({ label: id, calls: [call] });
        if (id === hiddenTopicId) {
            await host.sendUserMessage('Run without App access.', id);
            host.resumeAgent(id);
            await watchUntil(() => delivered.get(call.id));
            await watchUntil(() => hiddenTopic.agentDriver.getState() === 'idle');
        } else {
            await host.sendIMMessage({ sessionKey: id, agentId: 'blank', channel: 'local', chatType: 'direct',
                peerId: 'hidden', senderId: 'fixture', chatId: 'fixture', messageId: call.id, timestamp: Date.now(),
                body: 'Run without App access.', triggerAgent: true });
            await watchUntil(() => delivered.get(call.id));
            await watchUntil(() => (host['imSessionManager']!.getSession(id)?.agentDriver as AgentDriverV2 | undefined)?.getState() === 'idle');
        }
        const request = provider.requests.find(entry => entry.label === id);
        const names = request.body.tools.map(entry => entry.function.name).sort();
        assert.deepEqual(names, ['context_compact', 'run_code']);
        assert.doesNotMatch(JSON.stringify(request.body), /<view |<desktop>|console_catalog|console_tasks/);
        const result = savedResult(delivered.get(call.id), call.id);
        assert.deepEqual(result.output, ['3', '0', '0']);
        assert.equal((await journal(folders.get(id), 'writes')).length, 0);
        hiddenCases.push({ id, names, result });
    }
    await host.setSourceEnabled(hiddenTopicId, 'apps', true);
    const hiddenClose = system('hidden-close', 'close_app', { app_id: TASKS });
    provider.replyNext({ label: 'enable directory without enabling its Apps', calls: [hiddenClose] });
    await host.sendUserMessage('Try to close the disabled installation.', hiddenTopicId);
    host.resumeAgent(hiddenTopicId);
    const hiddenResult = savedResult(await watchUntil(() => delivered.get(hiddenClose.id)), hiddenClose.id);
    assert.equal(hiddenResult.code, 'INVALID_APP_TARGET');
    const hiddenRequest = provider.requests.find(entry => entry.label === 'enable directory without enabling its Apps');
    assert.doesNotMatch(JSON.stringify(hiddenRequest.body), /<view |console_catalog|console_tasks/);
    const stillRunning = hiddenTopic.desktop.listApps().find(entry => entry.appId === TASKS);
    assert.equal(stillRunning?.status, 'running');
    facts.disabledAgents = { cases: hiddenCases, hiddenResult, appStatus: stillRunning.status };
    await host.shutdownSession(hiddenTopicId);

    const topicId = 'console-topic';
    topic(topicId);
    await host.ensureSessionForTopic(topicId);
    host.pauseAgent(topicId);
    const session = sessions.getSession(topicId)!;
    async function turn(label: string, call: ReturnType<typeof codeCall>, beforeReply?: (request: unknown) => unknown) {
        provider.replyNext({ label, calls: [call], beforeReply });
        await host.sendUserMessage(label, topicId);
        host.resumeAgent(topicId);
        const message = await watchUntil(() => delivered.get(call.id), 18_000);
        await watchUntil(() => session.agentDriver.getState() === 'idle');
        const request = provider.requests.find(entry => entry.label === label);
        assert.ok(request);
        return { message, body: request.body };
    }
    facts.topic = await exerciseConsole({ turn, runtime, desktop: session.desktop, folder: folders.get(topicId), hooks, scoped: true,
        install: () => installConsoleFixtures(session.desktop, consumer, folders.get(topicId)!),
        async receipt(_message, parent, subcall) {
            const rows = host.getMessages(topicId) as Array<{ role: string; id: string; content: unknown }>;
            const saved = rows.find(row => row.role === 'tool' && JSON.stringify(row.content).includes('"toolCallId":"' + parent + '"'));
            assert.ok(saved?.id);
            return sessions.readAppReceipt(topicId, { messageId: saved.id, toolCallId: parent, subcallId: subcall }, 2_000);
        },
    });
    const originalFolder = folders.get(topicId)!;
    await host.shutdownSession(topicId);
    provider.replyNext({ label: 'replay saved Topic', text: 'Read the saved result.' });
    await host.sendUserMessage('Review the result from the saved conversation.', topicId);
    const replay = await watchUntil(() => provider.requests.find(request => request.label === 'replay saved Topic'));
    assert.equal(replay.body.messages.filter((message: { role: string; tool_call_id?: string }) =>
        message.role === 'tool' && message.tool_call_id === 'cross').length, 1);
    assert.ok(!replay.body.tools.some((tool: { function: { name: string } }) => tool.function.name === TASKS + '-accept'));
    assert.equal((await journal(originalFolder, 'writes')).length, 5);
    facts.replay = { inputBytes: replay.inputBytes, writes: 5 };

    const imKey = 'agent:console:local:direct:console-user';
    const im = () => host['imSessionManager']!.getSession(imKey)!;
    const imTurns = [];
    for (const [label, call] of [
        ['IM opens catalog', system('im-catalog', 'open_app', { installation_id: CATALOG })],
        ['IM opens tasks', system('im-tasks', 'open_app', { installation_id: TASKS })],
        ['IM runs program', codeCall('im-program', 'const result = await tools["console_tasks-accept"]({items:refs.console_catalog.list.todos,literal:"$IM"}); inspect(result.saved);')],
    ] as const) {
        provider.replyNext({ label, calls: [call] });
        await host.sendIMMessage({ sessionKey: imKey, agentId: 'console', channel: 'local', chatType: 'direct',
            peerId: 'console-user', senderId: 'fixture', chatId: 'fixture', messageId: call.id, timestamp: Date.now(),
            body: label, triggerAgent: false });
        const driver = im().agentDriver as AgentDriverV2;
        driver.resume();
        await driver.trigger();
        const message = await watchUntil(() => delivered.get(call.id));
        await watchUntil(() => driver.getState() === 'idle');
        const saved = listIMMessages(imKey).find(row => row.role === 'tool' && JSON.stringify(row.content) === JSON.stringify(message.content));
        assert.ok(saved?.id);
        assert.ok(listIMMessages(imKey).some(row => row.role === 'assistant' && JSON.stringify(row.content).includes(call.id)));
        imTurns.push({ messageId: saved.id, result: savedResult(message, call.id) });
    }
    const imFinal = imTurns.at(-1)!;
    assert.deepEqual(imFinal.result.output, ['true']);
    assert.equal(imFinal.result.subcalls[0].phase, 'entered-returned');
    const imWrites = await journal(folders.get(imKey), 'writes');
    assert.equal(imWrites.length, 1);
    assert.equal(imWrites[0].value.literal, '$IM');

    const imFolder = folders.get(imKey)!;
    await writeFile(join(imFolder, 'park'), '');
    try {
        const call = codeCall('im-cancelled', 'const x = tools["console_tasks-accept"]({items:[],literal:"park"}); ' +
            'const y = tools["console_tasks-accept"]({items:[],literal:"must not start"}); await Promise.all([x,y]);');
        provider.replyNext({ label: 'IM cancels a program', calls: [call] });
        await host.sendIMMessage({ sessionKey: imKey, agentId: 'console', channel: 'local', chatType: 'direct',
            peerId: 'console-user', senderId: 'fixture', chatId: 'fixture', messageId: call.id, timestamp: Date.now(),
            body: 'Stop after the first operation starts.', triggerAgent: false });
        const driver = im().agentDriver as AgentDriverV2;
        driver.resume();
        const running = driver.trigger();
        await watchUntil(async () => (await journal(imFolder, 'writes')).some(row => row.value.literal === 'park'));
        driver.stop();
        await running;
        const message = await watchUntil(() => delivered.get(call.id));
        const result = savedResult(message, call.id);
        assert.equal(result.code, 'CONSOLE_CANCELLED');
        assert.equal(result.result.scope, 'lost');
        assert.deepEqual(result.result.subcalls.map(child => child.phase), ['unknown', 'not-dispatched']);
        const row = host.getIMMessages(imKey).find(entry => entry.role === 'tool' && JSON.stringify(entry.content).includes('"toolCallId":"' + call.id + '"'));
        assert.ok(row?.id);
        const compacted = await im().source.runHardFallbackCompaction('verify retained receipt', { minMessages: 2, keepRecentMessages: 4 });
        assert.equal(compacted.compacted, true);
        assert.ok(host.getIMMessages(imKey).some(entry => entry.id === row.id));
        await unlink(join(imFolder, 'park'));
        const childId = result.result.subcalls[0].invocationId;
        const settled = await host.readIMAppReceipt(imKey, { messageId: row.id, toolCallId: call.id, subcallId: childId }, 2_000);
        assert.equal(settled.kind, 'receipt');
        assert.equal(settled.receipt.outcome.status, 'succeeded');
        assert.equal(settled.receipt.invocationId, childId);
        const writes = await journal(imFolder, 'writes');
        assert.deepEqual(writes.map(row => row.value.literal), ['$IM', 'park']);
        facts.im = { turns: imTurns, writes, cancelled: { messageId: row.id, result, settled, retainedAfterCompaction: true } };
    } finally { await unlink(join(imFolder, 'park')).catch(() => {}); }

    const budgetId = 'console-budget';
    topic(budgetId);
    inputLimit = 3_700;
    const budgetEvents = [];
    const observe = host.onGuiUpdate(event => { if (event.topicId === budgetId) budgetEvents.push(event); });
    provider.replyNext({ label: 'only management', text: 'Management recovered.' });
    await host.sendUserMessage('Use only the remaining operations.', budgetId);
    const management = await watchUntil(() => provider.requests.find(request => request.label === 'only management'));
    assert.equal(management.body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'run_code'), false);
    assert.ok(management.body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'system-open_app'));
    await watchUntil(() => budgetEvents.some(event => event.type === 'assistant'));
    facts.management = management;
    observe();

    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    unsubscribe();
    await host.dispose();
    facts.shutdown = await runtime.beginClose().completion;
    await provider.close();configuration.mock.restore();db.closeDatabase();
    if (evidence) await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(project, { recursive: true, force: true });
}
assert.equal((facts.shutdown as { resourcesReleased: boolean }).resourcesReleased, true);
console.log('PASS product Topic and IM Console against actual Worker actions and saved model requests');
