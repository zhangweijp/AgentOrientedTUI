import { normalizeInteractionLimits } from '@aotui/core/host';
import { AOTUIError, normalizeProjectionLimits } from '@aotui/core';
import type { AppInteractionPolicy, ProjectionLimits, InteractionLimits } from '@aotui/core';
import { captureJsonOption, captureLaunchConfig, isRecord } from './launch-config.js';

const appInteractionFields = { toolsEnabled: 'boolean', projectionLimits: 'object', interactionLimits: 'object' } as const;
export const appInstallFields = {
    installationId: 'string', name: 'string', description: 'string', whatItIs: 'string', whenToUse: 'string',
    config: 'object', policy: 'object', ...appInteractionFields,
} as const;
export const pendingAppFields = {
    ...appInteractionFields, installationId: 'string', localPath: 'string', command: 'array', backend: 'string',
    name: 'string', description: 'string', whatItIs: 'string', whenToUse: 'string', config: 'object',
} as const;

function invalidToolsEnabled(): Error {
    return Object.assign(new Error('toolsEnabled must be an own enumerable boolean data property.'), { code: 'TOOLS_ENABLED_INVALID' });
}

function captureLimits(input: unknown, path: string): ProjectionLimits {
    try {
        return normalizeProjectionLimits(input, path);
    } catch (error) {
        throw new AOTUIError('CONFIG_INVALID', { path: (error as { path?: string })?.path ?? path,
            reason: error instanceof Error ? error.message : 'Invalid projection limits' });
    }
}

/** Validate and capture Host options before allocating or transferring ownership. */
export function captureOptions<T extends object>(
    options: T | undefined,
    fields: OptionFields,
    path = 'options',
): T | undefined {
    if (options === undefined) return undefined;
    if (!isRecord(options)) throw new AOTUIError('CONFIG_INVALID', { path, reason: 'Expected a plain object' });
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const captured: Record<string, unknown> = Object.create(null);
    for (const [key, expected] of Object.entries(fields)) {
        if (Object.hasOwn(descriptors, key) || !(key in options)) continue;
        if (key === 'toolsEnabled') throw invalidToolsEnabled();
        throw new AOTUIError('CONFIG_INVALID', { path: `${path}.${key}`, reason: `Expected an own enumerable ${expected} data property` });
    }
    for (const key of Reflect.ownKeys(descriptors)) {
        const fieldPath = `${path}.${String(key)}`;
        if (typeof key !== 'string' || !Object.hasOwn(fields, key)) {
            throw new AOTUIError('CONFIG_INVALID', { path: fieldPath, reason: 'Unknown field ' + String(key) });
        }
        const descriptor = descriptors[key]!;
        const expected = fields[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || (descriptor.value !== undefined &&
            (expected === 'object' ? !isRecord(descriptor.value)
                : expected === 'array' ? !Array.isArray(descriptor.value) : typeof descriptor.value !== expected))) {
            if (key === 'toolsEnabled') throw invalidToolsEnabled();
            throw new AOTUIError('CONFIG_INVALID', { path: fieldPath, reason: `Expected an enumerable ${expected} data property` });
        }
        const value = descriptor.value;
        captured[key] = key === 'config' ? captureLaunchConfig(value, fieldPath) :
            key === 'command' && value !== undefined ? captureJsonOption(value, fieldPath) : value;
    }
    return captured as T;
}

type OptionFields = Readonly<Record<string, 'boolean' | 'string' | 'object' | 'function' | 'array'>>;

export interface CapturedAppInteractionOptions {
    readonly toolsEnabled: boolean;
    readonly projectionLimits: ProjectionLimits;
    readonly interactionLimits: InteractionLimits;
}

export function captureInstallationOptions<T extends { toolsEnabled?: boolean; projectionLimits?: unknown; interactionLimits?: unknown }>(
    options: T | undefined, fields: OptionFields,
): T & CapturedAppInteractionOptions {
    const captured = captureOptions(options, fields) ?? (Object.create(null) as T);
    let interactionLimits: InteractionLimits;
    try { interactionLimits = normalizeInteractionLimits(captured.interactionLimits); }
    catch (error) { throw new AOTUIError('CONFIG_INVALID', { path: (error as {path?:string})?.path ?? 'options.interactionLimits', reason: error instanceof Error ? error.message : 'Invalid interaction limits' }); }
    return Object.assign(captured, {
        interactionLimits,
        toolsEnabled: captured.toolsEnabled !== false,
        projectionLimits: captureLimits(captured.projectionLimits, 'options.projectionLimits'),
    });
}

export function capturePolicy(policy: AppInteractionPolicy | undefined): AppInteractionPolicy | undefined {
    if (policy === undefined) return;
    try {
        const captured = captureOptions(policy, { project: 'function', authorize: 'function', canReadReceipt: 'function' }, 'options.policy');
        if (captured && typeof captured.project === 'function' && typeof captured.authorize === 'function' &&
            typeof captured.canReadReceipt === 'function') {
            return policy;
        }
    } catch { /* Report the invalid policy at the lifecycle boundary. */ }
    throw Object.assign(new TypeError('Provide project, authorize and canReadReceipt policy functions.'), { code: 'APP_INTERACTION_POLICY_INVALID' });
}
