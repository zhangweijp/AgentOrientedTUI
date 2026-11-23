import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { createRuntime } from '@aotui/runtime';
import Database from 'better-sqlite3';
import { exerciseStorage, installation, trackStorage } from './batch-eleven-storage.mjs';
import { llmConfig } from './batch-ten-delivery.mjs';
import { fixtureProvider, watchUntil } from './batch-two-support.mjs';

const [installed, evidence] = process.argv.slice(2);
const state = await mkdtemp(join(tmpdir(), 'aotui-b11-public-'));
const id = 'storage-topic';
const runtime = createRuntime(), desktop = runtime.getDesktop(await runtime.createDesktop(id));
const provider = await fixtureProvider();
const history = [], delivered = [], errors = [];
const source = new SemanticAOTUIDrivenSource(desktop, runtime);
const driver = new AgentDriverV2({ sources: [source, { name: 'History', onUpdate: () => () => {},
    async getContext() { return { messages: history.slice(), tools: {} }; } }], llm: llmConfig(provider.url),
    onAssistantMessage(message) { history.push({ ...message, timestamp: history.length + 1, region: 'session' }); },
    onToolResult(message) {
        history.push({ ...message, timestamp: history.length + 1, region: 'session' });
        delivered.push(message); driver.pause();
    },
    onRunError(error) { errors.push(String(error)); },
});
driver.pause();
const workers = trackStorage();
const facts = { wire: provider.requests, workers: workers.owners, errors, passed: false };
try {
    assert.equal(await desktop.registerPendingApp({ installationId: installation, localPath: installed, config: { AOTUI_DATA_DIR: state } }), installation);
    facts.delivery = await exerciseStorage(async (label, calls) => {
        const count = delivered.length;
        provider.replyNext({ label, calls });
        history.push({ role: 'user', content: label, timestamp: history.length + 1, region: 'session' });
        driver.resume(); await driver.trigger();
        const request = await watchUntil(() => provider.requests.find(item => item.label === label));
        const message = await watchUntil(() => delivered[count]);
        await watchUntil(() => driver.getState() === 'idle');
        driver.pause();
        return { body: request.body, message };
    }, Database, state, id, workers.owners);
    assert.deepEqual(errors, []);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    await driver.closeToolTurn();
    driver.dispose();
    await source.dispose();
    facts.shutdown = await runtime.beginShutdown().completion;
    workers.restore();
    await provider.close();
    await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(state, { recursive: true, force: true });
}
assert.equal(facts.shutdown.ok && facts.shutdown.resourcesReleased, true);
