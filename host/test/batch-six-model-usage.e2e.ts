import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createRuntime, type DesktopID } from '@aotui/runtime';
import type { AgentDriverV2, LLMConfig } from '@aotui/agent-driver-v2';
import type { DesktopManager } from '../src/core/desktop-manager.js';
import type { GuiUpdateEvent, ModelUsageEvent } from '../src/types/session.js';
import type { IMInboundMessage } from '../src/im/types.js';
import { fixtureAppPath, appClient, fixtureProvider, journal, observe, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';
import { APP, INPUT, OUTPUT, openFiles, onFile, pageFor, setupFiles } from '../../tests/fixtures/batch-four-support.mjs';
import { googleFrames, googleUsage } from '../../tests/fixtures/batch-six-usage-support.mjs';

const [consumer, evidence] = process.argv.slice(2);
assert.ok(consumer, 'Pass the installed batch-six consumer directory.');
const project = await mkdtemp(join(tmpdir(), 'aotui-b6-host-'));
process.env.DB_PATH = join(project, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(project, 'state');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const db = await import('../src/db/index.js');
const { Config } = await import('../src/config/config.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const { IMRuntimeBridge } = await import('../src/im/im-runtime-bridge.js');

const topicId = 'usage-topic', key = 'agent:usage:local:direct:usage-peer';
const nativeTopicId = 'usage-native-topic';
const config = mock.method(Config, 'get', async () => ({
    agents: { list: [{ id: 'usage', prompt: 'Use the open file views.', enabledApps: ['files_install'] }] },
    im: { enabled: true, channels: { local: { enabled: true } } },
}));
const provider = await fixtureProvider();
const runtime = createRuntime();
const moduleURL = pathToFileURL(resolve(consumer, 'dist', 'batch-four-files.js')).href;
let contextWindow = INPUT + OUTPUT;
const llm: LLMConfig = { model: 'fixture/usage', provider: { id: 'usage-gateway', baseURL: provider.url }, apiKey: 'test-only',
    inputBudget: () => ({ contextWindow, maxOutputTokens: OUTPUT }) };
const nativeLLM: LLMConfig = { ...llm, model: 'fixture-native-google', provider: { id: 'google', baseURL: provider.url } };
const paths = new Map<string, string>();
const adoptedObservations = new Map<DesktopID, ReadonlyMap<string, string>>();
const restoreAdoptions: Array<() => void> = [];
const desktops = {
    async createDesktop(id: DesktopID) {
        if (id === nativeTopicId) return runtime.createDesktop(id);
        const folder = join(project, 'files-' + paths.size);
        paths.set(id, folder);
        await setupFiles(folder);
        const desktopId = (await runtime.createDesktop(id)).id;
        const desktop = runtime.getDesktop(desktopId);
        const adopt = desktop.adoptTurn.bind(desktop);
        const recordAdoption = mock.method(desktop, 'adoptTurn', (selection: Parameters<typeof adopt>[0]) => {
            const result = adopt(selection);
            if (result.status === 'adopted') adoptedObservations.set(id, new Map(selection.apps.map(({ candidate: { observation } }) =>
                [observation.source.appId, observation.observationId])));
            return result;
        });
        restoreAdoptions.push(() => recordAdoption.mock.restore());
        await desktop.registerPendingApp({ installationId: 'files_install', localPath: await fixtureAppPath(moduleURL, APP, folder), config: { folder } });
        await desktop.openApp('files_install');
        return desktop;
    },
    async getAppsConfig() { return { files_install: {} }; },
} as unknown as DesktopManager;
const host = new HostManagerV2(topicId, {} as ConstructorParameters<typeof HostManagerV2>[1]);
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async (hint?: string) => hint === nativeLLM.model ? nativeLLM : llm);
mock.method(host.getLLMConfigService(), 'withModelInputBudget', (settings: LLMConfig) => settings);

const outbound: Array<{ kind: string; text: string }> = [];
let dispatchIM!: (message: IMInboundMessage) => Promise<void>;
const im = new IMRuntimeBridge({
    hostManager: host,
    createChannelPlugins(dispatch) {
        dispatchIM = dispatch;
        return [{ id: 'local', meta: { label: 'Local fixture' }, capabilities: { chatTypes: ['direct'], streaming: true },
            async start() {}, async stop() {},
            createReplyHandler: () => ({
                async onPartialReply(text) { outbound.push({ kind: 'text', text }); },
                async onReasoningDelta(text) { outbound.push({ kind: 'reasoning', text }); },
                async onFinalReply(text) { outbound.push({ kind: 'final', text }); },
                async cleanup() {},
            }),
        }];
    },
});

const fileWorkers = new WeakMap<Worker, { threadId: number; desktopId: string }>();
const wire: Array<{ threadId: number; desktopId: string; direction: string; type: string; protocol?: string }> = [];
const dispatches: Array<{ desktopId: string; observationId: string; tool: string; viewId: string }> = [];
const exits: Array<{ threadId: number; desktopId: string; code: number }> = [];
const post = Worker.prototype.postMessage;
const record = mock.method(Worker.prototype, 'postMessage', function (this: Worker, ...args: Parameters<typeof post>) {
    const message = args[0];
    if (message?.type === 'INIT' && message.appName === APP) {
        const worker = { threadId: this.threadId, desktopId: message.desktopId };
        fileWorkers.set(this, worker);
        this.on('message', reply => wire.push({ ...worker, direction: 'fromWorker', type: reply.type,
            ...(reply.protocol ? { protocol: reply.protocol } : {}) }));
        this.once('exit', code => exits.push({ ...worker, code }));
    }
    const worker = fileWorkers.get(this);
    if (worker) wire.push({ ...worker, direction: 'toWorker', type: message.type,
        ...(message.protocol ? { protocol: message.protocol } : {}) });
    if (worker && message.type === 'VIEW_TOOL_INVOKE') {
        const observationId = adoptedObservations.get(worker.desktopId)?.get(message.appId);
        assert.ok(observationId, 'Expected the original observation from Desktop adoption');
        dispatches.push({ desktopId: worker.desktopId, observationId,
            tool: message.tool.name, viewId: message.receiver.viewId });
    }
    return post.apply(this, args);
});

const usage = {
    prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 4, vendor: { host: 'fixture-usage-only' } },
    completion_tokens_details: { reasoning_tokens: 3, vendor: { retained: [true, 0] } },
};
const received: ModelUsageEvent[] = [], cancelled: ModelUsageEvent[] = [], failing: string[] = [];
const unsubscribeFailing = host.onModelUsage(event => {
    failing.push(event.sessionId);
    throw new Error('fixture sync observer failed');
});
const unsubscribeAsync = host.onModelUsage(async () => { throw new Error('fixture async observer failed'); });
const unsubscribeCancelled = host.onModelUsage(event => { cancelled.push(event); });
const unsubscribeUsage = host.onModelUsage(event => { received.push(event); });
const events: GuiUpdateEvent[] = [];
const getIM = () => host['imSessionManager']?.getSession(key);
const unsubscribeGui = host.onGuiUpdate((event: GuiUpdateEvent) => {
    events.push(event);
    if (event.type === 'tool') {
        if (event.topicId === topicId) host.pauseAgent(topicId);
        if (event.topicId === key) getIM()?.agentDriver.pause();
    }
});
const facts: Record<string, unknown> = {
    requests: provider.requests, received, cancelled, failing, outbound, wire, dispatches, exits, events, passed: false,
};

try {
    await db.initDatabase();
    const time = Date.now();
    db.createTopic({ id: topicId, agentId: 'usage', title: 'Usage fixture', createdAt: time, updatedAt: time, status: 'hot',
        sourceControls: { apps: { enabled: true, disabledItems: [] }, skill: { enabled: false, disabledItems: [] },
            mcp: { enabled: false, disabledItems: [], allowedServers: [] } } });
    await host.initAgentDriver(desktops);
    await im.start();
    assert.equal(im.getRuntime().channels.find(channel => channel.id === 'local')?.active, true);
    await host.ensureSessionForTopic(topicId);
    const topic = host.getSessionManager()?.getSession(topicId);
    assert.ok(topic);
    host.pauseAgent(topicId);

    async function drainNotification(driver: AgentDriverV2, sessionId: string, offset: number) {
        await watchUntil(() => events.slice(offset).some(event =>
            event.topicId === sessionId && event.type === 'agent_state' && event.state === 'idle'));
        await (driver as unknown as { runInFlight: Promise<void> | null }).runInFlight;
        assert.equal(driver.getState(), 'idle');
    }
    for (const kind of ['topic', 'im'] as const) {
        const sessionId = kind === 'topic' ? topicId : key;
        let driver: AgentDriverV2;
        const startTurn = async (label: string, options?: Parameters<typeof provider.replyNext>[0]) => {
            const offset = events.length;
            if (options) provider.replyNext({ label, ...options });
            if (kind === 'topic') {
                host.pauseAgent(topicId);
                await host.sendUserMessage(label, topicId);
                driver = topic.agentDriver;
                host.resumeAgent(topicId);
            } else {
                await dispatchIM({ sessionKey: key, agentId: 'usage', channel: 'local', chatType: 'direct',
                    peerId: 'usage-peer', body: label, messageId: label, senderId: 'usage-peer', chatId: 'test-chat',
                    timestamp: Date.now(), triggerAgent: false });
                const session = getIM();
                assert.ok(session);
                driver = session.agentDriver;
                driver.resume();
                session.source.notifyUpdate();
            }
            await drainNotification(driver, sessionId, offset);
        };
        const openCall = kind + '-open', editedCall = kind + '-edit';
        const usageStart = received.length;
        const requestStart = provider.requests.length;
        await startTurn(kind + ' open without usage', { calls: [openFiles(openCall, 'B')] });
        assert.equal(received.length, usageStart);
        assert.equal(provider.requests.length, requestStart + 1);
        const desktop = runtime.getDesktop(sessionId);
        const { client } = appClient(desktop, APP);
        async function projection() {
            const { observationId, source, views, refs, tools } = await observe(client);
            client.release(observationId);
            return { source, views, refs, tools };
        }
        const before = await projection();
        assert.ok(before.views.some(view => view.id === 'file_B_1' && view.content.value.includes('B-INITIAL')));
        assert.ok(before.tools.some(tool => tool.name === 'edit'));

        let replyStart = -1;
        const quietLabel = kind + ' usage only';
        await startTurn(quietLabel, { usage, text: '', async beforeReply() {
            if (kind === 'topic') await host.switchTopic('another-topic');
            replyStart = wire.length;
        } });
        assert.ok(replyStart >= 0);
        const usageWire = wire.slice(replyStart);
        assert.deepEqual(usageWire, []);
        const after = await projection();
        assert.deepEqual(after, before);
        assert.equal(provider.requests.length, requestStart + 2);
        assert.equal(received.length, usageStart + 1);
        if (kind === 'topic') unsubscribeCancelled();

        for (let index = 0; index < 2; index++) {
            const offset = events.length;
            if (kind === 'topic') topic.sources.host.notifyNewMessage();
            else getIM()?.source.notifyUpdate();
            await drainNotification(driver!, sessionId, offset);
        }
        assert.equal(provider.requests.length, requestStart + 2);
        assert.equal(received.length, usageStart + 1);

        const lowBudget = events.length;
        contextWindow = OUTPUT + 1;
        await startTurn(kind + ' over budget');
        contextWindow = INPUT + OUTPUT;
        const budgetEvent = events.slice(lowBudget).find(event => event.topicId === sessionId &&
            JSON.stringify(event.message)?.includes('MODEL_INPUT_BUDGET_EXCEEDED'));
        assert.ok(budgetEvent, JSON.stringify(events.slice(lowBudget)));
        assert.equal(provider.requests.length, requestStart + 2);
        assert.equal(received.length, usageStart + 1);

        const text = kind + ' editing B.', reasoning = kind + ' selected the open file.';
        const editLabel = kind + ' edit with usage';
        const editEventsStart = events.length;
        await startTurn(editLabel, { usage, text, reasoning, calls: [onFile(editedCall, 'edit', 'B', { mode: 'short' })] });
        assert.equal(provider.requests.length, requestStart + 3);
        assert.equal(received.length, usageStart + 2);
        for (const event of received.slice(usageStart)) {
            assert.equal(event.kind, kind);
            assert.equal(event.sessionId, sessionId);
            assert.equal(event.providerId, llm.provider.id);
            assert.equal(event.modelId, llm.model);
            assert.deepEqual(event.usage.raw, usage);
            assert.deepEqual([event.usage.inputTokens, event.usage.outputTokens, event.usage.totalTokens], [11, 7, 18]);
        }
        const editEvents = events.slice(editEventsStart).filter(event => event.topicId === sessionId);
        assert.deepEqual(editEvents.filter(event => event.type === 'text_delta').map(event => event.delta), [text]);
        assert.deepEqual(editEvents.filter(event => event.type === 'reasoning_delta').map(event => event.delta), [reasoning]);
        const history = () => kind === 'topic' ? host.getMessages(topicId) : host.getIMMessages(key);
        const paired = await watchUntil(() => {
            const rows = history();
            const assistant = rows.find(row => row.role === 'assistant' && JSON.stringify(row.content).includes(editedCall));
            const result = rows.find(row => row.role === 'tool' && JSON.stringify(row.content).includes(editedCall));
            const opened = rows.find(row => row.role === 'tool' && JSON.stringify(row.content).includes(openCall));
            return assistant && result && opened && { assistant, result, opened };
        });
        assert.deepEqual(paired.assistant.content, [
            { type: 'reasoning', text: reasoning }, { type: 'text', text },
            { type: 'tool-call', toolCallId: editedCall, toolName: 'window_files-edit', input: { view_id: 'file_B_1', mode: 'short' } },
        ]);
        assert.equal(Array.isArray(paired.result.content) && paired.result.content[0]?.toolCallId, editedCall);
        assert.equal(Array.isArray(paired.result.content) && paired.result.content[0]?.output.value.saved, true);
        assert.equal(Array.isArray(paired.opened.content) && paired.opened.content[0]?.output.value.opened[0], 'B');
        const editDispatches = dispatches.filter(item => item.desktopId === sessionId && item.tool === 'edit');
        assert.equal(editDispatches.length, 1);
        assert.equal(editDispatches[0]!.viewId, 'file_B_1');
        const receipt = await client.readReceipt({ observationId: editDispatches[0]!.observationId, invocationId: editedCall });
        assert.equal(receipt.kind, 'receipt');
        assert.equal(receipt.receipt.executionPhase, 'entered-returned');
        assert.deepEqual(JSON.parse(JSON.stringify(receipt.receipt.outcome)),
            { status: 'succeeded', value: { success: true, data: { saved: true } } });
        const folder = paths.get(sessionId)!;
        const writes = await journal(folder, 'writes');
        assert.deepEqual(writes.map(entry => entry.name), ['B']);
        assert.equal(await readFile(join(folder, 'B.txt'), 'utf8'), 'B-EDITED');
        const edited = await projection();
        assert.ok(edited.source.revision > before.source.revision);
        assert.ok(edited.views.some(view => view.id === 'file_B_1' && view.content.value.includes('B-EDITED')));
        const request = provider.requests.find(item => item.label === editLabel);
        assert.match(pageFor(request.body, 'B'), /B-INITIAL/);
        assert.ok(request.body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === openCall));
        assert.doesNotMatch(JSON.stringify(history()), /fixture-usage-only|inputTokenDetails/);
        facts[kind] = { before, after, edited, usageWire, writes, paired, receipt, budgetEvent, editEvents,
            sendCounts: { absentUsage: 1, usageOnly: 1, duplicateNotifications: 0, overBudget: 0, edit: 1 } };
    }
    assert.deepEqual(cancelled.map(event => event.sessionId), [topicId]);
    assert.deepEqual(failing, [topicId, topicId, key, key]);
    assert.equal(received.length, 4);
    assert.ok(!events.some(event => (event as { type: string }).type === 'model-usage'));
    assert.doesNotMatch(JSON.stringify(events), /fixture-usage-only|inputTokenDetails/);
    assert.ok(provider.requests.every(request => request.body.max_tokens === OUTPUT));
    assert.ok(outbound.some(item => item.kind === 'reasoning' && item.text === 'im selected the open file.'));
    assert.ok(outbound.some(item => item.kind === 'text' && item.text === 'im editing B.'));
    assert.ok(outbound.some(item => item.kind === 'final' && item.text === 'im editing B.'));
    assert.doesNotMatch(JSON.stringify(outbound), /fixture-usage-only|inputTokenDetails/);
    assert.doesNotMatch(JSON.stringify(provider.requests.map(request => request.body)), /fixture-usage-only|inputTokenDetails/);
    assert.deepEqual(wire.filter(message => message.type === 'INIT').map(message => message.protocol), ['app-worker/v10', 'app-worker/v10']);
    assert.equal(wire.filter(message => message.direction === 'toWorker' && message.type === 'VIEW_TOOL_INVOKE').length, 4);
    assert.ok(!wire.some(message => /LLM_USAGE|LLM_OUTPUT/.test(message.type)));

    db.createTopic({ id: nativeTopicId, agentId: 'usage', title: 'Native usage fixture', modelOverride: nativeLLM.model,
        createdAt: time, updatedAt: time, status: 'hot',
        sourceControls: { apps: { enabled: false, disabledItems: [] }, skill: { enabled: false, disabledItems: [] },
            mcp: { enabled: false, disabledItems: [], allowedServers: [] } } });
    await host.ensureSessionForTopic(nativeTopicId);
    const session = host.getSessionManager()?.getSession(nativeTopicId);
    assert.ok(session);
    const requestStart = provider.requests.length, usageStart = received.length, offset = events.length;
    const text = 'Native fixture reply.';
    provider.replyNext({ label: 'Google native usage', path: '/v1/models/' + nativeLLM.model + ':streamGenerateContent?alt=sse',
        frames: googleFrames(googleUsage, text) });
    await host.sendUserMessage('Check native usage', nativeTopicId);
    await drainNotification(session.agentDriver, nativeTopicId, offset);
    const request = provider.requests[requestStart], [event] = received.slice(usageStart);
    const nativeHistory = host.getMessages(nativeTopicId);
    facts.native = { request, event, history: nativeHistory };
    assert.equal(provider.requests.length - requestStart, 1);
    assert.equal(received.length - usageStart, 1);
    assert.equal(event!.kind, 'topic');
    assert.equal(event!.sessionId, nativeTopicId);
    assert.equal(event!.providerId, 'google');
    assert.equal(event!.modelId, nativeLLM.model);
    assert.deepEqual(event!.usage.raw, request.response.findLast((frame: any) => frame.usageMetadata)?.usageMetadata);
    assert.deepEqual(event!.usage.raw, googleUsage);
    assert.deepEqual([event!.usage.inputTokens, event!.usage.outputTokens, event!.usage.totalTokens], [11, 7, 18]);
    assert.equal(request.body.generationConfig.maxOutputTokens, OUTPUT);
    assert.deepEqual(events.slice(offset).filter(event => event.type === 'text_delta').map(event => event.delta), [text]);
    assert.equal(nativeHistory.at(-1)?.content, text);
    assert.doesNotMatch(JSON.stringify(nativeHistory), /promptTokensDetails|candidatesTokensDetails/);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    unsubscribeGui();
    unsubscribeUsage();
    unsubscribeCancelled();
    unsubscribeAsync();
    unsubscribeFailing();
    await im.stop();
    await host.dispose();
    facts.shutdown = await runtime.beginClose().completion;
    await provider.close();
    record.mock.restore();
    for (const restore of restoreAdoptions) restore();
    config.mock.restore();
    db.closeDatabase();
    if (evidence) await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(project, { recursive: true, force: true });
}
assert.equal((facts.shutdown as { resourcesReleased: boolean }).resourcesReleased, true);
assert.deepEqual(exits.map(exit => exit.desktopId).sort(), [key, topicId].sort());
console.log('PASS real Topic and IM usage, native tool execution, output, budget, deduplication, Worker observation and closure');
