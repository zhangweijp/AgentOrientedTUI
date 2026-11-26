import { anthropic } from '@ai-sdk/anthropic';
import { describe, expect, it } from 'vitest';
import { AgentDriverV2, ModelInputError, jsonSchema, type ContextDrivenSource, type MessageWithTimestamp,
    type ModelInputMeasurement, type Tool, type ToolResult } from '../../src/index.js';
import { fixtureProvider, watchUntil } from '../../../tests/fixtures/batch-two-support.mjs';
import { CLAUDE, REGEX_SEARCH, claudeTurn, failedToolSearch, foundTool, useTool, wireBlocks } from '../../../tests/fixtures/claude-tool-search.mjs';

const SAVE = 'save_note';
const LIMITS = { contextWindow: 16_000, maxOutputTokens: 500 };

describe('Claude Messages tool search', () => {
    it('replays ordered success and failure history and weighs the actual request after the tools retire', async () => {
        const provider = await fixtureProvider();
        let tools: Record<string, Tool> = {
            [REGEX_SEARCH]: anthropic.tools.toolSearchRegex_20251119({}),
            [SAVE]: { description: 'Store the chosen note.', inputSchema: jsonSchema({ type: 'object', required: ['note'],
                properties: { note: { type: 'string' } }, additionalProperties: false }),
                providerOptions: { anthropic: { deferLoading: true } } },
        };
        let history: MessageWithTimestamp[] = [
            { role: 'system', content: 'Use the current notes tools.', timestamp: 1, region: 'static',
                providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
        ];
        let time = 2;
        const errors: Error[] = [], entered: string[] = [], outcomes: ToolResult[] = [], measured: ModelInputMeasurement[] = [];
        let adoptions = 0, assistantMessages = 0;
        const source: ContextDrivenSource = {
            name: 'notes', onUpdate: () => () => {},
            async getContext() {
                const context = { messages: history.slice(), tools, adopt() { adoptions++; },
                    async executeTool(toolName: string, args: unknown, toolCallId: string) {
                        entered.push(toolName);
                        return { toolName, toolCallId, outcomeStatus: 'succeeded' as const, result: args };
                    },
                };
                return { ...context, async fitModelBudget(measure, withFeedback) {
                    const size = await measure(context);
                    if (!withFeedback) measured.push(size);
                    return { measurement: size };
                } };
            },
        };
        const start = (id = 'anthropic') => new AgentDriverV2({
            llm: { model: CLAUDE, provider: { id, baseURL: provider.url }, apiKey: 'loopback-only',
                inputBudget: () => LIMITS },
            sources: [source],
            onAssistantMessage: message => { assistantMessages++; history.push({ ...message, timestamp: time++ }); },
            onToolResult: (message, results) => { outcomes.push(...results); history.push({ ...message, timestamp: time++ }); },
            onRunError: error => { errors.push(error); },
        });
        let driver = start();
        const send = async (label: string, ...parts: object[]) => {
            const expected = assistantMessages + 1;
            history.push({ role: 'user', content: label, timestamp: time++ });
            provider.replyNext(claudeTurn(label, parts, () => { expect(adoptions).toBe(expected); }));
            await driver.trigger();
            await watchUntil(() => errors[0] || (assistantMessages === expected && driver.getState() === 'idle'));
            expect(errors).toEqual([]);
            return provider.requests.at(-1)!;
        };
        try {
            const first = await send('search-only', ...foundTool('srvtoolu_search', SAVE));
            expect(first.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
            expect(first.body.tools.find((tool: { name: string }) => tool.name === SAVE)?.defer_loading).toBe(true);
            expect(first.body.tools[0].type).toBe('tool_search_tool_regex_20251119');
            expect(outcomes).toEqual([]);

            const failed = failedToolSearch('srvtoolu_failed', 'invalid_pattern', 'Unclosed group: 蓝色.');
            await send('search-and-write', { type: 'text', text: 'Before.' }, ...failed, ...foundTool('srvtoolu_mixed', SAVE),
                useTool('toolu_save', SAVE, { note: '蓝色' }), { type: 'text', text: 'After.' });
            expect(entered).toEqual([SAVE]);
            expect(history.find(message => message.role === 'assistant' &&
                JSON.stringify(message).includes('srvtoolu_failed'))?.content).toContainEqual(expect.objectContaining({
                toolCallId: 'srvtoolu_failed',
                output: { type: 'error-json', value: { type: 'tool_search_tool_result_error', errorCode: 'invalid_pattern' } },
                providerOptions: { aotui: expect.objectContaining({ anthropicSearchError: failed[1]!.content }) },
            }));

            driver.dispose();
            history = JSON.parse(JSON.stringify(history));
            // An old Host result for a provider call would be a second, invalid receipt.
            history.push({ role: 'tool', timestamp: time++, content: [{
                type: 'tool-result', toolName: REGEX_SEARCH, toolCallId: 'srvtoolu_mixed', output: { type: 'text', value: 'duplicate' },
            }] });
            tools = {};
            driver = start();
            const last = await send('retired-route', useTool('toolu_stale', SAVE, { note: 'must never run' }));

            expect(last.body.tools).toEqual(first.body.tools);
            expect(wireBlocks(last.body).filter((part: { type: string }) => ['server_tool_use', 'tool_search_tool_result',
                'tool_use', 'tool_result'].includes(part.type))).toMatchObject([
                { type: 'server_tool_use', id: 'srvtoolu_search' },
                { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_search', content: { tool_references: [{ tool_name: SAVE }] } },
                ...failed,
                { type: 'server_tool_use', id: 'srvtoolu_mixed' },
                { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_mixed', content: { tool_references: [{ tool_name: SAVE }] } },
                { type: 'tool_use', id: 'toolu_save' },
                { type: 'tool_result', tool_use_id: 'toolu_save' },
            ]);
            expect(last.body.messages.find((message: { role: string; content: Array<{ id?: string }> }) =>
                message.role === 'assistant' && message.content.some(part => part.id === 'srvtoolu_mixed')).content.map((part: { type: string }) => part.type))
                .toEqual(['text', 'server_tool_use', 'tool_search_tool_result', 'server_tool_use', 'tool_search_tool_result', 'tool_use', 'text']);
            expect(entered).toEqual([SAVE]);
            expect(outcomes).toMatchObject([
                { toolName: SAVE, toolCallId: 'toolu_save', outcomeStatus: 'succeeded', result: { note: '蓝色' } },
                { toolName: SAVE, toolCallId: 'toolu_stale', outcomeStatus: 'rejected', error: { code: 'E_TOOL_NOT_FOUND' } },
            ]);

            driver.dispose();
            driver = start('chat-fixture');
            history.push({ role: 'user', content: 'Continue over Chat.', timestamp: time++ });
            provider.replyNext({ label: 'chat replay', text: 'Done.' });
            await driver.trigger();
            await watchUntil(() => errors[0] || (assistantMessages === 4 && driver.getState() === 'idle'));
            expect(errors).toEqual([]);
            const chat = provider.requests.at(-1)!;
            expect(chat.body.messages.flatMap(message => message.tool_calls ?? []).map(call => call.id))
                .toEqual(['toolu_save', 'toolu_stale']);
            expect(chat.body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))
                .toEqual(['toolu_save', 'toolu_stale']);
            expect(JSON.stringify(history)).toContain('srvtoolu_mixed');

            expect(measured.map(cost => cost.inputBytes)).toEqual(provider.requests.map(request => request.inputBytes));
            expect(provider.requests).toHaveLength(4);
            expect(provider.failures).toEqual([]);
        } finally { driver.dispose(); await provider.close(); }
    });

    it('refuses an old error for a missing search alias before adopting or sending the request', async () => {
        const provider = await fixtureProvider();
        let adopted = false;
        let failure: Error | undefined;
        const driver = new AgentDriverV2({
            llm: { model: CLAUDE, provider: { id: 'anthropic', baseURL: provider.url }, apiKey: 'loopback-only' },
            sources: [{
                name: 'history', onUpdate: () => () => {}, getContext: async () => ({
                    messages: [
                        { role: 'user', timestamp: 1, content: 'Search the notes.' },
                        { role: 'assistant', timestamp: 2, content: [
                            { type: 'tool-call', toolCallId: 'srvtoolu_legacy', toolName: 'removed_alias',
                                providerExecuted: true, input: { pattern: '(' } },
                            { type: 'tool-result', toolCallId: 'srvtoolu_legacy', toolName: 'removed_alias',
                                output: { type: 'error-json', value: { type: 'tool_search_tool_result_error', errorCode: 'invalid_pattern' } } },
                        ] },
                        { role: 'user', timestamp: 3, content: 'Continue.' },
                    ],
                    tools: {}, adopt() { adopted = true; },
                }),
            }],
            onRunError: error => { failure = error; },
        });
        try {
            await driver.trigger();
            expect((await watchUntil(() => failure)).message).toContain('srvtoolu_legacy (invalid_pattern)');
            expect(adopted).toBe(false);
            expect(provider.requests).toEqual([]);
            expect(provider.failures).toEqual([]);
        } finally { driver.dispose(); await provider.close(); }
    });

    it('rejects media in tool history before the SDK can fetch an attachment or adopt the request', async () => {
        const provider = await fixtureProvider();
        let adopted = false;
        let failure: Error | undefined;
        const driver = new AgentDriverV2({
            llm: { model: CLAUDE, provider: { id: 'anthropic', baseURL: provider.url }, apiKey: 'loopback-only',
                inputBudget: () => LIMITS },
            sources: [{
                name: 'history', onUpdate: () => () => {}, getContext: async () => ({
                    messages: [
                        { role: 'assistant', timestamp: 1, content: [
                            { type: 'tool-call', toolCallId: 'asset', toolName: 'attachment', input: {} },
                        ] },
                        { role: 'tool', timestamp: 2, content: [{
                            type: 'tool-result', toolCallId: 'asset', toolName: 'attachment', output: { type: 'content', value: [
                                { type: 'file-url', url: provider.url + '/asset.pdf', mediaType: 'application/pdf' },
                            ] },
                        }] },
                    ],
                    tools: {}, adopt() { adopted = true; },
                }),
            }],
            onRunError: error => { failure = error; },
        });
        try {
            await driver.trigger();
            expect(await watchUntil(() => failure)).toBeInstanceOf(ModelInputError);
            expect(failure).toMatchObject({ code: 'MODEL_INPUT_UNMEASURABLE' });
            expect(adopted).toBe(false);
            expect(provider.requests).toEqual([]);
            expect(provider.failures).toEqual([]);
        } finally { driver.dispose(); await provider.close(); }
    });
});
