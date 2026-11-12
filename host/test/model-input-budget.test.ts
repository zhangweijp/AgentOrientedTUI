import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { AgentDriverV2, jsonSchema, type ContextDrivenSource, type LLMConfig, type MessageWithTimestamp } from '@aotui/agent-driver-v2';
import { LLMClient } from '@aotui/agent-driver-v2/dist/core/llm-client.js';
import { LLMConfigService } from '../src/core/llm-config-service.js';
import { Config } from '../src/config/config.js';
import type { ModelRegistry } from '../src/services/model-registry.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function app(name: string) {
    const adopt = vi.fn(), release = vi.fn();
    const source: ContextDrivenSource = { name, onUpdate: () => () => {}, getContext: async () => ({
        messages: [{ role: 'user', content: '<view>' + '中文和代码 const a = 1; '.repeat(75) + '</view>', timestamp: 1 }],
        tools: { [name + '-Item-update']: { description: 'Update ' + name,
            inputSchema: jsonSchema({ type: 'object', properties: { choice: { type: 'string', enum: ['选择 A', '选择 B'] } },
                required: ['choice'], additionalProperties: false }) } },
        adopt, release,
    }) };
    return { source, adopt, release };
}

function setup(llm: LLMConfig, sources: ContextDrivenSource[]) {
    const sent: Parameters<MockLanguageModelV3['doStream']>[0][] = [];
    const model = new MockLanguageModelV3({ doStream: async params => {
        sent.push(params);
        return { stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'ok' }, { type: 'text-end', id: 'text' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 } } },
        ]) };
    } });
    vi.spyOn(LLMClient.prototype as unknown as { createProvider(): unknown }, 'createProvider').mockReturnValue(model);
    const onRunError = vi.fn();
    const driver = new AgentDriverV2({ llm, sources, onRunError });
    return { sent, onRunError, async run() { await driver.trigger(); await driver['runInFlight']; },
        close() { driver.stop(); driver.dispose(); } };
}

