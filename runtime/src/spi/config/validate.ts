/**
 * Runtime Configuration Validation
 * 
 * @module @aotui/runtime/spi/config
 */

import { AOTUIError } from '../core/errors.js';
import type { RuntimeConfig } from './types.js';

/** @internal Shared by the builder and public validator; not re-exported from the config entry. */
export function isConfigRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function invalidConfiguration(path: string, reason: string): never {
    throw new AOTUIError('CONFIG_INVALID', { reason: `[${path || 'configuration'}] ${reason}` });
}

export function readOwnEnumerableConfigValue(source: unknown, key: PropertyKey, parentPath = ''): unknown {
    if (!isConfigRecord(source)) invalidConfiguration(parentPath, 'must be a plain object');
    const keyPath = parentPath ? `${parentPath}.${String(key)}` : String(key);
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) invalidConfiguration(keyPath, 'property is missing');
    if (!('value' in descriptor)) invalidConfiguration(keyPath, 'accessor properties are not supported');
    if (!descriptor.enumerable) invalidConfiguration(keyPath, 'property must be enumerable');
    return descriptor.value;
}

function readConfigPath(config: unknown, path: string): unknown {
    let value = config;
    let parentPath = '';
    for (const key of path.split('.')) {
        value = readOwnEnumerableConfigValue(value, key, parentPath);
        parentPath = parentPath ? `${parentPath}.${key}` : key;
    }
    return value;
}

interface ValidationRule {
    path: string;
    validate: (config: RuntimeConfig) => boolean;
    message: string;
}

const VALIDATION_RULES: ValidationRule[] = [
    // Worker 规则
    {
        path: 'worker.timeoutMs',
        validate: (c) => typeof c.worker.timeoutMs === 'number' && c.worker.timeoutMs >= 1000 && c.worker.timeoutMs <= 300_000,
        message: 'worker.timeoutMs must be a number between 1000ms and 300000ms',
    },
    {
        path: 'worker.pool.maxSize',
        validate: (c) => {
            const initialSize = c.worker.pool.initialSize;
            const initialSizeIsValid = Number.isSafeInteger(initialSize) && initialSize >= 0 && initialSize <= 100;
            return Number.isSafeInteger(c.worker.pool.maxSize) && c.worker.pool.maxSize >= 1 && c.worker.pool.maxSize <= 100 &&
                (!initialSizeIsValid || c.worker.pool.maxSize >= initialSize);
        },
        message: 'worker.pool.maxSize must be a safe integer between 1 and 100 and >= worker.pool.initialSize',
    },
    {
        path: 'worker.pool.initialSize',
        validate: (c) => Number.isSafeInteger(c.worker.pool.initialSize) && c.worker.pool.initialSize >= 0 && c.worker.pool.initialSize <= 100,
        message: 'worker.pool.initialSize must be between 0 and 100',
    },
    {
        path: 'worker.pool.idleTimeoutMs',
        validate: (c) => Number.isSafeInteger(c.worker.pool.idleTimeoutMs) && c.worker.pool.idleTimeoutMs >= 5000 && c.worker.pool.idleTimeoutMs <= 600_000,
        message: 'worker.pool.idleTimeoutMs must be between 5000ms and 600000ms',
    },

    // Logger 规则
    {
        path: 'logger.maxSystemLogs',
        validate: (c) => typeof c.logger.maxSystemLogs === 'number' && c.logger.maxSystemLogs >= 10 && c.logger.maxSystemLogs <= 10000,
        message: 'logger.maxSystemLogs must be a number between 10 and 10000',
    },
    {
        path: 'logger.maxAppLogs',
        validate: (c) => typeof c.logger.maxAppLogs === 'number' && c.logger.maxAppLogs >= 10 && c.logger.maxAppLogs <= 10000,
        message: 'logger.maxAppLogs must be a number between 10 and 10000',
    },
];

/**
 * 验证运行时配置
 * 
 * @throws {AOTUIError} CONFIG_INVALID 如果任何规则失败
 */
export function validateRuntimeConfig(config: RuntimeConfig): void {
    const errors: string[] = [];
    const safeConfig: RuntimeConfig = {
        worker: {
            timeoutMs: readConfigPath(config, 'worker.timeoutMs') as number,
            pool: {
                initialSize: readConfigPath(config, 'worker.pool.initialSize') as number,
                maxSize: readConfigPath(config, 'worker.pool.maxSize') as number,
                idleTimeoutMs: readConfigPath(config, 'worker.pool.idleTimeoutMs') as number,
            },
        },
        logger: {
            maxSystemLogs: readConfigPath(config, 'logger.maxSystemLogs') as number,
            maxAppLogs: readConfigPath(config, 'logger.maxAppLogs') as number,
        },
    };

    for (const rule of VALIDATION_RULES) {
        if (!rule.validate(safeConfig)) {
            errors.push(`[${rule.path}] ${rule.message}`);
        }
    }

    if (errors.length > 0) {
        // 使用简化的上下文对象以避免循环引用或巨大对象
        throw new AOTUIError('CONFIG_INVALID', {
            reason: errors.join('; '),
            // 不要在错误消息中包含完整 config，可能会很大
        });
    }
}
