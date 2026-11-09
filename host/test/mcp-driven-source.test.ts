import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpDrivenSource } from '../src/mcp/source.js';
import { MCP } from '../src/mcp/index.js';
import { AgentDriverV2, jsonSchema, type Tool, type ContextDrivenSource, type DrivenSourceContext, type MessageWithTimestamp } from '@aotui/agent-driver-v2';
import { LLMClient } from '@aotui/agent-driver-v2/dist/core/llm-client.js';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';

// Mock MCP Manager
vi.mock('../src/mcp/index.js', () => ({
    MCP: {
        tools: vi.fn(),
    }
}));

beforeEach(() => vi.mocked(MCP.tools).mockReset().mockResolvedValue({}));
afterEach(() => vi.restoreAllMocks());

describe('McpDrivenSource', () => {
    let source: McpDrivenSource;

    beforeEach(() => {
        vi.clearAllMocks();
        source = new McpDrivenSource();
        vi.mocked(MCP.tools).mockResolvedValue({});
    });

    it('should have the correct name', () => {
        expect(source.name).toBe('mcp-driven-source');
    });

    it('should fetch tools correctly', async () => {
        const mockTool: Tool = {
            inputSchema: jsonSchema({ type: 'object', properties: {} }),
            execute: vi.fn().mockResolvedValue('tool_success_result')
        };
        vi.mocked(MCP.tools).mockResolvedValue({ 'test-tool': mockTool });

        const tools = (await source.getContext()).tools;
        expect(MCP.tools).toHaveBeenCalled();
        expect(tools['test-tool']).toBe(mockTool);
    });

    it('should execute tool successfully', async () => {
        const mockTool: Tool = {
            inputSchema: jsonSchema({ type: 'object', properties: {} }),
            execute: vi.fn().mockResolvedValue('tool_success_result')
        };
        vi.mocked(MCP.tools).mockResolvedValue({ 'test-tool': mockTool });
        const context = await source.getContext();

        const result = await context.executeTool!('test-tool', { arg1: 'value' }, 'call_123');

        expect(mockTool.execute).toHaveBeenCalledWith(
            { arg1: 'value' },
            { toolCallId: 'call_123', messages: [] }
        );
        expect(result).toEqual({
            toolCallId: 'call_123',
            toolName: 'test-tool',
            result: 'tool_success_result'
        });
    });

    it('should handle tool execution errors', async () => {
        const mockTool: Tool = {
            inputSchema: jsonSchema({ type: 'object', properties: {} }),
            execute: vi.fn().mockRejectedValue(new Error('Tool failed'))
        };
        vi.mocked(MCP.tools).mockResolvedValue({ 'error-tool': mockTool });
        const context = await source.getContext();

        const result = await context.executeTool!('error-tool', {}, 'call_456');

        expect(result).toEqual({
            toolCallId: 'call_456',
            toolName: 'error-tool',
            result: 'Error: Tool failed'
        });
    });

    it('should handle missing tools gracefully', async () => {
        const result = await (await source.getContext()).executeTool!('non-existent-tool', {}, 'call_789');
        expect(result).toBeUndefined();
    });
});

