import type { MessageWithTimestamp } from '@aotui/agent-driver-v2'
import { createMessageId, type Message } from '../types/messages.js'
import { getDb, persistDatabase } from '../db/index.js'
import { readStoredMessage, type StoredMessageRow } from '../db/stored-message.js'

export function listIMMessages(sessionKey: string): Message[] {
  const db = getDb()
  const stmt = db.prepare(`
    SELECT id, role, content, timestamp
    FROM im_messages
    WHERE session_key = ?
    ORDER BY timestamp ASC, id ASC
  `)
  try {
    stmt.bind([sessionKey])
    const messages: Message[] = []
    while (stmt.step()) {
      messages.push(readStoredMessage(stmt.getAsObject() as unknown as StoredMessageRow))
    }
    return messages
  } finally {
    stmt.free()
  }
}

export function appendIMMessage(sessionKey: string, message: MessageWithTimestamp): string {
  const db = getDb()
  const id = createMessageId()
  db.run(
    `
      INSERT INTO im_messages (id, session_key, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `,
    [
      id,
      sessionKey,
      message.role,
      JSON.stringify(message.content),
      message.timestamp,
    ],
  )
  persistDatabase()
  return id
}

export function replaceIMMessages(sessionKey: string, messages: MessageWithTimestamp[], ids?: WeakMap<MessageWithTimestamp, string>): void {
  const db = getDb()
  db.run('DELETE FROM im_messages WHERE session_key = ?', [sessionKey])

  for (const message of messages) {
    const id = ids?.get(message) ?? createMessageId()
    db.run(
      `
        INSERT INTO im_messages (id, session_key, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `,
      [
        id,
        sessionKey,
        message.role,
        JSON.stringify(message.content),
        message.timestamp,
      ],
    )
    ids?.set(message, id)
  }

  persistDatabase()
}
