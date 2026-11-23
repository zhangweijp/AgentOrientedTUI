import { toolModelMessageSchema } from 'ai';
import type { Message } from '../types/messages.js';

export interface StoredMessageRow {
    id: string;
    role: Message['role'];
    content: string;
    timestamp: number;
    provider_options?: string | null;
}

export function readStoredMessage(row: StoredMessageRow): Message {
    const message = {
        id: row.id,
        role: row.role,
        content: JSON.parse(row.content),
        timestamp: row.timestamp,
        ...(row.provider_options ? { providerOptions: JSON.parse(row.provider_options) } : {}),
    } as Message;
    if (message.role === 'tool' && !toolModelMessageSchema.safeParse(message).success) {
        throw new Error(`Stored tool message ${message.id} uses an unsupported format. Start a new conversation to continue.`);
    }
    return message;
}
