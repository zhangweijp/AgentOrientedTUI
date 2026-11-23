export const WORKER_PROTOCOL = 'app-worker/v6' as const;

/**
 * Worker Protocol - Type Definitions
 * 
 * 基础类型定义，用于 Worker IPC 通信。
 * 
 * [架构原则] 这里重新导出 SPI 中已有的类型，保持单一来源。
 * 
 * @module @aotui/runtime/spi/worker-protocol
 */

import type { AppID, DesktopID } from '@aotui/core';

// ============================================================================
// Re-export core types for convenience
// ============================================================================

export type { AppID, DesktopID };

export type RequestID = string;

export function generateRequestId(): RequestID {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
