/**
 * SPI Layer - Operation Types
 * 
 * 定义 Agent 与 Runtime 之间的操作交互协议。
 * 
 * 术语说明:
 * - Operation: 内部统一抽象，替代旧的 Command
 * - ToolCall: 外部 LLM 接口 (保持不变)
 * 
 * @module @aotui/runtime/spi
 */

// ============================================================================
// Operation Result (原 CommandAck)
// ============================================================================

/**
 * 操作错误
 *
 * 统一错误模型：
 * - code: 机器可读的错误代码
 * - message: 人类可读的错误描述
 * - context: 额外调试信息（可选）
 */
export interface OperationError {
    /** 错误代码（机器可读），如 E_INVALID_ARGS, E_NOT_FOUND */
    code: string;
    /** 错误描述（人类可读） */
    message: string;
    /** 额外上下文信息（可选，用于调试） */
    context?: Record<string, unknown>;
}

/**
 * 操作结果
 */
export interface OperationResult {
    success: boolean;
    data?: Record<string, unknown>;
    error?: OperationError;
    /** Application-declared effects on failure; omission leaves effects unknown. */
    effects?: 'none' | 'partial';
}
