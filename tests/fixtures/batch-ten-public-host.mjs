import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { createRuntime } from '@aotui/runtime';
import { artifactDetails, exerciseDelivery, installation, llmConfig, recordWorkers, setupFiles } from './batch-ten-delivery.mjs';
import { fixtureProvider, watchUntil } from './batch-two-support.mjs';

const [archive, installed, evidence] = process.argv.slice(2);
const state = await mkdtemp(join(tmpdir(), 'aotui-b10-public-'));
process.env.AOTUI_DATA_DIR = join(state, 'state');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const runtime = createRuntime(), desktop = await runtime.createDesktop('delivery');
const provider = await fixtureProvider();
const history = [], delivered = [], errors = [];
const source = new SemanticAOTUIDrivenSource(desktop);
const driver = new AgentDriverV2({ sources: [source, { name: 'History', onUpdate: () => () => {},
    async getContext() { return { messages: history.slice(), tools: {} }; } }], llm: llmConfig(provider.url),
    onAssistantMessage(message) { history.push({ ...message, timestamp: history.length + 1, region: 'session' });
        if (typeof message.content === 'string') driver.pause(); },
    onToolResult(message) { history.push({ ...message, timestamp: history.length + 1, region: 'session' }); delivered.push(message); driver.pause(); },
    onRunError(error) { errors.push(String(error)); },
});
driver.pause();
const workers = recordWorkers();
const facts = { wire: provider.requests, errors, workers: workers.events, passed: false };
try {
    const folder = join(state, 'files');
    await setupFiles(folder);
    facts.artifact = await artifactDetails(archive, installed, import.meta.resolve('@aotui/runtime'));
    assert.equal(await desktop.registerPendingApp({ installationId: installation, localPath: installed, config: { folder } }), installation);
    facts.delivery = await exerciseDelivery(async (label, calls, beforeReply) => {
        const expectedResult = delivered.length;
        provider.replyNext({ label, calls, beforeReply });
        history.push({ role: 'user', content: label, timestamp: history.length + 1, region: 'session' });
        driver.resume(); await driver.trigger();
        const request = await watchUntil(() => provider.requests.find(item => item.label === label));
        const message = calls.length ? await watchUntil(() => delivered[expectedResult]) : undefined;
        await watchUntil(() => driver.getState() === 'idle');
        driver.pause();
        return { body: request.body, message };
    }, folder);
    assert.deepEqual(workers.events.map(event => [event.type, event.threadId]),
        [['init', facts.delivery.writes[0].threadId], ['exit', facts.delivery.writes[0].threadId]]);
    assert.deepEqual(errors, []);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    await driver.closeToolTurn();
    driver.dispose();
    await source.dispose();
    facts.shutdown = await runtime.beginClose().completion;
    workers.restore();
    await provider.close();
    await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(state, { recursive: true, force: true });
}
assert.equal(facts.shutdown.ok && facts.shutdown.resourcesReleased, true);
