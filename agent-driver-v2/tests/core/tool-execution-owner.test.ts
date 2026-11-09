import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ai from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { AgentDriverV2 } from '../../src/core/agent-driver-v2.js';
import { LLMClient } from '../../src/core/llm-client.js';
import type { ContextDrivenSource } from '../../src/core/interfaces.js';

// Native ESM exports cannot be spied on directly. Record calls while delegating
// every invocation to the real installed streamText implementation.
vi.mock('ai', async importOriginal => {
    const actual = await importOriginal<typeof import('ai')>();
    return { ...actual, streamText: vi.fn(actual.streamText) };
});

const drivers: AgentDriverV2[] = [];
const config = { model: 'openai:controlled-owner', apiKey: 'unused-no-network' };
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
    vi.restoreAllMocks();
});

function controlledModel(beforeResponse = async () => {}, toolCall = true) {
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
            ...(toolCall ? [{ type: 'tool-call' as const, toolCallId: 'owner-call', toolName: 'counter', input: JSON.stringify(input) }] : []),
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

function turn(tool: ai.Tool, execute: NonNullable<ai.Tool['execute']>) {
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
    const driver = new AgentDriverV2({ sources: [source], llm: config, onAssistantMessage, onToolResult, onRunError });
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
        for (const key of Object.keys(forwarded)) expect(Reflect.get(forwarded, key)).toBe(Reflect.get(original, key));
        expect(forwarded.inputSchema).toBe(inputSchema);
        expect(tools.counter).toBe(original);
        expect(original.execute).toBe(execute);
        expect(Object.isFrozen(original)).toBe(true);
        expect(response).toEqual({
            text: 'Run once.', toolCalls: [{ toolCallId: 'owner-call', toolName: 'counter', args: input }],
            finishReason: 'tool-calls', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 8 },
            assistantMessage,
        });
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
        expect(current.executeTool).toHaveBeenCalledExactlyOnceWith('counter', input, 'owner-call');
        expect(current.onAssistantMessage).toHaveBeenCalledExactlyOnceWith(assistantMessage);
        expect(current.onToolResult).toHaveBeenCalledExactlyOnceWith({
            role: 'tool', content: [{ type: 'tool-result', toolCallId: 'owner-call', toolName: 'counter',
                output: { type: 'json', value: { count: 1, args: input } } }],
        });
        expect(current.release).toHaveBeenCalledTimes(1);
        expect(current.release.mock.invocationCallOrder[0]).toBeGreaterThan(current.onToolResult.mock.invocationCallOrder[0]);
        expect(current.onRunError).not.toHaveBeenCalled();
        expect(model.doStreamCalls).toHaveLength(1);
        expect(tool.execute).toBe(hasExecute ? execute : undefined);
        expect(current.driver.hasPendingUpdate()).toBe(false);
    });

    it.each(['stop', 'disable'] as const)('does not bypass the Driver %s gate on a late provider response', async gate => {
        if (gate === 'disable') vi.useFakeTimers();
        const started = barrier(), response = barrier();
        const model = controlledModel(async () => { started.resolve(); await response.promise; });
        const execute = vi.fn(async () => ({ ok: true }));
        const current = turn(descriptor(execute), execute);
        const work = current.driver['run']();
        try {
            await started.promise;
            if (gate === 'stop') current.driver.stop();
            else current.driver.setSourceEnabled(current.source.name, false);
        } finally { response.resolve(); }
        await work;

        expect(execute).toHaveBeenCalledTimes(0);
        expect(current.executeTool).not.toHaveBeenCalled();
        expect(current.release).toHaveBeenCalledTimes(1);
        expect(current.onRunError).not.toHaveBeenCalled();
        expect(model.doStreamCalls).toHaveLength(1);
        if (gate === 'stop') {
            expect(current.onAssistantMessage).not.toHaveBeenCalled();
            expect(current.onToolResult).not.toHaveBeenCalled();
        } else {
            expect(current.onAssistantMessage).toHaveBeenCalledExactlyOnceWith(assistantMessage);
            expect(current.onToolResult).toHaveBeenCalledExactlyOnceWith({
                role: 'tool', content: [{ type: 'tool-result', toolCallId: 'owner-call', toolName: 'counter',
                    output: { type: 'error-json', value: { code: 'E_SOURCE_UNAVAILABLE', message: 'The driver or tool source is no longer active' } } }],
            });
        }
    });

    it('keeps a single effect and the existing unknown error mapping when execution throws', async () => {
        const model = controlledModel();
        let effects = 0;
        const execute = vi.fn(async () => { effects++; throw new Error('after-effect'); });
        const current = turn(descriptor(execute), execute);

        await current.driver['run']();

        expect(effects).toBe(1);
        expect(current.executeTool).toHaveBeenCalledExactlyOnceWith('counter', input, 'owner-call');
        expect(current.onAssistantMessage).toHaveBeenCalledExactlyOnceWith(assistantMessage);
        expect(current.onToolResult).toHaveBeenCalledExactlyOnceWith({
            role: 'tool', content: [{ type: 'tool-result', toolCallId: 'owner-call', toolName: 'counter',
                output: { type: 'error-json', value: { code: 'E_EXECUTION_ERROR', retryable: false,
                    message: 'after-effect The Tool call may have had effects. Check the application View before retrying.' } } }],
        });
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
        expect(response.text).toBe('Run once.');
        expect(response.finishReason).toBe('stop');
    });

    it('releases the Context after a real provider failure without entering the executor', async () => {
        const failure = new Error('controlled provider unavailable');
        const model = new MockLanguageModelV3({ doStream: async () => { throw failure; } });
        vi.spyOn(LLMClient.prototype as any, 'createProvider').mockReturnValue(model);
        const execute = vi.fn();
        const current = turn(descriptor(execute), execute);

        await current.driver['run']();

        expect(current.onRunError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            name: 'AI_NoOutputGeneratedError', message: 'No output generated. Check the stream for errors.',
        }));
        expect(current.release).toHaveBeenCalledTimes(1);
        expect(execute).not.toHaveBeenCalled();
        expect(current.executeTool).not.toHaveBeenCalled();
        expect(current.onAssistantMessage).not.toHaveBeenCalled();
        expect(current.onToolResult).not.toHaveBeenCalled();
        expect(model.doStreamCalls).toHaveLength(1);
    });
});
