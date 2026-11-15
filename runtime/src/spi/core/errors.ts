/**
 * SPI Core Layer - Error System
 * 
 * 统一的错误处理机制，提供类型安全的错误码和结构化错误类。
 * 
 * @module @aotui/runtime/spi/core/errors
 */

const ERROR_MESSAGES = {
    // Desktop
    DESKTOP_NOT_FOUND: (c) => `Desktop '${c.desktopId ?? 'unknown'}' not found`,
    DESKTOP_DISPOSED: (c) => `Desktop '${c.desktopId ?? 'unknown'}' has been disposed`,

    // App
    APP_NOT_FOUND: (c) => `App '${c.appId ?? 'unknown'}' not found${c.desktopId ? ` in Desktop '${c.desktopId}'` : ''}`,
    APP_INVALID_EXPORT: (c) => `App module '${c.modulePath ?? 'unknown'}' must default-export an App factory created by createApp or createTUIApp`,

    APP_MANIFEST_INVALID: (c) => `Invalid App manifest at '${c.path ?? 'unknown'}': ${c.reason ?? 'expected generated aoapp.json'}`,
    APP_IDENTITY_MISMATCH: (c) => `App identity mismatch: expected '${c.expected ?? 'unknown'}', received '${c.actual ?? 'unknown'}' (${c.path ?? 'registration'})`,

    // App
    APP_ALREADY_REGISTERED: (c) => `App '${c.appName ?? 'unknown'}' is already registered. Choose a different App name or remove it before registering again.`,

    // Worker
    WORKER_NOT_STARTED: (c) => `Worker '${c.appId ?? 'unknown'}' not started`,

    // Config
    CONFIG_INVALID: (c) => `Invalid configuration: ${c.reason ?? 'unknown'}`,
    CONFIG_NOT_SUPPORTED: (c) => `Configuration not supported: ${c.feature ?? 'unknown'}`,

    // Generic
    RUNTIME_SHUTDOWN: (c) => `Runtime has been shut down${c.reason ? `: ${c.reason}` : ''}`,
} satisfies Record<string, (context: Record<string, unknown>) => string>;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

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
        super(Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code](context) : `[${code}]`);

        this.name = 'AOTUIError';
        this.code = code;
        this.context = context;
        this.timestamp = Date.now();
    }
}
