import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDriverV2 } from '../../src/core/agent-driver-v2.js';
import type { LLMClient } from '../../src/core/llm-client.js';
import type {
    ContextDrivenSource, DrivenSource, DrivenSourceContext, ToolOutcomeStatus, ToolResult,
} from '../../src/core/interfaces.js';

const drivers: AgentDriverV2[] = [];
afterEach(() => {
    for (const driver of drivers.splice(0)) { driver.stop(); driver.dispose(); }
    vi.restoreAllMocks();
});

function makeSource(getContext: () => Promise<DrivenSourceContext>): ContextDrivenSource {
    return {
        name: 'semantic', getContext,
        onUpdate: () => () => {},
    };
}

function makeDriver(source: DrivenSource | DrivenSource[], call: ReturnType<typeof vi.fn>, onToolResult = vi.fn(), onRunError = vi.fn()) {
    const driver = new AgentDriverV2({ sources: Array.isArray(source) ? source : [source], llm: { model: 'gpt-4' }, onToolResult, onRunError });
    const modelCall: LLMClient['call'] = async (messages, tools, callbacks) => {
        await callbacks?.beforeRequest?.(JSON.stringify({ messages, tools }));
        return call(messages, tools);
    };
    (driver as any).llmClient = { call: modelCall };
    drivers.push(driver);
    return driver;
}

const response = (toolNames: string[] = []) => ({
    text: '', finishReason: toolNames.length ? 'tool-calls' : 'stop',
    toolCalls: toolNames.map((toolName, i) => ({ toolName, toolCallId: `call-${i}`, args: {} })),
});

