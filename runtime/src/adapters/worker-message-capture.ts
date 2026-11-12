import { isToolResultData } from '../spi/core/tool-result.js';
import { SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY } from '../spi/worker-protocol/types.js';
import { canonicalJson, copyJson, utf8Size, type JsonCopyLimits } from '../core/snapshot/json.js';
import type { JsonValue } from '../core/snapshot/types.js';
import { VIEW_TYPE_PARAMETERS_MODE } from '../core/tool/ordinary-parameter-contract.js';
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

type ViewToolCapabilityCapture =
    | Readonly<{ ok: true; capabilities: readonly string[] }>
    | Readonly<{ ok: false; code: 'WORKER_CAPABILITY_UNSUPPORTED' | 'WORKER_CAPABILITY_INVALID' }>;

/** Capture the bounded capability list and validate it against the current Worker protocol. */
export function captureViewToolCapabilities(input: unknown): ViewToolCapabilityCapture {
    try {
        const capabilities = captureInvocationJson(input === undefined ? [] : input,
            { maxDepth: 1, maxNodes: 7, maxApproxBytes: 512, maxCanonicalBytes: 512 });
        if (!Array.isArray(capabilities) || capabilities.length > 2 ||
            !capabilities.every(item => text(item) && item.length <= 128) || new Set(capabilities).size !== capabilities.length) {
            return Object.freeze({ ok: false, code: 'WORKER_CAPABILITY_INVALID' });
        }
        if (!capabilities.every(item => item === PARAMETERS_V4_CAPABILITY || item === SNAPSHOT_CAPABILITY)) {
            return Object.freeze({ ok: false, code: 'WORKER_CAPABILITY_UNSUPPORTED' });
        }
        return Object.freeze({ ok: true, capabilities });
    } catch { return Object.freeze({ ok: false, code: 'WORKER_CAPABILITY_INVALID' }); }
}

/** Validate the observed execution branch without accepting extra transport fields. */
export function invocationExecution(value: JsonValue | undefined): boolean {
    return invocationObject(value) && value.kind === 'view-type' && exact(value, ['kind', 'activationId']) && text(value.activationId);
}

/** Strict data shape for the V3 public Tool descriptor carried over Worker IPC. */
export function invocationToolDescriptorV3(value: JsonValue | undefined): boolean {
    return invocationObject(value) && exact(value, ['id', 'name', 'viewType', 'description', 'inputSchema', 'execution']) &&
        ['id', 'name', 'viewType', 'description'].every(key => text(value[key])) &&
        invocationObject(value.inputSchema) && value.inputSchema.type === 'object' && invocationExecution(value.execution);
}

/** Capture and correlate a bounded invocation terminal without trusting Worker payloads. */
export function captureTypeParametersTerminal(
    input: unknown,
    expected: Readonly<{ requestId: string; appId: string; instanceId: string }>
): ViewToolInvocationTerminal | Readonly<{ phase: 'finished-unknown' }> | null {
    try {
        const value = captureInvocationJson(input);
        if (!invocationObject(value) || !exact(value, [
            'type', 'requestId', 'appId', 'instanceId', 'argumentMode', 'success', 'terminal',
        ]) || value.type !== 'VIEW_TOOL_INVOKE_V4_RESPONSE' || value.requestId !== expected.requestId ||
            value.appId !== expected.appId || value.instanceId !== expected.instanceId ||
            value.argumentMode !== VIEW_TYPE_PARAMETERS_MODE || value.success !== true || !invocationObject(value.terminal)) {
            return null;
        }
        const { phase, result, failureEffects } = value.terminal;
        if (phase === 'finished-unknown') return exact(value.terminal, ['phase']) ? { phase } : null;
        if (!exact(value.terminal, ['phase', 'result', ...(Object.hasOwn(value.terminal, 'failureEffects') ? ['failureEffects'] : [])])) return null;
        if (!['not-entered', 'entered-returned'].includes(phase as string) || !isToolResultData(result) ||
            phase === 'not-entered' && result.success !== false ||
            Object.hasOwn(value.terminal, 'failureEffects') &&
                (phase !== 'entered-returned' || result.success !== false || failureEffects !== 'none' && failureEffects !== 'partial')) {
            return null;
        }
        return value.terminal as unknown as ViewToolInvocationTerminal;
    } catch {
        return null;
    }
}
