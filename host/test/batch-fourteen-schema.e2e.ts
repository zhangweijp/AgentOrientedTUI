import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { createRuntime, readAppManifest } from '@aotui/runtime';
import type { ModelRegistry } from '../src/services/model-registry.js';
import type { GuiUpdateEvent } from '../src/types/session.js';
import { appClient, fixtureProvider, watchUntil } from '../../tests/fixtures/batch-two-support.mjs';
import { captureAdmission, exerciseCinema, exerciseStrict, healthyLog, original, publishSeat } from '../../tests/fixtures/batch-fourteen-schema.mjs';
import { exerciseEmptyConsole, exercisePolicyWindows, exerciseStationBudget, setPolicyScenario } from '../../tests/fixtures/batch-fourteen-provider-repair.mjs';

const [cinema, healthy, theatre, evidence] = process.argv.slice(2) as [string, string, string, string];
const state = await mkdtemp(join(os.tmpdir(), 'aotui-b14-product-'));
const home = join(state, 'home');
await mkdir(join(home, '.agentina'), { recursive: true });
mock.method(os, 'homedir', () => home);
process.env.DB_PATH = join(state, 'chat.sqlite');
process.env.AOTUI_DATA_DIR = join(state, 'runtime');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const { Config } = await import('../src/config/config.js');
const { DesktopManager } = await import('../src/core/desktop-manager.js');
const { HostManagerV2 } = await import('../src/core/host-manager-v2.js');
const db = await import('../src/db/index.js');
const runtime = createRuntime();
const provider = await fixtureProvider();
const desktops = new DesktopManager({ kernel: runtime });
const host = new HostManagerV2('cinema-cli', { getModels: async () => [] } as unknown as ModelRegistry);
let enabledApps: string[] = [];
mock.method(Config, 'get', async () => ({ agents: { list: [{ id: 'cinema_agent', prompt: 'Choose a seat.',
    enabledApps }], activeAgentId: 'cinema_agent' } }));
const captured = captureAdmission(runtime);
const cinemaManifest = await readAppManifest(cinema);
const healthyManifest = await readAppManifest(healthy);
const theatreManifest = await readAppManifest(theatre);
const facts: Record<string, unknown> = { wire: provider.requests, adoptions: captured.events, workers: captured.workers,
    receipts: captured.receipts, passed: false };
const model = 'cinema-fixture';
const configPath = join(home, '.agentina/config.json');

async function runTopic(id: string, strict: boolean, options: { blocked?: boolean; scenario?: string } = {}) {
    const { blocked, scenario = 'cinema' } = options;
    if (scenario === 'cinema') await publishSeat(cinemaManifest, original);
    else if (scenario !== 'empty') await setPolicyScenario(theatreManifest, scenario);
    const key = `openai:${model}@${provider.url}`;
    const apps = scenario === 'empty' ? {} : {
        [scenario === 'cinema' ? 'cinema_install' : 'theatre_install']: { enabled: true, source: 'local:' + (scenario === 'cinema' ? cinema : theatre) },
        healthy_install: { enabled: true, source: 'local:' + healthy },
    };
    enabledApps = Object.keys(apps);
    await writeFile(configPath, JSON.stringify({ apps, modelInputLimits: { [key]: { contextWindow: 120_000, maxOutputTokens: 1_000,
        ...(blocked ? { capabilities: { toolCall: false } } : {}) } },
        ...(strict ? { toolSchemaModes: { [key]: 'strict' } } : {}) }));
    assert.equal((await host.getLLMConfigService().resolveLLMConfig()).provider.toolSchemaMode, strict ? 'strict' : undefined);
    await host.ensureSessionForTopic(id);
    host.pauseAgent(id);
    const session = host.getSessionManager()!.getSession(id)!;
    captured.attach(session.desktop);
    const delivered: GuiUpdateEvent[] = [], failures: unknown[] = [];
    const unsubscribe = host.onGuiUpdate(event => {
        if (event.topicId !== id || !event.message) return;
        if (event.type === 'tool') { delivered.push(event); host.pauseAgent(id); }
        if (event.type === 'assistant' && typeof event.message.content === 'string') {
            if (event.message.metadata?.isAgentError) failures.push(event.message.metadata);
            host.pauseAgent(id);
        }
    });
    const turn = async (label: string, calls: unknown[], beforeReply?: (body: unknown) => unknown) => {
        const count = delivered.length;
        const first = provider.requests.length;
        provider.replyNext({ label, calls, beforeReply });
        await host.sendUserMessage(label, id);
        host.resumeAgent(id);
        const request = await watchUntil(() => provider.requests.slice(first).find(item => item.label === label));
        const result = calls.length ? await watchUntil(() => delivered[count]) : undefined;
        await watchUntil(() => session.agentDriver.getState() === 'idle');
        return { body: request.body, message: result?.message };
    };
    try {
        if (blocked) {
            const before = [provider.requests.length, captured.events.length, captured.workers.length, (await healthyLog(healthyManifest)).length];
            await host.sendUserMessage('Cannot supply mandatory management Tools', id);
            host.resumeAgent(id);
            const error = await watchUntil(() => failures[0]) as { errorCode: string };
            assert.equal(error.errorCode, 'MODEL_TOOL_SCHEMA_UNSUPPORTED');
            assert.deepEqual([provider.requests.length, captured.events.length, captured.workers.length, (await healthyLog(healthyManifest)).length], before);
            return { error, requests: 0, adoptions: 0, dispatches: 0 };
        }
        if (scenario === 'empty') return await exerciseEmptyConsole(turn);
        if (scenario === 'window' || scenario === 'twins')
            return await exercisePolicyWindows(turn, session.desktop, captured, theatreManifest, scenario === 'twins');
        if (scenario !== 'cinema') return await exerciseStationBudget(turn, scenario, theatreManifest, healthyManifest, captured, strict);
        if (strict) return await exerciseStrict(turn, 'strict-openai', healthyManifest, captured);
        return await exerciseCinema(turn, cinemaManifest, appClient(runtime, session.desktop, 'cinema').client, captured);
    } finally {
        unsubscribe();
        await host.shutdownSession(id);
    }
}

try {
    await db.initDatabase();
    const llm = host.getLLMConfigService();
    const config = await llm.createConfig({ name: model, providerId: 'openai', model, baseUrl: provider.url,
        apiKey: 'fixture-only', skipValidation: true });
    llm.setActiveConfig(config.id);
    await desktops.initialize();
    await host.initAgentDriver(runtime, desktops);
    facts.native = await runTopic('cinema_topic', false);
    facts.openai = await runTopic('cinema_strict', true);
    facts.blocked = await runTopic('cinema_blocked', false, { blocked: true });
    const repair: Record<string, unknown> = {};
    facts.repair = repair;
    for (const scenario of ['window', 'twins', 'at', 'over', 'split-over', 'empty']) {
        repair[scenario] = await runTopic('provider_' + scenario, true, { scenario });
    }
    repair.ordinary = await runTopic('provider_ordinary', false, { scenario: 'over' });
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    await host.dispose();
    facts.shutdown = await runtime.beginShutdown().completion;
    captured.restore();
    await provider.close();
    db.closeDatabase();
    mock.restoreAll();
    await writeFile(evidence, JSON.stringify(facts, null, 2));
    await rm(state, { recursive: true, force: true });
}
