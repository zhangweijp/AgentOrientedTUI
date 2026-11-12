/**
 * @aotui/agent-driver-v2 - AgentDriver V2 Tests
 * 
 * 验证核心功能：
 * - 消息聚合和时间戳排序
 * - 工具收集
 * - ToolCall 路由
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { jsonSchema, type Tool } from 'ai';
import { LLMClient } from '../../src/core/llm-client.js';
import { AgentDriverV2 } from '../../src/core/agent-driver-v2.js';
import type { AgentDriverV2Config, ContextDrivenSource, DrivenSourceContext, LLMResponse, MessageWithTimestamp, ToolResult } from '../../src/core/interfaces.js';


const drivers = new Set<AgentDriverV2>();
function createDriver(config: AgentDriverV2Config): AgentDriverV2 {
    const driver = new AgentDriverV2(config);
    drivers.add(driver);
    return driver;
}

async function runTurn(driver: AgentDriverV2): Promise<void> {
    const requested = driver.trigger();
    const work = driver['runInFlight'];
    expect(work).not.toBeNull();
    await requested;
    await work; // Includes finally/release, unlike the first idle notification.
}

function response(toolCalls: LLMResponse['toolCalls'] = []): LLMResponse {
    return { text: toolCalls.length ? '' : 'ok', toolCalls, finishReason: toolCalls.length ? 'tool-calls' : 'stop',
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
        assistantMessage: { role: 'assistant', content: toolCalls.length
            ? toolCalls.map(call => ({ type: 'tool-call' as const, toolCallId: call.toolCallId, toolName: call.toolName, input: call.args }))
            : 'ok' },
    };
}

function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

afterEach(async () => {
    for (const driver of drivers) driver.stop();
    if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
    for (const driver of drivers) { await driver['runInFlight']; driver.dispose(); }
    drivers.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// Mock DrivenSource
class MockDrivenSource implements ContextDrivenSource {
    name: string;
    private messages: MessageWithTimestamp[];
    private tools: Record<string, any>;
    private updateCallback: (() => void) | null = null;

    constructor(name: string, messages: MessageWithTimestamp[] = [], tools: Record<string, any> = {}) {
        this.name = name;
        this.messages = messages;
        this.tools = tools;
    }

    async getContext(): Promise<DrivenSourceContext> {
        return { messages: this.messages, tools: this.tools, executeTool: this.invoke };
    }

    readonly invoke = vi.fn(async (toolName: string, args: unknown, toolCallId: string): Promise<ToolResult | undefined> => {
        if (!this.tools[toolName]) return undefined;
        return { toolCallId, toolName, result: { success: true, data: args } };
    });

    onUpdate(callback: () => void): () => void {
        this.updateCallback = callback;
        return () => {
            this.updateCallback = null;
        };
    }

    triggerUpdate(): void {
        this.updateCallback?.();
    }
}

describe('AgentDriverV2', () => {
    let driver: AgentDriverV2;
    let source1: MockDrivenSource;
    let source2: MockDrivenSource;
    let model: MockInstance<LLMClient['call']>;
    let onToolResult: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        model = vi.spyOn(LLMClient.prototype, 'call').mockResolvedValue(response());
        onToolResult = vi.fn();
        source1 = new MockDrivenSource(
            'Source1',
            [
                { role: 'user', content: [{ type: 'text', text: 'Message 1' }], timestamp: 100 },
                { role: 'user', content: [{ type: 'text', text: 'Message 3' }], timestamp: 300 },
            ],
            { tool1: { type: 'function', description: 'Tool 1', parameters: { type: 'object', properties: {} } } }
        );

        source2 = new MockDrivenSource(
            'Source2',
            [
                { role: 'user', content: [{ type: 'text', text: 'Message 2' }], timestamp: 200 },
                { role: 'user', content: [{ type: 'text', text: 'Message 4' }], timestamp: 400 },
            ],
            { tool2: { type: 'function', description: 'Tool 2', parameters: { type: 'object', properties: {} } } }
        );

        driver = createDriver({
            sources: [source1, source2],
            llm: {
                model: 'gpt-4',
            },
            workLoop: {
                debounceMs: 10,
            },
            onToolResult,
        });
    });

    it('应该正确聚合来自多个源的消息', async () => {
        await runTurn(driver);
        const messages = model.mock.calls[0][0];

        expect(messages).toHaveLength(4);
    });

    it('应该按时间戳排序消息', async () => {
        await runTurn(driver);
        const messages = model.mock.calls[0][0];

        expect((messages[0].content as any)[0].text).toBe('Message 1');
        expect((messages[1].content as any)[0].text).toBe('Message 2');
        expect((messages[2].content as any)[0].text).toBe('Message 3');
        expect((messages[3].content as any)[0].text).toBe('Message 4');
    });

    it('应该移除时间戳字段返回纯 CoreMessage', async () => {
        await runTurn(driver);
        const messages = model.mock.calls[0][0];

        messages.forEach((message) => {
            expect(message).not.toHaveProperty('timestamp');
        });
    });

    it('应该按 region 优先级组装上下文，并把最新执行尾巴放到底部', async () => {
        source1 = new MockDrivenSource(
            'StaticSource',
            [
                { role: 'user', content: [{ type: 'text', text: 'dynamic-view' }], timestamp: 50, region: 'dynamic' as const },
                { role: 'user', content: [{ type: 'text', text: 'static-msg' }], timestamp: 100, region: 'static' as const },
            ],
        );

        source2 = new MockDrivenSource(
            'SessionSource',
            [
                { role: 'user', content: [{ type: 'text', text: 'session-old' }], timestamp: 75, region: 'session' as const },
                {
                    role: 'assistant',
                    content: [{ type: 'tool-call', toolCallId: 'tc_tail', toolName: 'tool_tail', input: {} }],
                    timestamp: 120,
                    region: 'session' as const,
                } as any,
                {
                    role: 'tool',
                    content: [{ type: 'tool-result', toolCallId: 'tc_tail', toolName: 'tool_tail', output: { type: 'json', value: { ok: true } } }],
                    timestamp: 121,
                    region: 'session' as const,
                } as any,
            ],
        );

        const localDriver = createDriver({
            sources: [source1, source2],
            llm: { model: 'gpt-4' },
            workLoop: { debounceMs: 10 },
        });

        await runTurn(localDriver);
        const messages = model.mock.calls[0][0];
        localDriver.stop();
        localDriver.dispose();

        expect((messages[0].content as any)[0].text).toBe('static-msg');
        expect((messages[1].content as any)[0].text).toBe('session-old');
        expect((messages[2].content as any)[0].text).toBe('dynamic-view');
        expect(((messages[3].content as any[])[0]).toolName).toBe('tool_tail');
        expect(((messages[4].content as any[])[0]).toolName).toBe('tool_tail');
    });

    it('应该丢弃没有前置 assistant tool-call 的孤儿 tool message', async () => {
        source1 = new MockDrivenSource(
            'Source1',
            [
                {
                    role: 'assistant',
                    content: [{ type: 'tool-call', toolCallId: 'tc_1', toolName: 'tool1', input: {} }],
                    timestamp: 100,
                } as any,
                {
                    role: 'tool',
                    content: [{ type: 'tool-result', toolCallId: 'tc_1', toolName: 'tool1', output: { type: 'json', value: { ok: true } } }],
                    timestamp: 110,
                } as any,
                {
                    role: 'tool',
                    content: [{ type: 'tool-result', toolCallId: 'tc_orphan', toolName: 'tool1', output: { type: 'json', value: { ok: true } } }],
                    timestamp: 120,
                } as any,
            ],
            { tool1: { type: 'function', description: 'Tool 1', parameters: { type: 'object', properties: {} } } }
        );

        const localDriver = createDriver({
            sources: [source1],
            llm: { model: 'gpt-4' },
            workLoop: { debounceMs: 10 },
        });

        await runTurn(localDriver);
        const messages = model.mock.calls[0][0];
        localDriver.stop();
        localDriver.dispose();

        const toolMessages = messages.filter((m) => m.role === 'tool');
        expect(toolMessages).toHaveLength(1);
        expect((toolMessages[0].content as any[])[0].toolCallId).toBe('tc_1');
    });

    it('应该在混合 tool-result 时仅保留与前置 tool-call 匹配的结果', async () => {
        source1 = new MockDrivenSource(
            'Source1',
            [
                {
                    role: 'assistant',
                    content: [{ type: 'tool-call', toolCallId: 'tc_1', toolName: 'tool1', input: {} }],
                    timestamp: 100,
                } as any,
                {
                    role: 'tool',
                    content: [
                        { type: 'tool-result', toolCallId: 'tc_1', toolName: 'tool1', output: { type: 'json', value: { ok: true } } },
                        { type: 'tool-result', toolCallId: 'tc_orphan', toolName: 'tool1', output: { type: 'json', value: { ok: false } } },
                    ],
                    timestamp: 110,
                } as any,
            ],
            { tool1: { type: 'function', description: 'Tool 1', parameters: { type: 'object', properties: {} } } }
        );

        const localDriver = createDriver({
            sources: [source1],
            llm: { model: 'gpt-4' },
            workLoop: { debounceMs: 10 },
        });

        await runTurn(localDriver);
        const messages = model.mock.calls[0][0];
        localDriver.stop();
        localDriver.dispose();

        const toolMessages = messages.filter((m) => m.role === 'tool');
        expect(toolMessages).toHaveLength(1);
        expect((toolMessages[0].content as any[])).toHaveLength(1);
        expect((toolMessages[0].content as any[])[0].toolCallId).toBe('tc_1');
    });

    it('应该正确聚合工具', async () => {
        await runTurn(driver);
        const tools = model.mock.calls[0][1];

        expect(tools).toHaveProperty('tool1');
        expect(tools).toHaveProperty('tool2');
        expect(Object.keys(tools)).toHaveLength(2);
    });

    it('应该将 ToolCall 路由到正确的 DrivenSource', async () => {
        const first = source1.invoke, second = source2.invoke;
        const captureFirst = vi.spyOn(source1, 'getContext'), captureSecond = vi.spyOn(source2, 'getContext');
        const toolCalls = [
            { toolCallId: '1', toolName: 'tool1', args: { foo: 'bar' } },
            { toolCallId: '2', toolName: 'tool2', args: { baz: 'qux' } },
        ];
        model.mockResolvedValueOnce(response(toolCalls));
        await runTurn(driver);
        const results = onToolResult.mock.calls[0][0].content;

        expect(results).toHaveLength(2);
        expect(results[0].toolName).toBe('tool1');
        expect(results[0].output.value).toEqual({ success: true, data: { foo: 'bar' } });
        expect(results[1].toolName).toBe('tool2');
        expect(results[1].output.value).toEqual({ success: true, data: { baz: 'qux' } });
        expect(first).toHaveBeenCalledExactlyOnceWith('tool1', { foo: 'bar' }, '1');
        expect(second).toHaveBeenCalledExactlyOnceWith('tool2', { baz: 'qux' }, '2');
        expect(first.mock.contexts[0]).toBe(await captureFirst.mock.results[0].value);
        expect(second.mock.contexts[0]).toBe(await captureSecond.mock.results[0].value);
        expect(driver.getToolSource('tool1')).toBe(source1);
        expect(driver.getToolSource('tool2')).toBe(source2);
        expect(onToolResult).toHaveBeenCalledExactlyOnceWith({ role: 'tool', content: [
            { type: 'tool-result', toolCallId: '1', toolName: 'tool1', output: { type: 'json', value: { success: true, data: { foo: 'bar' } } } },
            { type: 'tool-result', toolCallId: '2', toolName: 'tool2', output: { type: 'json', value: { success: true, data: { baz: 'qux' } } } },
        ] });
    });

    it('应该处理工具未找到的情况', async () => {
        model.mockResolvedValueOnce(response([{ toolCallId: '1', toolName: 'nonExistentTool', args: {} }]));
        await runTurn(driver);
        const results = onToolResult.mock.calls[0][0].content;

        expect(results).toHaveLength(1);
        expect(results[0].output.value).toBeDefined();
        expect(results[0].output.value.code).toBe('E_TOOL_NOT_FOUND');
        expect(onToolResult).toHaveBeenCalledExactlyOnceWith({ role: 'tool', content: [
            { type: 'tool-result', toolCallId: '1', toolName: 'nonExistentTool', output: { type: 'error-json', value: {
                code: 'E_TOOL_NOT_FOUND', message: 'No DrivenSource can execute tool: nonExistentTool',
            } } },
        ] });
    });

    it.skip('应该监听更新信号', async () => {
        vi.useFakeTimers();

        // Create a dedicated driver instance for this test to ensure timers are faked
        const localDriver = createDriver({
            sources: [source1],
            llm: { model: 'gpt-4' },
            workLoop: { debounceMs: 10 },
        });

        const promise = new Promise<void>((resolve) => {
            const runSpy = vi.spyOn(localDriver as any, 'run');
            runSpy.mockImplementation(async () => {
                resolve();
            });
        });

        // Trigger update
        source1.triggerUpdate();

        // Advance time
        vi.advanceTimersByTime(300);

        await promise;

        localDriver.stop();
        vi.useRealTimers();
    });

    it('应该正确清理资源', () => {
        const unsubscribeSpy = vi.fn();
        source1.onUpdate = vi.fn(() => unsubscribeSpy);

        const newDriver = createDriver({
            sources: [source1],
            llm: { model: 'gpt-4' },
        });

        newDriver.dispose();

        expect(unsubscribeSpy).toHaveBeenCalled();
    });

    describe('captured contexts and per-turn routes', () => {
        const schema = jsonSchema({ type: 'object', properties: { value: { type: 'number' } } });
        const tool: Tool = Object.freeze({ description: 'Controlled tool', inputSchema: schema });
        const messages = [{ role: 'user' as const, content: 'controlled turn', timestamp: 1 }];
        const contextSource = (name: string, context: DrivenSourceContext): ContextDrivenSource => ({
            name, getContext: vi.fn(async () => context), onUpdate: () => () => {},
        });

        it('captures each context once in source order, ignores legacy methods and retains original tool/Schema references', async () => {
            let released = false;
            const context: DrivenSourceContext = { messages, tools: { atomic: tool },
                release: vi.fn(async () => { await Promise.resolve(); released = true; }) };
            const atomic = {
                name: 'atomic', getContext: vi.fn(async () => context),
                getMessages: vi.fn(async () => { throw new Error('legacy messages must not run'); }), getTools: vi.fn(async () => { throw new Error('legacy tools must not run'); }),
                executeTool: vi.fn(), onUpdate: () => () => {},
            };
            const split = new MockDrivenSource('split', [{ role: 'user', content: 'split', timestamp: 2 }], { split: tool });
            const readContext = vi.spyOn(split, 'getContext');
            const localDriver = createDriver({ sources: [atomic, split], llm: { model: 'gpt-4' } });

            await runTurn(localDriver);

            expect(atomic.getContext).toHaveBeenCalledTimes(1);
            expect(atomic.getMessages).not.toHaveBeenCalled();
            expect(atomic.getTools).not.toHaveBeenCalled();
            expect(readContext).toHaveBeenCalledTimes(1);
            expect(atomic.getContext.mock.invocationCallOrder[0]).toBeLessThan(readContext.mock.invocationCallOrder[0]);
            expect(model).toHaveBeenCalledTimes(1);
            expect(model.mock.calls[0][0]).toEqual([{ role: 'user', content: 'controlled turn' }, { role: 'user', content: 'split' }]);
            expect(model.mock.calls[0][1].atomic).toBe(tool);
            expect(model.mock.calls[0][1].split).toBe(tool);
            expect(model.mock.calls[0][1].atomic.inputSchema).toBe(schema);
            expect(localDriver.getToolSource('atomic')).toBe(atomic);
            expect(localDriver.getToolSource('split')).toBe(split);
            expect(readContext).toHaveBeenCalledTimes(1); // Public lookup does not recapture.
            expect(context.release).toHaveBeenCalledTimes(1);
            expect(released).toBe(true);
        });

        it('continues after a source returns its own degraded empty context', async () => {
            const bad = contextSource('degraded', { messages: [], tools: {} });
            const release = vi.fn();
            const healthy = contextSource('healthy', { messages, tools: { healthy: tool }, release });
            const onRunError = vi.fn();
            const localDriver = createDriver({ sources: [bad, healthy], llm: { model: 'gpt-4' }, onRunError });
            await runTurn(localDriver);
            expect(bad.getContext).toHaveBeenCalledTimes(1);
            expect(model).toHaveBeenCalledTimes(1);
            expect(model.mock.calls[0][0]).toEqual([{ role: 'user', content: 'controlled turn' }]);
            expect(model.mock.calls[0][1]).toEqual({ healthy: tool });
            expect(localDriver.getToolSource('bad')).toBeUndefined();
            expect(localDriver.getToolSource('healthy')).toBe(healthy);
            expect(release).toHaveBeenCalledTimes(1);
            expect(onRunError).not.toHaveBeenCalled();
        });

        it('does not fall back to split reads after atomic capture fails, and releases previous captures', async () => {
            const release = vi.fn(), failure = new Error('atomic failed');
            const earlier = contextSource('earlier', { messages, tools: {}, release });
            const failed = {
                name: 'failed', getContext: vi.fn().mockRejectedValue(failure),
                getMessages: vi.fn(async () => messages), getTools: vi.fn(async () => ({ ignored: tool })),
                executeTool: vi.fn(), onUpdate: () => () => {},
            };
            const later = contextSource('later', { messages, tools: {} });
            const onRunError = vi.fn();
            const localDriver = createDriver({ sources: [earlier, failed, later], llm: { model: 'gpt-4' }, onRunError });

            await runTurn(localDriver);

            expect(failed.getContext).toHaveBeenCalledTimes(1);
            expect(failed.getMessages).not.toHaveBeenCalled();
            expect(failed.getTools).not.toHaveBeenCalled();
            expect(later.getContext).not.toHaveBeenCalled();
            expect(model).not.toHaveBeenCalled();
            expect(onRunError).toHaveBeenCalledExactlyOnceWith(failure);
            expect(release).toHaveBeenCalledTimes(1);
        });

        it('keeps the captured winner, sends a changed tool definition and preserves routes on capture failure', async () => {
            const firstExecute = vi.fn(async (toolName: string, args: unknown, toolCallId: string) => ({ toolName, toolCallId, result: { first: args } }));
            const secondExecute = vi.fn(async (toolName: string, args: unknown, toolCallId: string) => ({ toolName, toolCallId, result: { second: args } }));
            const firstContext: DrivenSourceContext = { messages, tools: { shared: tool }, executeTool: firstExecute, release: vi.fn() };
            const winner = Object.freeze({ ...tool, description: 'Last source wins' });
            const secondContext: DrivenSourceContext = { messages: [], tools: { shared: winner }, executeTool: secondExecute, release: vi.fn() };
            const first = contextSource('first', firstContext), second = contextSource('second', secondContext);
            const result = vi.fn(), onRunError = vi.fn();
            const localDriver = createDriver({ sources: [first, second], llm: { model: 'gpt-4' }, onToolResult: result, onRunError });
            model.mockImplementationOnce(async (_messages, tools, callbacks) => {
                await callbacks?.beforeRequest?.('winner definition');
                expect(tools.shared).toBe(winner);
                expect(localDriver.getToolSource('shared')).toBe(second);
                // A later capture would differ; this turn must still use its captured route.
                secondContext.tools = {};
                return response([{ toolCallId: 'winner-call', toolName: 'shared', args: { value: 7 } }]);
            });

            await runTurn(localDriver);

            expect(firstExecute).not.toHaveBeenCalled();
            expect(secondExecute).toHaveBeenCalledExactlyOnceWith('shared', { value: 7 }, 'winner-call');
            expect(secondExecute.mock.contexts[0]).toBe(secondContext);
            expect(result).toHaveBeenCalledExactlyOnceWith({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'winner-call', toolName: 'shared',
                output: { type: 'json', value: { second: { value: 7 } } } }] });
            model.mockImplementationOnce(async (_messages, tools, callbacks) => {
                expect(tools.shared).toBe(tool);
                await callbacks?.beforeRequest?.('first definition');
                return response();
            });
            await runTurn(localDriver);
            expect(model).toHaveBeenCalledTimes(2);
            expect(localDriver.getToolSource('shared')).toBe(first);
            expect(first.getContext).toHaveBeenCalledTimes(2);
            expect(second.getContext).toHaveBeenCalledTimes(2);
            expect(firstContext.release).toHaveBeenCalledTimes(2);
            expect(secondContext.release).toHaveBeenCalledTimes(2);
            const failure = new Error('next capture failed');
            vi.mocked(second.getContext).mockRejectedValueOnce(failure);
            await runTurn(localDriver);
            expect(localDriver.getToolSource('shared')).toBe(first);
            expect(onRunError).toHaveBeenCalledExactlyOnceWith(failure);
            expect(model).toHaveBeenCalledTimes(2);
            expect(firstContext.release).toHaveBeenCalledTimes(3);
            expect(secondContext.release).toHaveBeenCalledTimes(2);
        });

        it.each(['context', 'late-source', 'missing', 'undefined'] as const)('preserves executor selection and full results: %s', async mode => {
            const execute = vi.fn(async (toolName: string, args: unknown, toolCallId: string): Promise<ToolResult | undefined> =>
                mode === 'undefined' ? undefined : { toolName, toolCallId, result: { mode, args } });
            const fallback = vi.fn(async () => undefined);
            const context: DrivenSourceContext = { messages, tools: { counter: tool }, release: vi.fn(),
                ...(mode === 'context' || mode === 'undefined' ? { executeTool: execute } : {}) };
            const source = contextSource('selection', context);
            if (mode === 'context') Reflect.set(source, 'executeTool', fallback);
            const result = vi.fn();
            const localDriver = createDriver({ sources: [source], llm: { model: 'gpt-4' }, onToolResult: result });
            model.mockImplementationOnce(async () => {
                // A later Source executor must never replace a missing Context executor.
                if (mode === 'late-source') Reflect.set(source, 'executeTool', execute);
                return response([{ toolCallId: 'selection-call', toolName: 'counter', args: { value: 9 } }]);
            });

            await runTurn(localDriver);

            expect(execute).toHaveBeenCalledTimes(mode === 'missing' || mode === 'late-source' ? 0 : 1);
            expect(fallback).not.toHaveBeenCalled();
            if (mode !== 'missing' && mode !== 'late-source') {
                expect(execute).toHaveBeenCalledWith('counter', { value: 9 }, 'selection-call');
                expect(execute.mock.contexts[0]).toBe(context);
            }
            const output = mode === 'missing' || mode === 'late-source' ? { type: 'error-json', value: { code: 'E_SOURCE_UNAVAILABLE', message: 'The captured context has no executor for this tool.' } }
                : mode === 'undefined' ? { type: 'error-json', value: { code: 'E_TOOL_NOT_FOUND', message: 'Tool counter not found' } }
                : { type: 'json', value: { mode, args: { value: 9 } } };
            expect(result).toHaveBeenCalledExactlyOnceWith({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'selection-call', toolName: 'counter', output }] });
            expect(context.release).toHaveBeenCalledTimes(1);
            expect(localDriver.getToolSource('counter')).toBe(source);
        });

        it.each(['stop', 'disable'] as const)('rechecks the %s gate for the second call after the first executor entered', async mode => {
            vi.useFakeTimers();
            const entered = barrier(), proceed = barrier(), releases: string[] = [];
            let localDriver!: AgentDriverV2;
            const secondExecute = vi.fn();
            const second = contextSource('second-gated', { messages: [], tools: { second: tool }, executeTool: secondExecute,
                release: () => { releases.push('second'); } });
            const firstExecute = vi.fn(async (toolName: string, _args: unknown, toolCallId: string) => {
                entered.resolve();
                await proceed.promise;
                if (mode === 'stop') localDriver.stop();
                else localDriver.setSourceEnabled(second.name, false);
                return { toolName, toolCallId, result: { first: 'done' } };
            });
            const first = contextSource('first-gated', { messages, tools: { first: tool }, executeTool: firstExecute,
                release: () => { releases.push('first'); } });
            const calls = [{ toolCallId: 'gate-1', toolName: 'first', args: {} }, { toolCallId: 'gate-2', toolName: 'second', args: {} }];
            model.mockResolvedValueOnce(response(calls));
            const result = vi.fn(), assistant = vi.fn();
            localDriver = createDriver({ sources: [first, second], llm: { model: 'gpt-4' }, onToolResult: result, onAssistantMessage: assistant });
            const work = runTurn(localDriver);
            try {
                await entered.promise;
                expect(localDriver.getToolSource('second')).toBe(second);
            } finally { proceed.resolve(); }
            await work;

            expect(firstExecute).toHaveBeenCalledExactlyOnceWith('first', {}, 'gate-1');
            expect(secondExecute).not.toHaveBeenCalled();
            expect(assistant).toHaveBeenCalledExactlyOnceWith(response(calls).assistantMessage);
            expect(result).toHaveBeenCalledExactlyOnceWith({ role: 'tool', content: [
                { type: 'tool-result', toolCallId: 'gate-1', toolName: 'first', output: { type: 'json', value: { first: 'done' } } },
                { type: 'tool-result', toolCallId: 'gate-2', toolName: 'second', output: { type: 'error-json', value: {
                    code: 'E_SOURCE_UNAVAILABLE', message: 'The driver or tool source is no longer active',
                } } },
            ] });
            expect(releases).toEqual(['second', 'first']);
            expect(model).toHaveBeenCalledTimes(1);
        });
    });
});
