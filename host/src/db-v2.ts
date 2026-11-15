/**
 * @aotui/host - Database V2
 * 
 * 直接存储 AI SDK v6 的 ModelMessage
 * 
 * 设计原则:
 * - ✅ 完全对齐 AI SDK v6
 * - ✅ 零转换成本
 * - ✅ 极简 schema
 */

import type { Database } from 'sql.js';
import type { Message, MessageRow } from './types-v2.js';
import { messageToRow, rowToMessage } from './types-v2.js';

// ============================================================================
// Messages CRUD
// ============================================================================

/**
 * 创建消息 (V2 格式)
 * 
 * 直接存储 AI SDK v6 的 ModelMessage
 */
export function createMessageV2(db: Database, topicId: string, message: Message): void {
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
 * 获取话题的所有消息 (V2 格式)
 */
export function getMessagesV2(db: Database, topicId: string): Message[] {
    const stmt = db.prepare('SELECT * FROM messages_v2 WHERE topic_id = ? ORDER BY timestamp ASC');
    stmt.bind([topicId]);

    const messages: Message[] = [];
    while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as MessageRow;
        messages.push(rowToMessage(row));
    }
    stmt.free();

    return messages;
}

/**
 * 删除消息 (V2 格式)
 */
export function deleteMessageV2(db: Database, id: string): void {
    db.run('DELETE FROM messages_v2 WHERE id = ?', [id]);
}

/**
 * 更新消息 (V2 格式)
 */
export function updateMessageV2(db: Database, topicId: string, message: Message): void {
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
export function createMessagesV2Table(db: Database): void {
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
