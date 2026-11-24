import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { exerciseRefresh, installations, watchProjectionWorkers } from './batch-fifteen-refresh.mjs';
import { llmConfig } from './batch-ten-delivery.mjs';
import { fixtureProvider, watchUntil } from './batch-two-support.mjs';

const [installed, evidence] = process.argv.slice(2);
const state = await mkdtemp(join(tmpdir(), 'aotui-b15-public-'));
process.env.AOTUI_DATA_DIR = join(state, 'runtime');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const { createRuntime } = await import('@aotui/runtime');
const runtime = createRuntime(), desktop = await runtime.createDesktop('refresh-desktop');
const provider = await fixtureProvider();
const history = [], delivered = [], errors = [];
const budget = { contextWindow: 160_000, maxOutputTokens: 1_000 };
const source = new SemanticAOTUIDrivenSource(desktop);
const driver = new AgentDriverV2({ sources: [source, { name: 'History', onUpdate: () => () => {},
    async getContext() { return { messages: history.slice(), tools: {} }; } }],
    llm: { ...llmConfig(provider.url), inputBudget: () => budget },
    onAssistantMessage(message) { history.push({ ...message, timestamp: history.length + 1, region: 'session' }); },
    onToolResult(message) {
        history.push({ ...message, timestamp: history.length + 1, region: 'session' });
        delivered.push(message); driver.pause();
    },
    onRunError(error) { errors.push(String(error)); },
});
driver.pause();
const tracked = watchProjectionWorkers();
const facts = { wire: provider.requests, workers: tracked.events, results: {}, errors, passed: false };
try {
    for (const installationId of installations)
        assert.equal(await desktop.registerPendingApp({ installationId, localPath: installed, config: { folder: state } }), installationId);
    await exerciseRefresh(async (label, calls, options) => {
        const count = delivered.length;
        provider.replyNext({ label, calls, beforeReply: options?.beforeReply });
        history.push({ role: 'user', content: options?.user ?? label, timestamp: history.length + 1, region: 'session' });
        driver.resume(); await driver.trigger();
        const request = await watchUntil(() => provider.requests.find(item => item.label === label));
        const message = await watchUntil(() => delivered[count]);
        await watchUntil(() => driver.getState() === 'idle');
        return { body: request.body, message };
    }, runtime, desktop, state, tracked.events, budget, facts);
    assert.deepEqual(errors, []);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    await driver.closeToolTurn();
    driver.dispose();
    await source.dispose();
    const shutdown = await runtime.beginClose().completion;
    tracked.restore();
    await provider.close();
    await writeFile(resolve(evidence), JSON.stringify({ ...facts, shutdown }, null, 2));
    await rm(state, { recursive: true, force: true });
    assert.equal(shutdown.resourcesReleased, true);
}
