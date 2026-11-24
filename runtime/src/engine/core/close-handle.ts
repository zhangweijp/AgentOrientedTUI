import type { CloseHandle, CloseReport } from '../../spi/runtime/close.interface.js';
import type { HostResourceReport } from '../app/worker-host.js';

export function closeError(code: string): Error & { readonly code: string } {
    return Object.defineProperty(new Error(code), 'code', { value: code, enumerable: true }) as Error & { readonly code: string };
}
export function closeTimeout(options?: { readonly timeoutMs?: number }): number {
    if (options !== undefined && (!options || typeof options !== 'object')) throw closeError('CLOSE_OPTIONS_INVALID');
    let supplied: number | undefined;
    try { supplied = options?.timeoutMs; } catch { throw closeError('CLOSE_OPTIONS_INVALID'); }
    const value = supplied === undefined ? 30000 : supplied;
    if (!Number.isSafeInteger(value) || value < 1 || value > 300000) throw closeError('CLOSE_OPTIONS_INVALID');
    return value;
}
function freezeClose(value: unknown): void {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freezeClose(child);
        Object.freeze(value);
    }
}

/** The owner supplies immutable progress reports and the actual immutable completion report. */
export function createCloseHandle<R extends CloseReport>(inspect: () => R, completion: Promise<R>): CloseHandle<R> {
    let final: R | undefined;
    type Result = Awaited<ReturnType<CloseHandle<R>['wait']>>;
    const waiters = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: (value: Result) => void; reject: (reason: Error) => void }>();
    const completed = completion.then(report => {
        final = report;inspect = () => report;
        for (const waiter of waiters) { clearTimeout(waiter.timer);waiter.resolve(Object.freeze({ status: 'settled', report })); }
        waiters.clear();return report;
    });
    void completed.catch(() => {
        for (const waiter of waiters) { clearTimeout(waiter.timer);waiter.reject(closeError('CLOSE_COMPLETION_FAILED')); }
        waiters.clear();
    });
    return Object.freeze({ completion: completed, inspect: () => inspect(), wait(options?: { readonly timeoutMs?: number }) {
        let timeout: number;
        try { timeout = closeTimeout(options); } catch (error) { return Promise.reject(error); }
        if (final) return Promise.resolve(Object.freeze({ status: 'settled' as const, report: final }));
        if (waiters.size >= 16) return Promise.reject(closeError('CLOSE_OBSERVER_LIMIT'));
        return new Promise<Result>((resolve, reject) => {
            const waiter: { resolve: (value: Result) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> } = { resolve, reject, timer: setTimeout(() => {
                waiters.delete(waiter);clearTimeout(waiter.timer);
                resolve(Object.freeze({ status: 'deadline', report: inspect() }));
            }, timeout) };
            waiters.add(waiter);
        });
    } });
}

type Mutable<T> = T extends readonly (infer E)[] ? Mutable<E>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export type CloseState = Mutable<CloseReport>;
type Stage = CloseReport['failures'][number]['stage'];
type Code = CloseReport['failures'][number]['codes'][number];

export function displayCloseId(value: string): string {
    let result = '', bytes = 0;
    for (const char of value) {
        const point = char.codePointAt(0)!;const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (bytes + size > 256) break;result += char;bytes += size;
    }
    return result;
}
export function newCloseState(scope: CloseReport['scope']): CloseState {
    const counts = () => ({ accepted: 0, settled: 0, pending: 0, notVerifiedReleased: 0 });
    return { scope, state: 'closing', ok: false, hasFailures: false, resourcesReleased: true, verification: 'managed',
        apps: counts(), desktops: counts(), pendingTasks: 0, unverifiedParticipants: 0,
        appCleanup: { managedApps: 0, completedApps: 0, failedApps: 0 },
        resources: { retainedOwners: 0, pendingOperations: 0 },
        interactions: { verified: true, retainedOperations: 0 },
        workers: { ownership: 'not-owned', report: null },
        cleanup: { signalBus: 'not-owned', logger: 'not-owned' },
        failures: [], failureCount: 0, samplesTruncated: false };
}
export function addCloseFailure(state: CloseState, stage: Stage, codes: readonly Code[], ids: { desktopId?: string; appId?: string } = {}): void {
    const distinct = [...new Set(codes)];if (!distinct.length) return;
    state.failureCount += distinct.length;state.hasFailures = true;
    if (distinct.length > 8 || state.failures.length >= 16) state.samplesTruncated = true;
    if (state.failures.length < 16) state.failures.push({ stage, codes: distinct.slice(0, 8),
        ...(ids.desktopId !== undefined ? { desktopId: displayCloseId(ids.desktopId) } : {}),
        ...(ids.appId !== undefined ? { appId: displayCloseId(ids.appId) } : {}) });
}
/** Fold each child once; callers keep unresolved owners separately rather than retaining a report history. */
export function mergeCloseReport(state: CloseState, child: CloseReport): void {
    for (const group of ['apps', 'desktops', 'resources'] as const) {
        for (const key of Object.keys(state[group])) (state[group] as unknown as Record<string, number>)[key] += (child[group] as unknown as Record<string, number>)[key];
    }
    if (child.persistence) {
        const persistence = state.persistence ??= newPersistenceSummary();
        for (const key of Object.keys(persistence) as Array<keyof typeof persistence>) persistence[key] += child.persistence[key];
    }
    if (child.appCleanup && state.appCleanup) for (const key of Object.keys(state.appCleanup) as Array<keyof NonNullable<CloseReport['appCleanup']>>)
        state.appCleanup[key] += child.appCleanup[key];
    state.resourcesReleased &&= child.resourcesReleased;
    if (state.verification !== child.verification) state.verification = 'mixed';
    state.unverifiedParticipants += child.unverifiedParticipants;state.failureCount += child.failureCount;
    mergeInteractions(state, child.interactions?.verified === true, child.interactions?.retainedOperations, child.unverifiedParticipants);
    state.hasFailures ||= child.hasFailures;state.samplesTruncated ||= child.samplesTruncated;
    for (const sample of child.failures) {
        if (state.failures.length >= 16) { state.samplesTruncated = true;break; }
        state.failures.push({ stage: sample.stage, codes: [...sample.codes],
            ...(sample.desktopId !== undefined ? { desktopId: displayCloseId(sample.desktopId) } : {}),
            ...(sample.appId !== undefined ? { appId: displayCloseId(sample.appId) } : {}) });
    }
}

