import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { HostManagerV2 } from '../../src/core/host-manager-v2.js';
import type { GUIBridge } from '../../src/server/gui-bridge.js';
import { WebSocketHandlerV2 } from '../../src/server/websocket-handler-v2.js';

function fixture() {
    const bridge = new EventEmitter();
    const manager = { switchTopic: vi.fn(), sendUserMessage: vi.fn(), ensureSessionForTopic: vi.fn() };
    const handlers = new Map<string, (input: Buffer) => Promise<void>>();
    const socket = { readyState: 1, send: vi.fn(), on: (event: string, listener: (input: Buffer) => Promise<void>) => handlers.set(event, listener) };
    const handler = new WebSocketHandlerV2(manager as unknown as HostManagerV2, bridge as unknown as GUIBridge);
    handler.handleConnection(socket as unknown as WebSocket);
    const send = (message: object | string) => handlers.get('message')!(Buffer.from(typeof message === 'string' ? message : JSON.stringify(message)));
    const replies = () => socket.send.mock.calls.map(([response]) => JSON.parse(response));
    const broadcast = (topicId: string) => bridge.emit('message:new', { topicId, type: 'assistant', message: { role: 'assistant', content: 'Reply' } });
    return { manager, send, replies, broadcast };
}

describe('Host WebSocket topic routing', () => {
    it('subscribes to one Topic, routes sends and creation, and stops delivery after unsubscribe', async () => {
        const x = fixture();
        expect(x.replies()[0].type).toBe('init');
        await x.send({ type: 'subscribe', topicId: 'topic-a' });
        x.broadcast('topic-b');
        expect(x.replies()).toHaveLength(1);
        x.broadcast('topic-a');
        expect(x.replies().at(-1)).toEqual({ type: 'new_message', topicId: 'topic-a', message: expect.objectContaining({ content: 'Reply' }) });
        await x.send({ type: 'unsubscribe', topicId: 'topic-a' });
        x.broadcast('topic-a');
        expect(x.replies()).toHaveLength(2);
        await x.send({ type: 'create_session', topicId: 'topic-b' });
        expect(x.manager.ensureSessionForTopic).toHaveBeenCalledWith('topic-b');
        expect(x.replies().at(-1)).toEqual({ type: 'session_created', topicId: 'topic-b' });
        await x.send({ type: 'message', topicId: 'topic-b', content: 'Hello', messageId: 'm1' });
        expect(x.manager.switchTopic).toHaveBeenCalledWith('topic-b');
        expect(x.manager.sendUserMessage).toHaveBeenCalledWith('Hello', 'topic-b', 'm1');
        expect(x.replies().at(-1)).toEqual({ type: 'message_received', topicId: 'topic-b', messageId: 'm1' });
    });

    it('rejects malformed messages and retired routing aliases before switching or sending', async () => {
        const x = fixture();
        for (const message of ['not-json', { type: 'message', sessionId: 'old', content: 'wrong' },
            { type: 'create_session', desktopId: 'old' }, { type: 'send_message', topicId: 't', content: 'retired' },
            { type: 'message', topicId: 't', content: false }]) {
            await x.send(message);
            expect(x.replies().at(-1).type).toBe('error');
        }
        expect(x.manager.switchTopic).not.toHaveBeenCalled();
        expect(x.manager.sendUserMessage).not.toHaveBeenCalled();
        expect(x.manager.ensureSessionForTopic).not.toHaveBeenCalled();
    });
});
