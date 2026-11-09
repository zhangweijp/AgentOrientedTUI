import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageServiceV2 } from '../src/core/message-service-v2.js';
import { HostDrivenSourceV2 } from '../src/adapters/host-driven-source.js';

describe('HostDrivenSourceV2', () => {
    const topicId = 'topic_compact_test';
    let messageServiceMock: any;
    let source: HostDrivenSourceV2;

    beforeEach(() => {
        messageServiceMock = {
            getMessagesForLLM: vi.fn().mockResolvedValue([{ role: 'user', content: 'hello', timestamp: 1, id: 'm1' }]),
            compactContext: vi.fn().mockReturnValue({
                compacted: true,
                trigger: 'agent',
                summary: 'summary',
                compactedMessageCount: 12,
                cleanedToolResultCount: 3,
                syntheticMessages: [],
            }),
            estimateContextTokens: vi.fn().mockReturnValue(5_001),
            markCompactionAnchor: vi.fn(),
        };
        source = new HostDrivenSourceV2(messageServiceMock, topicId);
    });

    it('should return LLM filtered messages from MessageService', async () => {
        const messages = await source.getContext().then(context => context.messages);
        expect(messageServiceMock.getMessagesForLLM).toHaveBeenCalledWith(topicId);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            role: 'user',
            content: 'hello',
            timestamp: 1,
            region: 'session',
        });
        expect(messages.every((message) => message.region === 'session')).toBe(true);
    });

    it('should expose context_compact tool', async () => {
        const tools = await source.getContext().then(context => context.tools);
        expect(Object.keys(tools)).toContain('context_compact');
        expect((tools as any).context_compact.description).toContain('## Goal');
        expect((tools as any).context_compact.description).toContain('When to trigger compaction:');
        expect((tools as any).context_compact.description).toContain('## Relevant files / directories');
        expect((tools as any).context_compact.inputSchema.jsonSchema.required).toContain('summary');
    });

    it('should route context_compact execution to MessageService with agent trigger', async () => {
        const result = await source.getContext().then(context => context.executeTool!('context_compact', {
            reason: 'manual request',
            summary: '## Goal\nmanual compact',
        }, 'tc_1'));

        expect(messageServiceMock.compactContext).toHaveBeenCalledWith(topicId, {
            trigger: 'agent',
            reason: 'manual request',
            summary: '## Goal\nmanual compact',
            createSyntheticMessages: false,
        });

        expect(result).toEqual({
            toolCallId: 'tc_1',
            toolName: 'context_compact',
            result: {
                success: true,
                trigger: 'agent',
                summary: 'summary',
                compactedMessageCount: 12,
                cleanedToolResultCount: 3,
            },
        });
    });

    it('should allow force-triggering context_compact from agent tool call', async () => {
        await source.getContext().then(context => context.executeTool!('context_compact', {
            reason: 'force test',
            summary: '## Goal\nforce compact',
            force: true,
        }, 'tc_force'));

        expect(messageServiceMock.compactContext).toHaveBeenCalledWith(topicId, {
            trigger: 'agent',
            reason: 'force test',
            summary: '## Goal\nforce compact',
            minMessages: 1,
            keepRecentMessages: undefined,
            createSyntheticMessages: false,
        });
    });

    it('should reject context_compact call when summary is missing', async () => {
        const result = await source.getContext().then(context => context.executeTool!('context_compact', { reason: 'missing summary' }, 'tc_missing'));

        expect(messageServiceMock.compactContext).not.toHaveBeenCalled();
        expect(result).toEqual({
            toolCallId: 'tc_missing',
            toolName: 'context_compact',
            result: {
                success: false,
                trigger: 'agent',
                summary: '',
                compactedMessageCount: 0,
                cleanedToolResultCount: 0,
                note: 'context_compact requires a non-empty summary. Provide a continuation summary using the required template.',
            },
        });
    });

    it('should pass LLM-provided summary into context_compact call', async () => {
        await source.getContext().then(context => context.executeTool!('context_compact', {
            reason: 'llm summary path',
            summary: '## Goal\ncompress now',
            force: true,
        }, 'tc_summary'));

        expect(messageServiceMock.compactContext).toHaveBeenCalledWith(topicId, {
            trigger: 'agent',
            reason: 'llm summary path',
            summary: '## Goal\ncompress now',
            minMessages: 1,
            keepRecentMessages: undefined,
            createSyntheticMessages: false,
        });
    });

    it('should run hard fallback compaction with synthetic messages', () => {
        messageServiceMock.compactContext.mockReturnValueOnce({
            compacted: true,
            trigger: 'host_fallback',
            summary: 'fallback summary',
            compactedMessageCount: 9,
            cleanedToolResultCount: 2,
            syntheticMessages: [
                { id: 'a1', role: 'assistant', content: [], timestamp: Date.now() },
                { id: 't1', role: 'tool', content: [], timestamp: Date.now() },
            ],
        });

        const result = source.runHardFallbackCompaction('hard fallback');

        expect(messageServiceMock.compactContext).toHaveBeenCalledWith(topicId, {
            trigger: 'host_fallback',
            reason: 'hard fallback',
            createSyntheticMessages: true,
        });
        expect(result.compacted).toBe(true);
        expect(result.syntheticMessages).toHaveLength(2);
    });

    it('should only trigger threshold fallback when context exceeds threshold', () => {
        messageServiceMock.estimateContextTokens.mockReturnValueOnce(4_200);
        const low = source.maybeCompactByThreshold({ maxContextTokens: 4_500 });
        expect(low.compacted).toBe(false);
        expect(low.currentTokens).toBe(4_200);
        expect(low.thresholdTokens).toBe(4_500);

        messageServiceMock.estimateContextTokens.mockReturnValueOnce(4_900);
        const high = source.maybeCompactByThreshold({ maxContextTokens: 4_500 });
        expect(high.compacted).toBe(true);
        expect(high.currentTokens).toBe(4_900);
        expect(high.thresholdTokens).toBe(4_500);
    });

    it('should skip hard fallback when policy is disabled', () => {
        const result = source.maybeCompactByThreshold({
            enabled: false,
            maxContextTokens: 4_500,
        });

        expect(result.compacted).toBe(false);
        expect(messageServiceMock.estimateContextTokens).not.toHaveBeenCalled();
    });
});

