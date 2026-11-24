import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { createRuntime } from '@aotui/runtime';
import { exerciseTodo, installation, trackTodo } from './batch-twelve-prepare.mjs';
import { llmConfig } from './batch-ten-delivery.mjs';
import { fixtureProvider, watchUntil } from './batch-two-support.mjs';

const [installed, evidence] = process.argv.slice(2);
const state = await mkdtemp(join(tmpdir(), 'aotui-b12-public-'));
const runtime = createRuntime(), desktop = await runtime.createDesktop('todo-desktop');
const provider = await fixtureProvider();
const history = [], delivered = [], errors = [];
const source = new SemanticAOTUIDrivenSource(desktop);
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
const tracked = trackTodo(desktop);
const facts = { wire: provider.requests, workers: tracked.events, signals: tracked.signals, errors, passed: false };
try {
    assert.equal(await desktop.registerPendingApp({ installationId: installation, localPath: installed, config: { folder: state } }), installation);
    facts.scenario = await exerciseTodo(async (label, calls) => {
        const count = delivered.length;
        provider.replyNext({ label, calls });
        history.push({ role: 'user', content: label, timestamp: history.length + 1, region: 'session' });
        driver.resume(); await driver.trigger();
        const request = await watchUntil(() => provider.requests.find(item => item.label === label));
        const message = await watchUntil(() => delivered[count]);
        await watchUntil(() => driver.getState() === 'idle');
        driver.pause();
        return { body: request.body, message };
    }, runtime, desktop, state, tracked);
    assert.deepEqual(errors, []);
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    await driver.closeToolTurn();
    driver.dispose();
    await source.dispose();
    facts.shutdown = await runtime.beginClose().completion;
    tracked.restore();
    await provider.close();
    await writeFile(resolve(evidence), JSON.stringify(facts, null, 2));
    await rm(state, { recursive: true, force: true });
}
assert.equal(facts.shutdown.ok && facts.shutdown.resourcesReleased, true);
