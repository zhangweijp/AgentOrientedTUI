import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { jsonSchema } from 'ai';
import { AgentDriverV2, createLanguageModel, type LLMConfig } from '../../src/index.js';
import { LLMClient } from '../../src/core/llm-client.js';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

const messages = [{ role: 'user' as const, content: 'Reply with a confirmation.' }];

function streamFrames(frames: readonly object[]) {
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
    });
}

function chatResponse(model: string) {
    const frame = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
    return streamFrames([frame]);
}

const vendor = { detail: [false, 0, null] };
const responsesUsage = { input_tokens: 11, output_tokens: 7, total_tokens: 18,
    input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 }, vendor };
const chatUsage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 4, vendor }, completion_tokens_details: { reasoning_tokens: 3, vendor },
    cost: 0, vendor };
const googleUsage = { promptTokenCount: 11, candidatesTokenCount: 4, thoughtsTokenCount: 3,
    totalTokenCount: 18, cachedContentTokenCount: 4, trafficType: 'ON_DEMAND',
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 11 }],
    candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 4 }], vendor };
const anthropicStart = { input_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 4, vendor };
const anthropicDelta = { output_tokens: 7, end_vendor: vendor };

it.each([
    { id: 'openai', baseURL: 'https://api.openai.com/v1', terminal: 'response.completed', incompleteDetails: null },
    { id: 'xai', baseURL: 'https://api.x.ai/v1', terminal: 'response.incomplete', incompleteDetails: { reason: 'max_output_tokens' } },
])('preserves the complete raw object from $id $terminal', async ({ id, baseURL, terminal, incompleteDetails }) => {
    const item = { type: 'message', id: 'message-1' };
    const fetch = vi.fn(async (url: string) => {
        expect(url).toBe(baseURL + '/responses');
        return streamFrames([
            { type: 'response.output_item.added', output_index: 0, item },
            { type: 'response.output_text.delta', item_id: item.id, delta: 'ok' },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: terminal, response: { usage: responsesUsage, incomplete_details: incompleteDetails } },
        ]);
    });
    vi.stubGlobal('fetch', fetch);
    const response = await new LLMClient({ provider: { id, baseURL }, model: 'fixture', apiKey: 'test' }).call(messages, {});
    expect(response).toMatchObject({ text: 'ok', finishReason: incompleteDetails ? 'length' : 'stop',
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } });
    expect(response.usage?.raw).toEqual(responsesUsage);
    expect(fetch).toHaveBeenCalledOnce();
});

it('uses the Anthropic adapter merge of start and delta usage', async () => {
    const fetch = vi.fn(async (url: string) => {
        expect(url).toBe('https://anthropic.test/v1/messages');
        return streamFrames([
            { type: 'message_start', message: { usage: anthropicStart } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: anthropicDelta },
            { type: 'message_stop' },
        ]);
    });
    vi.stubGlobal('fetch', fetch);
    const response = await new LLMClient({
        provider: { id: 'anthropic', baseURL: 'https://anthropic.test/v1' }, model: 'fixture', apiKey: 'test',
    }).call(messages, {});
    expect(response).toMatchObject({ text: 'ok', usage: {
        inputTokens: 11, outputTokens: 7, totalTokens: 18, raw: { ...anthropicStart, ...anthropicDelta },
    } });
    expect(fetch).toHaveBeenCalledOnce();
});

it.each([true, false])('keeps the latest Google usageMetadata through later missing and null fields (%s)', async (reported) => {
    const fetch = vi.fn(async (url: string) => {
        expect(url).toMatch(/\/models\/fixture:streamGenerateContent\?alt=sse$/);
        return streamFrames([
            ...(reported ? [{ usageMetadata: { promptTokenCount: 1 } }, { usageMetadata: googleUsage }] : []),
            { usageMetadata: null },
            { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
        ]);
    });
    vi.stubGlobal('fetch', fetch);
    const response = await new LLMClient({
        provider: { id: 'google', baseURL: 'https://google.test/v1beta' }, model: 'fixture', apiKey: 'test',
    }).call(messages, {});
    expect(response.text).toBe('ok');
    if (reported) {
        expect(response.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
        expect(response.usage?.raw).toEqual(googleUsage);
    } else expect(response).not.toHaveProperty('usage');
    expect(fetch).toHaveBeenCalledOnce();
});

it.each([
    { path: 'chat/completions', model: 'vendor/model', choice: { delta: { content: 'ok' } } },
    { path: 'completions', model: 'openai/gpt-3.5-turbo-instruct', choice: { text: 'ok' } },
])('keeps the OpenRouter $path adapter usage from the terminal chunk', async ({ path, model, choice }) => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://openrouter.test/v1/' + path);
        expect(JSON.parse(String(init.body))).toMatchObject({ stream_options: { include_usage: true } });
        return streamFrames([
            { id: 'fixture', object: 'chat.completion.chunk', model, choices: [{ ...choice, index: 0, finish_reason: 'stop' }] },
            { id: 'fixture', object: 'chat.completion.chunk', model, choices: [], usage: chatUsage },
        ]);
    });
    vi.stubGlobal('fetch', fetch);
    const response = await new LLMClient({
        provider: { id: 'openrouter', baseURL: 'https://openrouter.test/v1' }, model, apiKey: 'test',
    }).call(messages, {});
    expect(response).toMatchObject({ usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } });
    expect(response.usage?.raw).toEqual(chatUsage);
    expect(fetch).toHaveBeenCalledOnce();
});

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