describe('McpDrivenSource through the current Driver and model SDK', () => {
    it.each(['success', 'effect-then-throw'] as const)('executes the captured Context tool once: %s', async mode => {
        vi.useFakeTimers();
        let effects = 0;
        const execute = vi.fn(async (args: unknown) => {
            effects++;
            if (mode === 'effect-then-throw') throw new Error('after-effect');
            return { count: effects, args };
        });
        const original = Object.freeze({
            type: 'dynamic' as const, description: 'Controlled MCP counter', execute,
            inputSchema: jsonSchema({ type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false }),
        });
        vi.mocked(MCP.tools).mockResolvedValue({ counter: original });
        const source = new McpDrivenSource();
        const originalCapture = source.getContext.bind(source);
        const route = vi.fn<NonNullable<DrivenSourceContext['executeTool']>>();
        const getContext = vi.spyOn(source, 'getContext').mockImplementation(async () => {
            const context = await originalCapture();
            const invoke = context.executeTool;
            if (!invoke) throw new Error('Expected the actual MCP context executor');
            context.executeTool = route.mockImplementation((name, args, id) => invoke.call(context, name, args, id));
            return context;
        });
        const release = vi.fn();
        const instructions: ContextDrivenSource = {
            name: 'controlled-instructions', onUpdate: () => () => {},
            getContext: async () => ({
                messages: [{ role: 'user', content: 'Run the MCP counter once.', timestamp: 1 }], tools: {}, release,
            }),
        };
        const model = new MockLanguageModelV3({ doStream: async () => ({ stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'mcp-owner-call', toolName: 'counter', input: '{"value":1}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
        ]) }) });
        const provider = vi.spyOn(LLMClient.prototype as unknown as { createProvider: () => unknown }, 'createProvider').mockReturnValue(model);
        const onAssistantMessage = vi.fn(), onToolResult = vi.fn(), onRunError = vi.fn();
        const driver = new AgentDriverV2({
            sources: [instructions, source], llm: { model: 'openai:controlled-mcp-owner', apiKey: 'unused-no-network' },
            onAssistantMessage, onToolResult, onRunError,
        });
        try {
            await driver.trigger();
            await driver['runInFlight'];

            expect(execute).toHaveBeenCalledTimes(1);
            expect(effects).toBe(1);
            expect(execute).toHaveBeenCalledWith({ value: 1 }, { toolCallId: 'mcp-owner-call', messages: [] });
            expect(route).toHaveBeenCalledExactlyOnceWith('counter', { value: 1 }, 'mcp-owner-call');
            expect(getContext).toHaveBeenCalledTimes(1);
            expect((await getContext.mock.results[0].value).tools.counter).toBe(original);
            expect(original.execute).toBe(execute);
            expect(Object.isFrozen(original)).toBe(true);
            expect(onAssistantMessage).toHaveBeenCalledExactlyOnceWith({
                role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'mcp-owner-call', toolName: 'counter', input: { value: 1 } }],
            });
            expect(onToolResult).toHaveBeenCalledExactlyOnceWith({
                role: 'tool', content: [{ type: 'tool-result', toolCallId: 'mcp-owner-call', toolName: 'counter',
                    output: { type: 'json', value: mode === 'success' ? '{"count":1,"args":{"value":1}}' : 'Error: after-effect' } }],
            });
            expect(release).toHaveBeenCalledTimes(1);
            expect(onRunError).not.toHaveBeenCalled();
        } finally {
            driver.stop();
            driver.dispose();
            // The real Source emits an update after execution; drain it after stop.
            await vi.runOnlyPendingTimersAsync();
            vi.useRealTimers();
            provider.mockRestore();
            getContext.mockRestore();
        }
        expect(model.doStreamCalls).toHaveLength(1);
        expect(onToolResult).toHaveBeenCalledTimes(1);
    });
});

