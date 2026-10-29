import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { SessionManagerV3 } from '../src/core/session-manager-v3.js';
import { MessageServiceV2 } from '../src/core/message-service-v2.js';

/** Unit boundary: the Host owns persisted conversation messages and their updates. */
interface ReceiptHarness {
    sessions: Map<string, { sources: { host: {
        notifyNewMessage(): void;
        getCompactionToolName(): string;
        markToolCompactionAnchor(id: string, summary?: string): void;
    } } }>;
    handleMessage(topicId: string, type: 'assistant' | 'tool', message: ModelMessage): void;
}

describe('SessionManagerV3 tool receipt updates', () => {
    let manager: SessionManagerV3;
    let harness: ReceiptHarness;
    let messages: MessageServiceV2;
    let order: string[];
    let notify: ReturnType<typeof vi.fn>;
    const topicId = 'receipt-topic';
    const receipt: ModelMessage = { role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'call-1', toolName: 'semantic_read_diagnostics',
        output: { type: 'json', value: { outcomeStatus: 'succeeded' } },
    }] };

    beforeEach(() => {
        order = [];
        messages = new MessageServiceV2();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(messages, 'addMessage').mockImplementation((_topic, message) => {
            order.push('persist');
            return { ...message, id: 'message-1', timestamp: 1 };
        });
        // This unit exercises handleMessage only; lifecycle dependencies are
        // deliberately not constructed and are never touched by the boundary.
        type Dependencies = ConstructorParameters<typeof SessionManagerV3>;
        manager = new SessionManagerV3({} as Dependencies[0], {} as Dependencies[1],
            {} as Dependencies[2], messages);
        harness = manager as unknown as ReceiptHarness;
        notify = vi.fn(() => { order.push('notify'); });
        harness.sessions.set(topicId, { sources: { host: {
            notifyNewMessage: notify,
            getCompactionToolName: () => 'context_compact',
            markToolCompactionAnchor: () => {},
        } } });
        manager.on('message', () => { order.push('gui'); });
    });

    afterEach(async () => {
        // These are message-boundary fixtures, not live Desktop sessions.
        harness.sessions.clear();
        await manager.cleanup();
        vi.restoreAllMocks();
    });

    it('notifies the Host Source after persisting a tool receipt without a View update', () => {
        harness.handleMessage(topicId, 'tool', receipt);
        expect(messages.addMessage).toHaveBeenCalledWith(topicId, receipt);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['persist', 'notify', 'gui']);
    });

    it('does not schedule another model turn for a final assistant message', () => {
        harness.handleMessage(topicId, 'assistant', { role: 'assistant', content: 'Finished.' });
        expect(notify).not.toHaveBeenCalled();
        expect(order).toEqual(['persist', 'gui']);
    });

    it('does not announce a receipt that failed to persist', () => {
        vi.mocked(messages.addMessage).mockImplementation(() => { throw new Error('write failed'); });
        expect(() => harness.handleMessage(topicId, 'tool', receipt)).toThrow('write failed');
        expect(notify).not.toHaveBeenCalled();
        expect(order).toEqual([]);
    });
});
