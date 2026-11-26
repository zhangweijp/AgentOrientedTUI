import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { createRuntime, type DesktopID } from '@aotui/runtime';
import type { DrivenSourceContext, LLMConfig, ModelInputMeasurement } from '@aotui/agent-driver-v2';
import type { DesktopManager } from '../src/core/desktop-manager.js';
import type { LLMConfigService } from '../src/core/llm-config-service.js';
import type { GuiUpdateEvent } from '../src/types/session.js';
import { fixtureAppPath, fixtureProvider, journal, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';
import { APP, setupFiles } from '../../tests/fixtures/batch-four-support.mjs';
import { CLAUDE, REGEX_SEARCH, claudeTurn, failedToolSearch, foundTool, useTool, wireBlocks } from '../../tests/fixtures/claude-tool-search.mjs';

const [consumer, evidence] = process.argv.slice(2);
assert.ok(consumer && evidence, 'Pass the installed files App consumer and an absolute evidence filename.');
const require = createRequire(import.meta.url);
const { anthropic } = createRequire(require.resolve('@aotui/agent-driver-v2'))('@ai-sdk/anthropic');
const scratch = await mkdtemp(join(tmpdir(), 'aotui-claude-history-'));
const folder = join(scratch, 'files');
process.env.DB_PATH = join(scratch, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(scratch, 'state');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;

const db = await import('../src/db/index.js');
const { Config } = await import('../src/config/config.js');
const { MessageService } = await import('../src/core/message-service.js');
const { SessionManagerV3 } = await import('../src/core/session-manager-v3.js');
const config = mock.method(Config, 'get', async () => ({
    agents: { list: [{ id: 'claude', prompt: 'Work on the current file views.', enabledApps: ['files_install'] }] },
}));
const runtime = createRuntime();
const provider = await fixtureProvider();
const settings: LLMConfig = { model: CLAUDE, provider: { id: 'anthropic', baseURL: provider.url }, apiKey: 'loopback-only',
    inputBudget: () => ({ contextWindow: 36_000, maxOutputTokens: 700 }) };
const observationIds = new Map<number, string>();
const desktops = {
    async createDesktop(id: DesktopID) {
        const desktop = await runtime.createDesktop(id);
        const localPath = await fixtureAppPath(resolve(consumer, 'dist', 'batch-four-files.js'), APP, folder);
        await desktop.registerPendingApp({ installationId: 'files_install', localPath, config: { folder } });
        await desktop.openApp('files_install');
        const adopt = desktop.adoptTurn.bind(desktop);
        mock.method(desktop, 'adoptTurn', (selection: Parameters<typeof adopt>[0]) => {
            const result = adopt(selection);
            const observation = selection.apps[0]?.candidate.observation;
            if (observation && result.status === 'adopted')
                observationIds.set(provider.requests.length, observation.observationId);
            return result;
        });
        return { desktop, thirdPartyAppCount: 1 };
    },
    async getAppsConfig() { return { files_install: {} }; },
} as DesktopManager;
const models = { resolveLLMConfig: async () => settings, withModelInputBudget: (value: LLMConfig) => value } as LLMConfigService;
const history = new MessageService();
const topic = new SessionManagerV3(desktops, models, history);
const topicId = 'claude-tool-search';
const EDIT = APP + '-edit';
const measurements: { beforeRequest: number; size: ModelInputMeasurement }[] = [];
const facts: Record<string, unknown> = { requests: provider.requests, measurements, passed: false };

async function createTopicSession() {
    const session = await topic.ensureSession(topicId);
    topic.pauseSession(topicId);
    // Opt into the experiment on each candidate, including any layout selected by the real budget fitter.
    function decorate(context: DrivenSourceContext): DrivenSourceContext {
        const edit = context.tools[EDIT];
        const fit = context.fitModelBudget?.bind(context);
        const tools = edit ? { ...context.tools,
            [EDIT]: { ...edit, providerOptions: { anthropic: { deferLoading: true } } },
            [REGEX_SEARCH]: anthropic.tools.toolSearchRegex_20251119({}),
        } : context.tools;
        return { ...context, tools, ...(fit ? { async fitModelBudget(measure, withFeedback) {
            const plan = await fit((candidate, feedback) => measure(decorate(candidate), feedback), withFeedback);
            if (!withFeedback) measurements.push({ beforeRequest: provider.requests.length, size: plan.measurement });
            return plan.context ? { ...plan, context: decorate(plan.context) } : plan;
        } } : {}) };
    }
    const source = session.sources.aotui;
    const capture = source.getContext.bind(source);
    mock.method(source, 'getContext', async (...args) => decorate(await capture(...args)));
    const system = session.sources.systemPrompt;
    const instructions = system.getContext.bind(system);
    mock.method(system, 'getContext', async (...args) => {
        const context = await instructions(...args);
        return { ...context, messages: context.messages.map(message => message.role === 'system' ? { ...message,
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        } : message) };
    });
    return session;
}

function windows(session: Awaited<ReturnType<typeof createTopicSession>>) {
    const app = session.desktop.listApps().find(item => item.installationId === 'files_install');
    assert.ok(app?.appId && app.appInstanceId);
    const access = session.desktop.getRunningApp(app.appId, app.appInstanceId);
    assert.equal(access.status, 'ready');
    return { ...app, running: access.app, views: session.desktop.getAppWindows(app.appId, app.appInstanceId)!.views };
}

try {
    await setupFiles(folder);
    await db.initDatabase();
    const at = Date.now();
    db.createTopic({ id: topicId, agentId: 'claude', title: 'Claude search history fixture', createdAt: at, updatedAt: at,
        status: 'hot', sourceControls: { apps: { enabled: true, disabledItems: [] }, skill: { enabled: false, disabledItems: [] },
            mcp: { enabled: false, disabledItems: [], allowedServers: [] } } });

    let ready = await createTopicSession();
    let after: 'assistant' | 'tool' = 'assistant';
    let delivered: NonNullable<GuiUpdateEvent['message']> | undefined;
    topic.on('message', (event: GuiUpdateEvent) => {
        if (event.topicId === topicId && event.type === after && event.message) {
            delivered = event.message;
            topic.pauseSession(topicId);
        }
    });
    async function turn(label: string, parts: { type: string }[], beforeReply?: () => Promise<void>) {
        delivered = undefined;
        after = parts.some(part => part.type === 'tool_use') ? 'tool' : 'assistant';
        const requestIndex = provider.requests.length;
        provider.replyNext(claudeTurn(label, parts, beforeReply));
        await topic.sendMessage(topicId, label);
        topic.resumeSession(topicId);
        const message = await watchUntil(() => delivered);
        await watchUntil(() => ready.agentDriver.getState() === 'idle');
        const request = provider.requests[requestIndex];
        assert.equal(request?.label, label);
        assert.equal(request.body.max_tokens, 700);
        assert.ok(request.body.system.some(part => part.cache_control?.type === 'ephemeral'));
        assert.ok(measurements.some(entry => entry.beforeRequest === requestIndex &&
            entry.size.inputBytes === request.inputBytes && entry.size.estimated <= entry.size.inputLimit));
        assert.deepEqual(JSON.parse(JSON.stringify(message.content)), history.getMessages(topicId).find(row => row.id === message.id)?.content);
        return { message, request };
    }

    await turn('Open both files', [useTool('toolu_open', APP + '-open_file', { names: ['A', 'B'] })]);
    const original = windows(ready);
    const a = original.views.find(view => view.viewId.startsWith('file_A_'))!;
    const b = original.views.find(view => view.viewId.startsWith('file_B_'))!;
    assert.ok(a && b);
    const search = await turn('Search for edits', foundTool('srvtoolu_pure', EDIT));
    const definition = search.request.body.tools.find(tool => tool.name === EDIT);
    assert.equal(definition?.defer_loading, true);
    assert.ok(search.request.body.tools.some(tool => tool.type === 'tool_search_tool_regex_20251119'));
    assert.deepEqual(await journal(folder, 'writes'), []);

    const failed = failedToolSearch('srvtoolu_edit', 'invalid_pattern', 'Unclosed group: 文件.');
    const edit = await turn('Close A, edit B, and close B', [
        ...failed,
        useTool('toolu_close_a', 'system-close_view', { app_id: APP, view_id: a.viewId }),
        useTool('toolu_b', EDIT, { view_id: b.viewId, mode: 'short' }),
        useTool('toolu_stale_a', EDIT, { view_id: a.viewId, mode: 'short' }),
        useTool('toolu_close_b', 'system-close_view', { app_id: APP, view_id: b.viewId }),
    ]);
    assert.equal(edit.message.role, 'tool');
    const results = edit.message.content;
    assert.deepEqual(results.map(part => part.toolCallId), ['toolu_close_a', 'toolu_b', 'toolu_stale_a', 'toolu_close_b']);
    assert.equal(results[1]?.output.type, 'json');
    assert.match(JSON.stringify(results[2]?.output), /VIEW_INSTANCE_REVOKED/);
    const observationId = observationIds.get(provider.requests.indexOf(edit.request));
    assert.ok(observationId);
    const receipt = await original.running.readReceipt({ observationId, invocationId: 'toolu_b' });
    assert.equal(receipt.kind, 'receipt');
    assert.equal(receipt.receipt.executionPhase, 'entered-returned');
    assert.equal(receipt.receipt.outcome.status, 'succeeded');
    assert.equal(receipt.receipt.source?.instanceId, original.appInstanceId);
    facts.originalReceipt = receipt;

    assert.ok(windows(ready).views.every(view => !view.viewId.startsWith('file_')));
    await topic.destroySession(topicId);
    // Reopen from the saved SQLite conversation with a new Driver and a new App instance.
    db.closeDatabase();
    await db.initDatabase();
    ready = await createTopicSession();
    assert.notEqual(windows(ready).appInstanceId, original.appInstanceId);
    const retired = await turn('Try the retired edit', [useTool('toolu_retired', EDIT, { view_id: b.viewId, mode: 'short' })]);
    assert.deepEqual(retired.request.body.tools.find(tool => tool.name === EDIT), definition);
    assert.match(JSON.stringify(retired.message.content), /E_TOOL_NOT_FOUND/);
    const replayed = wireBlocks(retired.request.body);
    assert.deepEqual(replayed.filter(block => block.type === 'server_tool_use').map(block => block.id), ['srvtoolu_pure', 'srvtoolu_edit']);
    assert.deepEqual(replayed.filter(block => block.type === 'tool_search_tool_result').map(block => block.content), [
        { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: EDIT }] },
        failed[1]!.content,
    ]);
    assert.equal(replayed.filter(block => block.type === 'tool_result' && block.tool_use_id === 'toolu_b').length, 1);
    assert.equal(replayed.filter(block => block.type === 'tool_result' && block.tool_use_id.startsWith('srvtoolu_')).length, 0);
    facts.retiredResult = retired.message;

    await turn('Open B again', [useTool('toolu_open_b', APP + '-open_file', { names: ['B'] })]);
    const before = windows(ready);
    const oldB = before.views.find(view => view.viewId.startsWith('file_B_'))!;
    assert.ok(oldB);
    const replaced = await turn('Attempt edit during same-name remount', [
        useTool('toolu_replaced', EDIT, { view_id: oldB.viewId, mode: 'short' }),
    ], async () => {
        const command = join(folder, 'fixture-update.json');
        await writeFile(command + '.next', JSON.stringify({ name: 'B', remount: true }));
        await rename(command + '.next', command);
        const replacement = await watchUntil(async () => {
            await before.running.preview();
            return windows(ready).views.find(view => view.viewId.startsWith('file_B_') && view.viewInstanceId !== oldB.viewInstanceId);
        });
        facts.replaced = { before: oldB, after: replacement };
    });
    assert.match(JSON.stringify(replaced.message.content), /VIEW_INSTANCE_REVOKED/);
    facts.replacedResult = replaced.message;
    const writes = await journal(folder, 'writes');
    assert.deepEqual(writes.map(write => write.name), ['B']);
    assert.equal(await readFile(join(folder, 'A.txt'), 'utf8'), 'A-BODY ' + 'a'.repeat(7200));
    assert.equal(await readFile(join(folder, 'B.txt'), 'utf8'), 'B-EDITED');
    facts.writes = writes;
    facts.history = history.getMessages(topicId);
    assert.equal(provider.requests.length, 6);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    await topic.cleanup();
    facts.close = await runtime.beginClose().completion;
    await provider.close();
    config.mock.restore();
    db.closeDatabase();
    await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(scratch, { recursive: true, force: true });
}
assert.match(JSON.stringify(facts.close), /"resourcesReleased":true/);
