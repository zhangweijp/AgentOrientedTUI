import assert from 'node:assert/strict';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { fixtureProvider, watchUntil } from './batch-two-support.mjs';

export const providerIds = ['openai', 'anthropic', 'deepseek'];
export const budget = { contextWindow: 160_000, maxOutputTokens: 1_000 };
export const pathFor = id => id === 'anthropic' ? '/v1/messages'
    : id === 'deepseek' ? '/v1/beta/chat/completions' : '/v1/chat/completions';

export function providerConfig(id, url, strict = true) {
    return { model: id === 'anthropic' ? 'claude-sonnet-4-5' : id === 'deepseek' ? 'deepseek-chat' : 'gpt-4.1',
        provider: { id, baseURL: url + (id === 'deepseek' ? '/beta' : ''), toolSchemaMode: strict ? 'strict' : 'non-strict' },
        apiKey: 'fixture-only', inputBudget: () => budget };
}

function claudeFrames(model, sequence, calls) {
    const text = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    const blocks = calls.length ? calls.flatMap(({ id, function: fn }, index) => [
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: fn.name, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fn.arguments } },
        { type: 'content_block_stop', index },
    ]) : [text, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
        { type: 'content_block_stop', index: 0 }];
    return [{ type: 'message_start', message: { id: 'msg_' + sequence, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    ...blocks, { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 } }, { type: 'message_stop' }];
}

export const sourceContext = (name, getContext) => ({ name, getContext, onUpdate: () => () => {} });
export const wireTools = body => body.tools.map(entry => entry.function ?
    { name: entry.function.name, description: entry.function.description, schema: entry.function.parameters, strict: entry.function.strict } :
    { name: entry.name, description: entry.description, schema: entry.input_schema, strict: entry.strict });
export const userText = body => body.messages.filter(message => message.role === 'user').flatMap(({ content }) =>
    typeof content === 'string' ? [content] : content.flatMap(part => part.type === 'text' ? [part.text] : []));

export async function localModel(id, sources, { strict = true, saveHistory = true } = {}) {
    const provider = await fixtureProvider({ captureRaw: true });
    const config = providerConfig(id, provider.url, strict);
    const history = [], results = new Map(), errors = [];
    const createDriver = () => new AgentDriverV2({ llm: config, sources: [...sources,
        sourceContext('history', async () => ({ tools: {}, messages: history.slice() }))],
    onAssistantMessage(message) { if (saveHistory) history.push({ ...message, timestamp: Date.now() }); },
    onToolResult(message, delivered) {
        if (saveHistory) history.push({ ...message, timestamp: Date.now() });
        for (const result of delivered) results.set(result.toolCallId, result);
    },
    onRunError(error) { errors.push({ message: String(error), code: error.code, cause: error.cause }); },
    });
    let driver = createDriver();
    return {
        requests: provider.requests, history, results, errors,
        async step(label, calls = [], beforeReply, frames) {
            if (saveHistory) history.push({ role: 'user', content: label, timestamp: Date.now() });
            const previous = provider.requests.length;
            if (!saveHistory && previous) {
                driver.dispose();
                driver = createDriver();
            }
            provider.replyNext({ label, path: pathFor(id), calls, beforeReply,
                ...(id === 'anthropic' ? { frames: frames ?? claudeFrames(config.model, previous, calls) } : {}) });
            await driver.trigger();
            await watchUntil(() => driver.getState() === 'idle');
            assert.deepEqual(errors, []);
            assert.deepEqual(provider.failures, []);
            assert.equal(provider.requests.length, previous + 1, label);
            const request = provider.requests.at(-1);
            const tools = wireTools(request.body);
            if (strict) assert.ok(tools.every(tool => tool.strict === true), label);
            for (const call of calls) assert.ok(tools.some(tool => tool.name === call.function.name), call.function.name);
            return request;
        },
        async close() { await driver.closeToolTurn(); driver.dispose(); await provider.close(); },
    };
}
