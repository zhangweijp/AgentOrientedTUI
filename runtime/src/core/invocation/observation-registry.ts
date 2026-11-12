import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/types.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { AppIdentityReader, AppSnapshotV3, ObservedToolExecutionV3, SnapshotLease, SnapshotStore } from '../snapshot/types.js';
import { acquireToolSource } from '../tool/source-binding.js';
import type { AppPreviewResult, AppInteractionPolicy } from './app-interaction-types.js';
import { DEFAULT_SNAPSHOT_LIMITS as snapshotLimits, OBSERVATION_METADATA_BYTES } from '../snapshot/snapshot-support.js';
import type {
    Observation, ObservationBinding, ObservationGrant, ObservationIssue,
    ObservationIssueCode, ObservationJsonLimits, ObservationRegistryLimits,
    ObservationRegistryOptions, ObservationRegistryStats, ObservationRejected, ObservationSelection,
    ObservationSource, RefIdentity, ReservationHandle, ViewIdentity,
} from './observation-types.js';

const KiB = 1024, MiB = KiB * KiB;
const profile = (maxDepth: number, maxNodes: number, bytes: number): ObservationJsonLimits =>
    Object.freeze({ maxDepth, maxNodes, maxApproxBytes: bytes, maxCanonicalBytes: bytes });
export const DEFAULT_OBSERVATION_REGISTRY_LIMITS: ObservationRegistryLimits = Object.freeze({
    maxViews: 256, maxRefs: 512, maxTools: 256, maxBindings: 256,
    capture: profile(4, 1024, 16 * KiB), metadata: profile(12, 8192, OBSERVATION_METADATA_BYTES),
    observation: profile(snapshotLimits.maxDepth + 2, snapshotLimits.maxNodes + 4_000,
        snapshotLimits.maxViewContentBytes + snapshotLimits.maxToolSchemaBytes + 2 * OBSERVATION_METADATA_BYTES),
    source: profile(snapshotLimits.maxDepth + 2, snapshotLimits.maxNodes + 16, snapshotLimits.maxSnapshotBytes * 2 + 64 * KiB),
    maxSourceBytes: 32 * MiB, maxObservationBytes: 16 * MiB,
    maxMetadataBytes: 8 * MiB, maxTotalBytes: 64 * MiB,
});

/** The default Host selection keeps complete Views and their visible capabilities. */
export const projectCompleteViews: AppInteractionPolicy['project'] = ({ source, selection }) => {
    const selected = new Set(selection.viewIds);
    const views = source.views.filter(view => selected.has(view.id));
    const types = new Set(views.map(view => view.type));
    const identities = views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
    return {
        views: identities,
        refs: Object.values(source.refs).filter(ref => selected.has(ref.ownerViewId)).map(ref => ({
            viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id,
        })),
        toolBindings: Object.values(source.tools).filter(tool => types.has(tool.viewType)).map(tool => ({ toolId: tool.id, execution: tool.execution })),
        content: identities.map(view => ({ view, decision: 'retain' })),
    };
};

export function previewCommittedApp(store: SnapshotStore, appId: string, instanceId: string): AppPreviewResult {
    const result = store.readLatest(appId);
    if (result.status === 'degraded') return { status: 'rejected', issue: result.issue };
    if (result.status !== 'ready' || result.snapshot.instanceId !== instanceId) return { status: 'rejected',
        issue: { code: 'APP_INTERACTION_UNAVAILABLE', message: 'Current App projection is unavailable' } };
    const snapshot = result.snapshot;
    return Object.freeze({ status: 'previewed', source: Object.freeze({ appId, instanceId, snapshotId: snapshot.id,
        revision: snapshot.revision }), views: snapshot.views });
}

