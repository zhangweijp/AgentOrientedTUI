import type { Database } from 'sql.js';
import type { Message } from '../types/messages.js';
import { readStoredMessage, type StoredMessageRow } from './stored-message.js';

interface MessageRow extends StoredMessageRow {
    topic_id: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 将 Message 转换为数据库行
 */
function messageToRow(topicId: string, message: Message): MessageRow {
    return {
        id: message.id,
        topic_id: topicId,
        role: message.role,
        content: JSON.stringify(message.content),
        timestamp: message.timestamp,
        provider_options: message.providerOptions
            ? JSON.stringify(message.providerOptions)
            : undefined,
    };
}

/**
 * 创建消息
 * 
 * 直接存储 AI SDK v6 的 ModelMessage
 */
export function createMessage(db: Database, topicId: string, message: Message): void {
    const row = messageToRow(topicId, message);

    db.run(`
        INSERT INTO messages_v2 (id, topic_id, role, content, timestamp, provider_options)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [
        row.id,
        row.topic_id,
        row.role,
        row.content,
        row.timestamp,
        row.provider_options || null
    ]);
}

/**
 * 获取话题的所有消息
 */
export function getMessages(db: Database, topicId: string): Message[] {
    const stmt = db.prepare('SELECT * FROM messages_v2 WHERE topic_id = ? ORDER BY timestamp ASC');
    try {
        stmt.bind([topicId]);
        const messages: Message[] = [];
        while (stmt.step()) {
            messages.push(readStoredMessage(stmt.getAsObject() as unknown as StoredMessageRow));
        }
        return messages;
    } finally {
        stmt.free();
    }
}

/**
 * 更新消息
 */
export function updateMessage(db: Database, topicId: string, message: Message): void {
    const row = messageToRow(topicId, message);

    db.run(`
        UPDATE messages_v2
        SET role = ?, content = ?, timestamp = ?, provider_options = ?
        WHERE id = ? AND topic_id = ?
    `, [
        row.role,
        row.content,
        row.timestamp,
        row.provider_options || null,
        row.id,
        row.topic_id,
    ]);
}

/**
 * 创建 messages_v2 表
 */
export function createMessagesTable(db: Database): void {
    db.run(`
        CREATE TABLE IF NOT EXISTS messages_v2 (
            id TEXT PRIMARY KEY,
            topic_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            provider_options TEXT,
            FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
        );
        
        CREATE INDEX IF NOT EXISTS idx_messages_v2_topic_id ON messages_v2(topic_id);
        CREATE INDEX IF NOT EXISTS idx_messages_v2_timestamp ON messages_v2(timestamp);
    `);
}