describe('Host topic scope proof', () => {
  function makeHost() {
    const service = {
      getMessagesForLLM: vi.fn(async (topic: string) => [{ role: 'user' as const, content: topic, timestamp: 1 }]),
      compactContext: vi.fn((topic: string) => ({ compacted: true, trigger: 'agent', summary: topic, compactedMessageCount: 2, cleanedToolResultCount: 1, syntheticMessages: [] })),
    };
    return { service, source: new HostDrivenSourceV2(service as unknown as MessageServiceV2, 'A') };
  }
  it('preserves same-topic messages, compaction and notification', async () => {
    const { source, service } = makeHost(), update = vi.fn();
    source.onUpdate(update);
    const context = await source.getContext(), result = await context.executeTool?.('context_compact', { summary: 'Summary', force: true }, 'normal');
    expect(context.messages).toEqual([{ role: 'user', content: 'A', timestamp: 1, region: 'session' }]);
    expect(result).toEqual({ toolName: 'context_compact', toolCallId: 'normal', result: { success: true, trigger: 'agent', summary: 'A', compactedMessageCount: 2, cleanedToolResultCount: 1 } });
    expect(update).toHaveBeenCalledTimes(1);
  });
  it.each(['Summary', ''] as const)('rejects the old topic before business input: %j', async summary => {
    const { source, service } = makeHost(), context = await source.getContext(), update = vi.fn();
    source.switchTopic('B'); source.onUpdate(update);
    const result = await context.executeTool?.('context_compact', { summary }, 'stale');
    expect(result).toMatchObject({ outcomeStatus: 'rejected', error: { code: 'E_SOURCE_UNAVAILABLE' } });
    expect(service.compactContext).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });
  it('does not mix A messages with B executor across an awaited read', async () => {
    const { source, service } = makeHost();
    let finish!: (messages: Array<{ role: 'user'; content: string; timestamp: number }>) => void;
    service.getMessagesForLLM.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = source.getContext();
    expect(service.getMessagesForLLM).toHaveBeenCalledExactlyOnceWith('A');
    source.switchTopic('B'); finish([{ role: 'user', content: 'A', timestamp: 1 }]);
    const first = await pending, old = await first.executeTool?.('context_compact', { summary: 'Old' }, 'old');
    const current = await source.getContext(), result = await current.executeTool?.('context_compact', { summary: 'New' }, 'new');
    expect(first.messages[0].content).toBe('A');
    expect(old).toMatchObject({ outcomeStatus: 'rejected', error: { code: 'E_SOURCE_UNAVAILABLE' } });
    expect(service.compactContext).toHaveBeenCalledTimes(1);
    expect(service.compactContext.mock.calls[0][0]).toBe('B');
    expect(current.messages[0].content).toBe('B');
  });
});

 it('returns a complete empty context after message failure, diagnoses it and retries next capture', async () => {
    const failure = new Error('messages unavailable');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue([{ role: 'user', content: 'healthy', timestamp: 1 }]);
    const source = new HostDrivenSourceV2({ getMessagesForLLM: read } as unknown as MessageServiceV2, 'topic');
    try {
      await expect(source.getContext()).resolves.toEqual({ messages: [], tools: {} });
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith('Failed to capture context from Host:', failure);
      const recovered = await source.getContext();
      expect(recovered.messages).toEqual([{ role: 'user', content: 'healthy', timestamp: 1, region: 'session' }]);
      expect(recovered.tools).toHaveProperty('context_compact');
      expect(read).toHaveBeenCalledTimes(2);
    } finally { diagnostic.mockRestore(); }
 });
