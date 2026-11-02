import { utf8Size } from '../../core/snapshot/json.js';
import { captureStateAddress, captureStateMutationResult, captureStateReadResult, captureStateReleaseResult,
    requireStateLimits, stateFields, validStateOwner } from '../../core/persistence/state-storage.js';
import type { StateAddress, StateMutationResult, StateReadResult, StateReleaseResult } from '../../core/persistence/state-storage.js';
import type { StateSessionLimits } from '../../core/persistence/state-session.js';
import type { StateFlushEntry, StateFlushReport, StateDisposeReport } from '../../core/persistence/state-session.js';
import type { ManagedPersistenceReport } from '../../worker-runtime/state-persistence.js';

export const STATE_SESSION_PROTOCOL = 'state-session-v1' as const;
export const DEFAULT_STATE_SESSION_LIMITS: StateSessionLimits = Object.freeze({ maxKeys: 128, maxDepth: 32, maxNodes: 16384,
    maxValueBytes: 262144, maxRecordBytes: 262272, maxAddressBytes: 1024, maxRetainedBytes: 8388608,
    maxPendingOperations: 128, maxConcurrentOperations: 4, maxRevision: Number.MAX_SAFE_INTEGER });
export interface StateTransportLimits {
    readonly maxPendingOperations: number; readonly maxSequence: number; readonly maxEnvelopeBytes: number;
    readonly maxRecordBytes: number; readonly maxAddressBytes: number; readonly timeoutMs: number;
}
export const DEFAULT_STATE_TRANSPORT_LIMITS: StateTransportLimits = Object.freeze({ maxPendingOperations: 16,
    maxSequence: Number.MAX_SAFE_INTEGER, maxEnvelopeBytes: 265344, maxRecordBytes: 262272, maxAddressBytes: 1024, timeoutMs: 30000 });
