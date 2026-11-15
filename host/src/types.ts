/**
 * AOTUI System Chat - Type Definitions
 * 
 * Core data models for the chat application
 */

import type { SourceControlsSnapshot } from './core/source-controls.js';

/**
 * Message role - who sent the message
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Message type - what kind of message this is
 */
export type MessageType = 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'snapshot';

export interface ImageAttachment {
    id: string;
    /** MIME type, e.g. image/png or application/pdf */
    mime: string;
    /** data: URL (preferred) or external URL */
    url: string;
    filename?: string;
}

/**
 * A single chat message
 */
export interface Message {
    /** Unique message ID */
    id: string;
    /** Who sent this message */
    role: MessageRole;
    /** Message content (plain text) */
    content: string;
    /** Unix timestamp when message was sent */
    timestamp: number;
    /** Message type - distinguishes text, reasoning, tool calls, etc. */
    messageType?: MessageType;
    /** Additional metadata for special message types */
    metadata?: {
        /** For reasoning messages */
        reasoning?: string;
        /** For tool call messages */
        toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
        /** For tool result messages */
        toolResults?: Array<{ toolCallId: string; toolName: string; result: unknown; isError: boolean }>;
        /** For snapshot messages */
        appId?: string;
        /** Generic metadata */
        attachments?: ImageAttachment[];
        [key: string]: any;
    };
}

/**
 * Topic (conversation topic = Desktop)
 */
export interface Topic {
    /** Unique topic ID (maps to Desktop ID) */
    id: string;
    /** Topic title */
    title: string;
    /** Creation timestamp */
    createdAt: number;
    /** Last update timestamp */
    updatedAt: number;
    /** Desktop lifecycle status */
    status: 'hot' | 'warm' | 'cold';

    // ─────────────────────────────────────────────────────────────
    //  Chat App Enhancement Fields
    // ─────────────────────────────────────────────────────────────

    /** Agent-defined topic summary (set via the update_topic Tool) */
    summary?: string;
    /** Agent-defined conversation stage (e.g., "需求澄清", "任务执行", "交付确认") */
    stage?: string;
    /** Timestamp of last Agent snapshot pull (for unread tracking) */
    lastSnapshotTime?: number;
    // [RFC-025] Project Association
    projectId?: string;
    /** Topic-level model override (e.g. provider:model) */
    modelOverride?: string;
    /** Topic-level prompt override (stored as plain text snapshot) */
    promptOverride?: string;
    /** Topic-level agent override */
    agentId?: string;
    /** Topic-level capability/source control override snapshot */
    sourceControls?: SourceControlsSnapshot;
    /** Topic-level context compaction policy override */
    contextCompaction?: {
        enabled?: boolean;
        minMessages?: number;
        keepRecentMessages?: number;
        hardFallbackThresholdTokens?: number;
    };
}

export interface Project {
    id: string;
    path: string;
    name: string;
    lastOpenedAt?: number;
    createdAt: number;
}
