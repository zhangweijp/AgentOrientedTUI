import { mkdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
    captureStateAddress, captureStateMutationResult, captureStateReadResult, captureStateReleaseResult,
    failedMutation, failedRead, rejectState, requireStateLimits, stateFields, stateIssue, unknownMutation, validStateOwner,
} from '../../core/persistence/state-storage.js';
import type { StateAddress, StateIssue, StateIssueCode, StateReleaseResult, StateStorage, StateStorageBackend } from '../../core/persistence/state-storage.js';

export interface SqliteStateStorageLimits {
    readonly maxActiveOwners: number;
    readonly maxRoots: number;
    readonly maxClaimedNamespaces: number;
    readonly maxPendingRequests: number;
    readonly maxRecordBytes: number;
    readonly maxAddressBytes: number;
    readonly maxPathBytes: number;
    readonly maxBufferedBytes: number;
}

export type SqliteOperation =
    | { type: 'read' | 'remove'; address: StateAddress }
    | { type: 'replace'; address: StateAddress; text: string }
    | { type: 'close' };

export const sqliteStateFile = 'state.sqlite3';
function startRoot(directory: string, limits: SqliteStateStorageLimits) {
    const worker = new Worker(new URL('../../../dist/adapters/storage/sqlite-state-worker.js', import.meta.url), {
        workerData: { directory, limits },
        execArgv: [],
    });
    let sequence = 0;
    let exited = false;
    let pending: { id: number; finish: (result: unknown) => void } | undefined;
    let ready!: (result: StateIssue | undefined) => void;
    const initialized = new Promise<StateIssue | undefined>(resolve => { ready = resolve; });
    const exit = new Promise<void>(resolve => {
        worker.once('exit', () => {
            exited = true;
            ready(stateIssue('IO_FAILED'));
            pending?.finish(undefined);
            pending = undefined;
            resolve();
        });
    });
    // The exit event is the resource terminal, including after an error.
    worker.on('error', () => {});
    worker.on('message', message => {
        const fields = stateFields(message);
        const id = fields?.id?.value;
        if (id === 0) {
            const issue = fields?.issue;
            const failure = issue && captureStateReadResult({ status: 'failed', issue: issue.value }, limits.maxRecordBytes);
            ready(failure?.status === 'failed' ? failure.issue : undefined);
        } else {
            if (!pending || pending.id !== id) return;
            const { finish } = pending;
            pending = undefined;
            finish(fields?.result?.value);
        }
    });
    function request(operation: SqliteOperation): Promise<unknown> {
        if (exited) return Promise.resolve(undefined);
        const notSent = (code: StateIssueCode) => operation.type === 'read' ? failedRead(code)
            : operation.type === 'close' ? { status: 'failed', issue: stateIssue(code) } : failedMutation(code);
        const id = operation.type === 'close' ? -1 : ++sequence;
        if (!Number.isSafeInteger(id)) return Promise.resolve(notSent('REVISION_EXHAUSTED'));
        return new Promise(resolve => {
            pending = { id, finish: resolve };
            try { worker.postMessage({ id, operation }); }
            catch { pending = undefined;resolve(notSent('IO_FAILED')); }
        });
    }
    return {
        directory, initialized, exit, request, hasExited: () => exited, closing: false, tail: Promise.resolve(),
        owners: new Set<Owner>(), claims: new Map<string, { owner: Owner; uncertain: boolean }>(),
    };
}

type Owner = { closing: boolean; pending: Set<Promise<unknown>>; release?: Promise<StateReleaseResult> };

