import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { AppIdentityReader, AppSnapshotV2, SnapshotLease, SnapshotStore, ToolTargetV2 } from '../snapshot/types.js';
import { acquireToolSource } from '../tool/source-binding.js';
import type {
    Observation, ObservationBinding, ObservationCleanup, ObservationGrant, ObservationIssue,
    ObservationIssueCode, ObservationJsonLimits, ObservationRegistry, ObservationRegistryLimits,
    ObservationRegistryOptions, ObservationRegistryStats, ObservationRejected, ObservationSelection,
    ObservationSource, RefIdentity, ReservationHandle, ScopeHandle, ViewIdentity,
} from './observation-types.js';

const KiB = 1024, MiB = KiB * KiB;
const profile = (maxDepth: number, maxNodes: number, bytes: number): ObservationJsonLimits =>
    Object.freeze({ maxDepth, maxNodes, maxApproxBytes: bytes, maxCanonicalBytes: bytes });
export const DEFAULT_OBSERVATION_REGISTRY_LIMITS: ObservationRegistryLimits = Object.freeze({
    maxScopes: 16, maxObservationsPerScope: 8, maxObservations: 128,
    maxReservationsPerScope: 2, maxReservations: 16,
    maxViews: 256, maxRefs: 512, maxTools: 256, maxBindings: 256,
    scopeTtlMs: 600_000, observationTtlMs: 30_000,
    capture: profile(4, 1024, 16 * KiB), metadata: profile(12, 8192, 64 * KiB),
    observation: profile(50, 40_000, 256 * KiB), source: profile(50, 100_016, 8 * MiB),
    maxSourceBytes: 32 * MiB, maxObservationBytes: 16 * MiB,
    maxMetadataBytes: 8 * MiB, maxTotalBytes: 64 * MiB,
});

class RegistryFailure {
    constructor(readonly code: ObservationIssueCode) {}
}
function fail(code: ObservationIssueCode): never { throw new RegistryFailure(code); }
const issue = (error: unknown): ObservationIssue => Object.freeze({
    code: error instanceof RegistryFailure ? error.code : 'OBSERVATION_INTERNAL_ERROR',
    message: 'Observation registry operation could not be completed',
});
const rejected = (error: unknown): ObservationRejected => Object.freeze({ status: 'rejected', issue: issue(error) });
function object(value: unknown, keys: readonly string[], code: ObservationIssueCode = 'OBSERVATION_INVALID'): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) fail(code);
    return record;
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const viewKey = (view: ViewIdentity): string => JSON.stringify([view.viewId, view.viewInstanceId]);
const refKey = (ref: RefIdentity): string => JSON.stringify([ref.viewId, ref.viewInstanceId, ref.refId]);
const targetKey = (toolId: string, target: ToolTargetV2): string => JSON.stringify([toolId, target.viewId, target.viewInstanceId, target.bindingVersion, target.selector?.param, target.selector?.value]);
function bounded<T>(input: unknown, limits: ObservationJsonLimits, code: ObservationIssueCode): { value: T; bytes: number } {
    try {
        const value = copyJson(input, limits);
        // Detached records have null prototypes and copied arrays have the
        // intrinsic Array.prototype. Native JSON preserves byte length across
        // key order; keep the canonical path if an inherited array toJSON
        // could add behavior or execute an accessor.
        const bytes = utf8Size('toJSON' in Array.prototype ? canonicalJson(value) : JSON.stringify(value)!);
        if (bytes > limits.maxCanonicalBytes) fail(code);
        return { value: value as T, bytes };
    } catch { return fail(code); }
}
function configuration(input: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Invalid observation registry configuration');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) ||
        !descriptors[key]!.enumerable || !('value' in descriptors[key]!))) throw new TypeError('Invalid observation registry configuration');
    return Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value]));
}

interface Hold { readonly source: AppSnapshotV2; readonly lease: SnapshotLease }
interface Reservation extends Hold {
    readonly observationId: string;
    readonly selection: ObservationSelection;
    readonly expiresAt: number | null;
    cancelled: boolean;
}
interface Metadata {
    readonly scopeId: string;
    readonly observationId: string;
    readonly source: ObservationSource;
    readonly expiresAt: number | null;
    readonly views: readonly ViewIdentity[];
    readonly refs: readonly RefIdentity[];
    readonly bindings: readonly ObservationBinding[];
}
interface Registered extends Hold {
    readonly observation: Observation;
    readonly metadata: Metadata;
    readonly publicBytes: number;
    readonly metadataBytes: number;
}
interface Scope {
    readonly handle: ScopeHandle;
    readonly appId: string;
    readonly instanceId: string;
    readonly expiresAt: number | null;
    readonly reservations: Map<ReservationHandle, Reservation>;
    readonly observations: Map<string, Registered>;
    closed: boolean;
}

