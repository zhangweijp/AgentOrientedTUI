/**
 * SPI Core Layer - Error System
 * 
 * 统一的错误处理机制，提供类型安全的错误码和结构化错误类。
 * 
 * @module @aotui/runtime/spi/core/errors
 */

// ============================================================================
// Error Code Registry (按域分组)
// ============================================================================

/**
 * AOTUI 错误码常量
 * 
 * 命名规范: DOMAIN_SPECIFIC_ERROR
 * 例如: DESKTOP_NOT_FOUND, CONFIG_INVALID
 */
export const ERROR_CODES = {
    // ─────────────────────────────────────────────────────────────
    //  Desktop Domain
    // ─────────────────────────────────────────────────────────────
    DESKTOP_NOT_FOUND: 'DESKTOP_NOT_FOUND',
    DESKTOP_DISPOSED: 'DESKTOP_DISPOSED',

    // ─────────────────────────────────────────────────────────────
    //  App Domain
    // ─────────────────────────────────────────────────────────────
    APP_NOT_FOUND: 'APP_NOT_FOUND',
    APP_INVALID_EXPORT: 'APP_INVALID_EXPORT',

    // ─────────────────────────────────────────────────────────────
    //  Operation Domain
    // ─────────────────────────────────────────────────────────────
    OPERATION_DUPLICATE: 'OPERATION_DUPLICATE',

    // ─────────────────────────────────────────────────────────────
    //  Worker Domain
    // ─────────────────────────────────────────────────────────────
    WORKER_NOT_STARTED: 'WORKER_NOT_STARTED',

    // ─────────────────────────────────────────────────────────────
    //  Config Domain
    // ─────────────────────────────────────────────────────────────
    CONFIG_INVALID: 'CONFIG_INVALID',
    CONFIG_NOT_SUPPORTED: 'CONFIG_NOT_SUPPORTED',

    // ─────────────────────────────────────────────────────────────
    //  Generic
    // ─────────────────────────────────────────────────────────────
    RUNTIME_SHUTDOWN: 'RUNTIME_SHUTDOWN',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/**
 * 错误码类型
 */
export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// ============================================================================
// Error Message Templates
// ============================================================================

type MessageFormatter = (ctx: Record<string, unknown>) => string;

/**
 * 错误消息模板
 * 
 * 每个错误码对应一个消息格式化函数，接收 context 参数生成人类可读的消息。
 */
const ERROR_MESSAGES: Record<ErrorCode, MessageFormatter> = {
    // Desktop
    DESKTOP_NOT_FOUND: (c) => `Desktop '${c.desktopId ?? 'unknown'}' not found`,
    DESKTOP_DISPOSED: (c) => `Desktop '${c.desktopId ?? 'unknown'}' has been disposed`,

    // App
    APP_NOT_FOUND: (c) => `App '${c.appId ?? 'unknown'}' not found${c.desktopId ? ` in Desktop '${c.desktopId}'` : ''}`,
    APP_INVALID_EXPORT: (c) => `App module '${c.modulePath ?? 'unknown'}' must default-export a managed TUIAppFactory component factory`,

    // Operation
    OPERATION_DUPLICATE: (c) => `Operation '${c.operationName ?? 'unknown'}' is already registered`,

    // Worker
    WORKER_NOT_STARTED: (c) => `Worker '${c.appId ?? 'unknown'}' not started`,

    // Config
    CONFIG_INVALID: (c) => `Invalid configuration: ${c.reason ?? 'unknown'}`,
    CONFIG_NOT_SUPPORTED: (c) => `Configuration not supported: ${c.feature ?? 'unknown'}`,

    // Generic
    RUNTIME_SHUTDOWN: (c) => `Runtime has been shut down${c.reason ? `: ${c.reason}` : ''}`,
    INTERNAL_ERROR: (c) => `Internal error: ${c.message ?? 'unknown'}`,
};

// ============================================================================
// AOTUIError Class
// ============================================================================

/**
 * AOTUI 框架错误基类
 * 
 * 提供结构化错误信息，包含类型安全的错误码和上下文数据。
 * 
 * @example
 * ```typescript
 * // 抛出错误
 * throw new AOTUIError('DESKTOP_NOT_FOUND', { desktopId: 'abc123' });
 * ```
 */
export class AOTUIError extends Error {
    /**
     * 错误码 (类型安全)
     */
    readonly code: ErrorCode;

    /**
     * 错误上下文 (结构化调试信息)
     */
    readonly context: Record<string, unknown>;

    /**
     * 错误发生时间戳
     */
    readonly timestamp: number;

    constructor(code: ErrorCode, context: Record<string, unknown> = {}) {
        const message = AOTUIError.formatMessage(code, context);
        super(message);

        this.name = 'AOTUIError';
        this.code = code;
        this.context = context;
        this.timestamp = Date.now();

        // 保持原型链正确 (TypeScript 继承 Error 的已知问题)
        Object.setPrototypeOf(this, AOTUIError.prototype);
    }

    /**
     * 格式化错误消息
     */
    private static formatMessage(code: ErrorCode, context: Record<string, unknown>): string {
        const formatter = ERROR_MESSAGES[code];
        if (formatter) {
            return formatter(context);
        }
        return `[${code}]`;
    }
}
