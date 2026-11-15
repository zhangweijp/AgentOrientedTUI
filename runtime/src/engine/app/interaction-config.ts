import { AOTUIError } from '../../spi/core/errors.js';

export const appInstallFields = {
    appId: 'string', name: 'string', description: 'string', whatItIs: 'string', whenToUse: 'string',
    config: 'object', toolsEnabled: 'boolean', workerScriptPath: 'string',
} as const;

function isRecord(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function invalidToolsEnabled(): Error {
    return Object.assign(new Error('toolsEnabled must be an own enumerable boolean data property.'), { code: 'TOOLS_ENABLED_INVALID' });
}

/** Validate and capture Host options before allocating or transferring ownership. */
export function captureOptions<T extends object>(
    options: T | undefined,
    fields: Readonly<Record<string, 'boolean' | 'string' | 'object'>>,
    path = 'options',
): T | undefined {
    if (options === undefined) return undefined;
    if (!isRecord(options)) throw new AOTUIError('CONFIG_INVALID', { path, reason: 'Expected a plain object' });
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const captured: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
        const fieldPath = `${path}.${String(key)}`;
        if (typeof key !== 'string' || !Object.hasOwn(fields, key)) {
            throw new AOTUIError('CONFIG_INVALID', { path: fieldPath, reason: 'Unknown field ' + String(key) });
        }
        const descriptor = descriptors[key]!;
        const expected = fields[key];
        if (!descriptor.enumerable || !('value' in descriptor) || (descriptor.value !== undefined &&
            (expected === 'object' ? !isRecord(descriptor.value) : typeof descriptor.value !== expected))) {
            if (key === 'toolsEnabled') throw invalidToolsEnabled();
            throw new AOTUIError('CONFIG_INVALID', { path: fieldPath, reason: `Expected an enumerable ${expected} data property` });
        }
        captured[key] = descriptor.value;
    }
    return captured as T;
}

export function captureToolsEnabled(options?: object): boolean | undefined {
    if (options === undefined) return undefined;
    const field = Object.getOwnPropertyDescriptor(options, 'toolsEnabled');
    if (!field && !('toolsEnabled' in options)) return undefined;
    if (field?.enumerable && 'value' in field && (field.value === undefined || typeof field.value === 'boolean')) return field.value;
    throw invalidToolsEnabled();
}