const schema = () => jsonSchema({ type: 'object', properties: {}, additionalProperties: false });
function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe('MCP capture failure and live controls', () => {
    it('keeps the captured function and receiver while the real Driver awaits its model', async () => {
        vi.useFakeTimers();
        const calls: string[] = [];
        const original = vi.fn(async function (this: { label: string }) { calls.push(this.label); return this.label; });
        const a = { label: 'A', description: 'A descriptor', inputSchema: schema(), execute: original };
        const b = { label: 'B', description: 'B descriptor', inputSchema: schema(), execute: vi.fn(async function (this: { label: string }) { calls.push(this.label); return this.label; }) };
        vi.mocked(MCP.tools).mockResolvedValueOnce({ action: a }).mockResolvedValueOnce({ action: b });
        const source = new McpDrivenSource();
        let inspector: DrivenSourceContext | undefined;
        const model = vi.spyOn(LLMClient.prototype, 'call').mockImplementation(async (_messages, tools) => {
            expect(tools.action).toBe(a);
            inspector = await source.getContext();
            a.execute = vi.fn(async () => 'replacement');
            return { text: '', finishReason: 'tool-calls', toolCalls: [{ toolName: 'action', toolCallId: 'captured', args: {} }] };
        });
        const result = vi.fn();
        const driver = new AgentDriverV2({ sources: [source], llm: { model: 'openai:controlled-mcp-identity' }, onToolResult: result });
        try {
            await driver.trigger(); await driver['runInFlight'];
            expect(calls).toEqual(['A']); expect(original.mock.contexts[0]).toBe(a);
            expect(result).toHaveBeenCalledExactlyOnceWith({ role: 'tool', content: [{ type: 'tool-result', toolName: 'action', toolCallId: 'captured', output: { type: 'json', value: 'A' } }] });
            expect(await inspector?.executeTool?.('action', {}, 'inspector')).toEqual({ toolName: 'action', toolCallId: 'inspector', result: 'B' });
            expect(calls).toEqual(['A', 'B']); expect(a.execute).not.toHaveBeenCalled();
            expect(model).toHaveBeenCalledTimes(1);
        } finally {
            driver.stop(); await driver['runInFlight']; driver.dispose();
            await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); model.mockRestore();
        }
    });

    it('returns a full empty context on list failure and never reuses prior executors', async () => {
        const source = new McpDrivenSource(), failure = new Error('list failed');
        const execute = vi.fn(async () => 'original');
        vi.mocked(MCP.tools).mockResolvedValueOnce({ action: { inputSchema: schema(), execute } })
            .mockRejectedValueOnce(failure).mockResolvedValueOnce({});
        const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const first = await source.getContext();
            await expect(source.getContext()).resolves.toEqual({ messages: [], tools: {} });
            expect(diagnostic).toHaveBeenCalledWith('[mcp-driven-source]', 'Failed to fetch tools', failure);
            expect((await source.getContext()).tools).toEqual({});
            expect(await first.executeTool!('action', {}, 'original')).toEqual({ toolName: 'action', toolCallId: 'original', result: 'original' });
            expect(execute).toHaveBeenCalledTimes(1);
        } finally { diagnostic.mockRestore(); }
    });

    it.each(['source', 'tool', 'server'] as const)('observes %s disable while tools are being fetched', async control => {
        let resolve!: (tools: Awaited<ReturnType<typeof MCP.tools>>) => void;
        vi.mocked(MCP.tools).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
        const source = new McpDrivenSource(), pending = source.getContext(), execute = vi.fn();
        if (control === 'source') source.setEnabled(false);
        if (control === 'tool') source.setToolEnabled('mcp-controlled-action', false);
        if (control === 'server') source.setServerEnabled('controlled', false);
        resolve({ 'mcp-controlled-action': { inputSchema: schema(), execute } });
        expect((await pending).tools).toEqual({});
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([
        ['model', 'source'], ['model', 'tool'], ['model', 'server'],
        ['first-tool', 'source'], ['first-tool', 'tool'], ['first-tool', 'server'],
    ] as const)('rechecks %s / %s through real Driver routing', async (phase, control) => {
        vi.useFakeTimers();
        const started = barrier(), proceed = barrier();
        const source = new McpDrivenSource();
        const disable = () => {
            if (control === 'source') source.setEnabled(false);
            if (control === 'tool') source.setToolEnabled('mcp-controlled-second', false);
            if (control === 'server') source.setServerEnabled('controlled', false);
        };
        const first = vi.fn(async () => { disable(); return 'first finished'; });
        const second = vi.fn(async () => 'must not enter');
        vi.mocked(MCP.tools).mockResolvedValue({
            'mcp-controlled-first': { inputSchema: schema(), execute: first },
            'mcp-controlled-second': { inputSchema: schema(), execute: second },
        });
        const model = vi.spyOn(LLMClient.prototype, 'call').mockImplementation(async () => {
            started.resolve();
            if (phase === 'model') await proceed.promise;
            const names = phase === 'model' ? ['mcp-controlled-second'] : ['mcp-controlled-first', 'mcp-controlled-second'];
            return { text: '', finishReason: 'tool-calls', toolCalls: names.map((toolName, i) => ({ toolName, toolCallId: 'gate-' + i, args: {} })) };
        });
        const result = vi.fn(), error = vi.fn();
        const driver = new AgentDriverV2({ sources: [source], llm: { model: 'openai:controlled-mcp-live' }, onToolResult: result, onRunError: error });
        try {
            await driver.trigger();
            const work = driver['runInFlight'];
            await started.promise;
            if (phase === 'model') disable();
            proceed.resolve(); await work;
            expect(first).toHaveBeenCalledTimes(phase === 'first-tool' ? 1 : 0);
            expect(second).not.toHaveBeenCalled();
            expect(error).not.toHaveBeenCalled();
            expect(model).toHaveBeenCalledTimes(1);
            expect(result).toHaveBeenCalledTimes(1);
            expect(result.mock.calls[0][0].content.at(-1).output).toEqual({ type: 'error-json', value: {
                code: 'E_SOURCE_UNAVAILABLE', message: 'The MCP tool source is no longer active',
            } });
        } finally {
            proceed.resolve(); driver.stop(); await driver['runInFlight']; driver.dispose();
            await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); model.mockRestore();
        }
    });
});