function mergeInteractions(state: CloseState, verified: boolean, count: number | undefined, alreadyUnverified = 0): void {
    const target = state.interactions ??= { verified: true, retainedOperations: 0 };
    let valid = verified;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) valid = false;
    else if (count > Number.MAX_SAFE_INTEGER - target.retainedOperations) {
        target.retainedOperations = Number.MAX_SAFE_INTEGER;
        valid = false;
    } else target.retainedOperations += count;
    if (!valid) {
        target.verified = false;state.verification = 'mixed';state.resourcesReleased = false;
        if (!(alreadyUnverified > 0)) state.unverifiedParticipants++;
    }
    if (count !== 0) state.resourcesReleased = false;
}
/** Finalize a complete report whose mutable contents belong to this snapshot. */
export function snapshotClose<R extends CloseReport>(state: R): R {
    const report = { ...state, ok: state.state === 'settled' && state.resourcesReleased && state.verification === 'managed' && !state.hasFailures };
    freezeClose(report);
    return report;
}
function newPersistenceSummary(): NonNullable<CloseState['persistence']> {
    return { managedApps: 0, closeReceipts: 0, missingCloseReceipts: 0, confirmedFlushes: 0,
        failedFlushes: 0, unknownApps: 0, unsavedKeys: 0 };
}

/** Build the App's report from verified Worker and backend facts. */
export function recordAppClose(state: CloseState, host: HostResourceReport, ids: { desktopId: string; appId: string }, codes: ReadonlySet<Code>): void {
    const { storage, appCleanup } = host;
    state.resourcesReleased = host.resourcesReleased;
    state.apps.accepted = 1;
    state.apps.settled = state.state === 'settled' ? 1 : 0;
    state.apps.pending = 1 - state.apps.settled;
    const closed = host.interactions?.closed;
    mergeInteractions(state, typeof closed === 'boolean', host.interactions?.retainedOperations);
    if (closed !== true) state.resourcesReleased = false;
    const appIssues = new Set([...codes].filter(code => code !== 'PERSISTENCE_CLOSE_FAILED'));
    if (appCleanup?.support === 'managed') {
        state.appCleanup!.managedApps = 1;
        state.appCleanup!.completedApps = appCleanup.report?.state === 'completed' ? 1 : 0;
        state.appCleanup!.failedApps = appCleanup.report?.state === 'failed' ? 1 : 0;
        if (state.appCleanup!.failedApps || state.state === 'settled' && !state.appCleanup!.completedApps)
            appIssues.add('APP_CLOSE_FAILED');
    }
    if (storage) {
        const persistence = state.persistence = newPersistenceSummary();
        const lifecycle = storage.lifecycle;
        persistence.managedApps = 1;
        if (lifecycle) {
            persistence.closeReceipts = 1;
            if (lifecycle.flush.ok) persistence.confirmedFlushes = 1;
            else persistence.failedFlushes = 1;
        } else if (state.state === 'settled') persistence.missingCloseReceipts = 1;
        state.resources.retainedOwners = Number(storage.ownerRetained);
        state.resources.pendingOperations = storage.pending;
        persistence.unsavedKeys = new Set(lifecycle?.dispose.unsaved.map(entry => JSON.stringify([entry.address.namespace, entry.address.key]))).size;
        const unknown = storage.uncertain || storage.release?.status === 'unknown' || lifecycle?.dispose.release.status === 'unknown' ||
            lifecycle?.flush.entries.some(entry => entry.status === 'unknown') || lifecycle?.dispose.unsaved.some(entry => entry.status === 'unknown');
        persistence.unknownApps = unknown ? 1 : 0;
        if (codes.has('PERSISTENCE_CLOSE_FAILED') || storage.unsafe || unknown || persistence.failedFlushes || persistence.unsavedKeys ||
            storage.release?.status === 'failed' || lifecycle?.dispose.release.status === 'failed' ||
            state.state === 'settled' && (!lifecycle || storage.release?.status !== 'released'))
            addCloseFailure(state, 'persistence', ['PERSISTENCE_CLOSE_FAILED'], ids);
        if (lifecycle?.unmount === 'failed') appIssues.add('APP_UNMOUNT_FAILED');
    }
    state.apps.notVerifiedReleased = state.resourcesReleased ? 0 : 1;
    addCloseFailure(state, 'apps', [...appIssues], ids);
    addCloseFailure(state, 'worker', host.issues, ids);
}