/** A shared Node backend owns one SQLite Worker per active physical directory. */
export function createSqliteStateStorage(input: SqliteStateStorageLimits) {
    const limits = requireStateLimits(input, ['maxActiveOwners', 'maxRoots', 'maxClaimedNamespaces', 'maxPendingRequests',
        'maxRecordBytes', 'maxAddressBytes', 'maxPathBytes', 'maxBufferedBytes']);
    const maxRead = Math.min(limits.maxRecordBytes, limits.maxBufferedBytes);
    const roots = new Map<string, ReturnType<typeof startRoot>>();
    const owners = new Set<string>();
    let claimedNamespaces = 0, pendingStorageIO = 0, bufferedBytes = 0;

    const open: StateStorageBackend['open'] = async input => {
        const fields = stateFields(input);
        const ownerId = fields?.owner?.value, configured = fields?.rootDirectory?.value;
        if (!fields || Object.keys(fields).length !== 2 || !validStateOwner(ownerId, limits.maxAddressBytes) ||
            typeof configured !== 'string' || !path.isAbsolute(configured) || configured.includes('\0')) return rejectState('INVALID_INPUT');
        if (Buffer.byteLength(path.join(configured, sqliteStateFile)) > limits.maxPathBytes) return rejectState('CAPACITY_EXCEEDED');
        if (owners.has(ownerId)) return rejectState('OWNER_BUSY');
        if (owners.size >= limits.maxActiveOwners || pendingStorageIO >= limits.maxPendingRequests) return rejectState('CAPACITY_EXCEEDED');
        owners.add(ownerId);
        pendingStorageIO++;
        let opened = false;
        try {
            await mkdir(configured, { recursive: true, mode: 0o700 });
            const directory = await realpath(configured);
            if (Buffer.byteLength(path.join(directory, sqliteStateFile)) > limits.maxPathBytes) return rejectState('CAPACITY_EXCEEDED');
            const stat = await lstat(directory, { bigint: true });
            if (!stat.isDirectory()) return rejectState('RESOURCE_UNSUPPORTED');
            const identity = `${stat.dev}:${stat.ino}`;
            if ([...roots].some(([key, root]) => key !== identity && root.directory === directory)) return rejectState('RESOURCE_UNSUPPORTED');
            let root = roots.get(identity);
            if (!root) {
                if (roots.size >= limits.maxRoots) return rejectState('CAPACITY_EXCEEDED');
                root = startRoot(directory, limits);
                roots.set(identity, root);
            }
            if (root.closing) return rejectState('OWNER_BUSY');
            const owner: Owner = { closing: false, pending: new Set() };
            root.owners.add(owner);
            const issue = await root.initialized;
            if (issue || root.hasExited()) {
                await root.exit;
                root.owners.delete(owner);
                if (!root.owners.size) roots.delete(identity);
                return { status: 'rejected', issue: issue ?? stateIssue('IO_FAILED') };
            }
            opened = true;
            return { status: 'opened', storage: createOwner(ownerId, owner, root, identity) };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            return rejectState(code === 'EACCES' || code === 'EPERM' ? 'PERMISSION_DENIED'
                : code === 'EEXIST' || code === 'ENOTDIR' || code === 'ELOOP' ? 'RESOURCE_UNSUPPORTED' : 'IO_FAILED');
        } finally {
            pendingStorageIO--;
            if (!opened) owners.delete(ownerId);
        }
    };

    function createOwner(ownerId: string, owner: Owner, root: ReturnType<typeof startRoot>, identity: string): StateStorage {
        async function run(type: 'read' | 'replace' | 'remove', input: StateAddress, text?: string) {
            const failed = type === 'read' ? failedRead : failedMutation;
            if (owner.closing) return failed('OWNER_RELEASED');
            if (root.hasExited()) return failed('IO_FAILED');
            const captured = captureStateAddress(input, limits.maxAddressBytes);
            if (captured.status === 'rejected') return failed(captured.issue.code);
            const { address } = captured;
            // SQLite's UTF-8 binding replaces lone surrogates, which would alias distinct keys.
            if ([address.namespace, address.key].some(part => /[\uD800-\uDFFF]/u.test(part))) return failed('ADDRESS_UNSUPPORTED');
            const claim = root.claims.get(address.namespace);
            if (claim && claim.owner !== owner) return failed('NAMESPACE_BUSY');
            if (type !== 'read' && claim?.uncertain) return failed('UNKNOWN_OUTCOME');
            if (type === 'replace' && typeof text !== 'string') return failed('INVALID_INPUT');
            const bytes = type === 'read' ? maxRead : type === 'replace' ? Buffer.byteLength(text!) : 0;
            if (bytes > limits.maxRecordBytes || bytes > limits.maxBufferedBytes - bufferedBytes ||
                pendingStorageIO >= limits.maxPendingRequests || !claim && claimedNamespaces >= limits.maxClaimedNamespaces) {
                return failed('CAPACITY_EXCEEDED');
            }
            const activeClaim = claim ?? { owner, uncertain: false };
            if (!claim) { root.claims.set(address.namespace, activeClaim);claimedNamespaces++; }
            bufferedBytes += bytes;
            pendingStorageIO++;
            const work = root.tail.then(async () => {
                if (root.hasExited()) return failed('IO_FAILED');
                if (type !== 'read' && activeClaim.uncertain) return failed('UNKNOWN_OUTCOME');
                const receipt = await root.request(type === 'replace' ? { type, address, text: text! } : { type, address });
                if (type === 'read') return receipt === undefined ? failedRead('IO_FAILED') : captureStateReadResult(receipt, maxRead);
                const result = receipt === undefined ? unknownMutation() : captureStateMutationResult(receipt);
                if (result.status === 'unknown') activeClaim.uncertain = true;
                return result;
            }).finally(() => {
                owner.pending.delete(work);
                pendingStorageIO--;
                bufferedBytes -= bytes;
            });
            root.tail = work.then(() => {}, () => {});
            owner.pending.add(work);
            return work;
        }
        function release(): Promise<StateReleaseResult> {
            if (owner.release) return owner.release;
            owner.closing = true;
            return owner.release = Promise.resolve().then(async () => {
                await Promise.allSettled(owner.pending);
                if (root.owners.size === 1) {
                    root.closing = true;
                    if (!root.hasExited()) {
                        const result = captureStateReleaseResult(await root.request({ type: 'close' }));
                        if (result.status === 'released') await root.exit;
                        else if (!root.hasExited()) { owner.release = undefined;return result; }
                    }
                    roots.delete(identity);
                }
                for (const [namespace, claim] of root.claims) {
                    if (claim.owner === owner) { root.claims.delete(namespace);claimedNamespaces--; }
                }
                root.owners.delete(owner);
                owners.delete(ownerId);
                return { status: 'released' };
            });
        }
        return Object.freeze({ owner: ownerId,
            read: input => run('read', input) as ReturnType<StateStorage['read']>,
            replace: (input, text) => run('replace', input, text) as ReturnType<StateStorage['replace']>,
            remove: input => run('remove', input) as ReturnType<StateStorage['remove']>,
            release,
        } satisfies StateStorage);
    }

    return Object.freeze({ open, getStats: () => Object.freeze({
        ownerSlots: owners.size, roots: roots.size, claimedNamespaces, pendingStorageIO, bufferedBytes,
    }) });
}
