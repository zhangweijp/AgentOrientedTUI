import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ai from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { AgentDriverV2 } from '../../src/core/agent-driver-v2.js';
import { LLMClient } from '../../src/core/llm-client.js';
import type { ContextDrivenSource, LLMConfig } from '../../src/core/interfaces.js';

// Native ESM exports cannot be spied on directly. Record calls while delegating
// every invocation to the real installed streamText implementation.
vi.mock('ai', async importOriginal => {
    const actual = await importOriginal<typeof import('ai')>();
    return { ...actual, streamText: vi.fn(actual.streamText) };
});

const drivers: AgentDriverV2[] = [];
const config = { model: 'controlled-owner', provider: { id: 'openai' }, apiKey: 'unused-no-network' };
const input = { value: 1 };
const schema = { type: 'object' as const, properties: { value: { type: 'number' as const } }, required: ['value'], additionalProperties: false };
const assistantMessage = {
    role: 'assistant',
    content: [
        { type: 'reasoning', text: 'Plan once.' },
        { type: 'text', text: 'Run once.' },
        { type: 'tool-call', toolCallId: 'owner-call', toolName: 'counter', input },
    ],
};

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(ai.streamText).mockClear();
});

afterEach(async () => {
    for (const driver of drivers.splice(0)) { driver.stop(); driver.dispose(); }
    if (vi.isFakeTimers()) {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function controlledModel(beforeResponse = async () => {}, toolCall = true, moreCallIds: string[] = []) {
    const model = new MockLanguageModelV3({ doStream: async () => {
        await beforeResponse();
        return { stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'reason' },
            { type: 'reasoning-delta', id: 'reason', delta: 'Plan once.' },
            { type: 'reasoning-end', id: 'reason' },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: 'Run ' },
            { type: 'text-delta', id: 'text', delta: 'once.' },
            { type: 'text-end', id: 'text' },
            ...(toolCall ? ['owner-call', ...moreCallIds].map(toolCallId => ({
                type: 'tool-call' as const, toolCallId, toolName: 'counter', input: JSON.stringify(input),
            })) : []),
            { type: 'finish', finishReason: { unified: toolCall ? 'tool-calls' : 'stop', raw: toolCall ? 'tool_calls' : 'stop' },
                usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 3, reasoning: 2 } } },
        ]) };
    } });
    // Only provider creation is replaced: LLMClient.call and streamText remain real.
    vi.spyOn(LLMClient.prototype as any, 'createProvider').mockReturnValue(model);
    return model;
}

function descriptor(execute?: ai.Tool['execute']) {
    const tool: ai.Tool = {
        description: 'Count one controlled action', inputSchema: ai.jsonSchema(schema),
        ...(execute ? { execute } : {}), type: 'dynamic',
    };
    return Object.freeze(tool);
}

function turn(tool: ai.Tool, execute: NonNullable<ai.Tool['execute']>, llm: LLMConfig = config) {
    const release = vi.fn();
    const executeTool = vi.fn(async (toolName: string, args: unknown, toolCallId: string) => ({
        toolName, toolCallId, result: await execute(args, { toolCallId, messages: [] }),
    }));
    const source: ContextDrivenSource = {
        name: 'owner-context', onUpdate: () => () => {},
        getContext: vi.fn(async () => ({
            messages: [{ role: 'user' as const, content: 'Run the counter once.', timestamp: 1 }],
            tools: { counter: tool }, executeTool, release,
        })),
    };
    const onAssistantMessage = vi.fn(), onToolResult = vi.fn(), onRunError = vi.fn();
    const driver = new AgentDriverV2({ sources: [source], llm, onAssistantMessage, onToolResult, onRunError });
    drivers.push(driver);
    return { driver, source, executeTool, release, onAssistantMessage, onToolResult, onRunError };
}

