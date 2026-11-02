/**
 * AOTUI Runtime Configuration SPI
 * 
 * Unified source of truth for all runtime configurations.
 * 
 * @module @aotui/runtime/spi/config
 */

// 类型导出
export type { RuntimeConfig, RuntimeConfigInput, DeepPartial } from './types.js';

// 领域配置导出
export { WORKER_DEFAULTS, type WorkerConfig, type WorkerPoolConfig } from './domains/worker.config.js';
export { LOGGER_DEFAULTS, type LoggerConfig } from './domains/logger.config.js';

// 核心函数导出
export { defineRuntimeConfig, RUNTIME_DEFAULTS } from './define-config.js';
