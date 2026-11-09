import { SNAPSHOT_SCHEMA_VERSION } from './types.js';
import type {
    AppSnapshotV3, CommitResult, LeaseResult, PreparedSnapshotFailure, RefLookup, RefSelector, SnapshotCore,
    SnapshotIssue, SnapshotIssueCode, SnapshotLease, SnapshotLookup, SnapshotRead,
    SnapshotStoreOptions, SnapshotStoreStats, ToolLookup, ToolSelector, AppIdentityRead,
} from './types.js';
import { utf8Size } from './json.js';
import { refKey } from './snapshot-support.js';
import { validatePreparedV3Draft } from './v3-validator.js';

interface SnapshotEntry {
    readonly snapshot: AppSnapshotV3;
    canonical: string | undefined;
    readonly bytes: number;
    readonly leases: Map<object, number | null>;
    retiredAt?: number;
}
interface ActiveApp {
    readonly instanceId: string;
    revision: number;
    seenProducerSeq: number;
    seenSourceEpoch: number;
    status: 'unready' | 'ready' | 'degraded' | 'stopped';
    current?: SnapshotEntry;
    issue?: SnapshotIssue;
}
type CommitState = { ok: true; evictions: SnapshotEntry[] } | { ok: false };
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
function snapshotId(appId: string, instanceId: string, revision: number): string {
    return 'aotui-app-snapshot:v3:' + JSON.stringify([appId, instanceId, revision]);
}

/**
 * Constructs a capability-separated Snapshot Core.
 * Only committer.accept can publish; store is read-only except acquiring/releasing leases;
 * lifecycle.startApp/stopApp is reserved for a trusted runtime controller.
 *
 * Synchronous Core commit is intentional: no await can interleave the final pointer swap.
 * Does NOT prove that a Producer's input represented an atomic SDK render; M3 owns that.
 */
