import { afterEach, expect, it, vi } from 'vitest';
import { jsonSchema } from 'ai';
import { AgentDriverV2, createLanguageModel, type LLMConfig } from '../../src/index.js';
import { LLMClient } from '../../src/core/llm-client.js';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

const messages = [{ role: 'user' as const, content: 'Reply with a confirmation.' }];

function chatResponse(model: string) {
    const frame = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
    return new Response('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
    });
}

it.each(['gateway/team/model:fast', 'gateway:team/model:fast'])(
    'uses the same explicit Provider and verbatim model for the budget and request (%s)', async model => {
        vi.stubEnv('GATEWAY_API_KEY', 'fixture-gateway');
        const fetch = vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe('https://gateway.test/v1/chat/completions');
            expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-gateway');
            expect(JSON.parse(String(init.body))).toMatchObject({ model, max_tokens: 500 });
            return chatResponse(model);
        });
        vi.stubGlobal('fetch', fetch);
        const inputBudget = vi.fn(async () => ({ contextWindow: 16_384, maxOutputTokens: 500 }));
        const client = new LLMClient({ provider: { id: 'gateway', baseURL: 'https://gateway.test/v1' }, model, inputBudget });
        expect((await client.call(messages, {})).text).toBe('ok');
        expect(inputBudget).toHaveBeenCalledExactlyOnceWith({ providerId: 'gateway', modelId: model });
        expect(fetch).toHaveBeenCalledOnce();
    }
);

it.each([
    [{ model: 'openai:o3' }, 'provider.id'],
    [{ model: 'o3', provider: { id: ' ' } }, 'provider.id'],
    [{ model: 'o3', provider: { id: 1 } }, 'provider.id'],
    [{ provider: { id: 'openai' } }, 'model ID'],
    [{ model: '   ', provider: { id: 'openai' } }, 'model ID'],
])('rejects an invalid JavaScript configuration at both public entry points', (value, message) => {
    const config = value as LLMConfig;
    expect(() => new AgentDriverV2({ llm: config, sources: [] })).toThrow(message);
    expect(() => createLanguageModel(config)).toThrow(message);
});

it('selects Responses for the OpenAI endpoint and Chat for the resolved compatible endpoint', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-openai');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai-proxy.test/v1');
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-openai');
        expect(JSON.parse(String(init.body)).model).toBe('openai:raw');
        return Response.json({ error: { message: 'fixture stopped', type: 'invalid_request_error' } }, { status: 400 });
    });
    vi.stubGlobal('fetch', fetch);
    for (const baseURL of ['https://api.openai.com/v1', undefined]) {
        const model = createLanguageModel({ model: 'openai:raw', provider: { id: 'openai', baseURL } });
        await expect(model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] }))
            .rejects.toThrow('fixture stopped');
    }
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
        'https://api.openai.com/v1/responses',
        'https://openai-proxy.test/v1/chat/completions',
    ]);
});

const routerModel = 'vendor/model:suffix';
const routerTool = { fixture: { inputSchema: jsonSchema({ type: 'object' }) } };

function captureOpenRouterRequests(respond: (attempt: number) => Response) {
    const requests: { model: string; tools?: unknown[]; max_tokens?: number; messages: unknown[] }[] = [];
    const beforeRequest = vi.fn();
    const inputBudget = vi.fn(() => ({ contextWindow: 32_000, maxOutputTokens: 400 }));
    vi.stubEnv('OPENROUTER_API_KEY', 'fixture-router');
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-router');
        expect(beforeRequest).toHaveBeenCalledOnce();
        expect(inputBudget).toHaveBeenCalledExactlyOnceWith({ providerId: 'openrouter', modelId: routerModel });
        requests.push(JSON.parse(String(init.body)));
        return respond(requests.length);
    });
    const client = new LLMClient({ provider: { id: 'openrouter' }, model: routerModel, inputBudget });
    return { client, beforeRequest, requests };
}

it.each([
    [400, 'This model does not support tools'],
    [400, 'Function calling is not supported for this model.'],
    [404, 'No endpoints found that support tool use.'],
])('retries an explicit OpenRouter tool incompatibility (HTTP %i: %s)', async (status, message) => {
    const { client, beforeRequest, requests } = captureOpenRouterRequests(attempt => attempt === 1
        ? Response.json({ error: { message, code: status } }, { status })
        : chatResponse(routerModel));
    expect((await client.call(messages, routerTool, { beforeRequest })).text)
        .toBe('ok');
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: routerModel, tools: [expect.anything()], max_tokens: 400 });
    expect(requests[1]).toMatchObject({ model: routerModel, max_tokens: 400, messages: requests[0]?.messages });
    expect(requests[1]?.tools ?? []).toEqual([]);
});

it('keeps adopted context tools on the request when OpenRouter rejects them', async () => {
    const message = 'This model does not support tools';
    const { client, beforeRequest, requests } = captureOpenRouterRequests(() =>
        Response.json({ error: { message, code: 400 } }, { status: 400 }));
    await expect(client.call(messages, routerTool, { beforeRequest, preserveTools: true, onTextDelta: vi.fn() }))
        .rejects.toMatchObject({ statusCode: 400, message });
    expect(requests).toEqual([expect.objectContaining({ model: routerModel, tools: [expect.anything()] })]);
});

it.each([
    [401, 'Invalid API key'],
    [403, 'This model does not support tools'],
    [400, 'Invalid value for temperature'],
    [400, 'Invalid tools[0].function.parameters schema'],
    [400, 'This model does not support tools of this type'],
])('propagates an OpenRouter rejection after one request (HTTP %i: %s)', async (status, message) => {
    const { client, beforeRequest, requests } = captureOpenRouterRequests(() =>
        Response.json({ error: { message, code: status } }, { status }));
    await expect(client.call(messages, routerTool, { beforeRequest, onTextDelta: vi.fn() }))
        .rejects.toMatchObject({ statusCode: status, message });
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(requests).toEqual([expect.objectContaining({ model: routerModel, tools: [expect.anything()], max_tokens: 400 })]);
});

it('propagates an OpenRouter error after output without replaying the request', async () => {
    const message = 'This model does not support tools';
    const { client, beforeRequest, requests } = captureOpenRouterRequests(() => {
        const frames = [
            { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: routerModel,
                choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }] },
            { error: { message, code: 400 } },
        ];
        return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } });
    });
    const onTextDelta = vi.fn();
    await expect(client.call(messages, routerTool, { beforeRequest, onTextDelta })).rejects.toMatchObject({ message });
    expect(onTextDelta).toHaveBeenCalledExactlyOnceWith('partial');
    expect(requests).toEqual([expect.objectContaining({ model: routerModel, tools: [expect.anything()], max_tokens: 400 })]);
});
