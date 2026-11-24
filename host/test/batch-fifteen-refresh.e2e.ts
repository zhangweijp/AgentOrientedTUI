import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import type { LLMConfig } from '@aotui/agent-driver-v2';
import { createRuntime, type IDesktop } from '@aotui/runtime';
import type { GuiUpdateEvent } from '../src/types/session.js';
import { exerciseRefresh, installations, refreshEntries, watchProjectionWorkers } from '../../tests/fixtures/batch-fifteen-refresh.mjs';
import { llmConfig } from '../../tests/fixtures/batch-ten-delivery.mjs';
import { fixtureProvider, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';

const [installed, evidence] = process.argv.slice(2);
const state = await mkdtemp(join(tmpdir(), 'aotui-b15-topic-'));
process.env.DB_PATH = join(state, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(state, 'runtime');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const { AppCatalog } = await import('../src/app-distribution/app-catalog.js');
const { DesktopManager } = await import('../src/core/desktop-manager.js');
const { Config } = await import('../src/config/config.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const db = await import('../src/db/index.js');
const provider = await fixtureProvider(), runtime = createRuntime(), id = 'files-refresh-topic';
const budget = { contextWindow: 160_000, maxOutputTokens: 1_000 };
const registry = new AppCatalog({ configPath: join(state, 'fixture-apps.json') });
const manager = new DesktopManager({ kernel: runtime, appCatalog: registry });
const install = registry.installAll.bind(registry);
mock.method(registry, 'installAll', (desktop: IDesktop, options?: Parameters<typeof install>[1]) =>
    install(desktop, { ...options, dynamicConfig: { ...options?.dynamicConfig, folder: state } }));
mock.method(Config, 'get', async () => ({ agents: { list: [{ id, prompt: 'Inspect test files.', enabledApps: installations }] } }));
const host = new HostManagerV2(id, {} as ConstructorParameters<typeof HostManagerV2>[1]);
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async () => ({
    ...llmConfig(provider.url), inputBudget: () => budget,
}) as LLMConfig);
mock.method(host.getLLMConfigService(), 'withModelInputBudget', (config: LLMConfig) => config);
const delivered: GuiUpdateEvent[] = [];
const unsubscribe = host.onGuiUpdate(event => {
    if (event.topicId === id && event.message && event.type === 'tool') { delivered.push(event); host.pauseAgent(id); }
});
const tracked = watchProjectionWorkers();
const facts = { wire: provider.requests, workers: tracked.events, results: {}, passed: false };
try {
    await db.initDatabase();
    await manager.initialize({ appEntries: refreshEntries(installed) });
    await host.initAgentDriver(runtime, manager);
    const now = Date.now();
    db.createTopic({ id, agentId: id, title: id, status: 'hot', createdAt: now, updatedAt: now });
    await host.ensureSessionForTopic(id);
    const session = host.getSessionManager()!.getSession(id)!;
    host.pauseAgent(id);
    await exerciseRefresh(async (label, calls, options) => {
        const index = delivered.length;
        provider.replyNext({ label, calls, beforeReply: options?.beforeReply });
        await host.sendUserMessage(options?.user ?? label, id);
        host.resumeAgent(id);
        const request = await watchUntil(() => provider.requests.find(item => item.label === label));
        const event = await watchUntil(() => delivered[index]);
        await watchUntil(() => session.agentDriver.getState() === 'idle');
        return { body: request.body, message: event.message };
    }, runtime, session.desktop, state, tracked.events, budget, facts);
    await host.shutdownSession(id);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    unsubscribe();
    await host.dispose();
    const shutdown = await runtime.beginClose().completion;
    tracked.restore();
    await provider.close();
    db.closeDatabase();
    await writeFile(resolve(evidence), JSON.stringify({ ...facts, shutdown }, null, 2));
    await rm(state, { recursive: true, force: true });
    assert.equal(shutdown.resourcesReleased, true);
}
