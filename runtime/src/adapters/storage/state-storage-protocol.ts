import { utf8Size } from '@aotui/core';
import { captureStateAddress, captureStateMutationResult, captureStateReadResult, captureStateReleaseResult,
    stateFields, validStateOwner } from '@aotui/core/persistence';
import type { StateAddress, StateMutationResult, StateReadResult, StateReleaseResult } from '@aotui/core';
import type { StateSessionLimits } from '@aotui/core';
import type { StateFlushEntry, StateFlushReport, StateDisposeReport } from '@aotui/core';

import { STATE_SESSION_PROTOCOL } from '@aotui/core';
export { STATE_SESSION_PROTOCOL };
export const STATE_SESSION_VERSION = 2 as const;
export const DEFAULT_STATE_SESSION_LIMITS: StateSessionLimits = Object.freeze({ maxKeys: 128, maxDepth: 32, maxNodes: 16384,
    maxValueBytes: 262144, maxRecordBytes: 262272, maxAddressBytes: 1024, maxRetainedBytes: 8388608,
    maxPendingRequests: 128, maxConcurrentRequests: 4, maxRevision: Number.MAX_SAFE_INTEGER });
export interface StateTransportLimits {
    readonly maxPendingRequests: number; readonly maxSequence: number; readonly maxEnvelopeBytes: number;
    readonly maxRecordBytes: number; readonly maxAddressBytes: number; readonly timeoutMs: number;
}
export const DEFAULT_STATE_TRANSPORT_LIMITS: StateTransportLimits = Object.freeze({ maxPendingRequests: 16,
    maxSequence: Number.MAX_SAFE_INTEGER, maxEnvelopeBytes: 265344, maxRecordBytes: 262272, maxAddressBytes: 1024, timeoutMs: 30000 });
export interface StatePersistenceAck { readonly protocol: typeof STATE_SESSION_PROTOCOL; readonly version: typeof STATE_SESSION_VERSION; readonly instanceId: string }
export interface ManagedPersistenceReport {
    readonly protocol: typeof STATE_SESSION_PROTOCOL; readonly instanceId: string;
    readonly ok: boolean; readonly unmount: 'completed' | 'failed';
    readonly flush: StateFlushReport; readonly dispose: StateDisposeReport;
}
export type StateStorageAction = 'read' | 'replace' | 'remove' | 'release';
export interface StateStorageRequest {
    readonly type: 'STATE_STORAGE_REQUEST'; readonly version: typeof STATE_SESSION_VERSION; readonly instanceId: string;
    readonly sequence: number; readonly action: StateStorageAction; readonly address?: StateAddress; readonly text?: string;
}
export interface StateStorageResponse {
    readonly type: 'STATE_STORAGE_RESPONSE'; readonly version: typeof STATE_SESSION_VERSION; readonly instanceId: string;
    readonly sequence: number; readonly action: StateStorageAction;
    readonly result: StateReadResult | StateMutationResult | StateReleaseResult;
}
const exact = (f: ReturnType<typeof stateFields>, keys: readonly string[]) => !!f && Object.keys(f).length === keys.length && keys.every(k => Object.hasOwn(f, k));
export function capturePersistenceAck(input: unknown, instanceId: string): StatePersistenceAck | null {
    const f = stateFields(input);
    return exact(f, ['protocol', 'version', 'instanceId']) && f!.protocol!.value === STATE_SESSION_PROTOCOL && f!.version!.value === STATE_SESSION_VERSION &&
        f!.instanceId!.value === instanceId ? Object.freeze({ protocol: STATE_SESSION_PROTOCOL, version: STATE_SESSION_VERSION, instanceId }) : null;
}
export function captureStorageRequest(input: unknown, limits: StateTransportLimits): StateStorageRequest | null {
    const f = stateFields(input), action = f?.action?.value;
    if (!['read', 'replace', 'remove', 'release'].includes(action) || !exact(f,
        ['type', 'version', 'instanceId', 'sequence', 'action', ...(action === 'release' ? [] : ['address']), ...(action === 'replace' ? ['text'] : [])]) ||
        f!.type!.value !== 'STATE_STORAGE_REQUEST' || f!.version!.value !== STATE_SESSION_VERSION || typeof f!.instanceId!.value !== 'string' ||
        f!.instanceId!.value.length > limits.maxAddressBytes || !validStateOwner(f!.instanceId!.value, limits.maxAddressBytes) ||
        !Number.isSafeInteger(f!.sequence!.value) || f!.sequence!.value < 1 || f!.sequence!.value > limits.maxSequence) return null;
    const fields = action === 'release' ? undefined : stateFields(f!.address!.value);
    if (action !== 'release' && (!fields || typeof fields.namespace?.value !== 'string' || typeof fields.key?.value !== 'string' ||
        fields.namespace.value.length > limits.maxAddressBytes || fields.key.value.length > limits.maxAddressBytes)) return null;
    const address = action === 'release' ? undefined : captureStateAddress(f!.address!.value, limits.maxAddressBytes);
    if (address?.status === 'rejected') return null;
    const text = f!.text?.value;
    if (action === 'replace' && (typeof text !== 'string' || text.length > limits.maxRecordBytes || utf8Size(text) > limits.maxRecordBytes)) return null;
    // Logical UTF-8 payload, not JSON-escaped wire length or a heap/RSS claim.
    const metadata = utf8Size(JSON.stringify([f!.instanceId!.value, f!.sequence!.value, action])) + 128;
    if (metadata + (address?.status === 'captured' ? address.bytes : 0) + (action === 'replace' ? utf8Size(text) : 0) > limits.maxEnvelopeBytes) return null;
    return Object.freeze({ type: 'STATE_STORAGE_REQUEST', version: STATE_SESSION_VERSION, instanceId: f!.instanceId!.value, sequence: f!.sequence!.value, action,
        ...(address?.status === 'captured' ? { address: address.address } : {}), ...(action === 'replace' ? { text } : {}) });
}
export function captureStorageResponse(input: unknown, request: StateStorageRequest, limits: StateTransportLimits): StateStorageResponse | null {
    const f = stateFields(input);
    if (!exact(f, ['type', 'version', 'instanceId', 'sequence', 'action', 'result']) || f!.type!.value !== 'STATE_STORAGE_RESPONSE' ||
        f!.version!.value !== STATE_SESSION_VERSION || f!.instanceId!.value !== request.instanceId || f!.sequence!.value !== request.sequence || f!.action!.value !== request.action) return null;
    const resultFields = stateFields(f!.result!.value);
    if (request.action === 'read' && typeof resultFields?.text?.value === 'string' && resultFields.text.value.length > limits.maxRecordBytes) return null;
    const result = request.action === 'read' ? captureStateReadResult(f!.result!.value, limits.maxRecordBytes) :
        request.action === 'release' ? captureStateReleaseResult(f!.result!.value) : captureStateMutationResult(f!.result!.value);
    if (utf8Size(JSON.stringify([request.instanceId, request.sequence, request.action])) + 512 +
        (result.status === 'found' ? utf8Size(result.text) : 0) > limits.maxEnvelopeBytes) return null;
    return Object.freeze({ type: 'STATE_STORAGE_RESPONSE', version: STATE_SESSION_VERSION, instanceId: request.instanceId, sequence: request.sequence, action: request.action, result });
}