describe('atomic source contexts', () => {
    it('stops capture on an atomic error and releases all prior contexts in reverse despite a release failure', async () => {
        const events: string[] = [];
        const source = (name: string, failRelease = false) => ({
            name, onUpdate: () => () => {},
            getContext: vi.fn(async () => {
                events.push('capture-' + name);
                return { messages: [], tools: {}, release: () => {
                    events.push('release-' + name);
                    if (failRelease) throw new Error('release failed');
                } };
            }),
        });
        const first = source('first'), second = source('second', true), later = source('later');
        const failure = new Error('capture failed');
        const failed = { name: 'failed', onUpdate: () => () => {}, getContext: vi.fn(async () => {
            events.push('capture-failed'); throw failure;
        }) };
        const call = vi.fn(), onRunError = vi.fn();
        const driver = makeDriver([first, second, failed, later], call, vi.fn(), onRunError);
        await driver.trigger(); await driver['runInFlight'];
        expect(events).toEqual(['capture-first', 'capture-second', 'capture-failed', 'release-second', 'release-first']);
        expect(later.getContext).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
        expect(onRunError).toHaveBeenCalledExactlyOnceWith(failure);
    });

    it('uses the captured messages, tools and executor even if another consumer observes again', async () => {
        const contexts: DrivenSourceContext[] = [];
        const getContext = vi.fn(async () => {
            const revision = contexts.length + 1;
            const context: DrivenSourceContext = {
                messages: [{ role: 'user', content: `view-${revision}`, timestamp: revision }],
                tools: { edit: { description: `edit-${revision}` } as any },
                executeTool: vi.fn(async (toolName: string, _args: unknown, toolCallId: string): Promise<ToolResult> => ({
                    toolName, toolCallId, outcomeStatus: 'succeeded', result: { revision },
                })),
                release: vi.fn(),
            };
            contexts.push(context);
            return context;
        });
        const source = makeSource(getContext);
        const call = vi.fn(async (messages, tools) => {
            expect(messages[0].content).toBe('view-1');
            expect(tools.edit.description).toBe('edit-1');
            // An inspector/source control must not rebind the in-flight model turn.
            const inspector = await source.getContext!();
            await inspector.release?.();
            return response(['edit']);
        });
        const result = vi.fn();
        const driver = makeDriver(source, call, result);

        await driver['run']();

        expect('getMessages' in source).toBe(false);
        expect('getTools' in source).toBe(false);
        expect('executeTool' in source).toBe(false);
        expect(contexts[0].executeTool).toHaveBeenCalledTimes(1);
        expect(contexts[1].executeTool).not.toHaveBeenCalled();
        expect(contexts[0].release).toHaveBeenCalledTimes(1);
        expect(contexts[1].release).toHaveBeenCalledTimes(1);
        expect(result.mock.calls[0][0].content[0].output.value).toEqual({ revision: 1 });
    });

    it.each(['model-failure', 'unchanged-input'] as const)('releases the captured turn on %s', async mode => {
        const release = vi.fn();
        const source = makeSource(async () => ({
            messages: [{ role: 'user', content: 'same', timestamp: 1 }], tools: {}, release,
        }));
        const call = mode === 'model-failure'
            ? vi.fn().mockRejectedValue(new Error('model unavailable'))
            : vi.fn().mockResolvedValue(response());
        const driver = makeDriver(source, call);

        await driver['run']();
        if (mode === 'unchanged-input') await driver['run']();

        expect(call).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(mode === 'unchanged-input' ? 2 : 1);
        expect(driver.getState()).toBe('idle');
    });

    it('fails the turn and releases earlier contexts when atomic capture fails', async () => {
        const release = vi.fn();
        const captured = makeSource(async () => ({
            messages: [{ role: 'user', content: 'already captured', timestamp: 1 }], tools: {}, release,
        }));
        const failure = new Error('scope unavailable');
        const source = makeSource(vi.fn().mockRejectedValue(failure));
        const call = vi.fn().mockResolvedValue(response());
        const onRunError = vi.fn();
        const driver = makeDriver([captured, source], call, vi.fn(), onRunError);
        await driver['run']();
        expect('getMessages' in source).toBe(false);
        expect('getTools' in source).toBe(false);
        expect(call).not.toHaveBeenCalled();
        expect(onRunError).toHaveBeenCalledWith(failure);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('releases the context and rejects late model work after stop', async () => {
        let finish!: (value: ReturnType<typeof response>) => void;
        const executeTool = vi.fn();
        const release = vi.fn();
        const source = makeSource(async () => ({
            messages: [{ role: 'user', content: 'edit', timestamp: 1 }],
            tools: { edit: {} as any }, executeTool, release,
        }));
        const call = vi.fn(() => new Promise<ReturnType<typeof response>>(resolve => { finish = resolve; }));
        const driver = makeDriver(source, call);
        const run = driver['run']();
        await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
        driver.stop();
        finish(response(['edit']));
        await run;
        expect(executeTool).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
    });
});

describe('explicit tool outcomes', () => {
    it('classifies all five outcomes internally and publishes Legacy-shaped success or actionable failure', async () => {
        const statuses: ToolOutcomeStatus[] = ['succeeded', 'rejected', 'failed', 'accepted', 'unknown'];
        const release = vi.fn();
        const source = makeSource(async () => ({
            messages: [{ role: 'user', content: 'exercise outcomes', timestamp: 1 }],
            tools: Object.fromEntries(statuses.map(status => [status, {} as any])),
            executeTool: async (toolName, _args, toolCallId): Promise<ToolResult> => ({
                toolName, toolCallId, outcomeStatus: toolName as ToolOutcomeStatus,
                result: { message: 'Inspect the current View.', view_id: 'current' },
                // Deliberately omit error: explicit rejected must still be an error.
            }),
            release,
        }));
        const onToolResult = vi.fn();
        const driver = makeDriver(source, vi.fn().mockResolvedValue(response(statuses)), onToolResult);
        const log = vi.spyOn((driver as any).logger, 'info');

        await driver['run']();

        expect(log).toHaveBeenCalledWith('Tool execution completed:', {
            resultsCount: 5, successCount: 1, errorCount: 2,
            rejectedCount: 1, failedCount: 1, acceptedCount: 1, unknownCount: 1,
        });
        const outputs = onToolResult.mock.calls[0][0].content.map((part: any) => part.output);
        expect(outputs.map((output: any) => output.type)).toEqual(['json', 'error-json', 'error-json', 'error-json', 'error-json']);
        expect(outputs[0].value).toEqual({ message: 'Inspect the current View.', view_id: 'current' });
        expect(outputs[1].value.code).toBe('TOOL_EXECUTION_FAILED');
        expect(outputs[3].value.code).toBe('TOOL_RESULT_UNCONFIRMED');
        expect(outputs[3].value.retryable).toBe(false);
        expect(JSON.stringify(outputs)).not.toContain('outcomeStatus');
        expect(JSON.stringify(outputs)).not.toContain('receipt');
        expect(outputs[4].value.retryable).toBe(false);
        expect(driver.hasPendingUpdate()).toBe(false);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('treats a thrown invocation as unknown without scheduling an automatic retry', async () => {
        const executeTool = vi.fn().mockRejectedValue(new Error('reply lost after dispatch'));
        const release = vi.fn();
        const source = makeSource(async () => ({
            messages: [{ role: 'user', content: 'write', timestamp: 1 }],
            tools: { write: {} as any }, executeTool, release,
        }));
        const onToolResult = vi.fn();
        const driver = makeDriver(source, vi.fn().mockResolvedValue(response(['write'])), onToolResult);
        await driver['run']();
        const output = onToolResult.mock.calls[0][0].content[0].output;
        expect(output.type).toBe('error-json');
        expect(output.value.outcomeStatus).toBeUndefined();
        expect(output.value.code).toBe('E_EXECUTION_ERROR');
        expect(output.value.retryable).toBe(false);
        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(driver.hasPendingUpdate()).toBe(false);
        expect(release).toHaveBeenCalledTimes(1);
    });
});