class RegistryFailure {
    constructor(readonly code: ObservationIssueCode, readonly path?: string) {}
}
function fail(code: ObservationIssueCode, path?: string): never { throw new RegistryFailure(code, path); }
const issue = (error: unknown): ObservationIssue => Object.freeze({
    code: error instanceof RegistryFailure ? error.code : 'OBSERVATION_INTERNAL_ERROR',
    message: error instanceof RegistryFailure && error.code === 'OBSERVATION_CAPACITY'
        ? 'The selected Views and Tool metadata exceed the complete observation limit. Select fewer complete Views or page the App content.'
        : 'Observation registry request could not be completed',
    ...(error instanceof RegistryFailure && error.path ? { path: error.path } : {}),
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
const executionKey = (toolId: string, execution: ObservedToolExecutionV3): string =>
    JSON.stringify([toolId, 'view-type', execution.activationId]);
function bounded<T>(input: unknown, limits: ObservationJsonLimits, code: ObservationIssueCode, path?: string): { value: T; bytes: number } {
    try {
        const value = copyJson(input, limits);
        // Detached records have null prototypes and copied arrays have the
        // intrinsic Array.prototype. Native JSON preserves byte length across
        // key order; keep the canonical path if an inherited array toJSON
        // could add behavior or execute an accessor.
        const bytes = utf8Size('toJSON' in Array.prototype ? canonicalJson(value) : JSON.stringify(value)!);
        if (bytes > limits.maxCanonicalBytes) fail(code, path);
        return { value: value as T, bytes };
    } catch { return fail(code, path); }
}
function configuration(input: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Invalid observation registry configuration');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) ||
        !descriptors[key]!.enumerable || !('value' in descriptors[key]!))) throw new TypeError('Invalid observation registry configuration');
    return Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value]));
}

interface Hold { readonly source: AppSnapshotV3; readonly lease: SnapshotLease }
export interface Reservation extends Hold {
    readonly observationId: string;
    readonly selection: ObservationSelection;
    cancelled: boolean;
}
interface Metadata {
    readonly observationId: string;
    readonly source: ObservationSource;
    readonly views: readonly ViewIdentity[];
    readonly refs: readonly RefIdentity[];
    readonly bindings: readonly ObservationBinding[];
}
export interface RegisteredObservation extends Hold {
    readonly observation: Observation;
    readonly metadata: Metadata;
    readonly publicBytes: number;
    readonly metadataBytes: number;
}
export interface ObservationState {
    readonly appId: string;
    readonly instanceId: string;
    readonly reservations: Map<ReservationHandle, Reservation>;
    readonly observations: Map<string, RegisteredObservation>;
    adoptedObservationId?: string;
    closing: boolean;
}

