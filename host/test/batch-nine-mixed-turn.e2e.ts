import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ToolResultPart } from 'ai';
import { createRuntime, type DesktopID } from '@aotui/runtime';
import type { AgentDriverV2, LLMConfig } from '@aotui/agent-driver-v2';
import type { DesktopManager } from '../src/core/desktop-manager.js';
import { fixtureProvider, journal, modelCall, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';
import { codeCall, installConsoleFixtures, TASKS } from '../../tests/fixtures/batch-eight-support.mjs';

const [consumer, evidence, order = 'console-first', channel = 'topic', timing = 'pending'] = process.argv.slice(2);
assert.ok(consumer, 'Pass the clean batch-nine consumer.');
assert.ok(['console-first', 'mcp-first'].includes(order));
assert.ok(['topic', 'im'].includes(channel));
assert.ok(['pending', 'settled'].includes(timing));
const state = await mkdtemp(join(tmpdir(), 'aotui-mixed-turn-'));
process.env.DB_PATH = join(state, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(state, 'runtime');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const { Config } = await import('../src/config/config.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const { MCP } = await import('../src/mcp/index.js');
const db = await import('../src/db/index.js');
const server = fileURLToPath(new URL('./fixtures/mcp-waiting-read.mjs', import.meta.url));
const mcp = { local: { type: 'local' as const, command: [process.execPath, server, state], enabled: true } };
const agent = { id: 'mixed', name: 'Mixed tool fixture', prompt: 'Use the available tools.', enabledApps: [TASKS], enabledMCPs: ['local'] };
mock.method(Config, 'get', async () => ({ agents: { list: [agent] }, mcp }));
mock.method(Config, 'getMcp', async () => ({ mcp }));
const runtime = createRuntime(), provider = await fixtureProvider();
const host = new HostManagerV2('mixed-topic', {} as ConstructorParameters<typeof HostManagerV2>[1]);
const folders: string[] = [];
const factory = {
    async createDesktop(id: DesktopID) {
        const folder = join(state, `desktop-${folders.length}`);
        folders.push(folder);
        const desktop = await runtime.createDesktop(id);
        await installConsoleFixtures(desktop, resolve(consumer), folder);
        await desktop.openApp(TASKS);
        return desktop;
    },
    async getAppsConfig() { return { [TASKS]: {} }; },
} as DesktopManager;
const llm: LLMConfig = { provider: { id: 'loopback', baseURL: provider.url }, model: 'mixed-fixture', apiKey: 'fixture-only',
    inputBudget: () => ({ contextWindow: 150_000, maxOutputTokens: 1_000 }) };
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async () => llm);
mock.method(host.getLLMConfigService(), 'withModelInputBudget', (value: LLMConfig) => value);

const im = channel === 'im';
const id = im ? 'agent:mixed:local:direct:fixture' : 'mixed-topic';
const manager = () => host['imSessionManager']!;
const driver = () => (im ? manager().getSession(id)?.agentDriver : host.getSessionManager()?.getSession(id)?.agentDriver) as AgentDriverV2;
const open = () => im ? manager().ensureSession(id, agent.id) : host.ensureSessionForTopic(id);
const shutdown = () => im ? manager().destroySession(id) : host.shutdownSession(id);
const messages = () => im ? host.getIMMessages(id) : host.getMessages(id);
const results = () => messages().flatMap(message => message.role === 'tool' && Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'tool-result') : []);
const errorCode = (output?: ToolResultPart['output']) => {
    const value = output?.type === 'error-json' ? output.value : undefined;
    return value && typeof value === 'object' && 'code' in value ? value.code : undefined;
};
const entered = join(state, 'entered'), release = join(state, 'release'), returned = join(state, 'returned');
const facts: Record<string, unknown> = { order, channel, timing, requests: provider.requests, passed: false };

async function ask(label: string) {
    if (im) {
        await host.sendIMMessage({ sessionKey: id, agentId: agent.id, channel: 'local', chatType: 'direct', peerId: 'fixture',
            senderId: 'fixture', chatId: 'mixed-fixture', messageId: label, body: label, timestamp: Date.now(), triggerAgent: false });
        driver().resume();
        await driver().trigger();
    } else {
        await host.sendUserMessage(label, id);
        host.resumeAgent(id);
    }
}

try {
    await db.initDatabase();
    await host.initAgentDriver(factory);
    const now = Date.now();
    if (!im) db.createTopic({ id, agentId: agent.id, title: id, status: 'hot', createdAt: now, updatedAt: now });
    await open();
    const original = driver();
    original.pause();
    const consoleCall = codeCall('c-write', 'const item = await tools["console_tasks-accept"]({items:[],literal:"mixed write"}); inspect(item.saved);');
    const mcpCall = modelCall('m-read', 'mcp-local-read', {});
    const calls = order === 'console-first' ? [consoleCall, mcpCall] : [mcpCall, consoleCall];
    const ids = calls.map(call => call.id);
    const wrote = order === 'console-first' || timing === 'settled';
    provider.replyNext({ label: 'mixed', calls });
    await ask('Save a note and read the local status.');
    await watchUntil(() => existsSync(entered), 10_000);

    assert.deepEqual(results(), []);
    original.pause();
    if (timing === 'settled') {
        await writeFile(release, '');
        await watchUntil(() => results().length === ids.length);
    }
    let closed = false;
    const closing = shutdown().then(() => { closed = true; });
    void closing.catch(() => {});
    await watchUntil(() => closed, 4_000);
    await closing;
    assert.equal(driver(), undefined);
    assert.equal(existsSync(returned), timing === 'settled');
    await watchUntil(() => original.getState() === 'idle');
    const assistant = messages().flatMap(message => message.role === 'assistant' && Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'tool-call') : []);
    const saved = results();
    facts.savedAssistant = assistant;
    facts.savedResults = saved;
    assert.deepEqual(assistant.map(part => part.toolCallId), ids);
    assert.deepEqual(saved.map(part => part.toolCallId), ids);
    assert.deepEqual((await journal(folders[0], 'writes')).map(row => row.value.literal), wrote ? ['mixed write'] : []);
    const consoleResult = saved.find(part => part.toolCallId === consoleCall.id)?.output;
    const mcpResult = saved.find(part => part.toolCallId === mcpCall.id)?.output;
    if (wrote) assert.deepEqual(consoleResult, { type: 'json', value: { output: ['true'], scope: 'retained', subcalls: [
        { invocationId: 'console:' + createHash('sha256').update(consoleCall.id).digest('hex') + ':1',
            toolName: 'console_tasks-accept', status: 'succeeded', phase: 'entered-returned' },
    ] } });
    else assert.equal(errorCode(consoleResult), 'E_TOOL_NOT_DISPATCHED');
    if (timing === 'pending') assert.equal(errorCode(mcpResult), 'E_TOOL_OUTCOME_UNKNOWN');
    else assert.deepEqual(mcpResult, { type: 'json', value: '{"content":[{"type":"text","text":"local status"}]}' });

    await open();
    const successor = driver();
    assert.notEqual(successor, original);
    successor.pause();
    provider.replyNext({ label: 'resumed', text: 'Reopened successfully.' });
    await ask('Continue without repeating the write.');
    const resumed = await watchUntil(() => provider.requests.find(request => request.label === 'resumed'));
    assert.deepEqual(resumed.body.messages.filter(part => part.role === 'tool').map(part => part.tool_call_id), ids);
    await watchUntil(() => messages().some(message => message.role === 'assistant' && message.content === 'Reopened successfully.'));
    if (timing === 'pending') {
        assert.equal(existsSync(returned), false);
        await writeFile(release, '');
        await watchUntil(() => existsSync(returned));
        await delay(100);
    }
    assert.equal(driver(), successor);
    assert.deepEqual(results(), saved);
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(provider.failures, []);
    const writes = await journal(folders[0], 'writes');
    assert.equal(writes.length, Number(wrote));
    assert.deepEqual(await journal(folders[1], 'writes'), []);
    facts.writes = writes;
    facts.passed = true;
} finally {
    await writeFile(release, '');
    await host.dispose();
    await MCP.disconnect('local');
    facts.shutdown = await runtime.beginClose().completion;
    await provider.close();
    db.closeDatabase();
    if (evidence) await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(state, { recursive: true, force: true });
}
assert.ok((facts.shutdown as { resourcesReleased: boolean }).resourcesReleased);
