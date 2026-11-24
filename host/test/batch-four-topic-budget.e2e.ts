import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRuntime, type DesktopID } from '@aotui/runtime';
import type { LLMConfig } from '@aotui/agent-driver-v2';
import type { DesktopManager } from '../src/core/desktop-manager.js';
import type { LLMConfigService } from '../src/core/llm-config-service.js';
import type { GuiUpdateEvent } from '../src/types/session.js';
import { fixtureAppPath, fixtureProvider, journal, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';
import { APP, INPUT, OUTPUT, A_NOTE, openFiles, onFile, windowAction, pageFor, setupFiles } from '../../tests/fixtures/batch-four-support.mjs';

const [consumer, evidence] = process.argv.slice(2);
assert.ok(consumer, 'Pass the independent installed consumer for batch four.');
const project = await mkdtemp(join(tmpdir(), 'aotui-b4-host-'));
process.env.DB_PATH = join(project, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(project, 'state');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const db = await import('../src/db/index.js');
const { listIMMessages } = await import('../src/im/message-store.js');
const { Config } = await import('../src/config/config.js');
const { MessageService } = await import('../src/core/message-service.js');
const { SessionManagerV3 } = await import('../src/core/session-manager-v3.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const config = mock.method(Config, 'get', async () => ({
    agents: { list: [{ id: 'windows', prompt: 'Use the current file views to continue.', enabledApps: ['files_install'] }] },
}));
const runtime = createRuntime();
const moduleURL = pathToFileURL(resolve(consumer, 'dist', 'batch-four-files.js')).href;
const provider = await fixtureProvider();
// Allow for the Console declarations while keeping both expanded file bodies over budget.
const hostInput = INPUT + 2_000;
const llm: LLMConfig = { model: 'windows', provider: { id: 'windows', baseURL: provider.url }, apiKey: 'test-only',
    inputBudget: () => ({ contextWindow: hostInput + OUTPUT, maxOutputTokens: OUTPUT }) };
const models = { resolveLLMConfig: async () => llm, withModelInputBudget: (settings: LLMConfig) => settings } as LLMConfigService;
const paths = new Map<string, string>();
const desktops = {
    async createDesktop(id: DesktopID) {
        const path = join(project, 'files-' + paths.size);
        paths.set(id, path);
        await setupFiles(path);
        const desktopId = (await runtime.createDesktop(id)).id;
        const desktop = runtime.getDesktop(desktopId);
        await desktop.registerPendingApp({ installationId: 'files_install', localPath: await fixtureAppPath(moduleURL, APP, path), config: { folder: path, staticB: true } });
        await desktop.openApp('files_install');
        return { desktop, thirdPartyAppCount: 1 };
    },
    async getAppsConfig() { return { files_install: {} }; },
} as DesktopManager;
const topicId = 'budget-topic', key = 'agent:windows:test:direct:budget-peer';
const topicMessages = new MessageService();
const topic = new SessionManagerV3(desktops, models, topicMessages);
const host = new HostManagerV2('unused-topic', {} as ConstructorParameters<typeof HostManagerV2>[1]);
mock.method(host['llmConfigService'], 'resolveLLMConfig', models.resolveLLMConfig);
const facts: Record<string, unknown> = { requests: provider.requests, passed: false };

