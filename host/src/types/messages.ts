import type { MessageWithTimestamp } from '@aotui/agent-driver-v2';

export type Message = MessageWithTimestamp & { id: string };

export function createMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