describe('MCP identity scope proof', () => {
  it.each(['text', 'object', 'throw'] as const)('preserves result and one update: %s', async mode => {
    const execute = vi.fn(async () => {
      if (mode === 'throw') throw new Error('effect may have happened');
      return mode === 'text' ? 'original text' : { value: 7 };
    });
    vi.mocked(MCP.tools).mockResolvedValue({ action: { description: 'Original', inputSchema: schema(), execute } });
    const source = new McpDrivenSource(), update = vi.fn();
    source.onUpdate(update);
    const context = await source.getContext();
    const result = await context.executeTool?.('action', {}, 'call');
    expect(result).toEqual({ toolName: 'action', toolCallId: 'call', result: mode === 'text' ? 'original text' : mode === 'object' ? '{"value":7}' : 'Error: effect may have happened' });
    expect(execute).toHaveBeenCalledExactlyOnceWith({}, { toolCallId: 'call', messages: [] });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('keeps A when another consumer captures same-name B', async () => {
    const calls: string[] = [];
    const a = { label: 'A', inputSchema: schema(), execute: vi.fn(async function (this: { label: string }) { calls.push(this.label); return this.label; }) };
    const b = { label: 'B', inputSchema: schema(), execute: vi.fn(async function (this: { label: string }) { calls.push(this.label); return this.label; }) };
    vi.mocked(MCP.tools).mockResolvedValueOnce({ action: a }).mockResolvedValueOnce({ action: b });
    const source = new McpDrivenSource();
    const first = await source.getContext(), second = await source.getContext();
    const firstResult = await first.executeTool?.('action', {}, 'first');
    const secondResult = await second.executeTool?.('action', {}, 'second');
    expect(calls).toEqual(['A', 'B']);
    expect(firstResult?.result).toBe('A'); expect(secondResult?.result).toBe('B');
  });

  it('pins the original function and its Tool receiver', async () => {
    const calls: string[] = [];
    const original = vi.fn(async function (this: { label: string }) { calls.push(this.label); return this.label; });
    const tool = { label: 'original', inputSchema: schema(), execute: original };
    vi.mocked(MCP.tools).mockResolvedValue({ action: tool });
    const source = new McpDrivenSource(), context = await source.getContext();
    tool.execute = vi.fn(async () => 'replacement');
    const result = await context.executeTool?.('action', {}, 'pinned');
    expect(result?.result).toBe('original'); expect(calls).toEqual(['original']);
    expect(original).toHaveBeenCalledTimes(1); expect(tool.execute).not.toHaveBeenCalled();
  });

  it.each(['source', 'tool', 'server'] as const)('rechecks %s controls after capture', async control => {
    const execute = vi.fn(async () => 'must not enter');
    const key = 'mcp-controlled-action';
    vi.mocked(MCP.tools).mockResolvedValue({ [key]: { inputSchema: schema(), execute } });
    const source = new McpDrivenSource(), context = await source.getContext(), update = vi.fn();
    source.onUpdate(update);
    if (control === 'source') source.setEnabled(false);
    if (control === 'tool') source.setToolEnabled(key, false);
    if (control === 'server') source.setServerEnabled('controlled', false);
    update.mockClear();
    const result = await context.executeTool?.(key, {}, 'disabled');
    expect(result).toMatchObject({ outcomeStatus: 'rejected', error: { code: 'E_SOURCE_UNAVAILABLE' } });
    expect(execute).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });
});

const completionTraces: unknown[] = [];
afterAll(() => {
    const file = process.env.AOTUI_BATCH10_TRACE;
    if (file) writeFileSync(file, JSON.stringify({ records: completionTraces }, null, 2) + '\n', { flag: 'wx' });
});

describe('MCP completion subscriber isolation candidate', () => {
    it.each([
        { business: 'success', fault: 'never', position: 'middle' },
        { business: 'failure', fault: 'never', position: 'middle' },
        { business: 'success', fault: 'once', position: 'middle' },
        { business: 'failure', fault: 'once', position: 'middle' },
        { business: 'success', fault: 'always', position: 'first' },
        { business: 'failure', fault: 'always', position: 'first' },
    ] as const)('$business / subscriber $fault / $position', async ({ business, fault, position }) => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const events: unknown[] = [], raw: unknown[] = [], receipts: unknown[] = [], models: unknown[] = [], diagnostics: unknown[] = [];
        const counts = { before: 0, throwing: 0, after: 0, driver: 0 };
        const failure = new Error('subscriber unavailable'), businessFailure = new Error('business failed');
        const diagnostic = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
            diagnostics.push(args.map(value => value instanceof Error ? { name: value.name, message: value.message } : value));
        });
        const noNetwork = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected real network'));
        const client = vi.fn(async (args: unknown) => {
            events.push({ kind: 'client', args });
            if (business === 'failure') throw businessFailure;
            return 'ok';
        });
        const tool = Object.freeze({ description: 'Controlled MCP action', type: 'dynamic' as const,
            inputSchema: jsonSchema({ type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false }),
            execute: client });
        vi.mocked(MCP.tools).mockResolvedValue({ 'mcp-controlled-action': tool });
        const source = new McpDrivenSource();
        const before = () => { counts.before++; events.push({ kind: 'subscriber', name: 'before', call: counts.before }); };
        const throwing = () => {
            counts.throwing++; events.push({ kind: 'subscriber', name: 'throwing', call: counts.throwing });
            if (fault === 'always' || (fault === 'once' && counts.throwing === 1)) throw failure;
        };
        if (position === 'middle') source.onUpdate(before);
        source.onUpdate(throwing);
        if (position === 'first') source.onUpdate(before);
        source.onUpdate(() => { counts.after++; events.push({ kind: 'subscriber', name: 'after', call: counts.after }); });
        const subscribe = source.onUpdate.bind(source);
        vi.spyOn(source, 'onUpdate').mockImplementation(callback => subscribe(() => {
            counts.driver++; events.push({ kind: 'subscriber', name: 'driver', call: counts.driver }); callback();
        }));
        const capture = source.getContext.bind(source);
        vi.spyOn(source, 'getContext').mockImplementation(async () => {
            const context = await capture(), invoke = context.executeTool;
            if (!invoke) throw new Error('Expected real MCP executor');
            context.executeTool = async (...args) => {
                try {
                    const returned = await invoke.call(context, ...args);
                    raw.push({ returned });
                    events.push({ kind: 'source-return', pending: driver.hasPendingUpdate() });
                    return returned;
                } catch (error) {
                    raw.push({ threw: error instanceof Error ? error.message : String(error) });
                    events.push({ kind: 'source-throw', pending: driver.hasPendingUpdate() });
                    throw error;
                }
            };
            return context;
        });
        let captures = 0;
        const releases: number[] = [];
        const history: MessageWithTimestamp[] = [{ role: 'user', content: 'Run once and read the receipt.', timestamp: 1, region: 'session' }];
        const conversation: ContextDrivenSource = {
            name: 'controlled-history', onUpdate: () => () => {},
            getContext: async () => {
                const captureId = ++captures;
                return { messages: [...history], tools: {}, release: () => { releases.push(captureId); events.push({ kind: 'release', captureId }); } };
            },
        };
        const model = new MockLanguageModelV3({ doStream: async options => {
            models.push({ prompt: structuredClone(options.prompt), tools: structuredClone(options.tools), at: Date.now() });
            events.push({ kind: 'model', call: models.length });
            if (models.length > 2) throw new Error('Unexpected third model call');
            const first = models.length === 1;
            return { stream: convertArrayToReadableStream([
                { type: 'stream-start', warnings: [] },
                ...(first ? [{ type: 'tool-call' as const, toolCallId: 'completion-call', toolName: 'mcp-controlled-action', input: '{"value":1}' }]
                    : [{ type: 'text-start' as const, id: 'final' }, { type: 'text-delta' as const, id: 'final', delta: 'Receipt recorded.' }, { type: 'text-end' as const, id: 'final' }]),
                { type: 'finish', finishReason: { unified: first ? 'tool-calls' : 'stop', raw: first ? 'tool_calls' : 'stop' },
                    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ]) };
        } });
        const provider = vi.spyOn(LLMClient.prototype as unknown as { createProvider: () => unknown }, 'createProvider').mockReturnValue(model);
        const runErrors = vi.fn();
        const driver = new AgentDriverV2({
            sources: [conversation, source], llm: { model: 'openai:controlled-completion', apiKey: 'unused-no-network' },
            onAssistantMessage: message => { history.push({ ...message, timestamp: history.length + 1, region: 'session' }); },
            onToolResult: message => { receipts.push(structuredClone(message)); history.push({ ...message, timestamp: history.length + 1, region: 'session' }); },
            onRunError: runErrors,
        });
        let passed = false;
        try {
            await driver.trigger();
            await driver['runInFlight'];
            await vi.advanceTimersByTimeAsync(300);
            await driver['runInFlight'];
            expect(driver['runInFlight']).toBeNull();
            const callsBeforeQuiet = models.length;
            await vi.advanceTimersByTimeAsync(600);
            await driver['runInFlight'];
            expect(models).toHaveLength(callsBeforeQuiet);
            expect(client).toHaveBeenCalledExactlyOnceWith({ value: 1 }, { toolCallId: 'completion-call', messages: [] });
            const value = business === 'success' ? 'ok' : 'Error: business failed';
            expect(raw).toStrictEqual([{ returned: { toolCallId: 'completion-call', toolName: 'mcp-controlled-action', result: value } }]);
            expect(receipts).toStrictEqual([{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'completion-call', toolName: 'mcp-controlled-action', output: { type: 'json', value } }] }]);
            expect(counts).toEqual({ before: 1, throwing: 1, after: 1, driver: 1 });
            expect(models).toHaveLength(2);
            expect(releases).toEqual([1, 2]);
            expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'Receipt recorded.' });
            expect(runErrors).not.toHaveBeenCalled();
            expect(noNetwork).not.toHaveBeenCalled();
            if (fault !== 'never') expect(diagnostic).toHaveBeenCalledWith('[mcp-driven-source]', 'Failed to notify MCP tool update subscriber', failure);
            passed = true;
        } finally {
            completionTraces.push({ scenario: `${business}-${fault}-${position}`, passed, clientCalls: client.mock.calls,
                counts: { ...counts }, raw, receipts, models, events, releases, diagnostics,
                pendingAfterQuiet: driver.hasPendingUpdate(), networkCalls: noNetwork.mock.calls.length });
            driver.stop(); await driver['runInFlight']; driver.dispose();
            await vi.runOnlyPendingTimersAsync();
            provider.mockRestore(); diagnostic.mockRestore(); noNetwork.mockRestore();
            vi.useRealTimers();
        }
    });

    it.each(['source', 'server', 'tool'] as const)('keeps control notification failure and rejects a disabled %s without a completion notification', async control => {
        const client = vi.fn(async () => 'must not enter'), throwing = vi.fn(() => { throw new Error('control subscriber unavailable'); }), healthy = vi.fn();
        vi.mocked(MCP.tools).mockResolvedValue({ 'mcp-controlled-action': { inputSchema: schema(), execute: client } });
        const source = new McpDrivenSource(), context = await source.getContext();
        source.onUpdate(throwing); source.onUpdate(healthy);
        const disable = () => {
            if (control === 'source') source.setEnabled(false);
            if (control === 'server') source.setServerEnabled('controlled', false);
            if (control === 'tool') source.setToolEnabled('mcp-controlled-action', false);
        };
        expect(disable).toThrow('control subscriber unavailable');
        expect(throwing).toHaveBeenCalledTimes(1); expect(healthy).not.toHaveBeenCalled();
        throwing.mockClear(); healthy.mockClear();
        const result = await context.executeTool!('mcp-controlled-action', {}, 'disabled');
        expect(result).toMatchObject({ outcomeStatus: 'rejected', error: { code: 'E_SOURCE_UNAVAILABLE' } });
        expect(client).not.toHaveBeenCalled(); expect(throwing).not.toHaveBeenCalled(); expect(healthy).not.toHaveBeenCalled();
        completionTraces.push({ scenario: `disabled-${control}`, passed: true, result, clientCalls: client.mock.calls.length, completionNotifications: { throwing: throwing.mock.calls.length, healthy: healthy.mock.calls.length },
            controlNotification: { throws: 'control subscriber unavailable', throwing: 1, healthy: 0 } });
    });
});