export function createObservationOperations(store: SnapshotStore & AppIdentityReader, options: ObservationRegistryOptions,
    state: ObservationState, refresh: () => number) {
    let hasIdentity = false;
    try { hasIdentity = typeof store.readAppIdentity === 'function'; } catch { /* Invalid trusted capability. */ }
    if (!hasIdentity) throw new TypeError('Invalid observation registry store');
    let namespace: string, limits: ObservationRegistryLimits;
    try {
        const config = configuration(options, ['namespace', 'limits']);
        if (!text(config.namespace) || utf8Size(config.namespace) > 128) throw 0;
        namespace = config.namespace;
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
    let sequence = 0;
    let sourceBytes = 0, observationBytes = 0, metadataBytes = 0;
    const sources = new Map<string, { readonly source: AppSnapshotV3; readonly bytes: number; references: number }>();
    const id = (kind: string): string => {
        if (sequence === Number.MAX_SAFE_INTEGER) fail('OBSERVATION_CAPACITY');
        const value = namespace + ':' + kind + ':' + ++sequence;
        if (utf8Size(value) > 256) fail('OBSERVATION_CAPACITY');
        return value;
    };
    function dropHold(hold: Hold): void {
        try { hold.lease.release(); } finally {
            const entry = sources.get(hold.source.id)!;
            if (--entry.references === 0) { sources.delete(hold.source.id); sourceBytes -= entry.bytes; }
        }
    }
    function dropObservation(scope: ObservationState, key: string, value: RegisteredObservation): void {
        scope.observations.delete(key);
        if (scope.adoptedObservationId === key) scope.adoptedObservationId = undefined;
        observationBytes -= value.publicBytes; metadataBytes -= value.metadataBytes;
        dropHold(value);
    }
    function releaseAll(scope: ObservationState): void {
        for (const value of scope.reservations.values()) value.cancelled = true;
        for (const [key, value] of scope.observations) dropObservation(scope, key, value);
    }
    function isCurrent(scope: ObservationState): boolean {
        if (scope.closing) return false;
        const identity = store.readAppIdentity(scope.appId);
        return identity.status !== 'stopped' && (identity.status !== 'active' || identity.instanceId === scope.instanceId);
    }
    function requireActive(scope: ObservationState): void {
        if (scope !== state || scope.closing) fail('APP_INTERACTION_UNAVAILABLE');
    }
    function ready(scope: ObservationState): AppSnapshotV3 {
        const latest = store.readLatest(scope.appId);
        if (latest.status !== 'ready') fail(latest.status === 'stopped' ? 'APP_STOPPED' : 'SNAPSHOT_UNREADY');
        if (latest.snapshot.instanceId !== scope.instanceId) fail('APP_INSTANCE_MISMATCH');
        if (latest.snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) fail('SNAPSHOT_INVALID');
        return latest.snapshot;
    }
    function reacquire(scope: ObservationState, source: AppSnapshotV3): void {
        ready(scope);
        const result = store.acquire(source.id);
        if (result.status === 'rejected') fail(result.issue.code);
        try {
            if (result.lease.snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || result.lease.snapshot.appId !== scope.appId ||
                result.lease.snapshot.instanceId !== scope.instanceId) fail('APP_INSTANCE_MISMATCH');
        } finally { result.lease.release(); }
    }
    function capacity(nextSource: number, nextPublic: number, nextMetadata: number): void {
        if (nextSource > limits.maxSourceBytes || nextPublic > limits.maxObservationBytes ||
            nextMetadata > limits.maxMetadataBytes || nextSource + nextPublic + nextMetadata > limits.maxTotalBytes) fail('OBSERVATION_CAPACITY', '$.observation');
    }
    function settle(scope: ObservationState, token: ReservationHandle, value: Reservation, transferred = false): void {
        scope.reservations.delete(token);
        observationBytes -= limits.observation.maxCanonicalBytes;
        metadataBytes -= limits.metadata.maxCanonicalBytes;
        if (!transferred) dropHold(value);
    }
    function stats(error?: unknown): ObservationRegistryStats {
        return Object.freeze({ closed: state.closing, observations: state.observations.size, reservations: state.reservations.size,
            cancelledReservations: [...state.reservations.values()].filter(reservation => reservation.cancelled).length,
            observationSlots: state.observations.size + state.reservations.size, sources: sources.size, sourceBytes,
            observationBytes, metadataBytes, totalBytes: sourceBytes + observationBytes + metadataBytes,
            ...(error === undefined ? {} : { issue: issue(error) }) });
    }
    function project(value: Reservation, input: unknown): { observation: Observation; metadata: Metadata; publicBytes: number; metadataBytes: number } {
        let grant: ObservationGrant;
        try {
            grant = bounded<ObservationGrant>(input, limits.metadata, 'OBSERVATION_PROJECTION_INVALID').value;
            object(grant, ['views', 'refs', 'toolBindings', 'content']);
            if (![grant.views, grant.refs, grant.toolBindings, grant.content].every(Array.isArray)) fail('OBSERVATION_PROJECTION_INVALID');
            if (grant.views.length > limits.maxViews || grant.refs.length > limits.maxRefs || grant.toolBindings.length > limits.maxBindings) fail('OBSERVATION_CAPACITY');
            const sourceViews = new Set(value.source.views.filter(v => value.selection.viewIds.includes(v.id))
                .map(v => viewKey({ viewId: v.id, viewInstanceId: v.viewInstanceId })));
            const sourceRefs = Object.values(value.source.refs);
            const originalRefs = new Set(sourceRefs.map(r => refKey({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })));
            const sourceTools = new Map(Object.values(value.source.tools).map(tool => [tool.id, tool]));
            const originalBindings = new Set(Object.values(value.source.tools).map(tool => executionKey(tool.id, tool.execution)));
            const views = new Set<string>(), refs = new Set<string>(), toolBindings = new Map<string, ObservedToolExecutionV3>(), content = new Map<string, string>();
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
            for (const binding of grant.toolBindings) {
                object(binding, ['toolId', 'execution']);
                if (!text(binding.toolId)) fail('OBSERVATION_PROJECTION_INVALID');
                const tool = sourceTools.get(binding.toolId);
                if (!tool) fail('OBSERVATION_PROJECTION_INVALID');
                let execution: ObservedToolExecutionV3;
                if (!binding.execution || typeof binding.execution !== 'object' || Array.isArray(binding.execution)) fail('OBSERVATION_PROJECTION_INVALID');
                if (binding.execution.kind === 'view-type') {
                    object(binding.execution, ['kind', 'activationId']);
                    if (!text(binding.execution.activationId)) fail('OBSERVATION_PROJECTION_INVALID');
                    execution = { kind: 'view-type', activationId: binding.execution.activationId };
                    const hasMatchingView = grant.views.some(selected => views.has(viewKey(selected)) &&
                        value.source.views.some(view => view.id === selected.viewId &&
                            view.viewInstanceId === selected.viewInstanceId && view.type === tool.viewType));
                    if (tool.execution.kind !== 'view-type' || tool.execution.activationId !== execution.activationId || !hasMatchingView)
                        fail('OBSERVATION_PROJECTION_INVALID');
                } else fail('OBSERVATION_PROJECTION_INVALID');
                const key = executionKey(binding.toolId, execution);
                if (!originalBindings.has(key) || toolBindings.has(key)) fail('OBSERVATION_PROJECTION_INVALID');
                toolBindings.set(key, execution);
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
            const tools = Object.values(value.source.tools).filter(tool => toolBindings.has(executionKey(tool.id, tool.execution)));
            if (tools.length > limits.maxTools) fail('OBSERVATION_CAPACITY');
            const bindings: ObservationBinding[] = tools.map(tool => ({ bindingId: id('binding'), toolId: tool.id,
                execution: { kind: 'view-type', activationId: tool.execution.activationId } }));
            const source = { appId: value.source.appId, instanceId: value.source.instanceId, snapshotId: value.source.id, revision: value.source.revision };
            const output = bounded<Observation>({ observationId: value.observationId, source, expiresAt: null,
                views: projectedViews, refs: projectedRefs, tools, bindings }, limits.observation, 'OBSERVATION_CAPACITY', '$.observation');
            const metadata = bounded<Metadata>({ observationId: value.observationId, source, views: projectedViews.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
                refs: projectedRefs.map(({ viewId, viewInstanceId, refId }) => ({ viewId, viewInstanceId, refId })), bindings }, limits.metadata, 'OBSERVATION_CAPACITY', '$.observation');
            return { observation: output.value, metadata: metadata.value, publicBytes: output.bytes, metadataBytes: metadata.bytes };
        } catch (error) {
            if (error instanceof RegistryFailure && error.code === 'OBSERVATION_CAPACITY') throw error;
            return fail('OBSERVATION_PROJECTION_INVALID');
        }
    }
    return Object.freeze({
        limits,
        isCurrent, releaseAll, stats,
        begin(scope: ObservationState, input: unknown) {
            let lease: SnapshotLease | undefined;
            try {
                refresh(); requireActive(scope);
                const captured = bounded<Record<string, unknown>>(input, limits.capture, 'OBSERVATION_INVALID').value;
                const all = captured !== null && typeof captured === 'object' && Object.hasOwn(captured, 'all');
                const data = object(captured, all ? ['all'] : ['viewIds']);
                if (all && data.all !== true) fail('OBSERVATION_INVALID');
                if (!all && (!Array.isArray(data.viewIds) || data.viewIds.length === 0 ||
                    data.viewIds.length > DEFAULT_OBSERVATION_REGISTRY_LIMITS.maxViews ||
                    data.viewIds.some(v => !text(v)) || new Set(data.viewIds).size !== data.viewIds.length)) fail('OBSERVATION_INVALID');
                if (scope.reservations.size || scope.observations.size > (scope.adoptedObservationId ? 1 : 0))
                    fail('OBSERVATION_CAPACITY');
                const source = ready(scope);
                const viewIds = all ? source.views.map(view => view.id) : data.viewIds as string[];
                if (viewIds.length > DEFAULT_OBSERVATION_REGISTRY_LIMITS.maxViews) fail('OBSERVATION_CAPACITY');
                if (viewIds.some(viewId => !source.views.some(v => v.id === viewId))) fail('OBSERVATION_INVALID');
                const acquired = store.acquire(source.id, { lifetime: 'owner' });
                if (acquired.status === 'rejected') fail(acquired.issue.code);
                lease = acquired.lease;
                const existing = sources.get(source.id);
                const bytes = existing?.bytes ?? bounded(source, limits.source, 'OBSERVATION_CAPACITY', '$.snapshot').bytes;
                capacity(sourceBytes + (existing ? 0 : bytes), observationBytes + limits.observation.maxCanonicalBytes,
                    metadataBytes + limits.metadata.maxCanonicalBytes);
                const token = Object.freeze({ reservation: true as const });
                const selection: ObservationSelection = Object.freeze({ viewIds: Object.freeze([...viewIds]) });
                const value = { source, lease, selection, observationId: id('observation'), cancelled: false };
                if (existing) existing.references++;
                else { sources.set(source.id, { source, bytes, references: 1 }); sourceBytes += bytes; }
                scope.reservations.set(token, value);
                observationBytes += limits.observation.maxCanonicalBytes; metadataBytes += limits.metadata.maxCanonicalBytes;
                lease = undefined;
                return Object.freeze({ status: 'reserved' as const, reservation: token, source, selection });
            } catch (error) { return rejected(error); }
            finally { lease?.release(); }
        },
        complete(scope: ObservationState, token: ReservationHandle, input: unknown) {
            const value = scope.reservations.get(token);
            let transferred = false;
            try {
                refresh();
                if (!value || scope.closing || value.cancelled) fail('RESERVATION_UNAVAILABLE');
                reacquire(scope, value.source);
                const projected = project(value, input);
                capacity(sourceBytes, observationBytes - limits.observation.maxCanonicalBytes + projected.publicBytes,
                    metadataBytes - limits.metadata.maxCanonicalBytes + projected.metadataBytes);
                scope.observations.set(value.observationId, { ...projected, source: value.source, lease: value.lease });
                observationBytes += projected.publicBytes; metadataBytes += projected.metadataBytes;
                transferred = true;
                return Object.freeze({ status: 'observed' as const, observation: projected.observation });
            } catch (error) { return rejected(error); }
            finally { if (value) settle(scope, token, value, transferred); }
        },
        abandon(scope: ObservationState, token: ReservationHandle): void {
            try { refresh(); } catch { /* Explicit settlement remains possible with a failed clock. */ }
            const value = scope.reservations.get(token);
            if (value) settle(scope, token, value);
        },
        resolveBinding(scope: ObservationState, input: unknown) {
            try {
                refresh(); requireActive(scope);
                const data = object(bounded(input, limits.capture, 'OBSERVATION_INVALID').value, ['observationId', 'bindingId']);
                if (!text(data.observationId) || !text(data.bindingId)) fail('OBSERVATION_INVALID');
                const value = scope.observations.get(data.observationId);
                if (!value) fail('OBSERVATION_UNAVAILABLE');
                if (scope.adoptedObservationId !== data.observationId) fail('OBSERVATION_NOT_ADOPTED');
                const binding = value.metadata.bindings.find(b => b.bindingId === data.bindingId);
                if (!binding) fail('BINDING_UNAVAILABLE');
                const execution = binding.execution;
                const sourceRequest = Object.freeze({ appId: scope.appId, instanceId: scope.instanceId,
                    snapshotId: value.source.id, toolId: binding.toolId, execution });
                const selected = acquireToolSource(store, sourceRequest);
                if (selected.status === 'rejected') fail(selected.issue.code);
                try {
                    return Object.freeze({ status: 'found' as const, sourceRequest, tool: selected.tool,
                        execution: selected.execution, visibleRefs: value.metadata.refs });
                } finally { selected.release(); }
            } catch (error) { return rejected(error); }
        },
        adoptObservation(scope: ObservationState, observationId: string) {
            try {
                refresh(); requireActive(scope);
                if (!text(observationId) || utf8Size(observationId) > 256) fail('OBSERVATION_INVALID');
                if (!scope.observations.has(observationId)) fail('OBSERVATION_UNAVAILABLE');
                ready(scope);
                if (scope.adoptedObservationId === observationId) return Object.freeze({ status: 'adopted' as const });
                // Preparation and publication do not switch the consumer's source.
                // Only this explicit boundary revokes earlier qualifications.
                for (const pending of scope.reservations.values()) pending.cancelled = true;
                for (const [key, value] of scope.observations) {
                    if (key !== observationId) dropObservation(scope, key, value);
                }
                scope.adoptedObservationId = observationId;
                return Object.freeze({ status: 'adopted' as const });
            } catch (error) { return rejected(error); }
        },
        releaseObservation(scope: ObservationState, observationId: string): void {
            try { refresh(); } catch { /* Explicit release does not require advancing time. */ }
            const value = scope.observations.get(observationId);
            if (value) dropObservation(scope, observationId, value);
        },
    });
}