try {
    await mkdir(project, { recursive: true });
    await db.initDatabase();
    const time = Date.now();
    db.createTopic({ id: topicId, agentId: 'windows', title: 'Budget fixture', createdAt: time, updatedAt: time, status: 'hot',
        sourceControls: { apps: { enabled: true, disabledItems: [] }, skill: { enabled: false, disabledItems: [] },
            mcp: { enabled: false, disabledItems: [], allowedServers: [] } } });
    const delivered: NonNullable<GuiUpdateEvent['message']>[] = [];
    topic.on('message', (event: GuiUpdateEvent) => {
        if (event.topicId === topicId && event.message?.role === 'tool') { delivered.push(event.message); topic.pauseSession(topicId); }
    });
    const ready = await topic.ensureSession(topicId);
    topic.pauseSession(topicId);
    const topicTurn = async (label: string, calls: ReturnType<typeof openFiles>[]) => {
        const sequence = delivered.length;
        provider.replyNext({ label, calls });
        await topic.sendMessage(topicId, label);
        topic.resumeSession(topicId);
        const message = await watchUntil(() => delivered[sequence]);
        await watchUntil(() => ready.agentDriver.getState() === 'idle');
        assert.equal(JSON.stringify(topicMessages.getMessages(topicId).find(row => row.id === message.id)?.content),
            JSON.stringify(message.content));
        return message;
    };
    await topicTurn('topic open', [openFiles('topic-open', 'A', 'B')]);
    const topicWrite = await topicTurn('topic write', [onFile('topic-write', 'edit', 'B', { mode: 'large' })]);
    const payload = (message: any) => message.content[0].output.value;
    assert.equal(payload(topicWrite).result.saved, true);
    assert.equal(payload(topicWrite).window_budget.mode, 'window_hints');
    await topicTurn('topic collapse', [windowAction('topic-collapse', 'collapse_view', 'A', { note: A_NOTE })]);
    const hint = provider.requests.find(request => request.label === 'topic collapse');
    assert.match(pageFor(hint.body, 'B'), /body does not fit/);
    assert.ok(hint.body.tools.some((tool: any) => tool.function.name === 'system-read_window_budget'));
    assert.ok(hint.body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'topic-write'));
    provider.replyNext({ label: 'topic restored', calls: [] });
    await topic.sendMessage(topicId, 'topic restored');
    topic.resumeSession(topicId);
    const restored = await watchUntil(() => provider.requests.find(request => request.label === 'topic restored'));
    assert.match(pageFor(restored.body, 'A'), /Check A &lt;later&gt; &amp;/);
    assert.match(pageFor(restored.body, 'B'), /B-LATEST/);
    topic.pauseSession(topicId);
    assert.deepEqual((await journal(paths.get(topicId)!, 'writes')).map(entry => entry.name), ['B']);
    facts.topic = { savedToolMessage: topicWrite, recovered: restored, writes: await journal(paths.get(topicId)!, 'writes') };

    await host.initAgentDriver(runtime, desktops);
    const imDelivered: NonNullable<GuiUpdateEvent['message']>[] = [];
    const imSession = () => host['imSessionManager']?.getSession(key);
    const unsubscribe = host.onGuiUpdate(event => {
        if (event.topicId === key && event.message?.role === 'tool') { imDelivered.push(event.message); imSession()?.agentDriver.pause(); }
    });
    try {
        async function imTurn(label: string, calls: ReturnType<typeof openFiles>[]) {
            const sequence = imDelivered.length;
            provider.replyNext({ label, calls });
            await host.sendIMMessage({ sessionKey: key, agentId: 'windows', channel: 'test', chatType: 'direct',
                peerId: 'budget-peer', body: label, messageId: label, senderId: 'budget-peer', chatId: 'test-chat',
                timestamp: Date.now(), triggerAgent: false });
            const driver = imSession()?.agentDriver;
            assert.ok(driver);
            driver.resume();
            await driver.trigger();
            const message = await watchUntil(() => imDelivered[sequence]);
            await watchUntil(() => driver.getState() === 'idle');
            await watchUntil(() => listIMMessages(key).some(row => row.role === 'tool' && JSON.stringify(row.content) === JSON.stringify(message.content)));
            return message;
        }
        await imTurn('IM open', [openFiles('im-open', 'A', 'B')]);
        const imWrite = await imTurn('IM write', [onFile('im-write', 'edit', 'B', { mode: 'large' })]);
        assert.equal(payload(imWrite).result.saved, true);
        assert.equal(payload(imWrite).window_budget.mode, 'window_hints');
        const folder = paths.get(key)!;
        assert.deepEqual((await journal(folder, 'writes')).map(entry => entry.name), ['B']);
        assert.match(await readFile(join(folder, 'B.txt'), 'utf8'), /^B-LATEST/);
        facts.im = { savedToolMessage: imWrite, writes: await journal(folder, 'writes') };
    } finally { unsubscribe(); }
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    await host.dispose();
    await topic.cleanup();
    facts.shutdown = await runtime.beginClose().completion;
    await provider.close();
    config.mock.restore();
    db.closeDatabase();
    if (evidence) await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(project, { recursive: true, force: true });
}
assert.match(JSON.stringify(facts.shutdown), /"resourcesReleased":true/);
