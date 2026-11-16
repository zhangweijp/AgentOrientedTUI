import { SNAPSHOT_SCHEMA_VERSION } from './types.js';
import type {
    AppSnapshotV5, CommitResult, LeaseResult, PreparedSnapshotFailure, RefLookup, RefSelector, SnapshotCore,
    SnapshotHealth, SnapshotIssue, SnapshotIssueCode, SnapshotLease, SnapshotLookup, SnapshotRead,
    SnapshotStoreOptions, SnapshotStoreStats, ToolLookup, ToolSelector, AppIdentityRead,
} from './types.js';
import { utf8Size } from './json.js';
import { captureSnapshotLimits, refKey, snapshotId } from './snapshot-support.js';
import { validatePreparedV5Draft } from './v5-validator.js';

interface SnapshotEntry {
    readonly snapshot: AppSnapshotV5;
    canonical: string | undefined;
    readonly bytes: number;
    readonly leases: Map<object, number | null>;
    retiredAt?: number;
}
const DEFAULT_HISTORY_ENTRIES = 64;
const DEFAULT_HISTORY_BYTES = 32 * 1024 * 1024;
const DEFAULT_HISTORY_TTL = 10 * 60_000;
const DEFAULT_LEASE_TTL = 60_000;
const DEFAULT_MAX_ACTIVE_LEASES = 1_024;

function boundedText(value: string, limit: number): string {
    let prefix = '', bytes = 0;
    for (const char of value) {
        const size = utf8Size(char);
        if (bytes + size > limit) {
            while (utf8Size(prefix) > limit - 3) prefix = [...prefix].slice(0, -1).join('');
            return prefix + '…';
        }
        prefix += char;
        bytes += size;
    }
    return prefix;
}
function issue(
    code: SnapshotIssueCode, message: string,
    context: { appId?: string; instanceId?: string; snapshotId?: string; path?: string } = {},
): SnapshotIssue {
    return Object.freeze({ ...context,
        code: typeof code === 'string' && code.length <= 64 && utf8Size(code) <= 64 ? code : 'SNAPSHOT_INVALID',
        message: boundedText(typeof message === 'string' ? message : 'Invalid projection failure', 512),
        ...(context.path !== undefined ? { path: boundedText(typeof context.path === 'string' ? context.path : '', 512) } : {}),
    });
}
function releaseLease(leases: Map<object, number | null> | undefined, token: object, settle: (() => void) | undefined): () => void {
    return () => {
        if (!leases) return;
        const owned = leases, finish = settle;
        leases = undefined; settle = undefined;
        owned.delete(token); finish?.();
    };
}
function capacity(label: string): never {
    throw Object.assign(new Error('Snapshot capacity exceeded: ' + label), { code: 'SNAPSHOT_CAPACITY' });
}
function positiveInteger(value: number, label: string, allowZero = false): void {
    if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
        throw new RangeError(label + ' must be a safe integer ' + (allowZero ? '>= 0' : '> 0'));
    }
}
function nonEmpty(value: string, label: string): void {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(label + ' must be non-empty');
}
/**
 * A Snapshot Core belongs to one App run. The trusted owner binds its identity
 * at construction and controls stop/dispose. Only the committer can publish.
 *
 * Synchronous Core commit is intentional: no await can interleave the final pointer swap.
 * Does NOT prove that a Producer's input represented an atomic SDK render; M3 owns that.
 */
