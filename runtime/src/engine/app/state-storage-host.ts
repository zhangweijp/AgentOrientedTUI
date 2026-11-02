import * as path from 'node:path';
import { homedir } from 'node:os';
import { createNodeStateStorage } from '../../adapters/storage/node-state-storage.js';
import type { NodeStateStorageLimits } from '../../adapters/storage/node-state-storage.js';
import { captureStorageRequest, DEFAULT_STATE_TRANSPORT_LIMITS } from '../../adapters/storage/state-storage-protocol.js';
import type { StateStorageRequest, StateStorageResponse, StateTransportLimits } from '../../adapters/storage/state-storage-protocol.js';
import { captureStateReadResult, captureStateMutationResult, captureStateReleaseResult, failedRead, failedMutation,
    stateIssue, unknownMutation } from '../../core/persistence/state-storage.js';
import type { StateStorage, StateReleaseResult, StateIssueCode } from '../../core/persistence/state-storage.js';

export const DEFAULT_NODE_STATE_LIMITS: NodeStateStorageLimits = Object.freeze({ maxActiveOwners: 64, maxRoots: 16,
    maxClaimedNamespaces: 512, maxPendingOperations: 256, maxRecordBytes: 262272, maxAddressBytes: 1024,
    maxPathBytes: 4096, maxSegmentBytes: 128, maxDirectoryEntries: 4096, maxBufferedBytes: 16777216 });
export type StateStorageBackend = Pick<ReturnType<typeof createNodeStateStorage>, 'open'>;
// Construction performs no filesystem operation. All default Hosts share this exact backend.
export const defaultStateStorageBackend = createNodeStateStorage(DEFAULT_NODE_STATE_LIMITS);
export function resolveStateDirectory(config: Readonly<Record<string, unknown>> | undefined, cwd = process.cwd()): string {
    const value = config?.AOTUI_DATA_DIR;
    if (value !== undefined && typeof value !== 'string') throw new Error('INVALID_INPUT: Invalid persistence directory');
    if (typeof value === 'string' && value.length) {
        if (value.includes('\0')) throw new Error('INVALID_INPUT: Invalid persistence directory');
        return path.resolve(cwd, value, 'app-state');
    }
    return path.join(homedir(), '.aotui', 'app-state');
}

/** One logical Host owns admission, a shared opening Promise and real backend completion. */
export function createStateStorageHost(options: Readonly<{ instanceId: string; desktopId: string; rootDirectory: string;
    backend?: StateStorageBackend; limits?: StateTransportLimits }>) {
    const { instanceId, desktopId, rootDirectory } = options;
    const backend = options.backend ?? defaultStateStorageBackend, limits = options.limits ?? DEFAULT_STATE_TRANSPORT_LIMITS;
    const active = new Set<Promise<unknown>>();
    let highWater = 0, closing = false, uncertain = false, opening = false, bufferedBytes = 0;
    let owner: StateStorage | undefined, openingPromise: ReturnType<StateStorageBackend['open']> | undefined;
    let releasePromise: Promise<StateReleaseResult> | undefined, lastRelease: StateReleaseResult | undefined;
    function open() {
        if (!openingPromise) {
            opening = true;
            openingPromise = Promise.resolve().then(() => backend.open({ owner: instanceId, rootDirectory })).then(result => {
                if (result.status === 'opened') owner = result.storage;
                return result;
            }).catch(() => ({ status: 'rejected' as const, issue: stateIssue('IO_FAILED') })).finally(() => { opening = false; });
        }
        return openingPromise;
    }
    function release(): Promise<StateReleaseResult> {
        if (releasePromise) return releasePromise;
        closing = true;
        releasePromise = (async () => {
            await Promise.all([...active]);
            if (openingPromise) await openingPromise;
            let result: StateReleaseResult;
            try { result = owner ? captureStateReleaseResult(await owner.release()) : { status: 'released' }; }
            catch { result = { status: 'unknown', issue: stateIssue('UNKNOWN_OUTCOME') }; }
            lastRelease = result;
            if (result.status === 'released') owner = undefined;
            else uncertain = true;
            return result;
        })();
        return releasePromise;
    }
    const denied = (request: StateStorageRequest, code: StateIssueCode): StateStorageResponse => ({ type: 'STATE_STORAGE_RESPONSE', version: 1,
        instanceId, sequence: request.sequence, operation: request.operation,
        result: request.operation === 'read' ? failedRead(code) : request.operation === 'release' ? { status: 'failed', issue: stateIssue(code) } : failedMutation(code) });
    function accept(input: unknown): Promise<StateStorageResponse> | null {
        const request = captureStorageRequest(input, limits);
        if (!request || request.instanceId !== instanceId) return null;
        if (request.sequence <= highWater) return Promise.resolve(denied(request, 'INVALID_INPUT'));
        highWater = request.sequence; // Before any await, including opening the owner.
        if (request.operation === 'release') return release().then(result => ({ type: 'STATE_STORAGE_RESPONSE', version: 1, instanceId,
            sequence: request.sequence, operation: request.operation, result }));
        if (closing) return Promise.resolve(denied(request, 'OWNER_RELEASED'));
        if (uncertain && request.operation !== 'read') return Promise.resolve(denied(request, 'UNKNOWN_OUTCOME'));
        let namespace: unknown;
        try { namespace = JSON.parse(request.address!.namespace); } catch { return Promise.resolve(denied(request, 'ADDRESS_UNSUPPORTED')); }
        if (!Array.isArray(namespace) || namespace.length !== 2 || namespace[0] !== desktopId || typeof namespace[1] !== 'string' ||
            JSON.stringify(namespace) !== request.address!.namespace) return Promise.resolve(denied(request, 'ADDRESS_UNSUPPORTED'));
        if (active.size >= limits.maxPendingOperations) return Promise.resolve(denied(request, 'CAPACITY_EXCEEDED'));
        const bytes = request.text ? Buffer.byteLength(request.text, 'utf8') : 0;
        bufferedBytes += bytes;
        // Register synchronously; a release/disconnect in this turn must wait for this admitted access.
        const operation = Promise.resolve().then(async (): Promise<StateStorageResponse> => {
            const opened = await open();
            if (opened.status !== 'opened') return denied(request, opened.issue.code);
            let result: StateStorageResponse['result'];
            try {
                if (request.operation === 'read') result = captureStateReadResult(await opened.storage.read(request.address!), limits.maxRecordBytes);
                else if (request.operation === 'replace') result = captureStateMutationResult(await opened.storage.replace(request.address!, request.text!));
                else result = captureStateMutationResult(await opened.storage.remove(request.address!));
            } catch { result = request.operation === 'read' ? failedRead('IO_FAILED') : unknownMutation(); }
            if (result.status === 'unknown') uncertain = true;
            return { type: 'STATE_STORAGE_RESPONSE', version: 1, instanceId, sequence: request.sequence, operation: request.operation, result };
        });
        active.add(operation);
        void operation.finally(() => { active.delete(operation);bufferedBytes -= bytes; });
        return operation;
    }
    return Object.freeze({ accept, release, disconnect: release,
        markTransportUncertain: () => { uncertain = true; },
        getStats: () => Object.freeze({ highWater, closing, opening, pending: active.size, actualIO: active.size,
            bufferedBytes, ownerRetained: !!owner, uncertain, ...(lastRelease ? { release: lastRelease } : {}) }),
    });
}