/** Bounded lifecycle facts only. Capture fixed issues; never retain arbitrary Worker error text. */
export function captureManagedPersistenceReport(input: unknown, instanceId: string): ManagedPersistenceReport | null {
    function entries(input: unknown, limit: number): readonly StateFlushEntry[] | null {
        if (!Array.isArray(input) || input.length > limit) return null;
        const descriptors = Object.getOwnPropertyDescriptors(input);
        if (Reflect.ownKeys(descriptors).length !== input.length + 1) return null;
        const result: StateFlushEntry[] = [];
        for (let i = 0; i < input.length; i++) {
            const descriptor = descriptors[String(i)];if (!descriptor || !('value' in descriptor)) return null;
            const f = stateFields(descriptor.value), status = f?.status?.value;
            const issue = f?.issue ? captureStateReadResult({ status: 'failed', issue: f.issue.value }, 1) : undefined;
            const applied = status === 'saved' || status === 'removed';
            if ((!applied && status !== 'failed' && status !== 'unknown') ||
                !exact(f, ['address', 'revision', 'status', ...(f?.issue ? ['issue'] : [])]) ||
                !Number.isSafeInteger(f!.revision!.value) || f!.revision!.value < 1) return null;
            const address = captureStateAddress(f!.address!.value, 1024);
            if (address.status !== 'captured' || (applied ? issue !== undefined : !issue || issue.status !== 'failed' ||
                issue.issue.code === 'INVALID_RECEIPT' || (status === 'unknown' && issue.issue.code !== 'UNKNOWN_OUTCOME'))) return null;
            result.push(Object.freeze({ address: address.address, revision: f!.revision!.value, status,
                ...(issue?.status === 'failed' ? { issue: issue.issue } : {}) }));
        }
        return Object.freeze(result);
    }
    const f = stateFields(input);
    if (!f || !exact(f, ['protocol', 'instanceId', 'ok', 'unmount', 'flush', 'dispose']) ||
        f.protocol!.value !== STATE_SESSION_PROTOCOL || f.instanceId!.value !== instanceId || typeof f.ok!.value !== 'boolean' ||
        !['completed', 'failed'].includes(f.unmount!.value)) return null;
    const { maxKeys, maxPendingRequests } = DEFAULT_STATE_SESSION_LIMITS;
    const flushFields = stateFields(f.flush!.value), list = entries(flushFields?.entries?.value, 3 * maxKeys + maxPendingRequests);
    if (!exact(flushFields, ['status', 'ok', 'entries']) || flushFields!.status!.value !== 'completed' || !list ||
        flushFields!.ok!.value !== list.every(e => e.status === 'saved' || e.status === 'removed')) return null;
    const flush: StateFlushReport = Object.freeze({ status: 'completed', ok: flushFields!.ok!.value, entries: list });
    const disposeFields = stateFields(f.dispose!.value), unsaved = entries(disposeFields?.unsaved?.value, 2 * maxKeys);
    if (!exact(disposeFields, ['status', 'unsaved', 'release']) || disposeFields!.status!.value !== 'disposed' || !unsaved ||
        unsaved.some(e => e.status !== 'failed' && e.status !== 'unknown')) return null;
    const dispose: StateDisposeReport = Object.freeze({ status: 'disposed', unsaved, release: captureStateReleaseResult(disposeFields!.release!.value) });
    if (f.ok!.value !== (flush.ok && dispose.release.status === 'released' && dispose.unsaved.length === 0)) return null;
    return Object.freeze({ protocol: STATE_SESSION_PROTOCOL, instanceId, ok: f.ok!.value, unmount: f.unmount!.value, flush, dispose });
}
