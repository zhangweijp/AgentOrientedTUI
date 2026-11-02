import { captureStorageRequest, captureStorageResponse } from '../adapters/storage/state-storage-protocol.js';
import type { StateStorageRequest, StateTransportLimits } from '../adapters/storage/state-storage-protocol.js';
import { failedRead, failedMutation, stateFields, stateIssue, unknownMutation } from '../core/persistence/state-storage.js';
import type { StateAddress, StateStorage, StateReadResult, StateMutationResult, StateReleaseResult } from '../core/persistence/state-storage.js';

/** A timer counts IPC only. The Host separately owns every actual backend operation. */
export function createStateStorageProxy(instanceId: string, limits: StateTransportLimits, send: (request: StateStorageRequest) => void | boolean) {
    type Receipt = StateReadResult | StateMutationResult | StateReleaseResult;
    const pending = new Map<number, { request: StateStorageRequest; timer: ReturnType<typeof setTimeout>; resolve: (receipt: Receipt) => void }>();
    let sequence = 0, closing = false, disconnected = false, uncertain = false, releasePromise: Promise<StateReleaseResult> | undefined;
    const failed = (operation: string, code: 'INVALID_INPUT' | 'CAPACITY_EXCEEDED' | 'OWNER_RELEASED' | 'IO_FAILED' | 'REVISION_EXHAUSTED' | 'UNKNOWN_OUTCOME'): Receipt =>
        operation === 'read' ? failedRead(code) : operation === 'release' ? { status: 'failed', issue: stateIssue(code) } : failedMutation(code);
    function unconfirmed(operation: string): Receipt {
        if (operation === 'read') return failedRead('IO_FAILED');
        uncertain = true;return unknownMutation();
    }
    function request(operation: StateStorageRequest['operation'], address?: StateAddress, text?: string): Promise<Receipt> {
        if (disconnected || closing && operation !== 'release') return Promise.resolve(failed(operation, 'OWNER_RELEASED'));
        if (uncertain && operation !== 'read' && operation !== 'release') return Promise.resolve(failed(operation, 'UNKNOWN_OUTCOME'));
        if (sequence >= limits.maxSequence) return Promise.resolve(failed(operation, 'REVISION_EXHAUSTED'));
        if (operation !== 'release' && [...pending.values()].filter(p => p.request.operation !== 'release').length >= limits.maxPendingOperations)
            return Promise.resolve(failed(operation, 'CAPACITY_EXCEEDED'));
        const captured = captureStorageRequest({ type: 'STATE_STORAGE_REQUEST', version: 1, instanceId, sequence: ++sequence, operation,
            ...(operation !== 'release' ? { address } : {}), ...(operation === 'replace' ? { text } : {}) }, limits);
        if (!captured) return Promise.resolve(failed(operation, 'INVALID_INPUT'));
        return new Promise(resolve => {
            const timer = setTimeout(() => { pending.delete(captured.sequence);resolve(unconfirmed(operation)); }, limits.timeoutMs);
            pending.set(captured.sequence, { request: captured, timer, resolve });
            try { if (send(captured) === false) throw new Error(); }
            catch { clearTimeout(timer);pending.delete(captured.sequence);resolve(failed(operation, 'IO_FAILED')); }
        });
    }
    const storage: StateStorage = Object.freeze({ owner: instanceId,
        read: (address: StateAddress) => request('read', address) as Promise<StateReadResult>,
        replace: (address: StateAddress, text: string) => request('replace', address, text) as Promise<StateMutationResult>,
        remove: (address: StateAddress) => request('remove', address) as Promise<StateMutationResult>,
        release: () => {
            if (!releasePromise) { closing = true;releasePromise = request('release') as Promise<StateReleaseResult>; }
            return releasePromise;
        },
    });
    return Object.freeze({ storage,
        receive(input: unknown) {
            const f = stateFields(input);
            if (f?.type?.value !== 'STATE_STORAGE_RESPONSE' || f.instanceId?.value !== instanceId) return;
            const entry = pending.get(f.sequence?.value);if (!entry) return;
            const receipt = captureStorageResponse(input, entry.request, limits);
            clearTimeout(entry.timer);pending.delete(entry.request.sequence);
            const result = receipt?.result ?? unconfirmed(entry.request.operation);
            if (result.status === 'unknown') uncertain = true;
            entry.resolve(result);
        },
        disconnect() {
            disconnected = true;closing = true;
            for (const entry of pending.values()) { clearTimeout(entry.timer);entry.resolve(unconfirmed(entry.request.operation)); }
            pending.clear();
        },
        getStats: () => Object.freeze({ pending: pending.size, sequence, closing, disconnected, uncertain }),
    });
}