const closed = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false,
    properties, required: Object.keys(properties) });
const seatSchema = closed({ seat: { anyOf: [
    { type: 'array', items: false, minItems: 2, prefixItems: [{ type: 'string' }, { type: 'integer', minimum: 1 }] },
    { type: 'string', description: 'Select a published Ref with $ref.app_id.view_id.ref_id.' },
] } });

it('checks OpenAI strict enum totals per tool, including alternatives and nested properties', async () => {
    const station = (count: number) => ({ type: 'string', enum: Array.from({ length: count }, (_, index) => `S${index}`) });
    const provider = { id: 'openai', toolSchemaMode: 'strict' as const };
    const policy = await new LLMClient({ model: 'fixture', provider }).toolSchemaPolicy();
    const check = policy.check!;
    expect(check(closed({ station: station(1000) }))).toBeUndefined();
    expect(check(closed({ station: station(1001) }))).toEqual({ path: '$.properties.station.enum',
        reason: expect.stringContaining('1001 enum values') });
    const split = (count: number) => closed({ outward: { anyOf: [station(501), { type: 'null' }] },
        return: closed({ code: station(count) }) });
    expect(check(split(499))).toBeUndefined();
    expect(check(split(500))).toEqual({ path: '$.properties.return.properties.code.enum',
        reason: expect.stringContaining('1000 per tool schema') });
    expect(check(closed({ station: station(1000) }))).toBeUndefined();
    expect(check(closed({ line: station(1000) }))).toBeUndefined();
    const deepseek = await new LLMClient({ model: 'fixture', provider: { ...provider, id: 'deepseek', baseURL: 'https://api.deepseek.com/beta' } }).toolSchemaPolicy();
    expect(deepseek.check?.(closed({ station: station(1001) }))).toBeUndefined();
});

it('checks reachable OpenAI strict nesting and the large string enum boundary', async () => {
    const policy = await new LLMClient({ model: 'fixture', provider: { id: 'openai', toolSchemaMode: 'strict' } }).toolSchemaPolicy();
    const check = policy.check!;
    let nested = closed({ value: { type: 'string' } });
    for (let level = 1; level < 10; level++) nested = closed({ child: nested });
    expect(check(nested)).toBeUndefined();
    expect(check(closed({ child: { anyOf: [nested, { type: 'null' }] } }))).toMatchObject({
        path: '$.properties.child.anyOf[0]' + '.properties.child'.repeat(9), reason: expect.stringContaining('11 levels') });
    const codes = Array.from({ length: 251 }, (_, index) => 'a'.repeat(index < 191 ? 57 : 56) + String(index).padStart(3, '0'));
    expect(codes.reduce((total, code) => total + code.length, 0)).toBe(15_000);
    expect(check(closed({ line: { type: 'string', enum: codes } }))).toBeUndefined();
    codes[0] += '🚉';
    expect(check(closed({ line: { type: 'string', enum: codes } }))).toEqual({ path: '$.properties.line.enum',
        reason: expect.stringContaining('15001 characters') });
    expect(check(closed({ line: { type: 'string', enum: codes.slice(0, 250).map(code => code + '123') } }))).toBeUndefined();
});

