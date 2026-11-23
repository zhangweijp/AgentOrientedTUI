import { isToolResultData } from '@aotui/core/internal';
import { canonicalJson, copyJson, utf8Size, type JsonCopyLimits } from '@aotui/core/internal';
import type { JsonValue } from '@aotui/core';
import type { ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';

/** Shared hard ceiling for bounded Worker IPC JSON envelopes. */
export const WORKER_MESSAGE_LIMITS = Object.freeze({
    maxDepth: 50,
    maxNodes: 32_000,
    maxApproxBytes: 512 * 1024,
    maxCanonicalBytes: 512 * 1024,
});

type JsonObject = Readonly<Record<string, JsonValue>>;

export function invocationObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exact(value: JsonObject, keys: readonly string[]): boolean {
    return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function text(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

/** Capture only bounded JSON data; getters, cycles, unsupported values and oversized data reject. */
export function captureInvocationJson(
    input: unknown,
    limits: JsonCopyLimits & { readonly maxCanonicalBytes: number } = WORKER_MESSAGE_LIMITS
): JsonValue {
    const value = copyJson(input, limits);
    if (utf8Size(canonicalJson(value)) > limits.maxCanonicalBytes) {
        throw new RangeError('Worker message exceeds budget');
    }
    return value;
}

export function invocationReceiver(value: JsonValue | undefined): boolean {
    return invocationObject(value) && exact(value, ['viewId', 'viewInstanceId', 'activationId']) &&
        text(value.viewId) && !value.viewId.includes('.') && text(value.viewInstanceId) && text(value.activationId);
}

export function invocationToolDescriptor(value: JsonValue | undefined): boolean {
    return invocationObject(value) && exact(value, ['id', 'name', 'viewType', 'multiplicity', 'description', 'inputSchema']) &&
        ['id', 'name', 'viewType', 'description'].every(key => text(value[key])) &&
        (value.multiplicity === 'single' || value.multiplicity === 'multiple') &&
        invocationObject(value.inputSchema) && value.inputSchema.type === 'object';
}

/** Capture and correlate a bounded invocation terminal without trusting Worker payloads. */
export function captureToolInvocationTerminal(
    input: unknown,
    expected: Readonly<{ requestId: string; appId: string; instanceId: string }>
): ViewToolInvocationTerminal | Readonly<{ phase: 'finished-unknown' }> | null {
    try {
        const value = captureInvocationJson(input);
        if (!invocationObject(value) || !exact(value, [
            'type', 'requestId', 'appId', 'instanceId', 'success', 'terminal',
        ]) || value.type !== 'VIEW_TOOL_INVOKE_RESPONSE' || value.requestId !== expected.requestId ||
            value.appId !== expected.appId || value.instanceId !== expected.instanceId ||
            value.success !== true || !invocationObject(value.terminal)) {
            return null;
        }
        const { phase, result } = value.terminal;
        if (phase === 'finished-unknown') return exact(value.terminal, ['phase']) ? { phase } : null;
        if (!exact(value.terminal, ['phase', 'result']) || (phase !== 'not-entered' && phase !== 'entered-returned') ||
            !isToolResultData(result) || (phase === 'not-entered' && result.success !== false)) {
            return null;
        }
        return value.terminal as unknown as ViewToolInvocationTerminal;
    } catch {
        return null;
    }
}
