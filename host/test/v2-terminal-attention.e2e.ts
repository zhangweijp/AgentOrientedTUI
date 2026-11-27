import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime, type IDesktop, type UpdateSignal } from '@aotui/runtime';
import type { LLMConfig } from '@aotui/agent-driver-v2';
import { AppCatalog } from '../src/app-distribution/app-catalog.js';
import { llmConfig } from '../../tests/fixtures/batch-ten-delivery.mjs';
import { fixtureProvider, modelCall, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';

const [installed, evidence, mode = 'headless'] = process.argv.slice(2);
const state = await realpath(await mkdtemp(join(tmpdir(), 'aotui-terminal-attention-')));
process.env.DB_PATH = join(state, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(state, 'runtime');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const { DesktopManager } = await import('../src/core/desktop-manager.js');
const { Config } = await import('../src/config/config.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const db = await import('../src/db/index.js');
const id = 'terminal-attention', installation = 'terminal_install';
const provider = await fixtureProvider(), runtime = createRuntime();
const catalog = new AppCatalog({ configPath: join(state, 'apps.json') });
const manager = new DesktopManager({ kernel: runtime, appCatalog: catalog });
const install = catalog.installAll.bind(catalog);
mock.method(catalog, 'installAll', (desktop: IDesktop, options?: Parameters<typeof install>[1]) =>
    install(desktop, { ...options, dynamicConfig: { ...options?.dynamicConfig, projectPath: state } }));
mock.method(Config, 'get', async () => ({ agents: { list: [{ id, prompt: 'Use the terminal.', enabledApps: [installation] }] } }));
const host = new HostManagerV2(id, {} as ConstructorParameters<typeof HostManagerV2>[1]);
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async () => ({ ...llmConfig(provider.url),
    model: 'deepseek-chat', provider: { id: 'deepseek', baseURL: provider.url } }) as LLMConfig);
mock.method(host.getLLMConfigService(), 'withModelInputBudget', (value: LLMConfig) => value);
const signals: UpdateSignal[] = [];
const previews: string[] = [];
const facts: Record<string, unknown> = { mode, requests: provider.requests, signals, previews, passed: false };
async function previewTerminal() {
    const desktop = await host.getDesktopPreview(id);
    assert.deepEqual(desktop.diagnostics, []);
    const page = desktop.applications.find(app => app.installationId === installation)?.views.map(view => view.content).join('\n') ?? '';
    previews.push(page);
    return page;
}
const begin = join(state, 'begin'), logged = join(state, 'logged'), exit = join(state, 'exit'), command = join(state, 'logs.mjs');
const userTask = 'Start the synthetic task.';
const waiting = 'The terminal has started. I will wait for an App reminder.';
const lastLineMarker = 'AOTUI_TERMINAL_OUTPUT_TAIL_91F4';
const isAttention = ({ content }: { content?: unknown }) => typeof content === 'string' && content.includes('<aotui_attention ');
await writeFile(command, `
import {existsSync, writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
while (!existsSync(${JSON.stringify(begin)})) await delay(10);
for (let tick = 0; tick < 200; tick++) {
    process.stdout.write(Array.from({length:5}, (_, i) => {
        const line = tick * 5 + i + 1;
        return 'Task log ' + line + (line === 1000 ? ' ' + ${JSON.stringify(lastLineMarker)} : '');
    }).join('\\n') + '\\n');
    await delay(5);
}
writeFileSync(${JSON.stringify(logged)}, '1000');
while (!existsSync(${JSON.stringify(exit)})) await delay(10);
process.exitCode = 1;
`);

try {
    await db.initDatabase();
    await manager.initialize({ appEntries: [{ name: installation, source: `local:${resolve(installed)}`, enabled: true, autoStart: true }] });
    await host.initAgentDriver(manager);
    const now = Date.now();
    db.createTopic({ id, agentId: id, title: id, status: 'hot', createdAt: now, updatedAt: now });
    await host.ensureSessionForTopic(id);
    const desktop = runtime.getDesktop(id as IDesktop['id']);
    desktop.output.subscribe(signal => signals.push(signal));
    const terminal = desktop.listApps().find(app => app.installationId === installation)!;
    assert.equal(terminal.status, 'running');
    provider.replyNext({ label: 'start', calls: [modelCall('start-task', 'terminal-TerminalConsole-new_terminal_and_send_command',
        { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(command)}` })],
        beforeReply: () => provider.replyNext({ label: 'waiting-for-attention', text: waiting }) });
    await host.sendUserMessage(userTask, id);
    const followUp = await watchUntil(() => provider.requests.find(request => request.label === 'waiting-for-attention'));
    const session = host.getSessionManager()!.getSession(id)!;
    await watchUntil(() => session.agentDriver.getState() === 'idle');
    const beforeLogs = provider.requests.length;
    assert.equal(beforeLogs, 2, 'The original tool receipt has one normal follow-up.');
    assert.equal(followUp.body.messages.some(isAttention), false);
    if (mode === 'preview') await previewTerminal();
    await writeFile(begin, 'go');
    if (mode === 'preview') {
        await watchUntil(async () => {
            await delay(150);
            return /Task log 1000\b/.test(await previewTerminal());
        }, 8_000);
        assert.ok(previews.some(page => /Task log \d+/.test(page) && !/Task log 1000\b/.test(page)));
    }
    await watchUntil(() => existsSync(logged), 8_000);
    await delay(450);
    assert.ok(signals.some(signal => signal.reason === 'view_updated'));
    assert.equal(signals.filter(signal => signal.reason === 'attention_requested').length, 0);
    assert.equal(provider.requests.length, beforeLogs, 'Log updates alone never send a model request.');
    provider.replyNext({ label: 'failed-task', text: 'The task failed.' });
    await writeFile(exit, 'exit');
    const final = await watchUntil(() => provider.requests.find(request => request.label === 'failed-task'));
    const messages = final.body.messages as { role: string; content?: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    const original = messages.findIndex(message => message.role === 'user' && message.content === userTask);
    const start = messages.findIndex(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'start-task'));
    const receipt = messages.findIndex(message => message.role === 'tool' && message.tool_call_id === 'start-task');
    const previousReply = messages.findIndex(message => message.role === 'assistant' && message.content === waiting);
    const notice = messages.findIndex(isAttention);
    const terminalPage = messages.findIndex(({ content }) => content?.startsWith('<view ') && content.includes(lastLineMarker));
    const page = messages[terminalPage]?.content;
    facts.order = { original, start, receipt, previousReply, terminalPage, notice };
    facts.final = page;
    assert.ok(original >= 0 && original < start && start < receipt && receipt < previousReply);
    assert.ok(page?.includes('Task log 1000 ' + lastLineMarker));
    assert.match(page, /Exit Code:[*\s]*1\b/);
    assert.deepEqual(messages.filter(message => message.content?.includes(lastLineMarker)), [messages[terminalPage]]);
    assert.equal(messages.filter(isAttention).length, 1, 'The attention request carries one explicit Host notice.');
    assert.ok(previousReply < notice && terminalPage < notice);
    assert.equal(notice, messages.length - 1);
    assert.match(messages[notice]?.content ?? '', /^<aotui_attention app_id="terminal" source="host">[\s\S]+Read its latest View messages\./);
    if (mode === 'preview') assert.match(await previewTerminal(), /Exit Code:[*\s]*1\b/);
    await watchUntil(() => session.agentDriver.getState() === 'idle');
    await delay(450);
    assert.equal(provider.requests.length, beforeLogs + 1);
    assert.deepEqual(signals.filter(signal => signal.reason === 'attention_requested').map(({ appId, instanceId }) => [appId, instanceId]),
        [[terminal.appId, terminal.appInstanceId]]);
    const history = await session.sources.host.getContext();
    assert.equal(history.messages.some(isAttention), false);
    const next = await session.sources.aotui.getContext();
    try { assert.equal(next.messages.some(isAttention), false); }
    finally { await next.release?.(); }
    assert.deepEqual(provider.failures, []);
    facts.logRequests = 0;
    facts.attentionRequests = 1;
    facts.passed = true;
    await host.shutdownSession(id);
} finally {
    await writeFile(begin, 'go');
    await writeFile(exit, 'exit');
    await host.dispose();
    facts.closed = await runtime.beginClose().completion;
    await provider.close();
    db.closeDatabase();
    await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(state, { recursive: true, force: true });
}