export function createSnapshotCore(options: SnapshotStoreOptions): SnapshotCore {
    const limits = captureSnapshotLimits(options);
    const { appId, instanceId } = options;
    nonEmpty(appId, 'appId');
    nonEmpty(instanceId, 'instanceId');
    const now = options.now ?? Date.now;
    const maxHistoryEntries = options.maxHistoryEntries ?? DEFAULT_HISTORY_ENTRIES;
    const maxHistoryBytes = options.maxHistoryBytes ?? DEFAULT_HISTORY_BYTES;
    const historyTtlMs = options.historyTtlMs ?? DEFAULT_HISTORY_TTL;
    const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL;
    const maxActiveLeases = options.maxActiveLeases ?? DEFAULT_MAX_ACTIVE_LEASES;
    positiveInteger(maxActiveLeases, 'maxActiveLeases', true);
    positiveInteger(maxHistoryEntries, 'maxHistoryEntries', true);
    positiveInteger(maxHistoryBytes, 'maxHistoryBytes', true);
    positiveInteger(historyTtlMs, 'historyTtlMs', true);
    positiveInteger(leaseTtlMs, 'leaseTtlMs');

    const ceilings = { maxIdentityBytes: 8 * 1024 * 1024, maxCurrentBytes: 32 * 1024 * 1024 };
    const retention = {
        maxIdentityBytes: options.maxIdentityBytes === undefined ? ceilings.maxIdentityBytes : options.maxIdentityBytes,
        maxCurrentBytes: options.maxCurrentBytes === undefined ? ceilings.maxCurrentBytes : options.maxCurrentBytes,
    };
    for (const key of Object.keys(retention) as Array<keyof typeof retention>) {
        positiveInteger(retention[key], key, true);
        if (retention[key] > ceilings[key]) throw new RangeError(key + ' exceeds hard limit');
    }
    if (appId.length + instanceId.length > retention.maxIdentityBytes ||
        utf8Size(appId) + utf8Size(instanceId) > retention.maxIdentityBytes) capacity('maxIdentityBytes');
    let identity: Readonly<{ appId: string; instanceId: string }> | undefined = { appId, instanceId };
    let status: SnapshotHealth = 'unready';
    let current: SnapshotEntry | undefined;
    let lastIssue: SnapshotIssue | undefined;
    let seenProducerSeq = 0;
    let seenSourceEpoch = 0;
    const entries = new Map<string, SnapshotEntry>();

    function clock(): number {
        const value = now();
        if (!Number.isFinite(value) || value < 0) throw new RangeError('Clock must provide finite non-negative milliseconds');
        return value;
    }
    function cleanLeases(entry: SnapshotEntry, time: number): void {
        for (const [id, deadline] of entry.leases) {
            if (deadline !== null && time >= deadline) entry.leases.delete(id);
        }
    }
    function trimExpired(time = clock()): void {
        for (const [id, entry] of entries) {
            cleanLeases(entry, time);
            if (entry.retiredAt !== undefined && entry.leases.size === 0) {
                entries.delete(id);
            }
        }
    }
    function historyFitsAfterCommit(time: number): boolean {
        trimExpired(time);
        let count = 0, bytes = 0;
        // Only held entries, including the outgoing current snapshot, survive the swap.
        for (const entry of entries.values()) {
            if (entry.leases.size === 0) continue;
            count++;
            bytes += entry.bytes;
        }
        return count <= maxHistoryEntries && bytes <= maxHistoryBytes;
    }
    function retire(entry: SnapshotEntry, time: number): void {
        entry.canonical = undefined;
        entry.retiredAt = time;
        if (entry.leases.size === 0) entries.delete(entry.snapshot.id);
    }
    function clearExpiredAndLookup(id: string): SnapshotEntry | undefined {
        if (!identity) return undefined;
        trimExpired();
        return entries.get(id);
    }
    function rejected(code: SnapshotIssueCode, message: string, context: Parameters<typeof issue>[2] = {}): CommitResult {
        return Object.freeze({ status: 'rejected', issue: issue(code, message, context) });
    }
    function markDegraded(source: NonNullable<typeof identity>, problem: SnapshotIssue): SnapshotIssue {
        status = 'degraded';
        lastIssue = issue(problem.code, problem.message, {
            ...source, ...(problem.path !== undefined ? { path: problem.path } : {}),
        });
        return lastIssue;
    }

    const lifecycle = Object.freeze({
        stop(): void {
            if (!identity || status === 'stopped') return;
            status = 'stopped';
            lastIssue = undefined;
            const previous = current;
            current = undefined;
            let time: number | undefined;
            try { time = clock(); trimExpired(time); }
            catch { /* Revocation and explicit lease release do not require time. */ }
            if (previous) retire(previous, time ?? previous.snapshot.createdAt);
        },
        dispose(): void {
            if (!identity) return;
            identity = undefined;
            current = undefined;
            lastIssue = undefined;
            for (const entry of entries.values()) entry.leases.clear();
            entries.clear();
        },
    });

    const committer = Object.freeze({
        reportPrepareFailure(failure: PreparedSnapshotFailure): CommitResult {
            const source = identity;
            if (!source) return rejected('APP_STOPPED', 'Snapshot Core is closed');
            if (source.appId !== failure.appId || source.instanceId !== failure.instanceId) {
                return rejected('APP_INSTANCE_MISMATCH', 'Producer failure source is not an active App instance',
                    { appId: failure.appId, instanceId: failure.instanceId });
            }
            if (status === 'stopped') {
                return rejected('APP_STOPPED', 'App instance stopped', { appId: failure.appId });
            }
            if (!Number.isSafeInteger(failure.producerSeq) || failure.producerSeq <= seenProducerSeq ||
                !Number.isSafeInteger(failure.sourceEpoch) || failure.sourceEpoch < seenSourceEpoch) {
                return rejected('SNAPSHOT_SEQUENCE_STALE', 'Invalid/stale failure notification', { appId: failure.appId });
            }
            seenProducerSeq = failure.producerSeq;
            seenSourceEpoch = failure.sourceEpoch;
            return Object.freeze({ status: 'rejected', issue: markDegraded(source, failure.issue) });
        },
        accept(input: unknown): CommitResult {
            const source = identity;
            if (!source) return rejected('APP_STOPPED', 'Snapshot Core is closed');
            const time = clock();
            const checked = validatePreparedV5Draft(input, limits, (appId, instanceId) =>
                appId === source.appId && instanceId === source.instanceId ? current?.snapshot.tools : undefined);
            if (!identity) return rejected('APP_STOPPED', 'Snapshot Core is closed');
            if (!checked.ok) {
                const envelope = checked.envelope;
                if (envelope?.appId === source.appId && envelope.instanceId === source.instanceId &&
                    status !== 'stopped' && envelope.producerSeq > seenProducerSeq) {
                    seenProducerSeq = envelope.producerSeq;
                    seenSourceEpoch = Math.max(seenSourceEpoch, envelope.sourceEpoch);
                    markDegraded(source, checked.issue);
                }
                return Object.freeze({ status: 'rejected', issue: issue(checked.issue.code, checked.issue.message, checked.issue) });
            }
            const data = checked.value;
            const draft = data.draft;
            if (source.appId !== draft.appId) {
                return rejected('APP_NOT_REGISTERED', 'Draft belongs to a different App', { appId: draft.appId });
            }
            if (source.instanceId !== draft.instanceId) {
                return rejected('APP_INSTANCE_MISMATCH', 'Draft belongs to a different App instance', {
                    appId: draft.appId, instanceId: draft.instanceId,
                });
            }
            if (status === 'stopped') {
                return rejected('APP_STOPPED', 'App instance has stopped', {
                    appId: draft.appId, instanceId: draft.instanceId,
                });
            }
            if (draft.producerSeq <= seenProducerSeq) {
                return rejected('SNAPSHOT_SEQUENCE_STALE', 'Producer sequence did not advance', { appId: draft.appId });
            }
            if (draft.sourceEpoch < seenSourceEpoch) {
                seenProducerSeq = draft.producerSeq;
                const problem = issue('SNAPSHOT_SOURCE_CONFLICT', 'Producer source epoch regressed', { appId: draft.appId });
                markDegraded(source, problem);
                return Object.freeze({ status: 'rejected', issue: problem });
            }
            seenProducerSeq = draft.producerSeq;
            const equal = current?.canonical === data.canonicalContent;
            if ((equal || !current) && lastIssue && draft.sourceEpoch === seenSourceEpoch) {
                // Transport can replay a previously prepared frame. Only a new source
                // commit proves recovery from a failure at this epoch.
                return Object.freeze({ status: 'rejected', issue: lastIssue });
            }
            if (current && equal) {
                seenSourceEpoch = draft.sourceEpoch;
                status = 'ready';
                lastIssue = undefined;
                return Object.freeze({ status: 'unchanged', snapshot: current.snapshot });
            }
            if (current && draft.sourceEpoch === seenSourceEpoch) {
                const problem = issue('SNAPSHOT_SOURCE_EPOCH_CONFLICT',
                    'Semantic data changed without advancing the source epoch', { appId: draft.appId });
                markDegraded(source, problem);
                return Object.freeze({ status: 'rejected', issue: problem });
            }
            const revision = (current?.snapshot.revision ?? 0) + 1;
            if (!Number.isSafeInteger(revision)) {
                const problem = issue('SNAPSHOT_CAPACITY', 'Committed revision counter exhausted', { appId: draft.appId });
                markDegraded(source, problem);
                return Object.freeze({ status: 'rejected', issue: problem });
            }
            if (data.bytes > retention.maxCurrentBytes) {
                const problem = issue('SNAPSHOT_CAPACITY', 'Current snapshot budget exceeded: maxCurrentBytes', { appId: draft.appId });
                markDegraded(source, problem);
                return Object.freeze({ status: 'rejected', issue: problem });
            }
            if (!historyFitsAfterCommit(time)) {
                const problem = issue('SNAPSHOT_CAPACITY', 'Retained lease budget prevents a safe commit', { appId: draft.appId });
                markDegraded(source, problem);
                return Object.freeze({ status: 'rejected', issue: problem });
            }
            const snapshot = Object.freeze({
                schemaVersion: SNAPSHOT_SCHEMA_VERSION,
                id: snapshotId(draft.appId, draft.instanceId, revision),
                appId: draft.appId,
                instanceId: draft.instanceId,
                revision,
                createdAt: time,
                views: data.draft.views,
                refs: data.draft.refs,
                tools: data.draft.tools,
                contentDigest: data.contentDigest,
            }) as AppSnapshotV5;
            const record: SnapshotEntry = {
                snapshot, canonical: data.canonicalContent, bytes: data.bytes,
                leases: new Map(),
            };
            // The following mutation block has no await and publishes one pointer.
            if (current) retire(current, time);
            entries.set(snapshot.id, record);
            current = record;
            seenSourceEpoch = draft.sourceEpoch;
            lastIssue = undefined;
            status = 'ready';
            return Object.freeze({ status: 'published', snapshot });
        },
    });

    const store = Object.freeze({
        readAppIdentity(appId: string): AppIdentityRead {
            if (!identity || identity.appId !== appId) return Object.freeze({ status: 'absent' });
            return Object.freeze({ status: status === 'stopped' ? 'stopped' : 'active', instanceId: identity.instanceId });
        },
        readLatest(appId: string): SnapshotRead {
            if (!identity) return Object.freeze({ status: 'stopped' });
            if (identity.appId !== appId) return Object.freeze({ status: 'unready' });
            trimExpired();
            if (status === 'ready' && current) {
                return Object.freeze({ status: 'ready', snapshot: current.snapshot });
            }
            if (status === 'degraded') {
                return Object.freeze({
                    status: 'degraded',
                    ...(current ? { lastGood: current.snapshot } : {}),
                    issue: lastIssue ?? issue('SNAPSHOT_INVALID', 'Unknown projection failure', { appId }),
                });
            }
            return Object.freeze({ status: status === 'stopped' ? 'stopped' as const : 'unready' as const });
        },
        getById(id: string): SnapshotLookup {
            const entry = clearExpiredAndLookup(id);
            if (entry) return Object.freeze({ status: 'found', snapshot: entry.snapshot });
            return Object.freeze({
                status: 'rejected',
                issue: issue('SNAPSHOT_EXPIRED', 'Snapshot is unavailable or expired', { snapshotId: id }),
            });
        },
        acquire(id: string, requestedTtlMs?: number | Readonly<{ lifetime: 'owner' }>): LeaseResult {
            const entry = clearExpiredAndLookup(id);
            if (!entry) {
                return Object.freeze({ status: 'rejected', issue: issue('SNAPSHOT_EXPIRED', 'Snapshot unavailable', { snapshotId: id }) });
            }
            const fields = requestedTtlMs !== null && typeof requestedTtlMs === 'object'
                ? Object.getOwnPropertyDescriptors(requestedTtlMs) : undefined;
            const owned = fields !== undefined && Reflect.ownKeys(fields).length === 1 &&
                fields.lifetime?.enumerable === true && 'value' in fields.lifetime && fields.lifetime.value === 'owner';
            const ttl = requestedTtlMs === undefined ? leaseTtlMs : requestedTtlMs;
            if (!owned && (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > leaseTtlMs)) {
                return Object.freeze({ status: 'rejected', issue: issue('SNAPSHOT_INVALID', 'Invalid lease TTL', { snapshotId: id }) });
            }
            const time = clock();
            // An explicit owner keeps the original source usable across long model
            // turns. A timed pin alone must not renew expired history forever.
            if (entry.retiredAt !== undefined && time >= entry.retiredAt + historyTtlMs &&
                ![...entry.leases.values()].some(deadline => deadline === null)) {
                return Object.freeze({ status: 'rejected', issue: issue('SNAPSHOT_EXPIRED', 'Historical snapshot retention expired', { snapshotId: id }) });
            }
            const activeLeaseCount = [...entries.values()].reduce((sum, item) => sum + item.leases.size, 0);
            if (activeLeaseCount >= maxActiveLeases) {
                return Object.freeze({ status: 'rejected', issue: issue('SNAPSHOT_CAPACITY', 'Active lease limit reached', { snapshotId: id }) });
            }
            const expiresAt = owned ? null : time + (ttl as number);
            const token = {};
            entry.leases.set(token, expiresAt);
            const lease: SnapshotLease = Object.freeze({
                snapshot: entry.snapshot, expiresAt, release: releaseLease(entry.leases, token, () => {
                    if (entry.retiredAt !== undefined && entry.leases.size === 0) entries.delete(id);
                }),
            });
            return Object.freeze({ status: 'acquired', lease });
        },
        resolveRef(selector: RefSelector): RefLookup {
            if (!identity) return Object.freeze({ status: 'rejected', issue: issue('SNAPSHOT_EXPIRED', 'Snapshot Core is closed') });
            const lookup = store.getById(selector.snapshotId);
            if (lookup.status === 'rejected') return lookup;
            const snapshot = lookup.snapshot;
            if (snapshot.appId !== selector.appId || snapshot.instanceId !== selector.instanceId) {
                return Object.freeze({
                    status: 'rejected', issue: issue('APP_INSTANCE_MISMATCH', 'Ref source identity mismatch', { snapshotId: selector.snapshotId }),
                });
            }
            if (typeof selector.viewInstanceId !== 'string' ||
                !snapshot.views.some(view =>
                    view.id === selector.viewId && view.viewInstanceId === selector.viewInstanceId)) {
                return Object.freeze({
                    status: 'rejected', issue: issue('VIEW_INSTANCE_REVOKED',
                        'Ref View instance is not part of this source snapshot',
                        { snapshotId: selector.snapshotId }),
                });
            }
            const ref = snapshot.refs[refKey(selector.viewId, selector.viewInstanceId, selector.refId)];
            if (!ref) return Object.freeze({ status: 'rejected', issue: issue('REF_NOT_FOUND',
                'Ref not present in source snapshot', { snapshotId: selector.snapshotId }) });
            return Object.freeze({ status: 'resolved', ref, target: ref.target });
        },
        getTool(selector: ToolSelector): ToolLookup {
            if (!identity) return Object.freeze({ status: 'rejected', issue: issue('SNAPSHOT_EXPIRED', 'Snapshot Core is closed') });
            const lookup = store.getById(selector.snapshotId);
            if (lookup.status === 'rejected') return lookup;
            const snapshot = lookup.snapshot;
            if (snapshot.appId !== selector.appId || snapshot.instanceId !== selector.instanceId) {
                return Object.freeze({
                    status: 'rejected', issue: issue('APP_INSTANCE_MISMATCH', 'Tool source identity mismatch', { snapshotId: selector.snapshotId }),
                });
            }
            const tool = snapshot.tools[selector.toolId];
            if (tool) return Object.freeze({ status: 'found', tool });
            return Object.freeze({ status: 'rejected', issue: issue('TOOL_UNAVAILABLE',
                'Tool unavailable in source snapshot', { snapshotId: selector.snapshotId }) });
        },
        inspect(): SnapshotStoreStats {
            if (identity) trimExpired();
            const snapshots = [...entries.values()];
            const histories = snapshots.filter(entry => entry.retiredAt !== undefined);
            return Object.freeze({
                state: identity ? 'active' : 'disposed',
                currentBytes: current?.bytes ?? 0,
                diagnosticBytes: lastIssue ? utf8Size(lastIssue.code) + utf8Size(lastIssue.message) + utf8Size(lastIssue.path ?? '') : 0,
                currentSnapshots: current ? 1 : 0,
                historicalSnapshots: histories.length,
                historicalBytes: histories.reduce((sum, entry) => sum + entry.bytes, 0),
                activeLeases: snapshots.reduce((sum, entry) => sum + entry.leases.size, 0),
            });
        },
    });
    return Object.freeze({ store, committer, lifecycle });
}
