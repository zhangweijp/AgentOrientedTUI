/**
 * SPI Layer - Operation Log Types
 * 
 * Defines the structure for operation execution logs that capture:
 * - WHO: The agent/actor that initiated the operation
 * - WHEN: Timestamp and duration of execution
 * - WHERE: Desktop > App > View hierarchy
 * - WHAT: Operation name, result, and semantic description
 * 
 * @module @aotui/runtime/spi
 */

import type { AppID, ViewID, DesktopID, OperationID } from './types.js';

// ============================================================================
// Operation Log Entry
// ============================================================================

/**
 * Operation execution scope
 */
export type OperationLogScope = 'system' | 'app';

/**
 * Operation Log Entry
 * 
 * Captures complete context of an operation execution for debugging,
 * monitoring, and Agent awareness.
 * 
 * @example
 * ```typescript
 * const entry: OperationLogEntry = {
 *     id: 'log_001',
 *     actor: 'Gemini',
 *     timestamp: Date.now(),
 *     durationMs: 12,
 *     desktopId: 'desktop_0' as DesktopID,
 *     appId: 'app_chat' as AppID,
 *     appName: 'System-Chat',
 *     viewId: 'view_0' as ViewID,
 *     viewName: 'ChatView',
 *     scope: 'app',
 *     operationName: 'send_message' as OperationID,
 *     keyArgs: { content: 'Hello...' },
 *     success: true,
 *     semanticDescription: '15:32:45 ✅ Gemini in System-Chat/ChatView sent message "Hello..." (12ms)'
 * };
 * ```
 */
export interface OperationLogEntry {
    /** Unique log entry ID */
    id: string;

    // === WHO ===
    /** Actor who initiated (e.g., "Gemini", "DeepSeek", "User") */
    actor: string;

    // === WHEN ===
    /** Execution start timestamp */
    timestamp: number;
    /** Execution duration in milliseconds */
    durationMs: number;

    // === WHERE ===
    /** Desktop ID */
    desktopId: DesktopID;
    /** Target App ID (for app/view operations) */
    appId?: AppID;
    /** App display name (for human-readable logs) */
    appName?: string;
    /** Target View ID (for view operations) */
    viewId?: ViewID;
    /** View display name */
    viewName?: string;

    // === WHAT ===
    /** Operation scope */
    scope: OperationLogScope;
    /** Operation name */
    operationName: OperationID;
    /** Key arguments (sanitized, no sensitive data) */
    keyArgs: Record<string, string>;
    /** Execution result */
    success: boolean;
    /** Error message if failed */
    errorMessage?: string;
    /** Human-readable semantic description */
    semanticDescription: string;
}

// ============================================================================
// Log Entry Builder Helper
// ============================================================================

/**
 * Parameters for building an operation log entry
 */
export interface OperationLogParams {
    actor: string;
    desktopId: DesktopID;
    scope: OperationLogScope;
    operationName: OperationID;
    args: Record<string, unknown>;
    success: boolean;
    durationMs: number;
    appId?: AppID;
    appName?: string;
    viewId?: ViewID;
    viewName?: string;
    errorMessage?: string;
}