describe('Host model input budget', () => {
    it('uses the actual model override and checks both Apps, wire schema and history before adopting', async () => {
        const first = app('first'), second = app('second');
        const history: ContextDrivenSource = { name: 'history', onUpdate: () => () => {}, getContext: async () => ({
            messages: [
                { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'prior', toolName: 'old', input: { text: 'history input' } }], timestamp: 2 },
                { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'prior', toolName: 'old', output: { type: 'text', value: 'history result' } }], timestamp: 3 },
            ], tools: {},
        }) };
        let contextWindow = 4_000;
        const inputBudget = vi.fn(() => ({ contextWindow, maxOutputTokens: 500 }));
        const driver = setup({ model: 'openai:resolved-model', apiKey: 'unused', inputBudget }, [first.source, second.source, history]);
        try {
            await driver.run();
            expect(driver.onRunError).toHaveBeenCalledWith(expect.objectContaining({ code: 'MODEL_INPUT_BUDGET_EXCEEDED',
                details: expect.objectContaining({ method: 'utf8-bytes', inputLimit: 3500, outputReserved: 500 }) }));
            expect(driver.sent).toHaveLength(0);
            for (const source of [first, second]) {
                expect(source.adopt).not.toHaveBeenCalled();
                expect(source.release).toHaveBeenCalledOnce();
            }
            contextWindow = 24_000;
            await driver.run();
            expect(inputBudget).toHaveBeenCalledWith({ providerId: 'openai', modelId: 'resolved-model' });
            expect(driver.sent).toHaveLength(1);
            const request = driver.sent[0]!;
            expect(request.maxOutputTokens).toBe(500);
            expect(JSON.stringify(request.prompt)).toContain('中文和代码');
            expect(JSON.stringify(request.prompt)).toContain('history input');
            expect(JSON.stringify(request.prompt)).toContain('history result');
            expect(request.tools).toEqual(expect.arrayContaining(['first', 'second'].map(name => expect.objectContaining({
                name: name + '-Item-update', inputSchema: expect.objectContaining({
                    properties: { choice: { type: 'string', enum: ['选择 A', '选择 B'] } },
                }),
            }))));
            await driver.run();
            expect(driver.sent).toHaveLength(1);
            expect(first.adopt).toHaveBeenCalledOnce();
            expect(second.adopt).toHaveBeenCalledOnce();
            expect(first.release).toHaveBeenCalledTimes(3);
        } finally { driver.close(); }
    });

    it('applies final tool capability filtering and refuses unknown windows without a request', async () => {
        const source = app('app');
        const driver = setup({ model: 'custom:manual', apiKey: 'unused', inputBudget: () => ({
            contextWindow: 9000, maxInputTokens: 5000, maxOutputTokens: 1000, capabilities: { toolCall: false },
        }) }, [source.source]);
        try {
            await driver.run();
            expect(driver.sent).toHaveLength(1);
            expect(driver.sent[0]!.tools ?? []).toEqual([]);
        } finally { driver.close(); }
        const unknown = setup({ model: 'custom:unknown', apiKey: 'unused', inputBudget: () => undefined }, [source.source]);
        try {
            await unknown.run();
            expect(unknown.sent).toHaveLength(0);
            expect(unknown.onRunError).toHaveBeenCalledWith(expect.objectContaining({ code: 'MODEL_INPUT_LIMITS_UNAVAILABLE' }));
        } finally { unknown.close(); }
    });

    it('refuses unmeasurable media nested in retained tool history', async () => {
        const source = app('media');
        const history: ContextDrivenSource = { name: 'history', onUpdate: () => () => {}, getContext: async () => ({
            messages: [
                { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'image', toolName: 'prior', input: {} }], timestamp: 2 },
                { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'image', toolName: 'prior',
                    output: { type: 'content', value: [{ type: 'image-data', data: 'AA==', mediaType: 'image/png' }] } }], timestamp: 3 },
            ], tools: {},
        }) };
        const driver = setup({ model: 'openai:media', apiKey: 'unused', inputBudget: () => ({
            contextWindow: 30_000, maxOutputTokens: 1_000,
        }) }, [source.source, history]);
        try {
            await driver.run();
            expect(driver.onRunError).toHaveBeenCalledWith(expect.objectContaining({ code: 'MODEL_INPUT_UNMEASURABLE' }));
            expect(driver.sent).toHaveLength(0);
            expect(source.adopt).not.toHaveBeenCalled();
            expect(source.release).toHaveBeenCalledOnce();
        } finally { driver.close(); }
    });

    it.each([
        ['openai', 'https://api.openai.com/v1'],
        ['anthropic', 'https://api.anthropic.com/v1'],
        ['google', 'https://generativelanguage.googleapis.com/v1beta'],
        ['deepseek', 'https://api.deepseek.com'],
        ['xai', 'https://api.x.ai/v1'],
        ['openrouter', 'https://openrouter.ai/api/v1'],
    ])('treats the %s SDK default endpoint as implicit when the catalog omits api', async (providerId, baseURL) => {
        vi.stubEnv('OPENAI_BASE_URL', undefined);
        vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
        vi.spyOn(Config, 'getTuiConfig').mockResolvedValue({});
        const modelId = providerId === 'openai' ? 'o3' : 'listed-model';
        const registry = {
            getModels: async () => [{ id: modelId, limit: { context: 200_000, output: 32_000 }, tool_call: true }],
            getProviderConfig: async () => ({ baseURL: '' }),
        } as unknown as ModelRegistry;
        const service = new LLMConfigService(registry);
        const model = providerId + ':' + modelId;
        const limits = (endpoint?: string) => service.withModelInputBudget({ model,
            ...(endpoint ? { provider: { id: providerId, baseURL: endpoint } } : {}),
        }).inputBudget?.({ providerId, modelId });
        expect(await limits()).toMatchObject({ contextWindow: 200_000 });
        expect(await limits(baseURL + '/')).toEqual(await limits());
        expect(await limits('https://proxy.example/v1')).toBeUndefined();
        expect(await limits(baseURL + '/another-path')).toBeUndefined();
    });

    it('does not use the official catalog for an OpenAI environment override', async () => {
        vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.example/v1');
        vi.spyOn(Config, 'getTuiConfig').mockResolvedValue({ modelInputLimits: {
            'openai:o3': { contextWindow: 200_000, maxOutputTokens: 4_096 },
        } });
        const registry = {
            getModels: async () => [{ id: 'o3', limit: { context: 200_000, output: 32_000 } }],
            getProviderConfig: async () => ({ baseURL: '' }),
        } as unknown as ModelRegistry;
        const service = new LLMConfigService(registry);
        expect(await service.withModelInputBudget({ model: 'openai:o3' }).inputBudget?.({ providerId: 'openai', modelId: 'o3' })).toBeUndefined();
        expect(await service.withModelInputBudget({ model: 'openai:o3',
            provider: { id: 'openai', baseURL: 'https://api.openai.com/v1' },
        }).inputBudget?.({ providerId: 'openai', modelId: 'o3' })).toMatchObject({ contextWindow: 200_000 });
    });

    it('resolves limits from the Host catalog and supports explicit limits scoped to a custom endpoint', async () => {
        vi.spyOn(Config, 'getTuiConfig').mockResolvedValue({ modelInputLimits: {
            'openai:actual@https://custom.example/v1': { contextWindow: 8_000, maxOutputTokens: 500 },
        } });
        const getModels = vi.fn(async () => [{ id: 'actual', limit: { context: 64_000, input: 32_000, output: 8_000 }, tool_call: false }]);
        const service = new LLMConfigService({ getModels } as unknown as ModelRegistry);
        const catalog = service.withModelInputBudget({ model: 'openai:actual' });
        expect(await catalog.inputBudget?.({ providerId: 'openai', modelId: 'actual' })).toMatchObject({
            contextWindow: 64_000, maxInputTokens: 32_000, maxOutputTokens: 4_096, capabilities: { toolCall: false },
        });
        expect(await catalog.inputBudget?.({ providerId: 'openai', modelId: 'unknown' })).toBeUndefined();
        const custom = service.withModelInputBudget({ model: 'openai:actual', provider: { id: 'openai', baseURL: 'https://custom.example/v1/' } });
        expect(await custom.inputBudget?.({ providerId: 'openai', modelId: 'actual' })).toEqual({ contextWindow: 8_000, maxOutputTokens: 500 });
        expect(getModels).toHaveBeenCalledWith({ providerId: 'openai' });
    });
});