export function createSnapshotCore(options: SnapshotStoreOptions = {}): SnapshotCore {
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

    const retention = {
        maxAppRecords: options.maxAppRecords === undefined ? 1024 : options.maxAppRecords,
        maxInstanceIds: options.maxInstanceIds === undefined ? 65536 : options.maxInstanceIds,
        maxIdentityBytes: options.maxIdentityBytes === undefined ? 8 * 1024 * 1024 : options.maxIdentityBytes,
        maxCurrentBytes: options.maxCurrentBytes === undefined ? 32 * 1024 * 1024 : options.maxCurrentBytes,
    };
    const ceilings = { maxAppRecords: 1024, maxInstanceIds: 65536,
        maxIdentityBytes: 8 * 1024 * 1024, maxCurrentBytes: 32 * 1024 * 1024 };
    for (const key of Object.keys(retention) as Array<keyof typeof retention>) {
        positiveInteger(retention[key], key, true);
        if (retention[key] > ceilings[key]) throw new RangeError(key + ' exceeds hard limit');
    }
    let disposed = false;
    let identityBytes = 0;
    let currentBytes = 0;
    const apps = new Map<string, ActiveApp>();
    const usedInstanceIds = new Set<string>();
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
    function historyEntries(): SnapshotEntry[] {
        return [...entries.values()].filter(entry => entry.retiredAt !== undefined);
    }
    function budgetTransition(previous: SnapshotEntry | undefined, time: number): CommitState {
        trimExpired(time);
        const candidates = historyEntries();
        if (previous && previous.retiredAt === undefined) candidates.push(previous);
        const toRemove: SnapshotEntry[] = [];
        let count = candidates.length;
        let bytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
        const removable = candidates
            .filter(entry => entry.leases.size === 0)
            .sort((a, b) => (a.retiredAt ?? time) - (b.retiredAt ?? time));
        for (const entry of removable) {
            if (count <= maxHistoryEntries && bytes <= maxHistoryBytes) break;
            toRemove.push(entry);
            count--;
            bytes -= entry.bytes;
        }
        if (count > maxHistoryEntries || bytes > maxHistoryBytes) return { ok: false };
        return { ok: true, evictions: toRemove };
    }
    function retire(entry: SnapshotEntry, time: number): void {
        entry.canonical = undefined;
        entry.retiredAt = time;
        trimExpired(time);
    }
    function clearExpiredAndLookup(id: string): SnapshotEntry | undefined {
        if (disposed) return undefined;
        trimExpired();
        return entries.get(id);
    }
    function rejected(code: SnapshotIssueCode, message: string, context: Parameters<typeof issue>[2] = {}): CommitResult {
        return Object.freeze({ status: 'rejected', issue: issue(code, message, context) });
    }
    function markDegraded(app: ActiveApp, appId: string, problem: SnapshotIssue): void {
        app.status = 'degraded';
        app.issue = issue(problem.code, problem.message, {
            appId, instanceId: app.instanceId, ...(problem.path !== undefined ? { path: problem.path } : {}),
        });
    }

    const lifecycle = Object.freeze({
        startApp(appId: string, instanceId: string): void {
            if (disposed) throw Object.assign(new Error('Snapshot Core is closed'), { code: 'SNAPSHOT_CORE_CLOSED' });
            nonEmpty(appId, 'appId');
            nonEmpty(instanceId, 'instanceId');
            if (usedInstanceIds.has(instanceId)) {
                const existing = apps.get(appId);
                if (existing?.instanceId === instanceId && existing.status !== 'stopped') return;
                throw new Error('APP_INSTANCE_MISMATCH: instance ID must be unique across restarts');
            }
            const prior = apps.get(appId);
            if (!prior && apps.size >= retention.maxAppRecords) capacity('maxAppRecords');
            if (usedInstanceIds.size >= retention.maxInstanceIds) capacity('maxInstanceIds');
            const remaining = retention.maxIdentityBytes - identityBytes;
            if (instanceId.length + (prior ? 0 : appId.length) > remaining) capacity('maxIdentityBytes');
            const addedBytes = utf8Size(instanceId) + (prior ? 0 : utf8Size(appId));
            if (addedBytes > remaining) capacity('maxIdentityBytes');
            const time = clock();
            if (prior?.current) {
                currentBytes -= prior.current.bytes;
                retire(prior.current, time);
                // Lifecycle changes may have to invalidate an app while leases are
                // still live. Preserve pinned snapshots; block future commits if over budget.
                const trim = budgetTransition(undefined, time);
                if (trim.ok) trim.evictions.forEach(entry => entries.delete(entry.snapshot.id));
                else for (const entry of historyEntries()) {
                    if (entry.leases.size === 0) entries.delete(entry.snapshot.id);
                }
            }
            identityBytes += addedBytes;
            usedInstanceIds.add(instanceId);
            apps.set(appId, {
                instanceId, revision: 0, seenProducerSeq: 0, seenSourceEpoch: 0,
                status: 'unready',
            });
        },
        stopApp(appId: string, instanceId: string): void {
            if (disposed) return;
            const app = apps.get(appId);
            if (!app || app.instanceId !== instanceId || app.status === 'stopped') return;
            const time = clock();
            if (app.current) {
                currentBytes -= app.current.bytes;
                retire(app.current, time);
                app.current = undefined;
            }
            app.status = 'stopped';
            app.issue = undefined;
            const trim = budgetTransition(undefined, time);
            if (trim.ok) trim.evictions.forEach(entry => entries.delete(entry.snapshot.id));
            else for (const entry of historyEntries()) {
                if (entry.leases.size === 0) entries.delete(entry.snapshot.id);
            }
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const entry of entries.values()) entry.leases.clear();
            apps.clear();
            usedInstanceIds.clear();
            entries.clear();
            identityBytes = 0;
            currentBytes = 0;
        },
    });

    const committer = Object.freeze({
        reportPrepareFailure(failure: PreparedSnapshotFailure): CommitResult {
            if (disposed) return rejected('APP_STOPPED', 'Snapshot Core is closed');
            const app = apps.get(failure.appId);
            if (!app || app.instanceId !== failure.instanceId) {
                return rejected('APP_INSTANCE_MISMATCH', 'Producer failure source is not an active App instance',
                    { appId: failure.appId, instanceId: failure.instanceId });
            }
            if (app.status === 'stopped') {
                return rejected('APP_STOPPED', 'App instance stopped', { appId: failure.appId });
            }
            if (!Number.isSafeInteger(failure.producerSeq) || failure.producerSeq <= app.seenProducerSeq ||
                !Number.isSafeInteger(failure.sourceEpoch) || failure.sourceEpoch < app.seenSourceEpoch) {
                return rejected('SNAPSHOT_SEQUENCE_STALE', 'Invalid/stale failure notification', { appId: failure.appId });
            }
            app.seenProducerSeq = failure.producerSeq;
            app.seenSourceEpoch = failure.sourceEpoch;
            markDegraded(app, failure.appId, failure.issue);
            return Object.freeze({ status: 'rejected', issue: app.issue! });
        },
        accept(input: unknown): CommitResult {
            if (disposed) return rejected('APP_STOPPED', 'Snapshot Core is closed');
            const time = clock();
            const checked = validatePreparedV3Draft(input, options.limits);
            if (!checked.ok) {
                const envelope = checked.envelope;
                if (envelope) {
                    const app = apps.get(envelope.appId);
                    if (app?.instanceId === envelope.instanceId &&
                        app.status !== 'stopped' && envelope.producerSeq > app.seenProducerSeq) {
                        app.seenProducerSeq = envelope.producerSeq;
                        app.seenSourceEpoch = Math.max(app.seenSourceEpoch, envelope.sourceEpoch);
                        markDegraded(app, envelope.appId, checked.issue);
                    }
                }
                return Object.freeze({ status: 'rejected', issue: issue(checked.issue.code, checked.issue.message, checked.issue) });
            }
            const data = checked.value;
            const draft = data.draft;
            const app = apps.get(draft.appId);
            if (!app) return rejected('APP_NOT_REGISTERED', 'App has not been registered', { appId: draft.appId });
            if (app.instanceId !== draft.instanceId) {
                return rejected('APP_INSTANCE_MISMATCH', 'Draft belongs to a different App instance', {
                    appId: draft.appId, instanceId: draft.instanceId,
                });
            }
            if (app.status === 'stopped') {
                return rejected('APP_STOPPED', 'App instance has stopped', {
                    appId: draft.appId, instanceId: draft.instanceId,
                });
            }
            if (draft.producerSeq <= app.seenProducerSeq) {
                return rejected('SNAPSHOT_SEQUENCE_STALE', 'Producer sequence did not advance', { appId: draft.appId });
            }
            if (draft.sourceEpoch < app.seenSourceEpoch) {
                app.seenProducerSeq = draft.producerSeq;
                const problem = issue('SNAPSHOT_SOURCE_CONFLICT', 'Producer source epoch regressed', { appId: draft.appId });
                markDegraded(app, draft.appId, problem);
                return Object.freeze({ status: 'rejected', issue: problem });
            }
            app.seenProducerSeq = draft.producerSeq;
            const equal = app.current?.canonical === data.canonicalContent;
            if (equal) {
                app.seenSourceEpoch = draft.sourceEpoch;
                app.status = 'ready';
                app.issue = undefined;
                return Object.freeze({ status: 'unchanged', snapshot: app.current!.snapshot });
            }
            if (app.current && draft.sourceEpoch === app.seenSourceEpoch) {
                const problem = issue('SNAPSHOT_SOURCE_EPOCH_CONFLICT',
                    'Semantic data changed without advancing the source epoch', { appId: draft.appId });
                markDegraded(app, draft.appId, problem);
                return Object.freeze({ status: 'rejected', issue: problem });
            }
            if (app.revision >= Number.MAX_SAFE_INTEGER) {
                const problem = issue('SNAPSHOT_CAPACITY', 'Committed revision counter exhausted', { appId: draft.appId });
                markDegraded(app, draft.appId, problem);
                return Object.freeze({ status: 'rejected', issue: problem });
            }
            if (currentBytes - (app.current?.bytes ?? 0) + data.bytes > retention.maxCurrentBytes) {
                const problem = issue('SNAPSHOT_CAPACITY', 'Current snapshot budget exceeded: maxCurrentBytes', { appId: draft.appId });
                markDegraded(app, draft.appId, problem);
                return Object.freeze({ status: 'rejected', issue: problem });
            }
            const budget = budgetTransition(app.current, time);
            if (!budget.ok) {
                const problem = issue('SNAPSHOT_CAPACITY', 'Retained lease budget prevents a safe commit', { appId: draft.appId });
                markDegraded(app, draft.appId, problem);
                return Object.freeze({ status: 'rejected', issue: problem });
            }
            const revision = app.revision + 1;
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
            }) as AppSnapshotV3;
            const record: SnapshotEntry = {
                snapshot, canonical: data.canonicalContent, bytes: data.bytes,
                leases: new Map(),
            };
            // The following mutation block has no await and publishes one pointer.
            budget.evictions.forEach(entry => entries.delete(entry.snapshot.id));
            if (app.current && entries.has(app.current.snapshot.id)) retire(app.current, time);
            entries.set(snapshot.id, record);
            currentBytes += record.bytes - (app.current?.bytes ?? 0);
            app.current = record;
            app.revision = revision;
            app.seenSourceEpoch = draft.sourceEpoch;
            app.issue = undefined;
            app.status = 'ready';
            return Object.freeze({ status: 'published', snapshot });
        },
    });

    const store = Object.freeze({
        readAppIdentity(appId: string): AppIdentityRead {
            const app = apps.get(appId);
            if (!app) return Object.freeze({ status: 'absent' });
            return Object.freeze({ status: app.status === 'stopped' ? 'stopped' : 'active', instanceId: app.instanceId });
        },
        readLatest(appId: string): SnapshotRead {
            if (disposed) return Object.freeze({ status: 'stopped' });
            trimExpired();
            const app = apps.get(appId);
            if (!app) return Object.freeze({ status: 'unready' });
            if (app.status === 'ready' && app.current) {
                return Object.freeze({ status: 'ready', snapshot: app.current.snapshot });
            }
            if (app.status === 'degraded') {
                return Object.freeze({
                    status: 'degraded',
                    ...(app.current ? { lastGood: app.current.snapshot } : {}),
                    issue: app.issue ?? issue('SNAPSHOT_INVALID', 'Unknown projection failure', { appId }),
                });
            }
            return Object.freeze({ status: app.status === 'stopped' ? 'stopped' as const : 'unready' as const });
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
            if (disposed) return Object.freeze({ status: 'rejected', issue: issue('SNAPSHOT_EXPIRED', 'Snapshot Core is closed') });
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
            if (disposed) return Object.freeze({ status: 'rejected', issue: issue('SNAPSHOT_EXPIRED', 'Snapshot Core is closed') });
            const lookup = store.getById(selector.snapshotId);
            if (lookup.status === 'rejected') return lookup;
            const snapshot = lookup.snapshot;
            if (snapshot.appId !== selector.appId || snapshot.instanceId !== selector.instanceId) {
                return Object.freeze({
                    status: 'rejected', issue: issue('APP_INSTANCE_MISMATCH', 'Tool source identity mismatch', { snapshotId: selector.snapshotId }),
                });
            }
            const tool = snapshot.tools[selector.toolId];
            if (tool && tool.execution.kind === 'view-type') return Object.freeze({ status: 'found', tool });
            return Object.freeze({ status: 'rejected', issue: issue('TOOL_UNAVAILABLE',
                'Tool unavailable in source snapshot', { snapshotId: selector.snapshotId }) });
        },
        inspect(): SnapshotStoreStats {
            if (!disposed) trimExpired();
            const snapshots = [...entries.values()];
            const histories = snapshots.filter(entry => entry.retiredAt !== undefined);
            return Object.freeze({
                state: disposed ? 'disposed' : 'active',
                appRecords: apps.size,
                issuedInstanceIds: usedInstanceIds.size,
                identityBytes, currentBytes,
                diagnosticBytes: [...apps.values()].reduce((sum, app) => sum + (app.issue
                    ? utf8Size(app.issue.code) + utf8Size(app.issue.message) + utf8Size(app.issue.path ?? '') : 0), 0),
                activeApps: [...apps.values()].filter(app => app.status !== 'stopped').length,
                currentSnapshots: snapshots.length - histories.length,
                historicalSnapshots: histories.length,
                historicalBytes: histories.reduce((sum, entry) => sum + entry.bytes, 0),
                activeLeases: snapshots.reduce((sum, entry) => sum + entry.leases.size, 0),
            });
        },
    });
    return Object.freeze({ store, committer, lifecycle });
}