export interface StatePersistenceAck { readonly protocol: 'state-session-v1'; readonly version: 1; readonly instanceId: string }
export interface StatePersistenceOffer extends StatePersistenceAck { readonly limits: StateSessionLimits; readonly transport: StateTransportLimits }
export type StateStorageOperation = 'read' | 'replace' | 'remove' | 'release';
export interface StateStorageRequest {
    readonly type: 'STATE_STORAGE_REQUEST'; readonly version: 1; readonly instanceId: string;
    readonly sequence: number; readonly operation: StateStorageOperation; readonly address?: StateAddress; readonly text?: string;
}
export interface StateStorageResponse {
    readonly type: 'STATE_STORAGE_RESPONSE'; readonly version: 1; readonly instanceId: string;
    readonly sequence: number; readonly operation: StateStorageOperation;
    readonly result: StateReadResult | StateMutationResult | StateReleaseResult;
}
const exact = (f: ReturnType<typeof stateFields>, keys: readonly string[]) => !!f && Object.keys(f).length === keys.length && keys.every(k => Object.hasOwn(f, k));
export function capturePersistenceAck(input: unknown, instanceId: string): StatePersistenceAck | null {
    const f = stateFields(input);
    return exact(f, ['protocol', 'version', 'instanceId']) && f!.protocol!.value === STATE_SESSION_PROTOCOL && f!.version!.value === 1 &&
        f!.instanceId!.value === instanceId ? Object.freeze({ protocol: STATE_SESSION_PROTOCOL, version: 1, instanceId }) : null;
}
export function capturePersistenceOffer(input: unknown, instanceId: string): StatePersistenceOffer | null {
    const f = stateFields(input);
    if (!exact(f, ['protocol', 'version', 'instanceId', 'limits', 'transport']) ||
        !capturePersistenceAck({ protocol: f!.protocol!.value, version: f!.version!.value, instanceId: f!.instanceId!.value }, instanceId)) return null;
    try {
        const limits = requireStateLimits(f!.limits!.value as StateSessionLimits, Object.keys(DEFAULT_STATE_SESSION_LIMITS));
        const transport = requireStateLimits(f!.transport!.value as StateTransportLimits, Object.keys(DEFAULT_STATE_TRANSPORT_LIMITS));
        if (Object.keys(DEFAULT_STATE_SESSION_LIMITS).some(k => limits[k as keyof StateSessionLimits] > DEFAULT_STATE_SESSION_LIMITS[k as keyof StateSessionLimits]) ||
            Object.keys(DEFAULT_STATE_TRANSPORT_LIMITS).some(k => k !== 'timeoutMs' && transport[k as keyof StateTransportLimits] > DEFAULT_STATE_TRANSPORT_LIMITS[k as keyof StateTransportLimits]) ||
            transport.timeoutMs > 300000 || transport.maxRecordBytes > 262272 || transport.maxAddressBytes > 1024 ||
            transport.maxEnvelopeBytes > 265344 || !validStateOwner(instanceId, transport.maxAddressBytes) ||
            limits.maxRecordBytes > transport.maxRecordBytes || limits.maxAddressBytes > transport.maxAddressBytes) return null;
        return Object.freeze({ protocol: STATE_SESSION_PROTOCOL, version: 1, instanceId, limits, transport });
    } catch { return null; }
}
export function captureStorageRequest(input: unknown, limits: StateTransportLimits): StateStorageRequest | null {
    const f = stateFields(input), operation = f?.operation?.value;
    if (!['read', 'replace', 'remove', 'release'].includes(operation) || !exact(f,
        ['type', 'version', 'instanceId', 'sequence', 'operation', ...(operation === 'release' ? [] : ['address']), ...(operation === 'replace' ? ['text'] : [])]) ||
        f!.type!.value !== 'STATE_STORAGE_REQUEST' || f!.version!.value !== 1 || typeof f!.instanceId!.value !== 'string' ||
        f!.instanceId!.value.length > limits.maxAddressBytes || !validStateOwner(f!.instanceId!.value, limits.maxAddressBytes) ||
        !Number.isSafeInteger(f!.sequence!.value) || f!.sequence!.value < 1 || f!.sequence!.value > limits.maxSequence) return null;
    const fields = operation === 'release' ? undefined : stateFields(f!.address!.value);
    if (operation !== 'release' && (!fields || typeof fields.namespace?.value !== 'string' || typeof fields.key?.value !== 'string' ||
        fields.namespace.value.length > limits.maxAddressBytes || fields.key.value.length > limits.maxAddressBytes)) return null;
    const address = operation === 'release' ? undefined : captureStateAddress(f!.address!.value, limits.maxAddressBytes);
    if (address?.status === 'rejected') return null;
    const text = f!.text?.value;
    if (operation === 'replace' && (typeof text !== 'string' || text.length > limits.maxRecordBytes || utf8Size(text) > limits.maxRecordBytes)) return null;
    // Logical UTF-8 payload, not JSON-escaped wire length or a heap/RSS claim.
    const metadata = utf8Size(JSON.stringify([f!.instanceId!.value, f!.sequence!.value, operation])) + 128;
    if (metadata + (address?.status === 'captured' ? address.bytes : 0) + (operation === 'replace' ? utf8Size(text) : 0) > limits.maxEnvelopeBytes) return null;
    return Object.freeze({ type: 'STATE_STORAGE_REQUEST', version: 1, instanceId: f!.instanceId!.value, sequence: f!.sequence!.value, operation,
        ...(address?.status === 'captured' ? { address: address.address } : {}), ...(operation === 'replace' ? { text } : {}) });
}
export function captureStorageResponse(input: unknown, request: StateStorageRequest, limits: StateTransportLimits): StateStorageResponse | null {
    const f = stateFields(input);
    if (!exact(f, ['type', 'version', 'instanceId', 'sequence', 'operation', 'result']) || f!.type!.value !== 'STATE_STORAGE_RESPONSE' ||
        f!.version!.value !== 1 || f!.instanceId!.value !== request.instanceId || f!.sequence!.value !== request.sequence || f!.operation!.value !== request.operation) return null;
    const resultFields = stateFields(f!.result!.value);
    if (request.operation === 'read' && typeof resultFields?.text?.value === 'string' && resultFields.text.value.length > limits.maxRecordBytes) return null;
    const result = request.operation === 'read' ? captureStateReadResult(f!.result!.value, limits.maxRecordBytes) :
        request.operation === 'release' ? captureStateReleaseResult(f!.result!.value) : captureStateMutationResult(f!.result!.value);
    if (utf8Size(JSON.stringify([request.instanceId, request.sequence, request.operation])) + 512 +
        (result.status === 'found' ? utf8Size(result.text) : 0) > limits.maxEnvelopeBytes) return null;
    return Object.freeze({ type: 'STATE_STORAGE_RESPONSE', version: 1, instanceId: request.instanceId, sequence: request.sequence, operation: request.operation, result });
}

