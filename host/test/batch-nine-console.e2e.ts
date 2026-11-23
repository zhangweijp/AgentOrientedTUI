import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { createRuntime, type DesktopID } from '@aotui/runtime';
import type { AgentDriverV2, LLMConfig } from '@aotui/agent-driver-v2';
import type { DesktopManager } from '../src/core/desktop-manager.js';
import type { GuiUpdateEvent } from '../src/types/session.js';
import { fixtureProvider, journal, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';
import { attachConsolePolicy, CATALOG, installConsoleFixtures, savedResult, TASKS } from '../../tests/fixtures/batch-eight-support.mjs';
import { exerciseScope, scopedCall } from '../../tests/fixtures/batch-nine-support.mjs';

const [consumer, evidence] = process.argv.slice(2);
assert.ok(consumer, 'Pass the clean batch-nine consumer.');
const project = await mkdtemp(join(tmpdir(), 'aotui-b9-product-'));
process.env.DB_PATH = join(project, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(project, 'state');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const db = await import('../src/db/index.js');
const { Config } = await import('../src/config/config.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const override = mock.method(Config, 'get', async () => ({
    agents: { list: [{ id: 'scope', prompt: 'Use the tools from the request.', enabledApps: [] }] },
}));
const runtime = createRuntime({ worker: { timeoutMs: 25_000 } }), provider = await fixtureProvider();
const hooks = { authorized: [], receipts: [] };
attachConsolePolicy(runtime, hooks);
const folders = new Map<string, string>();
const assembled = {
    async createDesktop(id: DesktopID) {
        const folder = join(project, 'desktop-' + Date.now() + '-' + Math.random().toString(36).slice(2));
        folders.set(id, folder);
        const desktop = runtime.getDesktop(await runtime.createDesktop(id));
        await installConsoleFixtures(desktop, consumer, folder);
        return { desktop, thirdPartyAppCount: 2 };
    },
    async getAppsConfig() { return { [CATALOG]: {}, [TASKS]: {} }; },
} as DesktopManager;
const facts: Record<string, unknown> = { requests: provider.requests, hooks, passed: false };
const host = new HostManagerV2('scope-topic', {} as ConstructorParameters<typeof HostManagerV2>[1]);
const llm: LLMConfig = { provider: { id: 'b9-local', baseURL: provider.url }, model: 'b9', apiKey: 'fixture-only',
    inputBudget: () => ({ contextWindow: 200_000, maxOutputTokens: 1_000 }) };
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async () => llm);
mock.method(host.getLLMConfigService(), 'withModelInputBudget', (value: LLMConfig) => value);

function processes(): number[] {
    const lines = execFileSync('ps', ['-axo', 'ppid=,pid=,command='], { encoding: 'utf8' }).split('\n');
    return lines.flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+.*program-child\.mjs scoped$/.exec(line);
        return match && Number(match[1]) === process.pid ? [Number(match[2])] : [];
    });
}
const gone = (pid: number) => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
const delivered = new Map<string, NonNullable<GuiUpdateEvent['message']>>();
const unsubscribe = host.onGuiUpdate((event: GuiUpdateEvent) => {
    const content = event.message?.content;
    if (event.type !== 'tool' || !Array.isArray(content) || content[0]?.type !== 'tool-result') return;
    delivered.set(content[0].toolCallId, event.message!);
    if (event.topicId.startsWith('agent:')) (host['imSessionManager']?.getSession(event.topicId)?.agentDriver as AgentDriverV2).pause();
    else host.pauseAgent(event.topicId);
});