it.each([
    ['openai', 'https://api.openai.com/v1', '/responses', false],
    ['openai', 'https://api.openai.com/v1', '/responses', true],
    ['openai', 'https://compatible.test/v1', '/chat/completions', false],
    ['openai', 'https://compatible.test/v1', '/chat/completions', true],
    ['deepseek', 'https://api.deepseek.com', '/chat/completions', false],
    ['deepseek', 'https://api.deepseek.com/beta', '/chat/completions', true],
] as const)('checks and encodes %s %s strict mode %s (%s) without hiding a 400', async (id, baseURL, route, strict) => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe(baseURL + route);
        expect(typeof init.body).toBe('string');
        return Response.json({ error: { message: 'fixture refused this request', type: 'invalid_request_error' } }, { status: 400 });
    });
    vi.stubGlobal('fetch', fetch);
    const client = new LLMClient({ apiKey: 'fixture', model: 'fixture', provider: { id, baseURL,
        ...(strict ? { toolSchemaMode: 'strict' as const } : {}) } });
    const beforeRequest = vi.fn();
    if (strict) {
        await expect(client.call(messages, { cinema: { inputSchema: jsonSchema(seatSchema) } }, { beforeRequest, preserveTools: true }))
            .rejects.toMatchObject({ code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED', tool: 'cinema', path: '$.properties.seat.anyOf[0].prefixItems' });
        expect(fetch).not.toHaveBeenCalled();
        expect(beforeRequest).not.toHaveBeenCalled();
        const policy = await client.toolSchemaPolicy();
        expect(policy.check?.({ ...closed({ note: { type: 'string' } }), required: [] })?.path).toBe('$.properties.note');
    }
    const input = strict ? closed({ note: { type: 'string' } }) : seatSchema;
    await expect(client.call(messages, { published: { inputSchema: jsonSchema(input) } }, { beforeRequest, preserveTools: true }))
        .rejects.toMatchObject({ statusCode: 400, message: 'fixture refused this request' });
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [tool] = JSON.parse(String(fetch.mock.calls[0]![1].body)).tools;
    expect(tool.function ?? tool).toMatchObject({ name: 'published', strict, parameters: input });
});