/** Bounded lifecycle facts only. Capture fixed issues; never retain arbitrary Worker error text. */
export function captureManagedPersistenceReport(input: unknown, instanceId: string): ManagedPersistenceReport | null {
    function entries(input: unknown): readonly StateFlushEntry[] | null {
        if (!Array.isArray(input) || input.length > DEFAULT_STATE_SESSION_LIMITS.maxKeys) return null;
        const descriptors = Object.getOwnPropertyDescriptors(input);
        if (Reflect.ownKeys(descriptors).length !== input.length + 1) return null;
        const result: StateFlushEntry[] = [];
        for (let i = 0; i < input.length; i++) {
            const descriptor = descriptors[String(i)];if (!descriptor || !('value' in descriptor)) return null;
            const f = stateFields(descriptor.value), status = f?.status?.value;
            const issue = f?.issue ? captureStateReadResult({ status: 'failed', issue: f.issue.value }, 1) : undefined;
            if (!['saved', 'unchanged', 'blocked', 'failed', 'unknown'].includes(status) ||
                !exact(f, ['address', 'revision', 'status', ...(f?.issue ? ['issue'] : [])]) ||
                !Number.isSafeInteger(f!.revision!.value) || f!.revision!.value < 1) return null;
            const address = captureStateAddress(f!.address!.value, 1024);
            if (address.status !== 'captured' || !['saved', 'unchanged'].includes(status) && (!issue || issue.status !== 'failed' || issue.issue.code === 'INVALID_RECEIPT')) return null;
            result.push(Object.freeze({ address: address.address, revision: f!.revision!.value, status,
                ...(issue?.status === 'failed' ? { issue: issue.issue } : {}) }));
        }
        return Object.freeze(result);
    }
    const f = stateFields(input);
    if (!f || !exact(f, ['protocol', 'instanceId', 'ok', 'unmount', ...(f.flush ? ['flush'] : []), ...(f.dispose ? ['dispose'] : [])]) ||
        f.protocol!.value !== STATE_SESSION_PROTOCOL || f.instanceId!.value !== instanceId || typeof f.ok!.value !== 'boolean' ||
        !['pending', 'completed', 'failed'].includes(f.unmount!.value)) return null;
    let flush: StateFlushReport | undefined, dispose: StateDisposeReport | undefined;
    if (f.flush) {
        const value = stateFields(f.flush.value), list = entries(value?.entries?.value);
        if (!exact(value, ['status', 'ok', 'entries']) || !['completed', 'disposed'].includes(value!.status!.value) || typeof value!.ok!.value !== 'boolean' || !list ||
            value!.ok!.value !== (value!.status!.value === 'completed' && list.every(e => e.status === 'saved' || e.status === 'unchanged'))) return null;
        flush = Object.freeze({ status: value!.status!.value, ok: value!.ok!.value, entries: list });
    }
    if (f.dispose) {
        const value = stateFields(f.dispose.value), unsaved = entries(value?.unsaved?.value);
        if (!exact(value, ['status', 'unsaved', 'release']) || value!.status!.value !== 'disposed' || !unsaved) return null;
        dispose = Object.freeze({ status: 'disposed', unsaved, release: captureStateReleaseResult(value!.release!.value) });
    }
    if (f.ok!.value && (!flush?.ok || f.unmount!.value !== 'completed' || !dispose || dispose.release.status !== 'released' || dispose.unsaved.length)) return null;
    return Object.freeze({ protocol: STATE_SESSION_PROTOCOL, instanceId, ok: f.ok!.value, unmount: f.unmount!.value,
        ...(flush ? { flush } : {}), ...(dispose ? { dispose } : {}) });
}