try {
    await db.initDatabase();
    await host.initAgentDriver(runtime, assembled);
    const id = 'scope-topic', key = 'agent:scope:local:direct:scope-im';
    const now = Date.now();
    db.createTopic({ id, agentId: 'scope', title: id, status: 'hot', createdAt: now, updatedAt: now });
    await host.ensureSessionForTopic(id);
    host.pauseAgent(id);
    const topic = () => host.getSessionManager()!.getSession(id)!;
    const im = () => host['imSessionManager']!.getSession(key)!;
    assert.deepEqual(processes(), []);
    async function topicTurn(label: string, call: ReturnType<typeof scopedCall>, beforeReply?: () => unknown) {
        provider.replyNext({ label, calls: [call], beforeReply });
        await host.sendUserMessage(label, id);
        host.resumeAgent(id);
        const message = await watchUntil(() => delivered.get(call.id), 15_000);
        await watchUntil(() => topic().agentDriver.getState() === 'idle');
        return { message, body: provider.requests.find(request => request.label === label).body };
    }
    async function imTurn(label: string, call: ReturnType<typeof scopedCall>) {
        provider.replyNext({ label, calls: [call] });
        await host.sendIMMessage({ sessionKey: key, agentId: 'scope', channel: 'local', chatType: 'direct', peerId: 'scope-im',
            senderId: 'fixture', chatId: 'scope-fixture', messageId: call.id, timestamp: Date.now(), body: label, triggerAgent: false });
        const driver = im().agentDriver as AgentDriverV2;
        driver.resume();await driver.trigger();
        const message = await watchUntil(() => delivered.get(call.id));
        await watchUntil(() => driver.getState() === 'idle');
        const rows = host.getIMMessages(key);
        assert.equal(rows.filter(row => row.role === 'tool' && JSON.stringify(row.content) === JSON.stringify(message.content)).length, 1);
        return { message, body: provider.requests.find(request => request.label === label).body };
    }
    const first = scopedCall('im-init', 'let x = "separate IM"; const read = () => x;');
    const imFirst = await imTurn('IM initializes without Apps', first);
    assert.deepEqual(imFirst.body.tools.map(entry => entry.function.name).sort(), ['context_compact', 'run_code']);
    const [imPid] = processes();
    assert.ok(imPid);
    const folder = folders.get(id)!;
    const scope = await exerciseScope({ turn: topicTurn, namespace: 'product', runtime, desktop: topic().desktop, folder,
        install: async () => {
            await host.setSourceEnabled(id, 'apps', true);
            for (const app of [CATALOG, TASKS]) await host.setSourceItemEnabled(id, 'apps', app, true);
        },
    });
    facts.topic = scope;
    const priorPid = processes().find(pid => pid !== imPid)!;
    assert.ok(priorPid);
    const imValue = scopedCall('im-value', 'inspect(x); inspect(read()); inspect(typeof marker);');
    assert.deepEqual(savedResult((await imTurn('IM never sees the Topic scope', imValue)).message, imValue.id).output, ['separate IM', 'separate IM', 'undefined']);

    await writeFile(join(folder, 'park'), '');
    try {
        const call = scopedCall('product-park-close', 'const discarded = true; inspect("before close"); ' +
            'const accepted = tools["console_tasks-accept"]({items:[],literal:"park"}); ' +
            'const queued = tools["console_tasks-accept"]({items:[],literal:"must not write"}); await Promise.all([accepted,queued]);');
        provider.replyNext({ label: 'close Topic during admitted business call', calls: [call] });
        await host.sendUserMessage('Start one test write.', id);
        host.resumeAgent(id);
        await watchUntil(async () => (await journal(folder, 'writes')).some(row => row.value.literal === 'park'));
        const close = host.shutdownSession(id);
        // The program exits while the original Worker is still draining the admitted operation.
        await watchUntil(() => !processes().includes(priorPid));
        gone(priorPid);
        await unlink(join(folder, 'park'));
        await close;
        assert.equal(topic(), undefined);
        assert.deepEqual((await journal(folder, 'writes')).map(row => row.value.literal), [...scope.writes.map(row => row.value.literal), 'park']);
        assert.equal(delivered.has(call.id), false);
        const rows = host.getMessages(id).filter(message => message.role === 'tool' &&
            message.content.some(part => part.type === 'tool-result' && part.toolCallId === call.id));
        assert.equal(rows.length, 1);
        const saved = savedResult(rows[0], call.id);
        assert.equal(saved.code, 'CONSOLE_CANCELLED');
        assert.equal(saved.result.scope, 'lost');
        assert.deepEqual(saved.result.output, ['before close']);
        assert.deepEqual(saved.result.subcalls.map(child => child.phase), ['unknown', 'not-dispatched']);
        facts.close = { priorPid, duplicateWrites: 0, savedClosingResult: saved };
    } finally { await unlink(join(folder, 'park')).catch(() => {}); }

    await host.ensureSessionForTopic(id);
    host.pauseAgent(id);
    const reopened = scopedCall('product-reopened', 'inspect(typeof savedEmail); inspect(typeof marker); inspect(typeof discarded);');
    const next = await topicTurn('same-name Topic restores messages in fresh scope', reopened);
    assert.deepEqual(savedResult(next.message, reopened.id).output, ['undefined', 'undefined', 'undefined']);
    assert.ok(next.body.messages.some(entry => entry.role === 'tool' && entry.tool_call_id === 'product-2'));
    assert.equal(next.body.messages.filter(entry => entry.role === 'tool' && entry.tool_call_id === 'product-park-close').length, 1);
    assert.equal((await journal(folder, 'writes')).length, scope.writes.length + 1);
    const nextPid = processes().find(pid => pid !== imPid)!;
    assert.ok(nextPid && nextPid !== priorPid);
    const imLater = scopedCall('im-later', 'inspect(read());');
    assert.deepEqual(savedResult((await imTurn('IM can proceed after Topic closes', imLater)).message, imLater.id).output, ['separate IM']);
    await host['imSessionManager']!.destroySession(key);
    gone(imPid);
    const imFresh = scopedCall('im-fresh', 'inspect(typeof x);');
    const imNext = await imTurn('same-key IM starts fresh after closing', imFresh);
    assert.deepEqual(savedResult(imNext.message, imFresh.id).output, ['undefined']);
    const imNextPid = processes().find(pid => pid !== nextPid)!;
    assert.ok(imNextPid && imNextPid !== imPid);
    facts.reopen = { nextPid, imPid, imNextPid, topicWrites: await journal(folder, 'writes') };
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    unsubscribe();
    const pids = processes();
    await host.dispose();
    facts.remaining = processes();
    for (const pid of pids) gone(pid);
    facts.shutdown = await runtime.beginShutdown().completion;
    await provider.close();override.mock.restore();db.closeDatabase();
    if (evidence) await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(project, { recursive: true, force: true });
}
assert.deepEqual(facts.remaining, []);