it('preserves DeepSeek reasoning through successive tool calls and the next user turn', async () => {
    type WireMessage = { role: string; content: string; reasoning_content?: string;
        tool_calls?: { id: string }[]; tool_call_id?: string };
    const requests: { messages: WireMessage[]; thinking?: { type: string } }[] = [];
    const modelId = 'deepseek-flash';
    const toolName = 'work-Item-update';
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
        expect(url).toBe('https://api.deepseek.com/chat/completions');
        const request = JSON.parse(String(options.body));
        expect(request).toMatchObject({ model: modelId, max_tokens: 4_096,
            tools: expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: toolName }) })]) });
        const number = requests.push(request);
        const call = number <= 3;
        const header = { id: 'completion-' + number, object: 'chat.completion.chunk', created: 1, model: modelId };
        const frames = [
            { ...header, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'reason-' + number,
                ...(call ? { tool_calls: [{ index: 0, id: 'call-' + number, type: 'function',
                    function: { name: toolName, arguments: '{}' } }] } : { content: 'Done' }),
            }, finish_reason: null }] },
            { ...header, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
                usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
        ];
        return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.spyOn(Config, 'getTuiConfig').mockResolvedValue({});
    const service = new LLMConfigService({
        getModels: async () => [{ id: modelId, limit: { context: 32_000, output: 8_000 }, tool_call: true }],
    } as unknown as ModelRegistry);
    const history: MessageWithTimestamp[] = [{ role: 'user', content: 'Update the item.', timestamp: 1 }];
    const remember = (message: Omit<MessageWithTimestamp, 'timestamp'>) => {
        history.push({ ...message, timestamp: history.length + 1 });
    };
    let revision = 0;
    const executeTool = vi.fn(async (name: string, _input: unknown, toolCallId: string) => {
        revision++;
        return { toolName: name, toolCallId, result: { success: true } };
    });
    const source: ContextDrivenSource = { name: 'work', onUpdate: () => () => {}, getContext: async () => ({
        messages: [...history, { role: 'user', region: 'dynamic', content: '<view>revision ' + revision + '</view>', timestamp: 0 }],
        tools: { [toolName]: { description: 'Update the item.', inputSchema: jsonSchema({ type: 'object', properties: {} }) } },
        executeTool,
    }) };
    const onRunError = vi.fn();
    const driver = new AgentDriverV2({ sources: [source], llm: service.withModelInputBudget({
        model: 'deepseek:' + modelId, apiKey: 'fixture-only', provider: { id: 'deepseek' },
    }), onAssistantMessage: remember, onToolResult: remember, onTextDelta: () => {}, onRunError });
    try {
        for (let number = 1; number <= 5; number++) {
            if (number === 5) remember({ role: 'user', content: 'Confirm the result.' });
            await driver.trigger();
            await driver['runInFlight'];
        }
        expect(onRunError).not.toHaveBeenCalled();
        expect(requests).toHaveLength(5);
        expect(executeTool.mock.calls.map(call => call[2])).toEqual(['call-1', 'call-2', 'call-3']);
        expect(requests.map(request => request.thinking?.type)).not.toContain('disabled');
        expect(requests[2]!.messages).toMatchObject([
            { role: 'user', content: 'Update the item.' },
            { role: 'assistant', reasoning_content: 'reason-1', tool_calls: [{ id: 'call-1' }] },
            { role: 'tool', tool_call_id: 'call-1' },
            { role: 'user', content: '<view>revision 2</view>' },
            { role: 'assistant', reasoning_content: 'reason-2', tool_calls: [{ id: 'call-2' }] },
            { role: 'tool', tool_call_id: 'call-2' },
        ]);
        expect(requests[3]!.messages.filter(message => message.role === 'assistant').map(message => message.reasoning_content))
            .toEqual(['reason-1', 'reason-2', 'reason-3']);
        expect(requests[4]!.messages.filter(message => message.role === 'assistant').map(message => message.reasoning_content))
            .toEqual(['reason-1', 'reason-2', 'reason-3', 'reason-4']);
    } finally { driver.stop(); driver.dispose(); }
});
