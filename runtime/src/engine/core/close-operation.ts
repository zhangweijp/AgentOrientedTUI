import type { CloseOperation, CloseReport } from '../../spi/runtime/close.interface.js';
import type { AppManagerCloseReport } from '../../spi/runtime/close.interface.js';
import type { SandboxCloseReport } from '../app/worker-sandbox.js';

export function closeError(code: string, report?: CloseReport): Error & { readonly code: string; readonly report?: CloseReport } {
    const error = new Error(code);
    Object.defineProperties(error, { code: { value: code, enumerable: true }, ...(report ? { report: { value: report, enumerable: true } } : {}) });
    return error as Error & { readonly code: string; readonly report?: CloseReport };
}
export function closeTimeout(options?: { readonly timeoutMs?: number }): number {
    if (options !== undefined && (!options || typeof options !== 'object')) throw closeError('CLOSE_OPTIONS_INVALID');
    let supplied: number | undefined;
    try { supplied = options?.timeoutMs; } catch { throw closeError('CLOSE_OPTIONS_INVALID'); }
    const value = supplied === undefined ? 30000 : supplied;
    if (!Number.isSafeInteger(value) || value < 1 || value > 300000) throw closeError('CLOSE_OPTIONS_INVALID');
    return value;
}
export function freezeClose<T>(value: T): T {
    if (Array.isArray(value)) return Object.freeze(value.map(item => freezeClose(item))) as T;
    if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeClose(item)]))) as T;
    return value;
}

/** The owner supplies an actual-completion promise whose failures are already represented in its report. */
export function createCloseOperation<R extends CloseReport>(inspect: () => R, completion: Promise<R>): CloseOperation<R> {
    let reader: (() => R) | undefined = inspect;
    let final: R | undefined;
    type Result = Awaited<ReturnType<CloseOperation<R>['wait']>>;
    const waiters = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: (value: Result) => void; reject: (reason: Error) => void }>();
    const snapshot = () => freezeClose(final ?? reader!());
    const completed = completion.then(report => {
        final = freezeClose(report);reader = undefined;inspect = () => final!;
        for (const waiter of waiters) { clearTimeout(waiter.timer);waiter.resolve(Object.freeze({ status: 'settled', report: snapshot() })); }
        waiters.clear();return final;
    });
    void completed.catch(() => {
        for (const waiter of waiters) { clearTimeout(waiter.timer);waiter.reject(closeError('LEGACY_CLOSE_FAILED')); }
        waiters.clear();
    });
    return Object.freeze({ completion: completed, inspect: snapshot, wait(options?: { readonly timeoutMs?: number }) {
        let timeout: number;
        try { timeout = closeTimeout(options); } catch (error) { return Promise.reject(error); }
        if (final) return Promise.resolve(Object.freeze({ status: 'settled' as const, report: snapshot() }));
        const current = snapshot();
        if (current.state === 'settled') return Promise.resolve(Object.freeze({ status: 'settled' as const, report: current }));
        if (waiters.size >= 16) return Promise.reject(closeError('CLOSE_OBSERVER_LIMIT'));
        return new Promise<Result>((resolve, reject) => {
            const waiter: { resolve: (value: Result) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> } = { resolve, reject, timer: setTimeout(() => {
                waiters.delete(waiter);clearTimeout(waiter.timer);
                resolve(Object.freeze({ status: 'deadline', report: snapshot() }));
            }, timeout) };
            waiters.add(waiter);
        });
    } });
}

export function closeVoid(completion: Promise<CloseReport>, code: 'APP_CLOSE_FAILED' | 'DESKTOP_CLOSE_FAILED' | 'RUNTIME_CLOSE_FAILED'): Promise<void> {
    const promise = completion.then(report => { if (report.hasFailures) throw closeError(code, report); });
    void promise.catch(() => {});return promise;
}

