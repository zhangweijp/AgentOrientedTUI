import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDriverV2 } from '../../src/core/agent-driver-v2.js';
import { jsonSchema } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { LLMClient } from '../../src/core/llm-client.js';
import type { ContextDrivenSource, DrivenSourceContext } from '../../src/core/interfaces.js';

const drivers: AgentDriverV2[] = [];
afterEach(() => { for (const driver of drivers.splice(0)) { driver.stop(); driver.dispose(); } vi.restoreAllMocks(); });

function fixture(context: DrivenSourceContext, beforeCapture = async () => {}) {
    const source: ContextDrivenSource = { name: 'adoption', onUpdate: () => () => {},
        getContext: vi.fn(async () => { await beforeCapture(); return context; }) };
    const onRunError = vi.fn();
    const driver = new AgentDriverV2({ sources: [source], llm: { model: 'openai:unused', apiKey: 'unused' }, onRunError });
    // Exercise exactly one real run, with the same active owner as start(), without its scheduling timer.
    driver['running'] = true; drivers.push(driver);
    return { driver, source, onRunError };
}

function provider(onRequest: () => void) {
    const request = vi.fn(onRequest);
    const model = new MockLanguageModelV3({ doStream: async () => {
        request();
        return { stream: convertArrayToReadableStream([
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: 'Done' },
            { type: 'text-end', id: 'text' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
            } },
        ]) };
    } });
    vi.spyOn(LLMClient.prototype as unknown as { createProvider(): unknown }, 'createProvider').mockReturnValue(model);
    return request;
}

describe('Driver serial adoption boundary', () => {
    it('prepares without adopting for preview, then adopts before the model reads and releases in finally', async () => {
        const order: string[] = [];
        const context: DrivenSourceContext = { messages: [{ role: 'user', timestamp: 1, content: 'Current' }], tools: {},
            adopt: () => { order.push('adopt'); }, release: () => { order.push('release'); } };
        const f = fixture(context);
        await f.source.getContext(); expect(order).toEqual([]);
        const call = provider(() => { expect(order).toEqual(['adopt']); order.push('model'); });
        await f.driver['run']();
        expect(call).toHaveBeenCalledTimes(1); expect(order).toEqual(['adopt', 'model', 'release']);
        expect(f.onRunError).not.toHaveBeenCalled();
    });

    it('preserves partial App adoption diagnostics, skips the model and still releases the turn', async () => {
        const error = Object.assign(new Error('Partial adoption'), { code: 'SEMANTIC_ADOPTION_PARTIAL',
            results: [{ appId: 'a', status: 'adopted' }, { appId: 'b', status: 'rejected' }] });
        const release = vi.fn();
        const f = fixture({ messages: [{ role: 'user', timestamp: 1, content: 'Current' }], tools: {}, adopt: () => { throw error; }, release });
        const call = provider(() => {});
        await f.driver['run']();
        expect(call).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
        expect(f.onRunError).toHaveBeenCalledWith(error);
    });

    it('does not adopt a late preparation after stop but releases the retained context', async () => {
        let enter!: () => void, finish!: () => void;
        const entered = new Promise<void>(done => { enter = done; });
        const gate = new Promise<void>(done => { finish = done; });
        const adopt = vi.fn(), release = vi.fn();
        const f = fixture({ messages: [], tools: {}, adopt, release }, async () => { enter(); await gate; });
        const call = vi.spyOn(LLMClient.prototype, 'call');
        const running = f.driver['run'](); await entered; f.driver.stop(); finish(); await running;
        expect(adopt).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
    });
    it('retains queued Source updates while a completion callback pauses the current drain', async () => {
        let update!: () => void, driver!: AgentDriverV2;
        let captures = 0, executions = 0;
        const release = vi.fn(), onRunError = vi.fn();
        const source: ContextDrivenSource = {
            name: 'queued-pause',
            onUpdate: callback => { update = callback; return () => {}; },
            getContext: vi.fn(async (): Promise<DrivenSourceContext> => ({
                messages: [{ role: 'user', content: `Frame ${++captures}`, timestamp: captures }],
                tools: { apply: { inputSchema: jsonSchema({ type: 'object', additionalProperties: false }) } },
                executeTool: async (toolName, _args, toolCallId) => {
                    if (++executions === 1) {
                        update();
                        await vi.waitFor(() => expect(driver.hasPendingUpdate()).toBe(true));
                    }
                    return { toolName, toolCallId, outcomeStatus: 'succeeded', result: { done: true } };
                },
                release,
            })),
        };
        const call = vi.spyOn(LLMClient.prototype, 'call').mockResolvedValue({
            text: '', toolCalls: [{ toolCallId: 'queued', toolName: 'apply', args: {} }], finishReason: 'tool-calls',
        });
        driver = new AgentDriverV2({ sources: [source], llm: { model: 'openai:unused', apiKey: 'unused' },
            workLoop: { debounceMs: 0 }, onToolResult: () => driver.pause(), onRunError });
        drivers.push(driver);
        await driver.trigger(); await driver['runInFlight'];
        expect(driver.isPaused()).toBe(true); expect(driver.getState()).toBe('idle');
        expect(call).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
        expect(driver.hasPendingUpdate()).toBe(true);
        driver.resume(); await driver['runInFlight'];
        expect(call).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledTimes(2);
        expect(driver.hasPendingUpdate()).toBe(false); expect(onRunError).not.toHaveBeenCalled();
    });

});
