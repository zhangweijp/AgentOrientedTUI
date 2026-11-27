import { AOTUIError, copyJson, SnapshotDataError } from '@aotui/core';
import type { AppLaunchConfig } from '@aotui/core';

export function isRecord(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function captureJsonOption(value: unknown, path: string): object {
    try {
        return copyJson(value, { maxDepth: 48, maxNodes: 100_000, maxApproxBytes: 4 * 1024 * 1024 }) as object;
    } catch (error) {
        throw new AOTUIError('CONFIG_INVALID', {
            path: error instanceof SnapshotDataError ? path + error.path.slice(1) : path,
            reason: error instanceof Error ? error.message : 'Expected JSON launch configuration',
        });
    }
}

/** Capture the same bounded JSON contract at installation and at the execution entry. */
export function captureLaunchConfig(value: unknown, path: string): Readonly<AppLaunchConfig> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new AOTUIError('CONFIG_INVALID', { path, reason: 'Expected a plain object' });
    return captureJsonOption(value, path) as Readonly<AppLaunchConfig>;
}
