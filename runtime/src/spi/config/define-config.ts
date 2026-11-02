/**
 * Runtime Configuration Builder
 * 
 * @module @aotui/runtime/spi/config
 */

import { WORKER_DEFAULTS } from './domains/worker.config.js';
import { LOGGER_DEFAULTS } from './domains/logger.config.js';
import { AOTUIError } from '../core/errors.js';
import type { RuntimeConfig, RuntimeConfigInput } from './types.js';

function isConfigRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function invalidConfiguration(path: string, reason: string): never {
    throw new AOTUIError('CONFIG_INVALID', { reason: `[${path || 'configuration'}] ${reason}` });
}

function readOwnEnumerableConfigValue(source: unknown, key: PropertyKey, parentPath = ''): unknown {
    if (!isConfigRecord(source)) invalidConfiguration(parentPath, 'must be a plain object');
    const keyPath = parentPath ? `${parentPath}.${String(key)}` : String(key);
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) invalidConfiguration(keyPath, 'property is missing');
    if (!('value' in descriptor)) invalidConfiguration(keyPath, 'accessor properties are not supported');
    if (!descriptor.enumerable) invalidConfiguration(keyPath, 'property must be enumerable');
    return descriptor.value;
}

/**
 * 完整默认配置
 */
export const RUNTIME_DEFAULTS: RuntimeConfig = Object.freeze({
    worker: Object.freeze({
        timeoutMs: WORKER_DEFAULTS.timeoutMs,
        pool: Object.freeze({ ...WORKER_DEFAULTS.pool }),
    }),
    logger: Object.freeze({ ...LOGGER_DEFAULTS }),
});

/**
 * 深度合并 plain own enumerable data properties，并在同一次遍历中校验形状和字段。
 */
function mergeConfig<T extends object>(target: T, source: unknown, path = ''): T {
    if (!isConfigRecord(source)) invalidConfiguration(path, 'must be a plain object');
    const result = { ...target } as T;
    const targetRecord = target as unknown as Record<string, unknown>;

    for (const key of Reflect.ownKeys(source)) {
        const keyText = String(key);
        const keyPath = path ? `${path}.${keyText}` : keyText;
        const sourceValue = readOwnEnumerableConfigValue(source, key, path);
        if (typeof key !== 'string') invalidConfiguration(keyPath, 'configuration keys must be strings');
        if (!Object.hasOwn(targetRecord, key)) invalidConfiguration(keyPath, 'unknown configuration key');

        if (sourceValue === undefined) continue;

        const targetValue = targetRecord[key];
        if (isConfigRecord(targetValue)) {
            if (!isConfigRecord(sourceValue)) invalidConfiguration(keyPath, 'must be a plain object');
            (result as Record<string, unknown>)[key] = mergeConfig(targetValue, sourceValue, keyPath);
        } else {
            (result as Record<string, unknown>)[key] = sourceValue;
        }
    }

    return result;
}

function validateRuntimeConfig(config: RuntimeConfig): void {
    const errors: string[] = [];
    const { worker, logger } = config;
    const initialSizeIsValid = Number.isSafeInteger(worker.pool.initialSize) &&
        worker.pool.initialSize >= 0 && worker.pool.initialSize <= 100;

    if (!(typeof worker.timeoutMs === 'number' && worker.timeoutMs >= 1000 && worker.timeoutMs <= 300_000)) {
        errors.push('[worker.timeoutMs] worker.timeoutMs must be a number between 1000ms and 300000ms');
    }
    if (!Number.isSafeInteger(worker.pool.maxSize) || worker.pool.maxSize < 1 || worker.pool.maxSize > 100 ||
        (initialSizeIsValid && worker.pool.maxSize < worker.pool.initialSize)) {
        errors.push('[worker.pool.maxSize] worker.pool.maxSize must be a safe integer between 1 and 100 and >= worker.pool.initialSize');
    }
    if (!initialSizeIsValid) {
        errors.push('[worker.pool.initialSize] worker.pool.initialSize must be between 0 and 100');
    }
    if (!Number.isSafeInteger(worker.pool.idleTimeoutMs) || worker.pool.idleTimeoutMs < 5000 || worker.pool.idleTimeoutMs > 600_000) {
        errors.push('[worker.pool.idleTimeoutMs] worker.pool.idleTimeoutMs must be between 5000ms and 600000ms');
    }
    if (!(typeof logger.maxSystemLogs === 'number' && logger.maxSystemLogs >= 10 && logger.maxSystemLogs <= 10_000)) {
        errors.push('[logger.maxSystemLogs] logger.maxSystemLogs must be a number between 10 and 10000');
    }
    if (!(typeof logger.maxAppLogs === 'number' && logger.maxAppLogs >= 10 && logger.maxAppLogs <= 10_000)) {
        errors.push('[logger.maxAppLogs] logger.maxAppLogs must be a number between 10 and 10000');
    }

    if (errors.length > 0) {
        throw new AOTUIError('CONFIG_INVALID', { reason: errors.join('; ') });
    }
}

/**
 * 定义运行时配置
 * 
 * 将用户配置与默认配置合并，并进行验证。
 * 
 * @param input 用户配置（可选部分）
 * @returns 完整的运行时配置（所有字段填充）
 * @throws {AOTUIError} CONFIG_INVALID 如果配置验证失败
 * 
 * @example
 * ```typescript
 * // 使用全部默认配置
 * const config = defineRuntimeConfig();
 * 
 * // 覆盖特定值
 * const config = defineRuntimeConfig({
 *   worker: { timeoutMs: 60_000 }
 * });
 * ```
 */
export function defineRuntimeConfig(input: RuntimeConfigInput = {}): RuntimeConfig {
    const config = mergeConfig(RUNTIME_DEFAULTS, input);
    validateRuntimeConfig(config);
    Object.freeze(config.worker.pool);
    Object.freeze(config.worker);
    Object.freeze(config.logger);
    return Object.freeze(config) as RuntimeConfig;
}
