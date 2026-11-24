import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { createRuntime, type IDesktop } from '@aotui/runtime';
import { AppCatalog } from '../src/app-distribution/app-catalog.js';
import type { LLMConfig } from '@aotui/agent-driver-v2';
import type { GuiUpdateEvent } from '../src/types/session.js';
import { appEntry, artifactDetails, exerciseDelivery, installation, llmConfig, recordWorkers, setupFiles } from '../../tests/fixtures/batch-ten-delivery.mjs';
import { fixtureProvider, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';

const [archive, installed, evidence] = process.argv.slice(2);
const state = await mkdtemp(join(tmpdir(), 'aotui-b10-product-'));
process.env.DB_PATH = join(state, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(state, 'runtime');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const { DesktopManager } = await import('../src/core/desktop-manager.js');
const { Config } = await import('../src/config/config.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const db = await import('../src/db/index.js');
const id = 'package-delivery', folder = join(state, 'files');
const provider = await fixtureProvider(), runtime = createRuntime();
const registry = new AppCatalog({ configPath: join(state, 'fixture-apps.json') });
const manager = new DesktopManager({ kernel: runtime, appCatalog: registry });
const install = registry.installAll.bind(registry);
mock.method(registry, 'installAll', (desktop: IDesktop, options?: Parameters<typeof install>[1]) =>
    install(desktop, { ...options, dynamicConfig: { ...options?.dynamicConfig, folder } }));
mock.method(Config, 'get', async () => ({ agents: { list: [{ id, prompt: 'Use the current file view.', enabledApps: [installation] }] } }));
const host = new HostManagerV2(id, {} as ConstructorParameters<typeof HostManagerV2>[1]);
mock.method(host.getLLMConfigService(), 'resolveLLMConfig', async () => llmConfig(provider.url) as LLMConfig);
mock.method(host.getLLMConfigService(), 'withModelInputBudget', (value: LLMConfig) => value);
const delivered: GuiUpdateEvent[] = [];
const unsubscribe = host.onGuiUpdate(event => {
    if (event.topicId === id && event.message && (event.type === 'tool' || event.type === 'assistant')) {
        delivered.push(event);
        if (event.type === 'tool' || typeof event.message.content === 'string') host.pauseAgent(id);
    }
});
const workers = recordWorkers();
const facts: Record<string, unknown> = { wire: provider.requests, workers: workers.events, passed: false };
try {
    await db.initDatabase();
    await setupFiles(folder);
    facts.artifact = await artifactDetails(archive, installed, import.meta.resolve('@aotui/runtime'));
    await manager.initialize({ appEntries: [appEntry(installed)] });
    await host.initAgentDriver(runtime, manager);
    const now = Date.now();
    db.createTopic({ id, agentId: id, title: id, status: 'hot', createdAt: now, updatedAt: now });
    await host.ensureSessionForTopic(id);
    host.pauseAgent(id);
    const delivery = await exerciseDelivery(async (label, calls, beforeReply) => {
        const index = delivered.length;
        provider.replyNext({ label, calls, beforeReply });
        await host.sendUserMessage(label, id);
        host.resumeAgent(id);
        const request = await watchUntil(() => provider.requests.find(item => item.label === label));
        const event = await watchUntil(() => delivered.slice(index).find(item => calls.length ? item.type === 'tool'
            : item.type === 'assistant' && typeof item.message?.content === 'string'));
        await watchUntil(() => host.getSessionManager()?.getSession(id)?.agentDriver.getState() === 'idle');
        return { body: request.body, message: event.message };
    }, folder);
    facts.delivery = delivery;
    assert.deepEqual(workers.events.map(event => [event.type, event.threadId]),
        [['init', delivery.writes[0].threadId], ['exit', delivery.writes[0].threadId]]);
    await host.shutdownSession(id);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    unsubscribe();
    await host.dispose();
    facts.shutdown = await runtime.beginClose().completion;
    workers.restore();
    await provider.close();
    db.closeDatabase();
    await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(state, { recursive: true, force: true });
}
assert.ok((facts.shutdown as { ok: boolean; resourcesReleased: boolean }).ok);
assert.ok((facts.shutdown as { ok: boolean; resourcesReleased: boolean }).resourcesReleased);
