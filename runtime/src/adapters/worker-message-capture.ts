import { isToolResultData } from '../spi/core/tool-result.js';
import { SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY } from '../spi/worker-protocol/types.js';
export { SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY };
import { canonicalJson, copyJson, utf8Size, type JsonCopyLimits } from '../core/snapshot/json.js';
import type { JsonValue, ObservedToolExecutionV3, ToolDescriptorV3 } from '../core/snapshot/types.js';
import type { ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';

/** Shared hard ceiling for bounded Worker IPC JSON envelopes. */
export const WORKER_MESSAGE_LIMITS = Object.freeze({
    maxDepth: 50,
    maxNodes: 32_000,
    maxApproxBytes: 512 * 1024,
    maxCanonicalBytes: 512 * 1024,
});

const LEGACY_VIEW_TOOL_CAPABILITIES = new Set(['view-tool-ordinary-invoke/v2', 'view-tool-ref-invoke/v2']);

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

/** Capture the bounded capability acknowledgement list used during INIT. */
export function captureWorkerCapabilities(input: unknown): readonly string[] | null {
    if (input === undefined) return Object.freeze([]);
    try {
        const value = captureInvocationJson(input, { maxDepth: 1, maxNodes: 7, maxApproxBytes: 512, maxCanonicalBytes: 512 });
        return Array.isArray(value) && value.length <= 2 && value.every(item => text(item) && item.length <= 128) &&
            new Set(value).size === value.length ? value as readonly string[] : null;
    } catch { return null; }
}

export type ViewToolCapabilityCapture =
    | Readonly<{ ok: true; capabilities: readonly string[] }>
    | Readonly<{ ok: false; code: 'WORKER_PROTOCOL_V3_REQUIRED' | 'WORKER_CAPABILITY_UNSUPPORTED' | 'WORKER_CAPABILITY_INVALID' }>;

/** Validate the V4 Worker handshake; retired capabilities cannot negotiate execution. */
export function captureViewToolCapabilities(input: unknown): ViewToolCapabilityCapture {
    const capabilities = captureWorkerCapabilities(input);
    if (!capabilities) return Object.freeze({ ok: false, code: 'WORKER_CAPABILITY_INVALID' });
    if (capabilities.some(capability => LEGACY_VIEW_TOOL_CAPABILITIES.has(capability))) {
        return Object.freeze({ ok: false, code: 'WORKER_PROTOCOL_V3_REQUIRED' });
    }
    if (capabilities.some(capability => capability !== PARAMETERS_V4_CAPABILITY && capability !== SNAPSHOT_CAPABILITY)) {
        return Object.freeze({ ok: false, code: 'WORKER_CAPABILITY_UNSUPPORTED' });
    }
    return Object.freeze({ ok: true, capabilities });
}

/** Validate the observed execution branch without accepting extra transport fields. */
export function invocationExecution(value: JsonValue | undefined): boolean {
    if (!invocationObject(value)) return false;
    if (value.kind === 'view-type') return exact(value, ['kind', 'activationId']) && text(value.activationId);
    return false;
}

/** Strict data shape for the V3 public Tool descriptor carried over Worker IPC. */
export function invocationToolDescriptorV3(value: JsonValue | undefined): boolean {
    if (!invocationObject(value) || !exact(value, ['id', 'name', 'viewType', 'description', 'inputSchema', 'execution']) ||
        !['id', 'name', 'viewType', 'description'].every(key => text(value[key])) ||
        !invocationObject(value.inputSchema) || value.inputSchema.type !== 'object' || !invocationObject(value.execution)) return false;
    const execution = value.execution;
    if (execution.kind === 'view-type') return exact(execution, ['kind', 'activationId']) && text(execution.activationId);
    return false;
}

/** A wire caller may only send an execution identity present in the descriptor. */
export function executionMatchesTool(tool: ToolDescriptorV3, execution: ObservedToolExecutionV3): boolean {
    if (tool.execution.kind !== execution.kind) return false;
    if (execution.kind === 'view-type') return tool.execution.kind === 'view-type' && tool.execution.activationId === execution.activationId;
    return false;
}

/** Capture and correlate a bounded invocation terminal without trusting Worker payloads. */
export function captureInvocationTerminal(
    input: unknown,
    expected: Readonly<{ requestId: string; appId: string; instanceId: string }>,
    responseType: string,
    mode: string
): ViewToolInvocationTerminal | null {
    try {
        const value = captureInvocationJson(input);
        if (!invocationObject(value) || !exact(value, [
            'type', 'requestId', 'appId', 'instanceId', 'argumentMode', 'success', 'terminal',
        ]) || value.type !== responseType || value.requestId !== expected.requestId ||
            value.appId !== expected.appId || value.instanceId !== expected.instanceId ||
            value.argumentMode !== mode || value.success !== true || !invocationObject(value.terminal) ||
            !exact(value.terminal, ['phase', 'result', ...(Object.hasOwn(value.terminal, 'failureEffects') ? ['failureEffects'] : [])])) {
            return null;
        }
        const { phase, result, failureEffects } = value.terminal;
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