function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe('Source tool execution owner', () => {
    it.each([false, true])('real LLMClient leaves execution to Driver (streaming=%s) and preserves metadata', async streaming => {
        const model = controlledModel();
        const execute = vi.fn(async () => ({ ok: true }));
        const validate = vi.fn(async (value: unknown) => ({ success: true as const, value }));
        const inputSchema = ai.jsonSchema(schema, { validate });
        const definition = {
            description: 'Count one controlled action', inputSchema, execute,
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
            strict: true, inputExamples: [{ input }], needsApproval: false,
            onInputAvailable: vi.fn(),
            toModelOutput: () => ({ type: 'json' as const, value: { ok: true } }),
        };
        const original = Object.freeze(ai.dynamicTool(definition));
        const tools = Object.freeze({ counter: original });
        // This spy delegates to the installed SDK; it does not fabricate its response.
        const sdk = vi.mocked(ai.streamText);
        const onTextDelta = vi.fn(), onReasoningDelta = vi.fn();

        const response = await new LLMClient(config).call(
            [{ role: 'user', content: 'Run once.' }], tools,
            streaming ? { onTextDelta, onReasoningDelta } : undefined,
        );

        expect(execute).toHaveBeenCalledTimes(0);
        expect(model.doStreamCalls).toHaveLength(1);
        expect(validate).toHaveBeenCalledTimes(1);
        expect(sdk).toHaveBeenCalledTimes(1);
        const forwarded = sdk.mock.calls[0][0].tools!.counter;
        expect(forwarded).not.toHaveProperty('execute');
        expect(Object.keys(forwarded).sort()).toEqual(Object.keys(original).filter(key => key !== 'execute').sort());
        expect(forwarded.strict).toBe(false);
        for (const key of Object.keys(forwarded).filter(key => key !== 'strict')) expect(Reflect.get(forwarded, key)).toBe(Reflect.get(original, key));
        expect(forwarded.inputSchema).toBe(inputSchema);
        expect(tools.counter).toBe(original);
        expect(original.execute).toBe(execute);
        expect(Object.isFrozen(original)).toBe(true);
        expect(response).toEqual({
            toolCalls: [{ toolCallId: 'owner-call', toolName: 'counter', args: input }],
            usage: {
                inputTokens: 3, outputTokens: 5, totalTokens: 8,
                inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
                outputTokenDetails: { textTokens: 3, reasoningTokens: 2 },
                cachedInputTokens: 0, reasoningTokens: 2,
            },
            assistantMessage,
        });
        expect(response.usage).not.toHaveProperty('raw');
        expect(onTextDelta.mock.calls).toEqual(streaming ? [['Run '], ['once.']] : []);
        expect(onReasoningDelta.mock.calls).toEqual(streaming ? [['Plan once.']] : []);
    });

    it.each([true, false])('routes once and releases the Context (Source descriptor has execute=%s)', async hasExecute => {
        const model = controlledModel();
        let effects = 0;
        const execute = vi.fn(async (args: unknown) => ({ count: ++effects, args }));
        const tool = descriptor(hasExecute ? execute : undefined);
        const current = turn(tool, execute);

        await current.driver['run']();

        expect(execute).toHaveBeenCalledTimes(1);
        expect(current.executeTool).toHaveBeenCalledExactlyOnceWith('counter', input, 'owner-call', undefined, expect.any(AbortSignal));
        expect(current.onAssistantMessage).toHaveBeenCalledExactlyOnceWith(assistantMessage);
        expect(current.onToolResult).toHaveBeenCalledExactlyOnceWith({
            role: 'tool', content: [{ type: 'tool-result', toolCallId: 'owner-call', toolName: 'counter',
                output: { type: 'json', value: { count: 1, args: input } } }],
        }, expect.any(Array));
        expect(current.release).toHaveBeenCalledTimes(1);
        expect(current.release.mock.invocationCallOrder[0]).toBeGreaterThan(current.onToolResult.mock.invocationCallOrder[0]);
        expect(current.onRunError).not.toHaveBeenCalled();
        expect(model.doStreamCalls).toHaveLength(1);
        expect(tool.execute).toBe(hasExecute ? execute : undefined);
        expect(current.driver.hasPendingUpdate()).toBe(false);
    });

    it.each(['stop', 'close', 'disable'] as const)('does not bypass the Driver %s gate on a late provider response', async gate => {
        if (gate === 'disable') vi.useFakeTimers();
        const started = barrier(), response = barrier();
        const model = controlledModel(async () => { started.resolve(); await response.promise; });
        const execute = vi.fn(async () => ({ ok: true }));
        const current = turn(descriptor(execute), execute);
        const work = current.driver['run']();
        try {
            await started.promise;
            if (gate === 'stop') current.driver.stop();
            else if (gate === 'close') await current.driver.closeToolTurn();
            else current.driver.setSourceEnabled(current.source.name, false);
        } finally { response.resolve(); }
        await work;

        expect(execute).toHaveBeenCalledTimes(0);
        expect(current.executeTool).not.toHaveBeenCalled();
        expect(current.release).toHaveBeenCalledTimes(1);
        expect(current.onRunError).not.toHaveBeenCalled();
        expect(model.doStreamCalls).toHaveLength(1);
        if (gate !== 'disable') {
            expect(current.onAssistantMessage).not.toHaveBeenCalled();
            expect(current.onToolResult).not.toHaveBeenCalled();
        } else {
            expect(current.onAssistantMessage).toHaveBeenCalledExactlyOnceWith(assistantMessage);
            expect(current.onToolResult).toHaveBeenCalledExactlyOnceWith({
                role: 'tool', content: [{ type: 'tool-result', toolCallId: 'owner-call', toolName: 'counter',
                    output: { type: 'error-json', value: { code: 'E_SOURCE_UNAVAILABLE', message: 'The driver or tool source is no longer active' } } }],
            }, expect.any(Array));
        }
    });

    it.each(['external success', 'external rejection', 'settles on abort'] as const)('closes the published tool turn once with a pending %s executor', async pending => {
        controlledModel(undefined, true, ['pending-call', 'queued-call']);
        const entered = barrier(), allowed = barrier(), saving = barrier(), saved = barrier();
        const managed = pending === 'settles on abort';
        const execute = vi.fn(async (_args: unknown, { toolCallId }: { toolCallId: string }) => {
            if (toolCallId === 'owner-call') return { output: ['already returned'], subcalls: ['original-receipt'] };
            entered.resolve();
            await allowed.promise;
            if (pending === 'external rejection') throw new Error('late executor error');
            return { output: ['pending result'] };
        });
        const current = turn(descriptor(execute), execute);
        if (managed) {
            const capture = current.source.getContext;
            current.source.getContext = async () => ({ ...await capture(), toolsSettlingOnAbort: new Set(['counter']) });
        }
        current.onToolResult.mockImplementation(async () => { saving.resolve(); await saved.promise; });
        const work = current.driver['run']();
        await entered.promise;
        let complete = false;
        const paired = current.driver.closeToolTurn().then(() => { complete = true; });
        try {
            if (managed) {
                expect(current.onToolResult).not.toHaveBeenCalled();
                allowed.resolve();
            }
            await saving.promise;
            expect(complete).toBe(false);
            const [message, results] = current.onToolResult.mock.calls[0];
            expect(message.content.map((item: { toolCallId: string }) => item.toolCallId)).toEqual(['owner-call', 'pending-call', 'queued-call']);
            expect(results.map((result: { result?: unknown; error?: { code: string } }) => result.result ?? result.error?.code)).toEqual([
                { output: ['already returned'], subcalls: ['original-receipt'] },
                managed ? { output: ['pending result'] } : 'E_TOOL_OUTCOME_UNKNOWN',
                'E_TOOL_NOT_DISPATCHED',
            ]);
            expect(current.executeTool).toHaveBeenCalledTimes(2);
            saved.resolve();
            await paired;
        } finally { allowed.resolve(); saved.resolve(); }
        await work;
        expect(current.onToolResult).toHaveBeenCalledTimes(1);
        expect(current.release).toHaveBeenCalledTimes(1);
    });

    it('reports a failed save when closing the published tool turn', async () => {
        controlledModel();
        const exec = vi.fn(async () => ({ ok: true }));
        const current = turn(descriptor(exec), exec);
        const error = new Error('tool message could not be saved');
        current.onToolResult.mockRejectedValueOnce(error);
        await current.driver['run']();
        await expect(current.driver.closeToolTurn()).rejects.toBe(error);
        expect(current.onRunError).toHaveBeenCalledExactlyOnceWith(error);
        expect(current.onToolResult).toHaveBeenCalledTimes(1);
    });

    it('saves a completed result even if closing interrupts the trial for budget feedback', async () => {
        controlledModel();
        const measuring = barrier(), measured = barrier();
        const measurement = { method: 'utf8-bytes' as const, inputBytes: 1, safety: 1, estimated: 2, inputLimit: 100, outputReserved: 10 };
        vi.spyOn(LLMClient.prototype, 'createInputMeasurement').mockResolvedValue(async () => measurement);
        const execute = vi.fn(async () => ({ ok: true }));
        const current = turn(descriptor(execute), execute, { ...config, inputBudget: () => ({ contextWindow: 110, maxOutputTokens: 10 }) });
        const retainFeedback = vi.fn(), capture = current.source.getContext;
        current.source.getContext = async () => ({ ...await capture(), async fitModelBudget(_, includeToolFeedback) {
            if (!includeToolFeedback) return { measurement };
            measuring.resolve();
            await measured.promise;
            return { measurement, feedback: { report_id: 'never saved' }, retainFeedback };
        } });
        const work = current.driver['run']();
        await measuring.promise;
        try {
            await current.driver.closeToolTurn();
            await work;
            expect(current.onToolResult).toHaveBeenCalledExactlyOnceWith({ role: 'tool', content: [
                { type: 'tool-result', toolCallId: 'owner-call', toolName: 'counter', output: { type: 'json', value: { ok: true } } },
            ] }, expect.any(Array));
            expect(current.release).toHaveBeenCalledTimes(1);
        } finally { measured.resolve(); }
        await vi.waitFor(() => expect(current.release).toHaveBeenCalledTimes(2));
        expect(retainFeedback).not.toHaveBeenCalled();
    });

    it('keeps a single effect and the existing unknown error mapping when execution throws', async () => {
        const model = controlledModel();
        let effects = 0;
        const execute = vi.fn(async () => { effects++; throw new Error('after-effect'); });
        const current = turn(descriptor(execute), execute);

        await current.driver['run']();

        expect(effects).toBe(1);
        expect(current.executeTool).toHaveBeenCalledExactlyOnceWith('counter', input, 'owner-call', undefined, expect.any(AbortSignal));
        expect(current.onAssistantMessage).toHaveBeenCalledExactlyOnceWith(assistantMessage);
        expect(current.onToolResult).toHaveBeenCalledExactlyOnceWith({
            role: 'tool', content: [{ type: 'tool-result', toolCallId: 'owner-call', toolName: 'counter',
                output: { type: 'error-json', value: { code: 'E_EXECUTION_ERROR', retryable: false,
                    message: 'after-effect The Tool call may have had effects. Check the application View before retrying.' } } }],
        }, expect.any(Array));
        expect(current.release).toHaveBeenCalledTimes(1);
        expect(current.driver.hasPendingUpdate()).toBe(false);
        expect(current.onRunError).not.toHaveBeenCalled();
        expect(model.doStreamCalls).toHaveLength(1);
    });

    it('keeps modelCapabilities.toolCall=false on the no-tools path', async () => {
        const model = controlledModel(undefined, false);
        const sdk = vi.mocked(ai.streamText);
        const execute = vi.fn();
        const response = await new LLMClient({ ...config, modelCapabilities: { toolCall: false } }).call(
            [{ role: 'user', content: 'Only text.' }], { counter: descriptor(execute) },
        );

        expect(sdk.mock.calls[0][0].tools).toEqual({});
        expect(model.doStreamCalls[0].tools).toBeUndefined();
        expect(execute).not.toHaveBeenCalled();
        expect(response.toolCalls).toEqual([]);
        expect(response.assistantMessage?.content).toMatchObject([{ type: 'reasoning', text: 'Plan once.' }, { type: 'text', text: 'Run once.' }]);
    });

    it('releases the Context after a real provider failure without entering the executor', async () => {
        const failure = new Error('controlled provider unavailable');
        const model = new MockLanguageModelV3({ doStream: async () => { throw failure; } });
        vi.spyOn(LLMClient.prototype as any, 'createProvider').mockReturnValue(model);
        const execute = vi.fn();
        const current = turn(descriptor(execute), execute);

        await current.driver['run']();

        expect(current.onRunError).toHaveBeenCalledExactlyOnceWith(failure);
        expect(current.release).toHaveBeenCalledTimes(1);
        expect(execute).not.toHaveBeenCalled();
        expect(current.executeTool).not.toHaveBeenCalled();
        expect(current.onAssistantMessage).not.toHaveBeenCalled();
        expect(current.onToolResult).not.toHaveBeenCalled();
        expect(model.doStreamCalls).toHaveLength(1);
    });

    it.each([
        { kind: 'bare EOF', dispatches: false },
        { kind: 'explicit provider reason', dispatches: true },
        { kind: 'independent DONE split across chunks', dispatches: true },
        { kind: 'independent DONE ending with CR', dispatches: true },
        { kind: 'literal, comment and unterminated DONE', dispatches: false },
    ])('checks compatible tool completion for $kind', async ({ kind, dispatches }) => {
        const chunk = (delta: object, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'fixture',
            model: config.model, created: 1, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
        const fetch = vi.fn(async (url: unknown) => {
            expect(String(url)).toBe('https://fixture.invalid/v1/chat/completions');
            const tool = { id: 'owner-call', index: 0, type: 'function',
                function: { name: 'counter', arguments: JSON.stringify(input) } };
            const frames = [chunk({ tool_calls: [tool] }, null)];
            if (kind === 'explicit provider reason') frames.push(chunk({}, 'provider-specific-finish'));
            if (kind === 'independent DONE split across chunks') frames.push('data: [DO', 'NE]\r', '\n\r', '\n');
            if (kind === 'independent DONE ending with CR') frames.push('data: [DONE]\r', '\r');
            if (kind === 'literal, comment and unterminated DONE') {
                frames.push(chunk({ content: 'Literal [DONE]' }, null), ': [DONE]\n\n', 'data: [DONE]\r');
            }
            const stream = new ReadableStream({
                pull(controller) {
                    const frame = frames.shift();
                    if (frame === undefined) controller.close();
                    else controller.enqueue(new TextEncoder().encode(frame));
                },
            });
            return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        });
        vi.stubGlobal('fetch', fetch);
        const execute = vi.fn(async () => ({ ok: true }));
        const current = turn(descriptor(execute), execute,
            { ...config, provider: { id: 'compatible-owner', baseURL: 'https://fixture.invalid/v1' } });

        await current.driver.trigger();
        await current.driver['runInFlight'];

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(current.release).toHaveBeenCalledTimes(1);
        expect(current.executeTool).toHaveBeenCalledTimes(Number(dispatches));
        expect(current.onAssistantMessage).toHaveBeenCalledTimes(Number(dispatches));
        expect(current.onToolResult).toHaveBeenCalledTimes(Number(dispatches));
        if (dispatches) expect(current.onRunError).not.toHaveBeenCalled();
        else expect(current.onRunError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            message: expect.stringContaining('without a termination signal'),
        }));
    });
});
