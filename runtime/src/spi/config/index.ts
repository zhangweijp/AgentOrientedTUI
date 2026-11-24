/**
 * AOTUI Runtime Configuration SPI
 * 
 * Unified source of truth for all runtime configurations.
 * 
 */

// 类型导出
export type { RuntimeConfig, RuntimeConfigInput, DeepPartial } from './types.js';

// 领域配置导出
export { WORKER_DEFAULTS, type WorkerConfig } from './domains/worker.config.js';
export { LOGGER_DEFAULTS, type LoggerConfig } from './domains/logger.config.js';

// 核心函数导出
export { defineRuntimeConfig, RUNTIME_DEFAULTS } from './define-config.js';
