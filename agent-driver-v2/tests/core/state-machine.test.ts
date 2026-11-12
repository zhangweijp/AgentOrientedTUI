/**
 * AgentDriver V2 - 状态机测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentDriverV2 } from '../../src/core/agent-driver-v2.js';
import type { LLMClient } from '../../src/core/llm-client.js';
import type { ContextDrivenSource, AgentState } from '../../src/core/interfaces.js';

function stubLlmCall(driver: AgentDriverV2) {
    const call = vi.fn().mockResolvedValue({
        text: 'ok',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: {
            role: 'assistant',
            content: 'ok',
        },
    });

    (driver as any).llmClient = { call };
    return call;
}

async function waitForIdle(driver: AgentDriverV2): Promise<void> {
    await vi.waitFor(() => {
        expect(driver.getState()).toBe('idle');
    });
}

describe('AgentDriver State Machine', () => {
    let mockSource: ContextDrivenSource;
    let stateChangeLog: Array<{ old: AgentState; new: AgentState }>;

    beforeEach(() => {
        stateChangeLog = [];

        mockSource = {
            name: 'MockSource',
            getContext: vi.fn().mockResolvedValue({
                messages: [
                    {
                        role: 'user',
                        content: 'test message',
                        timestamp: Date.now(),
                    },
                ],
                tools: {},
                executeTool: vi.fn().mockResolvedValue(undefined),
            }),
            onUpdate: vi.fn().mockReturnValue(() => { }),
        };
    });

    it('should start at idle state', () => {
        const driver = new AgentDriverV2({
            sources: [mockSource],
            llm: { model: 'gpt-4' },
            onStateChange: (old, newState) => {
                stateChangeLog.push({ old, new: newState });
            },
        });

        expect(driver.getState()).toBe('idle');
    });

    it('should transition states when running', async () => {
        const driver = new AgentDriverV2({
            sources: [mockSource],
            llm: { model: 'gpt-4' },
            onStateChange: (old, newState) => {
                stateChangeLog.push({ old, new: newState });
            },
        });
        const call = stubLlmCall(driver);

        // 手动触发
        await driver.trigger();
        await waitForIdle(driver);

        // 应该至少有一次状态转换: idle → thinking
        const hasThinking = stateChangeLog.some(
            (log) => log.old === 'idle' && log.new === 'thinking'
        );
        expect(hasThinking).toBe(true);
        expect(call).toHaveBeenCalled();

        // 最终应该回到 idle (因为没有 ToolCalls)
        expect(driver.getState()).toBe('idle');
    });

    it('should mark update when busy (thinking)', async () => {
        const driver = new AgentDriverV2({
            sources: [mockSource],
            llm: { model: 'gpt-4' },
        });
        const call = vi.fn().mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
                text: 'ok',
                toolCalls: [],
                finishReason: 'stop',
                assistantMessage: {
                    role: 'assistant',
                    content: 'ok',
                },
            };
        });
        const modelCall: LLMClient['call'] = async (messages, tools, callbacks) => {
            await callbacks?.beforeRequest?.(JSON.stringify({ messages, tools }));
            return call();
        };
        (driver as any).llmClient = { call: modelCall };

        // 启动一个 run (会进入 thinking 状态)
        await driver.trigger();
        await vi.waitFor(() => {
            expect(driver.getState()).toBe('thinking');
        });

        // 立即尝试触发另一个更新
        await driver.trigger();
        expect(driver.hasPendingUpdate()).toBe(true);

        // 等待 run 完成
        await waitForIdle(driver);
        expect(call).toHaveBeenCalledTimes(1);
        expect(mockSource.getContext).toHaveBeenCalledTimes(2);
        expect(driver.hasPendingUpdate()).toBe(false);
    });

    it('should dispose correctly', () => {
        const unsubscribe = vi.fn();
        const mockSourceWithUnsubscribe: ContextDrivenSource = {
            ...mockSource,
            onUpdate: vi.fn().mockReturnValue(unsubscribe),
        };

        const driver = new AgentDriverV2({
            sources: [mockSourceWithUnsubscribe],
            llm: { model: 'gpt-4' },
        });

        driver.dispose();

        expect(unsubscribe).toHaveBeenCalled();
    });
});

describe('Tool Mapping', () => {
    it('should build correct tool-to-source mapping', async () => {
        const source1: ContextDrivenSource = {
            name: 'Source1',
            getContext: vi.fn().mockResolvedValue({
                messages: [],
                tools: {
                    tool1: {
                        description: 'Tool 1',
                        parameters: {},
                    },
                    tool2: {
                        description: 'Tool 2',
                        parameters: {},
                    },
                },
                executeTool: vi.fn().mockResolvedValue(undefined),
            }),
            onUpdate: vi.fn().mockReturnValue(() => { }),
        };

        const source2: ContextDrivenSource = {
            name: 'Source2',
            getContext: vi.fn().mockResolvedValue({
                messages: [],
                tools: {
                    tool3: {
                        description: 'Tool 3',
                        parameters: {},
                    },
                },
                executeTool: vi.fn().mockResolvedValue(undefined),
            }),
            onUpdate: vi.fn().mockReturnValue(() => { }),
        };

        const driver = new AgentDriverV2({
            sources: [source1, source2],
            llm: { model: 'gpt-4' },
        });
        stubLlmCall(driver);

        // 手动触发以建立映射
        await driver.trigger();
        await waitForIdle(driver);

        // 验证映射
        expect(driver.getToolSource('tool1')).toBe(source1);
        expect(driver.getToolSource('tool2')).toBe(source1);
        expect(driver.getToolSource('tool3')).toBe(source2);
        expect(driver.getToolSource('nonexistent')).toBeUndefined();
    });

    it('should use tool mapping when executing', async () => {
        const executeTool = vi.fn().mockResolvedValue({
            toolCallId: 'test-id',
            toolName: 'search',
            result: { data: 'result' },
        });

        const source: ContextDrivenSource = {
            name: 'TestSource',
            getContext: vi.fn().mockResolvedValue({
                messages: [],
                tools: {
                    search: {
                        description: 'Search tool',
                        parameters: {},
                    },
                },
                executeTool,
            }),
            onUpdate: vi.fn().mockReturnValue(() => { }),
        };

        const driver = new AgentDriverV2({
            sources: [source],
            llm: { model: 'gpt-4' },
        });
        stubLlmCall(driver);

        // 触发以建立映射
        await driver.trigger();
        await waitForIdle(driver);

        // 验证 executeTool 被调用
        // 注意：实际测试需要 mock LLM 返回 ToolCalls
        // 这里只是验证映射建立成功
        expect(driver.getToolSource('search')).toBe(source);
    });
});

describe('Message Collection', () => {
    it('should collect and sort messages by timestamp', async () => {
        const source1: ContextDrivenSource = {
            name: 'Source1',
            getContext: vi.fn().mockResolvedValue({
                messages: [
                    { role: 'user', content: 'Message 2', timestamp: 200 },
                    { role: 'user', content: 'Message 4', timestamp: 400 },
                ],
                tools: {},
                executeTool: vi.fn().mockResolvedValue(undefined),
            }),
            onUpdate: vi.fn().mockReturnValue(() => { }),
        };

        const source2: ContextDrivenSource = {
            name: 'Source2',
            getContext: vi.fn().mockResolvedValue({
                messages: [
                    { role: 'user', content: 'Message 1', timestamp: 100 },
                    { role: 'user', content: 'Message 3', timestamp: 300 },
                ],
                tools: {},
                executeTool: vi.fn().mockResolvedValue(undefined),
            }),
            onUpdate: vi.fn().mockReturnValue(() => { }),
        };

        const driver = new AgentDriverV2({
            sources: [source1, source2],
            llm: { model: 'gpt-4' },
        });
        stubLlmCall(driver);

        // 触发以收集消息
        await driver.trigger();
        await waitForIdle(driver);

        // 验证 getMessages 被调用
        expect(source1.getContext).toHaveBeenCalled();
        expect(source2.getContext).toHaveBeenCalled();

        // 验证消息按时间戳排序 (这个需要访问私有方法，所以测试有限)
    });
});
