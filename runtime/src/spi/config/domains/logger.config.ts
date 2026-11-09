/**
 * Logger Config Domain
 */

/**
 * Logger 配置
 */
export interface LoggerConfig {
    /**
     * 每个 Desktop 最大系统日志条数
     * 
     * @default 100
     * @rationale 内存与调试信息的平衡。
     * @range [10, 10000]
     */
    readonly maxSystemLogs: number;


}

/**
 * Logger 默认配置
 */
export const LOGGER_DEFAULTS: LoggerConfig = {
    maxSystemLogs: 100,
} as const;
