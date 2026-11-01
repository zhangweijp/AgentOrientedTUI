/**
 * Runtime Configuration Builder
 * 
 * @module @aotui/runtime/spi/config
 */

import { WORKER_DEFAULTS } from './domains/worker.config.js';
import { LOGGER_DEFAULTS } from './domains/logger.config.js';
import { invalidConfiguration, isConfigRecord, readOwnEnumerableConfigValue, validateRuntimeConfig } from './validate.js';
import type { RuntimeConfig, RuntimeConfigInput } from './types.js';

/**
 * 完整默认配置
 */
export const RUNTIME_DEFAULTS: RuntimeConfig = {
    worker: WORKER_DEFAULTS,
    logger: LOGGER_DEFAULTS,
} as const;

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
    return Object.freeze(config) as RuntimeConfig;
}