it('still attempts completion once when the installed MCP transport rejects null and receipt mapping throws', async () => {
    const server = new Server({ name: 'local', version: '1' }, { capabilities: { tools: {} } });
    const client = new Client({ name: 'completion-probe', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'act', inputSchema: { type: 'object' } }] }));
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let attempts = 0, rejection: unknown;
    const healthy = vi.fn();
    try {
        const send = clientTransport.send.bind(clientTransport);
        vi.spyOn(clientTransport, 'send').mockImplementation(async (message, options) => {
            if ('method' in message && message.method === 'tools/call') {
                attempts++;
                return Promise.reject(null);
            }
            return send(message, options);
        });
        expect((await client.listTools()).tools[0].name).toBe('act');
        vi.mocked(MCP.tools).mockResolvedValue({ 'mcp-local-act': {
            inputSchema: schema(),
            execute: () => client.callTool({ name: 'act', arguments: {} }, CallToolResultSchema),
        } });
        const source = new McpDrivenSource();
        source.onUpdate(healthy);
        const context = await source.getContext();
        try { await context.executeTool!('mcp-local-act', {}, 'same'); } catch (reason) { rejection = reason; }
        completionTraces.push({ scenario: 'transport-null-mapping-throws', attempts, healthy: healthy.mock.calls.length, rejection: String(rejection) });
        expect(attempts).toBe(1);
        expect(rejection).toBeInstanceOf(TypeError);
        expect(String(rejection)).toBe("TypeError: Cannot read properties of null (reading 'message')");
        expect(healthy).toHaveBeenCalledTimes(1);
    } finally {
        await client.close();
        await server.close();
    }
});
