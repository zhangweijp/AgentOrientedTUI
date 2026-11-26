/**
 * Runtime Configuration Builder
 * 
 */

import { WORKER_DEFAULTS } from './domains/worker.config.js';
import { LOGGER_DEFAULTS } from './domains/logger.config.js';
import { AOTUIError } from '@aotui/core';
import type { RuntimeConfig, RuntimeConfigInput } from './types.js';
import type { AppExecutionBackend } from '../runtime/execution-backend.js';

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
    worker: Object.freeze({ ...WORKER_DEFAULTS }),
    logger: Object.freeze({ ...LOGGER_DEFAULTS }),
});

function captureBackends(source: unknown): NonNullable<RuntimeConfig['executionBackends']> {
    const path = 'executionBackends';
    if (!isConfigRecord(source)) invalidConfiguration(path, 'must be a plain registry of named execution backends');
    const backends: Record<string, AppExecutionBackend> = Object.create(null);
    for (const key of Reflect.ownKeys(source)) {
        const field = path + '.' + String(key);
        if (typeof key !== 'string' || !key || key !== key.trim()) invalidConfiguration(field, 'provide a backend name');
        const value = readOwnEnumerableConfigValue(source, key, path) as AppExecutionBackend | undefined;
        const start = value && typeof value === 'object' ? value.start : undefined;
        if (typeof start !== 'function')
            invalidConfiguration(field, 'provide an execution backend with start()');
        backends[key] = Object.freeze({ start: start.bind(value) });
    }
    return Object.freeze(backends);
}

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
        if (!Object.hasOwn(targetRecord, key) && keyPath !== 'executionBackends') invalidConfiguration(keyPath, 'unknown configuration key');

        if (sourceValue === undefined) continue;

        const targetValue = targetRecord[key];
        if (keyPath === 'executionBackends') {
            (result as Record<string, unknown>)[key] = captureBackends(sourceValue);
        } else if (isConfigRecord(targetValue)) {
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
    if (!Number.isSafeInteger(worker.timeoutMs) || worker.timeoutMs < 1000 || worker.timeoutMs > 300_000) {
        errors.push('[worker.timeoutMs] worker.timeoutMs must be a safe integer between 1000ms and 300000ms');
    }
    if (worker.maxWorkers !== Number.POSITIVE_INFINITY &&
        (!Number.isSafeInteger(worker.maxWorkers) || worker.maxWorkers < 1 || worker.maxWorkers > 100)) {
        errors.push('[worker.maxWorkers] worker.maxWorkers must be positive Infinity or a safe integer between 1 and 100');
    }
    if (!(typeof logger.maxSystemLogs === 'number' && logger.maxSystemLogs >= 10 && logger.maxSystemLogs <= 10_000)) {
        errors.push('[logger.maxSystemLogs] logger.maxSystemLogs must be a number between 10 and 10000');
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
    Object.freeze(config.worker);
    Object.freeze(config.logger);
    return Object.freeze(config) as RuntimeConfig;
}
