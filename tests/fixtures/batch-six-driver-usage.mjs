import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureProvider, watchUntil } from './batch-two-support.mjs';
import { googleFrames, googleUsage, responsesFrames } from './batch-six-usage-support.mjs';

const [evidence, driverEntry] = process.argv.slice(2);
const entry = driverEntry ? pathToFileURL(resolve(driverEntry)).href : import.meta.resolve('@aotui/agent-driver-v2');
const { AgentDriverV2 } = await import(entry);
const fromDriver = createRequire(entry);
const versions = Object.fromEntries(['@ai-sdk/openai-compatible', '@ai-sdk/deepseek', '@ai-sdk/openai', '@ai-sdk/google', 'ai']
    .map(id => [id, fromDriver(id + '/package.json').version]));
const provider = await fixtureProvider();
const source = {
    name: 'conversation',
    async getContext() {
        return { messages: [{ role: 'user', content: 'Reply once.', timestamp: 1 }], tools: {} };
    },
    onUpdate() { return () => {}; },
};
const usage = {
    prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
    prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 7,
    prompt_tokens_details: { cached_tokens: 4, vendor: { input: [false, 0, 'cache'] } },
    completion_tokens_details: { reasoning_tokens: 3, vendor: { output: [1, null, 'reasoning'] } },
    vendor_details: { tier: 'fixture', sample: [0, null, false] },
};
const zero = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } };
const cases = [
    { label: 'reported', wire: { usage }, counts: [11, 7, 18], cache: 4, reasoning: 3 },
    { label: 'zero', wire: { usage: zero }, counts: [0, 0, 0], cache: 0, reasoning: 0 },
    { label: 'absent', wire: {} },
    { label: 'null', wire: { usage: null } },
];
const googleZero = { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 0 }] };
const results = [];
const local = new URL(provider.url);
const send = globalThis.fetch;
globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    // Keeping the official config selects Responses. Only the test transport goes to loopback.
    if (url.origin === 'https://api.openai.com') return send(new URL(url.pathname + url.search, local), init);
    assert.equal(url.origin, local.origin);
    return send(input, init);
};

async function runTurn({ id, baseURL = provider.url, model, deltas, label, text, reasoning, wire }) {
    const turn = { label, usageEvents: [], assistants: [], text: [], reasoning: [], errors: [] };
    results.push(turn);
    const driver = new AgentDriverV2({
        sources: [source],
        llm: { provider: { id, baseURL }, model, apiKey: 'test-only' },
        onLLMUsage: event => { turn.usageEvents.push(event); },
        onAssistantMessage: message => { turn.assistants.push(message); },
        onRunError: error => { turn.errors.push(String(error)); },
        ...(deltas ? { onTextDelta: delta => turn.text.push(delta), onReasoningDelta: delta => turn.reasoning.push(delta) } : {}),
    });
    try {
        const start = provider.requests.length;
        provider.replyNext({ label, text, reasoning, ...wire });
        await driver.trigger();
        await watchUntil(() => driver.getState() === 'idle' && (turn.assistants.length || turn.errors.length));
        assert.deepEqual(turn.errors, []);
        assert.equal(provider.requests.length, start + 1);
        assert.equal(turn.assistants.length, 1);
        assert.ok(JSON.stringify(turn.assistants[0]).includes(text));
        assert.deepEqual(turn.text, deltas ? [text] : []);
        assert.deepEqual(turn.reasoning, deltas && reasoning ? [reasoning] : []);
        return { request: provider.requests[start], usageEvents: turn.usageEvents };
    } finally {
        driver.dispose();
    }
}

function checkUsage(usageEvents, raw, counts) {
    assert.equal(usageEvents.length, raw === undefined ? 0 : 1);
    if (raw === undefined) return;
    const [reported] = usageEvents;
    assert.deepEqual(reported.raw, raw);
    assert.deepEqual([reported.inputTokens, reported.outputTokens, reported.totalTokens], counts);
    return reported;
}

try {
    for (const id of ['deepseek', 'custom-chat', 'openai']) {
        for (const deltas of [false, true]) {
            for (const test of cases) {
                const model = 'batch-six/' + id;
                const label = [id, deltas ? 'with-deltas' : 'without-deltas', test.label].join('/');
                const { request: { body, response }, usageEvents } = await runTurn({ id, model, deltas, label,
                    text: 'Fixture reply.', reasoning: 'Fixture reasoning.', wire: test.wire });
                assert.equal(body.model, model);
                assert.deepEqual(body.stream_options, id === 'deepseek' ? { include_usage: true } : undefined);
                const reported = checkUsage(usageEvents, response.at(-1).usage ?? undefined, test.counts);
                if (reported) {
                    assert.deepEqual(response.at(-1).choices, []);
                    assert.equal(reported.inputTokenDetails.cacheReadTokens, test.cache);
                    assert.equal(reported.outputTokenDetails.reasoningTokens, test.reasoning);
                }
            }
        }
    }
    const model = 'batch-six-native', text = 'Native fixture reply.';
    for (const deltas of [false, true]) {
        for (const id of ['openai', 'xai']) {
            for (const terminal of ['response.completed', 'response.incomplete']) {
                const baseURL = id === 'openai' ? 'https://api.openai.com/v1' : provider.url;
                const label = [id, terminal, deltas ? 'with-deltas' : 'without-deltas'].join('/');
                const { request, usageEvents } = await runTurn({ id, baseURL, model, deltas, label, text,
                    wire: { path: '/v1/responses', frames: responsesFrames(terminal, text) } });
                assert.equal(request.body.model, model);
                checkUsage(usageEvents, request.response.at(-1).response.usage, [11, 7, 18]);
            }
        }
        for (const [scenario, usage, counts] of [
            ['reported', googleUsage, [11, 7, 18]], ['zero', googleZero, [0, 0, 0]], ['absent', undefined, undefined],
        ]) {
            const label = ['google', scenario, deltas ? 'with-deltas' : 'without-deltas'].join('/');
            const { request, usageEvents } = await runTurn({ id: 'google', model, deltas, label, text,
                wire: { path: '/v1/models/' + model + ':streamGenerateContent?alt=sse', frames: googleFrames(usage, text) } });
            assert.equal(Object.hasOwn(request.response.at(-1), 'usageMetadata'), false);
            const reported = request.response.findLast(frame => frame.usageMetadata)?.usageMetadata;
            assert.deepEqual(reported, usage);
            checkUsage(usageEvents, reported, counts);
        }
    }
    assert.deepEqual(provider.failures, []);
    assert.equal(provider.requests.length, 38);
    console.log('PASS 38 real HTTP responses through the Driver', versions);
} finally {
    globalThis.fetch = send;
    await provider.close();
    if (evidence) await writeFile(evidence, JSON.stringify({ versions, results, requests: provider.requests, failures: provider.failures }, null, 2));
}
