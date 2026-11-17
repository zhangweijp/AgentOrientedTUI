import { AOTUIError } from '../../spi/core/errors.js';
import { normalizeProjectionLimits } from '../../core/invocation/observation-registry.js';
import type { ProjectionLimits } from '../../core/invocation/observation-types.js';

export const appInteractionFields = { toolsEnabled: 'boolean', projectionLimits: 'object' } as const;
export const appInstallFields = {
    appId: 'string', name: 'string', description: 'string', whatItIs: 'string', whenToUse: 'string',
    config: 'object', ...appInteractionFields,
} as const;

function isRecord(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function invalidToolsEnabled(): Error {
    return Object.assign(new Error('toolsEnabled must be an own enumerable boolean data property.'), { code: 'TOOLS_ENABLED_INVALID' });
}

const capturedLimits = new WeakSet<ProjectionLimits>();
function captureLimits(input: unknown, path: string): ProjectionLimits {
    // Reuse the immutable value forwarded by another Host installation entry.
    if (input && typeof input === 'object' && capturedLimits.has(input as ProjectionLimits)) return input as ProjectionLimits;
    try {
        const limits = normalizeProjectionLimits(input, path);
        capturedLimits.add(limits);
        return limits;
    } catch (error) {
        throw new AOTUIError('CONFIG_INVALID', { path: (error as { path?: string })?.path ?? path,
            reason: error instanceof Error ? error.message : 'Invalid projection limits' });
    }
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
        captured[key] = key === 'projectionLimits' ? captureLimits(descriptor.value, fieldPath) : descriptor.value;
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

export function captureProjectionLimits(options?: object): ProjectionLimits {
    const path = 'options.projectionLimits';
    const field = options && Object.getOwnPropertyDescriptor(options, 'projectionLimits');
    if (options && (field ? !field.enumerable || !('value' in field) : 'projectionLimits' in options)) {
        throw new AOTUIError('CONFIG_INVALID', { path, reason: 'Expected an own enumerable projectionLimits data property' });
    }
    return captureLimits(field?.value, path);
}