type Mutable<T> = T extends readonly (infer E)[] ? Mutable<E>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export type CloseState = Mutable<CloseReport> & { desktopId?: string; found?: boolean };
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
export function newCloseState(scope: CloseReport['scope'], intent: CloseReport['intent'] = 'close'): CloseState {
    const counts = () => ({ accepted: 0, settled: 0, pending: 0, notVerifiedReleased: 0 });
    return { scope, state: 'closing', intent, ok: false, hasFailures: false, resourcesReleased: true, verification: 'managed',
        apps: counts(), desktops: counts(), pendingOperations: 0, unverifiedParticipants: 0,
        appCleanup: { managedApps: 0, legacyUnverifiedApps: 0, completedApps: 0, failedApps: 0 },
        persistence: { managedApps: 0, legacyUnverifiedApps: 0, unnegotiatedApps: 0, notUsedApps: 0, closeReceipts: 0,
            missingCloseReceipts: 0, confirmedFlushes: 0, failedFlushes: 0, absentFlushes: 0, unknownApps: 0, unsavedKeys: 0 },
        resources: { activeFileReplacements: 0, retainedStorageOwners: 0, storageActualIO: 0, openingStorageOwners: 0 },
        interactions: { verified: true, retainedScopes: 0, retainedBytes: 0 },
        pool: { ownership: 'not-owned', report: null }, beforeClose: 'not-provided',
        cleanup: { signalBus: 'not-owned', signalService: 'not-owned', llmOutput: 'not-owned', logger: 'not-owned', registry: 'not-owned', locks: 'not-owned' },
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
    for (const group of ['apps', 'desktops', 'persistence', 'resources'] as const) {
        for (const key of Object.keys(state[group])) (state[group] as unknown as Record<string, number>)[key] += (child[group] as unknown as Record<string, number>)[key];
    }
    if (child.appCleanup && state.appCleanup) for (const key of Object.keys(state.appCleanup) as Array<keyof NonNullable<CloseReport['appCleanup']>>)
        state.appCleanup[key] += child.appCleanup[key];
    state.resourcesReleased &&= child.resourcesReleased;
    if (state.verification !== child.verification) state.verification = 'mixed';
    state.unverifiedParticipants += child.unverifiedParticipants;state.failureCount += child.failureCount;
    mergeInteractions(state, child, false, child.unverifiedParticipants);
    state.hasFailures ||= child.hasFailures;state.samplesTruncated ||= child.samplesTruncated;
    for (const sample of child.failures) {
        if (state.failures.length >= 16) { state.samplesTruncated = true;break; }
        state.failures.push({ stage: sample.stage, codes: [...sample.codes],
            ...(sample.desktopId !== undefined ? { desktopId: displayCloseId(sample.desktopId) } : {}),
            ...(sample.appId !== undefined ? { appId: displayCloseId(sample.appId) } : {}) });
    }
}

function ownData(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    try { const field = Object.getOwnPropertyDescriptor(value, key);return field && 'value' in field ? field.value : undefined; }
    catch { return undefined; }
}
function mergeInteractions(state: CloseState, child: unknown, host: boolean, alreadyUnverified = 0): void {
    const target = state.interactions ??= { verified: true, retainedScopes: 0, retainedBytes: 0 };
    const report = ownData(child, 'interactions'), flag = ownData(report, host ? 'closed' : 'verified');
    let valid = typeof flag === 'boolean' && (host || flag === true);
    let empty = true;
    for (const key of ['retainedScopes', 'retainedBytes'] as const) {
        const value = ownData(report, key);
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { valid = false;empty = false;continue; }
        if (value !== 0) empty = false;
        if (value > Number.MAX_SAFE_INTEGER - target[key]) { target[key] = Number.MAX_SAFE_INTEGER;valid = false; }
        else target[key] += value;
    }
    if (!valid) {
        target.verified = false;state.verification = 'mixed';state.resourcesReleased = false;
        if (!(alreadyUnverified > 0)) state.unverifiedParticipants++;
    }
    if (!empty || host && flag !== true) state.resourcesReleased = false;
}
export function snapshotClose(state: CloseState): CloseReport {
    return freezeClose({ ...state, ok: state.state === 'settled' && state.resourcesReleased && state.verification === 'managed' && !state.hasFailures });
}
export function sandboxCloseReport(report: SandboxCloseReport, desktopId: string, appId: string): AppManagerCloseReport {
    const state = newCloseState('app-manager', report.intent), ids = { desktopId, appId }, host = report.host, storage = host?.storage, lifecycle = storage?.lifecycle;
    state.state = report.state;state.resourcesReleased = report.resourcesReleased;
    state.apps.accepted = 1;state.apps.settled = report.state === 'settled' ? 1 : 0;state.apps.pending = 1 - state.apps.settled;
    state.apps.notVerifiedReleased = report.resourcesReleased ? 0 : 1;
    if (!host) state.persistence.notUsedApps = 1;
    else {
        mergeInteractions(state, host, true);
        const appCleanup = host.appCleanup;
        if (appCleanup?.support === 'managed') {
            state.appCleanup!.managedApps = 1;
            state.appCleanup!.completedApps = appCleanup.report?.state === 'completed' ? 1 : 0;
            state.appCleanup!.failedApps = appCleanup.report?.state === 'failed' ? 1 : 0;
            if (state.appCleanup!.failedApps || report.state === 'settled' && !state.appCleanup!.completedApps)
                addCloseFailure(state, 'apps', ['APP_CLOSE_FAILED'], ids);
        } else state.appCleanup!.legacyUnverifiedApps = 1;
        if (storage!.support === 'managed') {
            state.persistence.managedApps = 1;
            if (lifecycle) {
                state.persistence.closeReceipts = 1;
                if (!lifecycle.flush) state.persistence.absentFlushes = 1;
                else if (lifecycle.flush.status === 'completed' && lifecycle.flush.ok) state.persistence.confirmedFlushes = 1;
                else state.persistence.failedFlushes = 1;
            } else state.persistence.missingCloseReceipts = 1;
        } else {
            state.verification = 'mixed';
            if (storage!.support === 'legacy-unverified') state.persistence.legacyUnverifiedApps = 1;
            else state.persistence.unnegotiatedApps = 1;
        }
        state.resources.activeFileReplacements = host.activeFileReplacements;
        state.resources.retainedStorageOwners = storage!.ownerRetained ? 1 : 0;
        state.resources.storageActualIO = storage!.actualIO;
        state.resources.openingStorageOwners = storage!.opening ? 1 : 0;
        state.persistence.unsavedKeys = lifecycle?.dispose?.unsaved.length ?? 0;
        const unknown = storage!.uncertain || storage!.release?.status === 'unknown' || lifecycle?.dispose?.release.status === 'unknown' || lifecycle?.flush?.entries.some(entry => entry.status === 'unknown') || lifecycle?.dispose?.unsaved.some(entry => entry.status === 'unknown');
        state.persistence.unknownApps = unknown ? 1 : 0;
        const finalMissing = report.state === 'settled' && storage!.support === 'managed' && (!lifecycle?.ok || lifecycle.unmount !== 'completed' || !lifecycle.flush || !lifecycle.dispose || lifecycle.dispose.release.status !== 'released' || storage!.release?.status !== 'released');
        // B2 shutdown receipts can still have ok=false/unmount=pending while their flush is successful.
        const failedLifecycle = lifecycle?.ok === false && lifecycle.unmount !== 'pending';
        if (storage!.unsafe || unknown || state.persistence.failedFlushes || state.persistence.unsavedKeys || finalMissing || failedLifecycle || storage!.release?.status === 'failed' || lifecycle?.dispose?.release.status === 'failed')
            addCloseFailure(state, 'persistence', ['PERSISTENCE_CLOSE_FAILED'], ids);
        if (lifecycle?.unmount === 'failed') addCloseFailure(state, 'apps', ['APP_UNMOUNT_FAILED'], ids);
    }
    state.apps.notVerifiedReleased = state.resourcesReleased ? 0 : 1;
    addCloseFailure(state, 'apps', report.issues, ids);
    addCloseFailure(state, 'worker', [...host?.issues ?? [], ...report.lease?.issue ? [report.lease.issue] : []], ids);
    if (report.ownedPool) addCloseFailure(state, 'pool', report.ownedPool.issues, ids);
    return freezeClose({ ...snapshotClose(state), scope: 'app-manager' as const });
}