it('captures unrestricted JSON on the local provider wire and reports strict failures before sending', async () => {
    const requests: { path: string; body: any }[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        requests.push({ path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
            error: { code: 400, type: 'invalid_request_error', message: 'Captured local encoding', status: 'INVALID_ARGUMENT' },
        }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP address');
        const endpoint = `http://127.0.0.1:${address.port}`;
        const transport = globalThis.fetch;
        vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            return transport(endpoint + url.pathname + url.search, init);
        });
        const routes = [
            { id: 'openai', baseURL: 'https://api.openai.com/v1', path: '/v1/responses' },
            { id: 'openai', baseURL: endpoint + '/chat/v1', path: '/chat/v1/chat/completions' },
            { id: 'deepseek', baseURL: endpoint + '/beta', path: '/beta/chat/completions' },
        ];
        const direct = closed({ body: { description: 'Any JSON value' } });
        const nested = closed({ payload: closed({ values: { type: 'array', items: {} } }) });
        for (const { id, baseURL, path } of routes) {
            const strict = new LLMClient({ apiKey: 'fixture', model: 'fixture', provider: { id, baseURL, toolSchemaMode: 'strict' } });
            const beforeRequest = vi.fn();
            const before = requests.length;
            for (const [schema, field] of [[direct, '$.properties.body'], [nested, '$.properties.payload.properties.values.items']] as const) {
                await expect(strict.call(messages, { arbitrary: { inputSchema: jsonSchema(schema) } }, { preserveTools: true, beforeRequest }))
                    .rejects.toMatchObject({ code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED', path: field,
                        reason: expect.stringContaining('unconstrained JSON value') });
            }
            expect(beforeRequest).not.toHaveBeenCalled();
            expect(requests).toHaveLength(before);
            const client = new LLMClient({ apiKey: 'fixture', model: 'fixture', provider: { id, baseURL, toolSchemaMode: 'non-strict' } });
            await expect(client.call(messages, { direct: { inputSchema: jsonSchema(direct) }, nested: { inputSchema: jsonSchema(nested) } },
                { preserveTools: true })).rejects.toMatchObject({ statusCode: 400 });
            expect(requests).toHaveLength(before + 1);
            const wire = requests.at(-1)!;
            expect(wire.path).toBe(path);
            expect(wire.body.tools.map((value: any) => value.function ?? value)).toEqual([
                expect.objectContaining({ name: 'direct', strict: false, parameters: direct }),
                expect.objectContaining({ name: 'nested', strict: false, parameters: nested }),
            ]);
        }

        const google = new LLMClient({ apiKey: 'fixture', model: 'fixture', provider: { id: 'google', baseURL: endpoint + '/google' } });
        const { additionalProperties, ...open } = direct;
        await expect(google.call(messages, { arbitrary: { inputSchema: jsonSchema(open) } }, { preserveTools: true }))
            .rejects.toMatchObject({ statusCode: 400 });
        const googleTool = requests.at(-1)!.body.tools[0].functionDeclarations[0];
        expect(googleTool.parametersJsonSchema ?? googleTool.parameters).toEqual(open);
        const googlePolicy = await google.toolSchemaPolicy();
        if (googleTool.parameters) expect(googlePolicy.check?.(direct)?.path).toBe('$.additionalProperties');
        else expect(googlePolicy.check?.(direct)).toBeUndefined();
        expect(requests).toHaveLength(4);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15_000);

it('rejects DeepSeek strict without its Beta endpoint and a model without required tools before request admission', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const beforeRequest = vi.fn();
    const tools = { open: { inputSchema: jsonSchema(closed({ installation_id: { type: 'string' } })) } };
    const flags = { beforeRequest, preserveTools: true };
    const nonBeta = new LLMClient({ apiKey: 'fixture', model: 'fixture', provider: { id: 'deepseek', toolSchemaMode: 'strict' } });
    await expect(nonBeta.call(messages, tools, flags)).rejects.toMatchObject({ code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED', reason: expect.stringContaining('/beta') });
    const noTools = new LLMClient({ apiKey: 'fixture', model: 'fixture', provider: { id: 'openai' }, modelCapabilities: { toolCall: false } });
    await expect(noTools.call(messages, tools, flags)).rejects.toMatchObject({ code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED', tool: 'required tools' });
    expect(fetch).not.toHaveBeenCalled();
    expect(beforeRequest).not.toHaveBeenCalled();
});

it('rejects unsupported Claude strict array bounds in a required tool before adoption', async () => {
    const fetch = vi.fn(), beforeRequest = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const client = new LLMClient({ apiKey: 'fixture', model: 'claude-sonnet-4-5',
        provider: { id: 'anthropic', baseURL: 'https://anthropic.test/v1', toolSchemaMode: 'strict' } });
    const schema = (bounds: object) => closed({ imports: { anyOf: [
        { type: 'array', items: { type: 'string' }, ...bounds }, { type: 'null' },
    ] } });
    const policy = await client.toolSchemaPolicy();
    for (const minItems of [0, 1]) expect(policy.check?.(schema({ minItems }))).toBeUndefined();
    for (const [keyword, value] of [['maxItems', 256], ['minItems', 2]] as const) {
        await expect(client.call(messages, { required_lookup: { inputSchema: jsonSchema(schema({ [keyword]: value })) } },
            { preserveTools: true, beforeRequest })).rejects.toMatchObject({ code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED',
            tool: 'required_lookup', path: `$.properties.imports.anyOf[0].${keyword}`, reason: expect.stringContaining('minItems of 0 or 1') });
    }
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
});

it.each([
    { id: 'openai', baseURL: 'https://api.openai.com/v1' },
    { id: 'openai', baseURL: 'https://compatible.test/v1' },
    { id: 'anthropic' }, { id: 'google' }, { id: 'deepseek' }, { id: 'xai' }, { id: 'openrouter' },
])('trials the actual encoders without fetching and checks the same byte count on send ($id $baseURL)', async provider => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        expect(typeof init.body).toBe('string');
        return Response.json({ error: { message: 'fixture response', type: 'invalid_request_error' } }, { status: 400 });
    });
    vi.stubGlobal('fetch', fetch);
    const client = new LLMClient({ apiKey: 'fixture', provider, model: 'fixture',
        inputBudget: () => ({ contextWindow: 32_000, maxOutputTokens: 190 }) });
    const trial = await client.createInputMeasurement();
    const measurement = await trial!(messages, routerTool, true);
    expect(fetch).not.toHaveBeenCalled();
    expect(measurement).toMatchObject({ inputLimit: 31_810, outputReserved: 190, method: 'utf8-bytes' });
    const adopt = vi.fn();
    await expect(client.call(messages, routerTool, { beforeRequest: adopt, preserveTools: true })).rejects.toBeDefined();
    expect(adopt).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(measurement.inputBytes).toBe(Buffer.byteLength(String(fetch.mock.calls[0]![1].body)));
});

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
])('preserves an explicit OpenRouter tool incompatibility (HTTP %i: %s)', async (status, message) => {
    const { client, beforeRequest, requests } = captureOpenRouterRequests(attempt => attempt === 1
        ? Response.json({ error: { message, code: status } }, { status })
        : chatResponse(routerModel));
    await expect(client.call(messages, routerTool, { beforeRequest })).rejects.toMatchObject({ statusCode: status, message });
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: routerModel, tools: [expect.anything()], max_tokens: 400 });
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
