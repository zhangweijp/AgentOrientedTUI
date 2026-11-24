import { checkWireJson, isToolResultData } from '@aotui/core';
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

export function invocationReceiver(value: JsonValue | undefined): boolean {
    return invocationObject(value) && exact(value, ['viewId', 'viewInstanceId', 'activationId']) &&
        text(value.viewId) && !value.viewId.includes('.') && text(value.viewInstanceId) && text(value.activationId);
}

/** Capture and correlate a bounded invocation terminal without trusting Worker payloads. */
export function captureToolInvocationTerminal(
    input: unknown,
    expected: Readonly<{ requestId: string; appId: string; instanceId: string }>
): ViewToolInvocationTerminal | Readonly<{ phase: 'finished-unknown' }> | null {
    try {
        checkWireJson(input, WORKER_MESSAGE_LIMITS, true);
        const value = input;
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