/** Synchronous preparation ledger. It holds no Handler, policy callback or invocation receipt. */
export function createObservationRegistry(store: SnapshotStore & AppIdentityReader, options: ObservationRegistryOptions): ObservationRegistry {
    let hasIdentity = false;
    try { hasIdentity = typeof store.readAppIdentity === 'function'; } catch { /* Invalid trusted capability. */ }
    if (!hasIdentity) throw new TypeError('Invalid observation registry store');
    let namespace: string, now: () => number, limits: ObservationRegistryLimits, lifetime: 'scope' | 'ttl';
    try {
        const config = configuration(options, ['namespace', 'now', 'limits', 'lifetime']);
        if (!text(config.namespace) || utf8Size(config.namespace) > 128 || typeof config.now !== 'function') throw 0;
        namespace = config.namespace;
        now = config.now as () => number;
        if (config.lifetime !== undefined && config.lifetime !== 'scope' && config.lifetime !== 'ttl') throw 0;
        lifetime = config.lifetime === 'ttl' ? 'ttl' : 'scope';
        const overrides = config.limits === undefined ? {} : configuration(config.limits, Object.keys(DEFAULT_OBSERVATION_REGISTRY_LIMITS));
        const result: Record<string, number | ObservationJsonLimits> = {};
        for (const [key, hard] of Object.entries(DEFAULT_OBSERVATION_REGISTRY_LIMITS)) {
            const override = overrides[key];
            if (typeof hard === 'number') {
                const value = override === undefined ? hard : override;
                if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > hard) throw 0;
                result[key] = value as number;
            } else {
                const lower = override === undefined ? {} : configuration(override, Object.keys(hard));
                const effective = { ...hard };
                for (const field of Object.keys(hard) as (keyof ObservationJsonLimits)[]) {
                    const value = lower[field] === undefined ? hard[field] : lower[field];
                    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > hard[field]) throw 0;
                    Object.assign(effective, { [field]: value });
                }
                result[key] = Object.freeze(effective);
            }
        }
        limits = Object.freeze(result) as unknown as ObservationRegistryLimits;
    } catch { throw new TypeError('Invalid observation registry configuration'); }
    let lastNow = -1;
    function clock(): number {
        let value: number;
        try { value = now(); } catch { return fail('OBSERVATION_INTERNAL_ERROR'); }
        if (!Number.isSafeInteger(value) || value < 0 || value < lastNow) fail('OBSERVATION_INTERNAL_ERROR');
        lastNow = value;
        return value;
    }
    try { clock(); } catch { throw new RangeError('Invalid observation registry clock'); }
    let closed = false, sequence = 0, observations = 0, reservations = 0;
    let sourceBytes = 0, observationBytes = 0, metadataBytes = 0;
    const scopes = new Map<ScopeHandle, Scope>();
    const sources = new Map<string, { readonly source: AppSnapshotV2; readonly bytes: number; references: number }>();
    const id = (kind: string): string => {
        if (sequence === Number.MAX_SAFE_INTEGER) fail('OBSERVATION_CAPACITY');
        const value = namespace + ':' + kind + ':' + ++sequence;
        if (utf8Size(value) > 256) fail('OBSERVATION_CAPACITY');
        return value;
    };
    const deadline = (time: number, ttl: number): number => {
        const value = time + ttl;
        if (!Number.isSafeInteger(value)) fail('OBSERVATION_INTERNAL_ERROR');
        return value;
    };
    function dropHold(hold: Hold): void {
        try { hold.lease.release(); } finally {
            const entry = sources.get(hold.source.id)!;
            if (--entry.references === 0) { sources.delete(hold.source.id); sourceBytes -= entry.bytes; }
        }
    }
    function dropObservation(scope: Scope, key: string, value: Registered): void {
        scope.observations.delete(key); observations--;
        observationBytes -= value.publicBytes; metadataBytes -= value.metadataBytes;
        dropHold(value);
    }
    function removeClosedScope(scope: Scope): void {
        if (scope.closed && scope.reservations.size === 0) scopes.delete(scope.handle);
    }
    function revoke(scope: Scope): void {
        scope.closed = true;
        for (const value of scope.reservations.values()) value.cancelled = true;
        for (const [key, value] of scope.observations) dropObservation(scope, key, value);
        removeClosedScope(scope);
    }
    function sweep(): number {
        const time = clock();
        for (const scope of scopes.values()) {
            const identity = store.readAppIdentity(scope.appId);
            const latest = store.readLatest(scope.appId);
            if (closed || scope.closed || (scope.expiresAt !== null && time >= scope.expiresAt) || identity.status === 'stopped' ||
                (identity.status === 'active' && identity.instanceId !== scope.instanceId) || latest.status === 'stopped' ||
                (latest.status === 'ready' && latest.snapshot.instanceId !== scope.instanceId)) {
                revoke(scope);
                continue;
            }
            for (const value of scope.reservations.values()) if (value.expiresAt !== null && time >= value.expiresAt) value.cancelled = true;
            for (const [key, value] of scope.observations) if (value.observation.expiresAt !== null && time >= value.observation.expiresAt) dropObservation(scope, key, value);
        }
        return time;
    }
    function scopeFor(handle: ScopeHandle): Scope {
        const scope = scopes.get(handle);
        if (!scope) fail('SCOPE_INVALID');
        if (scope.closed || closed) fail('SCOPE_UNAVAILABLE');
        return scope;
    }
    function ready(scope: Scope): AppSnapshotV2 {
        const latest = store.readLatest(scope.appId);
        if (latest.status !== 'ready') fail(latest.status === 'stopped' ? 'APP_STOPPED' : 'SNAPSHOT_UNREADY');
        if (latest.snapshot.instanceId !== scope.instanceId) { revoke(scope); fail('APP_INSTANCE_MISMATCH'); }
        if (latest.snapshot.schemaVersion !== 2) fail('SNAPSHOT_INVALID');
        return latest.snapshot;
    }
    function reacquire(scope: Scope, source: AppSnapshotV2): void {
        ready(scope);
        const result = store.acquire(source.id);
        if (result.status === 'rejected') fail(result.issue.code);
        try {
            if (result.lease.snapshot.schemaVersion !== 2 || result.lease.snapshot.appId !== scope.appId ||
                result.lease.snapshot.instanceId !== scope.instanceId) fail('APP_INSTANCE_MISMATCH');
        } finally { result.lease.release(); }
    }
    function capacity(nextSource: number, nextPublic: number, nextMetadata: number): void {
        if (nextSource > limits.maxSourceBytes || nextPublic > limits.maxObservationBytes ||
            nextMetadata > limits.maxMetadataBytes || nextSource + nextPublic + nextMetadata > limits.maxTotalBytes) fail('OBSERVATION_CAPACITY');
    }
    function settle(scope: Scope, token: ReservationHandle, value: Reservation, transferred = false): void {
        scope.reservations.delete(token); reservations--;
        observationBytes -= limits.observation.maxCanonicalBytes;
        metadataBytes -= limits.metadata.maxCanonicalBytes;
        if (!transferred) dropHold(value);
        removeClosedScope(scope);
    }
    function stats(error?: unknown): ObservationRegistryStats {
        let cancelledReservations = 0;
        for (const scope of scopes.values()) for (const value of scope.reservations.values()) if (value.cancelled) cancelledReservations++;
        return Object.freeze({ closed, scopes: scopes.size, observations, reservations, cancelledReservations,
            observationSlots: observations + reservations, sources: sources.size, sourceBytes,
            observationBytes, metadataBytes, totalBytes: sourceBytes + observationBytes + metadataBytes,
            ...(error === undefined ? {} : { issue: issue(error) }) });
    }
    function cleanup(action?: () => void): ObservationCleanup {
        const before = { observations, sources: sources.size, scopes: scopes.size };
        let error: unknown;
        try { sweep(); } catch (caught) { error = caught; }
        try { action?.(); } catch (caught) { error = caught; }
        return Object.freeze({ ...stats(error), releasedObservations: before.observations - observations,
            releasedSources: before.sources - sources.size, removedScopes: before.scopes - scopes.size });
    }
    function project(scope: Scope, value: Reservation, input: unknown): { observation: Observation; metadata: Metadata; publicBytes: number; metadataBytes: number } {
        let grant: ObservationGrant;
        try {
            grant = bounded<ObservationGrant>(input, limits.metadata, 'OBSERVATION_PROJECTION_INVALID').value;
            object(grant, ['views', 'refs', 'targets', 'content']);
            if (![grant.views, grant.refs, grant.targets, grant.content].every(Array.isArray)) fail('OBSERVATION_PROJECTION_INVALID');
            if (grant.views.length > limits.maxViews || grant.refs.length > limits.maxRefs || grant.targets.length > limits.maxBindings) fail('OBSERVATION_CAPACITY');
            const sourceViews = new Set(value.source.views.filter(v => value.selection.viewIds.includes(v.id))
                .map(v => viewKey({ viewId: v.id, viewInstanceId: v.viewInstanceId })));
            const sourceRefs = Object.values(value.source.refs);
            const originalRefs = new Set(sourceRefs.map(r => refKey({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })));
            const originalTargets = new Set(Object.values(value.source.tools).flatMap(t => t.targets.map(target => targetKey(t.id, target))));
            const views = new Set<string>(), refs = new Set<string>(), targets = new Set<string>(), content = new Map<string, string>();
            const view = (v: ViewIdentity): string => {
                object(v, ['viewId', 'viewInstanceId']);
                if (!text(v.viewId) || !text(v.viewInstanceId)) fail('OBSERVATION_PROJECTION_INVALID');
                return viewKey(v);
            };
            for (const v of grant.views) {
                const key = view(v);
                if (!sourceViews.has(key) || views.has(key)) fail('OBSERVATION_PROJECTION_INVALID');
                views.add(key);
            }
            for (const r of grant.refs) {
                object(r, ['viewId', 'viewInstanceId', 'refId']);
                if (!text(r.viewId) || !text(r.viewInstanceId) || !text(r.refId)) fail('OBSERVATION_PROJECTION_INVALID');
                const key = refKey(r);
                if (!views.has(viewKey(r)) || !originalRefs.has(key) || refs.has(key)) fail('OBSERVATION_PROJECTION_INVALID');
                refs.add(key);
            }
            for (const t of grant.targets) {
                object(t, ['toolId', 'target']); object(t.target, ['viewId', 'viewInstanceId', 'bindingVersion', ...(Object.hasOwn(t.target, 'selector') ? ['selector'] : [])]);
                if (Object.hasOwn(t.target, 'selector')) object(t.target.selector, ['param', 'value']);
                if (!text(t.toolId) || !text(t.target.viewId) || !text(t.target.viewInstanceId) ||
                    !Number.isSafeInteger(t.target.bindingVersion)) fail('OBSERVATION_PROJECTION_INVALID');
                const key = targetKey(t.toolId, t.target);
                if (!views.has(viewKey(t.target)) || !originalTargets.has(key) || targets.has(key)) fail('OBSERVATION_PROJECTION_INVALID');
                targets.add(key);
            }
            for (const c of grant.content) {
                object(c, ['view', 'decision']); const key = view(c.view);
                if (!views.has(key) || content.has(key) || !['retain', 'hide'].includes(c.decision)) fail('OBSERVATION_PROJECTION_INVALID');
                if (c.decision === 'retain' && sourceRefs.some(r => r.ownerViewId === c.view.viewId &&
                    r.ownerViewInstanceId === c.view.viewInstanceId && !refs.has(refKey({ ...c.view, refId: r.id })))) fail('OBSERVATION_PROJECTION_INVALID');
                content.set(key, c.decision);
            }
            const projectedViews = value.source.views.filter(v => views.has(viewKey({ viewId: v.id, viewInstanceId: v.viewInstanceId })))
                .map(({ content: original, ...v }) => ({ ...v,
                    ...(content.get(viewKey({ viewId: v.id, viewInstanceId: v.viewInstanceId })) === 'retain' ? { content: original } : {}) }));
            const projectedRefs = sourceRefs.filter(r => refs.has(refKey({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })))
                .map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id, refType: r.refType, kind: r.target.kind }));
            const tools = Object.values(value.source.tools).map(t => ({ ...t, targets: t.targets.filter(target => targets.has(targetKey(t.id, target))) }))
                .filter(t => t.targets.length > 0);
            if (tools.length > limits.maxTools) fail('OBSERVATION_CAPACITY');
            const bindings = tools.flatMap(t => t.targets.map(target => ({ bindingId: id('binding'), toolId: t.id, target })));
            const source = { appId: value.source.appId, instanceId: value.source.instanceId, snapshotId: value.source.id, revision: value.source.revision };
            const output = bounded<Observation>({ observationId: value.observationId, source, expiresAt: value.expiresAt,
                views: projectedViews, refs: projectedRefs, tools, bindings }, limits.observation, 'OBSERVATION_CAPACITY');
            const metadata = bounded<Metadata>({ scopeId: scope.handle.scopeId, observationId: value.observationId,
                source, expiresAt: value.expiresAt, views: projectedViews.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
                refs: projectedRefs.map(({ viewId, viewInstanceId, refId }) => ({ viewId, viewInstanceId, refId })), bindings }, limits.metadata, 'OBSERVATION_CAPACITY');
            return { observation: output.value, metadata: metadata.value, publicBytes: output.bytes, metadataBytes: metadata.bytes };
        } catch (error) {
            if (error instanceof RegistryFailure && error.code === 'OBSERVATION_CAPACITY') throw error;
            return fail('OBSERVATION_PROJECTION_INVALID');
        }
    }
    return Object.freeze({
        checkScope(handle: ScopeHandle) {
            try {
                sweep();
                const scope = scopes.get(handle);
                if (!scope || scope.closed || closed) fail('SCOPE_UNAVAILABLE');
                return Object.freeze({ status: 'active' as const, expiresAt: scope.expiresAt });
            } catch (error) { return rejected(error); }
        },
        openScope(input: unknown) {
            try {
                const time = sweep();
                if (closed) fail('SCOPE_UNAVAILABLE');
                const data = object(bounded(input, limits.capture, 'SCOPE_INVALID').value, ['appId', 'instanceId'], 'SCOPE_INVALID');
                if (!text(data.appId) || !text(data.instanceId)) fail('SCOPE_INVALID');
                if (scopes.size >= limits.maxScopes) fail('OBSERVATION_CAPACITY');
                const expiresAt = lifetime === 'ttl' ? deadline(time, limits.scopeTtlMs) : null;
                const handle = Object.freeze({ scopeId: id('scope') });
                scopes.set(handle, { handle, appId: data.appId, instanceId: data.instanceId, expiresAt,
                    closed: false, reservations: new Map(), observations: new Map() });
                return Object.freeze({ status: 'opened' as const, scope: handle });
            } catch (error) { return rejected(error); }
        },
        begin(handle: ScopeHandle, input: unknown) {
            let lease: SnapshotLease | undefined;
            try {
                const time = sweep(), scope = scopeFor(handle);
                const captured = bounded<Record<string, unknown>>(input, limits.capture, 'OBSERVATION_INVALID').value;
                const all = captured !== null && typeof captured === 'object' && Object.hasOwn(captured, 'all');
                const data = object(captured, all ? ['all'] : ['viewIds']);
                if (all && data.all !== true) fail('OBSERVATION_INVALID');
                if (!all && (!Array.isArray(data.viewIds) || data.viewIds.length === 0 ||
                    data.viewIds.length > DEFAULT_OBSERVATION_REGISTRY_LIMITS.maxViews ||
                    data.viewIds.some(v => !text(v)) || new Set(data.viewIds).size !== data.viewIds.length)) fail('OBSERVATION_INVALID');
                if (scope.reservations.size >= limits.maxReservationsPerScope || reservations >= limits.maxReservations ||
                    scope.reservations.size + scope.observations.size >= limits.maxObservationsPerScope ||
                    observations + reservations >= limits.maxObservations) fail('OBSERVATION_CAPACITY');
                const source = ready(scope);
                const viewIds = all ? source.views.map(view => view.id) : data.viewIds as string[];
                if (viewIds.length > DEFAULT_OBSERVATION_REGISTRY_LIMITS.maxViews) fail('OBSERVATION_CAPACITY');
                if (viewIds.some(viewId => !source.views.some(v => v.id === viewId))) fail('OBSERVATION_INVALID');
                const acquired = lifetime === 'scope' ? store.acquire(source.id, { lifetime: 'owner' }) : store.acquire(source.id);
                if (acquired.status === 'rejected') fail(acquired.issue.code);
                lease = acquired.lease;
                const expiresAt = lifetime === 'scope' ? null : Math.min(scope.expiresAt!,
                    deadline(time, limits.observationTtlMs), lease.expiresAt ?? deadline(time, limits.observationTtlMs));
                if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= time)) fail('OBSERVATION_UNAVAILABLE');
                const existing = sources.get(source.id);
                const bytes = existing?.bytes ?? bounded(source, limits.source, 'OBSERVATION_CAPACITY').bytes;
                capacity(sourceBytes + (existing ? 0 : bytes), observationBytes + limits.observation.maxCanonicalBytes,
                    metadataBytes + limits.metadata.maxCanonicalBytes);
                const token = Object.freeze({ reservation: true as const });
                const selection: ObservationSelection = Object.freeze({ viewIds: Object.freeze([...viewIds]) });
                const value = { source, lease, selection, expiresAt, observationId: id('observation'), cancelled: false };
                if (existing) existing.references++;
                else { sources.set(source.id, { source, bytes, references: 1 }); sourceBytes += bytes; }
                scope.reservations.set(token, value); reservations++;
                observationBytes += limits.observation.maxCanonicalBytes; metadataBytes += limits.metadata.maxCanonicalBytes;
                lease = undefined;
                return Object.freeze({ status: 'reserved' as const, reservation: token, source, selection, expiresAt });
            } catch (error) { return rejected(error); }
            finally { lease?.release(); }
        },
        complete(handle: ScopeHandle, token: ReservationHandle, input: unknown) {
            const scope = scopes.get(handle), value = scope?.reservations.get(token);
            let transferred = false;
            try {
                const time = sweep();
                if (!scope || !value || scope.closed || closed || value.cancelled ||
                    (value.expiresAt !== null && time >= value.expiresAt)) fail('RESERVATION_UNAVAILABLE');
                reacquire(scope, value.source);
                const projected = project(scope, value, input);
                capacity(sourceBytes, observationBytes - limits.observation.maxCanonicalBytes + projected.publicBytes,
                    metadataBytes - limits.metadata.maxCanonicalBytes + projected.metadataBytes);
                scope.observations.set(value.observationId, { ...projected, source: value.source, lease: value.lease });
                observations++; observationBytes += projected.publicBytes; metadataBytes += projected.metadataBytes;
                transferred = true;
                return Object.freeze({ status: 'observed' as const, observation: projected.observation });
            } catch (error) { return rejected(error); }
            finally { if (scope && value) settle(scope, token, value, transferred); }
        },
        abandon(handle: ScopeHandle, token: ReservationHandle): void {
            try { sweep(); } catch { /* Explicit settlement remains possible with a failed clock. */ }
            const scope = scopes.get(handle), value = scope?.reservations.get(token);
            if (scope && value) settle(scope, token, value);
        },
        resolveBinding(handle: ScopeHandle, input: unknown) {
            try {
                sweep(); const scope = scopeFor(handle);
                const data = object(bounded(input, limits.capture, 'OBSERVATION_INVALID').value, ['observationId', 'bindingId']);
                if (!text(data.observationId) || !text(data.bindingId)) fail('OBSERVATION_INVALID');
                const value = scope.observations.get(data.observationId);
                if (!value) fail('OBSERVATION_UNAVAILABLE');
                const binding = value.metadata.bindings.find(b => b.bindingId === data.bindingId);
                if (!binding) fail('BINDING_UNAVAILABLE');
                const sourceRequest = Object.freeze({ appId: scope.appId, instanceId: scope.instanceId,
                    snapshotId: value.source.id, toolId: binding.toolId, viewId: binding.target.viewId });
                const selected = acquireToolSource(store, sourceRequest);
                if (selected.status === 'rejected') fail(selected.issue.code);
                try {
                    const visibleRefIds = Object.freeze(value.metadata.refs.filter(r => r.viewId === binding.target.viewId &&
                        r.viewInstanceId === binding.target.viewInstanceId).map(r => r.refId));
                    return Object.freeze({ status: 'found' as const, sourceRequest, tool: selected.tool, target: selected.target, visibleRefIds });
                } finally { selected.release(); }
            } catch (error) { return rejected(error); }
        },
        releaseObservation(handle: ScopeHandle, observationId: string): void {
            try { sweep(); } catch { /* Explicit release does not require advancing time. */ }
            const scope = scopes.get(handle), value = scope?.observations.get(observationId);
            if (scope && value) dropObservation(scope, observationId, value);
        },
        closeScope(handle: ScopeHandle) { return cleanup(() => { const scope = scopes.get(handle); if (scope) revoke(scope); }); },
        sweepExpired() { return cleanup(); },
        close() { return cleanup(() => { closed = true; for (const scope of scopes.values()) revoke(scope); }); },
        inspect() { try { sweep(); return stats(); } catch (error) { return stats(error); } },
    });
}
