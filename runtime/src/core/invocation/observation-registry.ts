import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/types.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { AppIdentityReader, AppSnapshotV4, SnapshotLease, SnapshotStore } from '../snapshot/types.js';
import { sameToolDefinition, viewToolReceiver } from '../tool/source-binding.js';
import type { AppPreviewResult, AppInteractionPolicy } from './app-interaction-types.js';
import { DEFAULT_SNAPSHOT_LIMITS as snapshotLimits, OBSERVATION_METADATA_BYTES } from '../snapshot/snapshot-support.js';
import type {
    Observation, ObservationGrant, ObservationIssue, ObservedView,
    ObservationIssueCode, ObservationJsonLimits, ObservationRegistryLimits,
    ObservationRegistryOptions, ObservationRegistryStats, ObservationRejected,
    RefIdentity, ReservationHandle,
} from './observation-types.js';

const KiB = 1024, MiB = KiB * KiB;
const profile = (maxDepth: number, maxNodes: number, bytes: number): ObservationJsonLimits =>
    Object.freeze({ maxDepth, maxNodes, maxApproxBytes: bytes, maxCanonicalBytes: bytes });
export const DEFAULT_OBSERVATION_REGISTRY_LIMITS: ObservationRegistryLimits = Object.freeze({
    maxViews: 256, maxRefs: 512, maxTools: 256,
    capture: profile(4, 1024, 16 * KiB), metadata: profile(12, 8192, OBSERVATION_METADATA_BYTES),
    observation: profile(snapshotLimits.maxDepth + 2, snapshotLimits.maxNodes + 4_000,
        snapshotLimits.maxViewContentBytes + snapshotLimits.maxToolSchemaBytes + 2 * OBSERVATION_METADATA_BYTES),
    source: profile(snapshotLimits.maxDepth + 2, snapshotLimits.maxNodes + 16, snapshotLimits.maxSnapshotBytes * 2 + 64 * KiB),
    maxSourceBytes: 32 * MiB, maxObservationBytes: 16 * MiB,
    maxMetadataBytes: 8 * MiB, maxTotalBytes: 64 * MiB,
});

/** The default Host grants the full set of executable data and Tools. */
export const projectCompleteViews: AppInteractionPolicy['project'] = ({ source }) => ({
    refs: Object.values(source.refs).map(ref => ({
        viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id,
    })),
    toolIds: Object.keys(source.tools),
});

function observedViews(source: AppSnapshotV4): readonly ObservedView[] {
    return source.views.map(({ id, viewInstanceId, type, name, kind, content }) =>
        Object.freeze({ id, viewInstanceId, type, name, kind, content }));
}

export function previewCommittedApp(store: SnapshotStore, appId: string, instanceId: string): AppPreviewResult {
    const result = store.readLatest(appId);
    if (result.status === 'degraded') return { status: 'rejected', issue: result.issue };
    if (result.status !== 'ready' || result.snapshot.instanceId !== instanceId) return { status: 'rejected',
        issue: { code: 'APP_INTERACTION_UNAVAILABLE', message: 'Current App projection is unavailable' } };
    const snapshot = result.snapshot;
    return Object.freeze({ status: 'previewed', source: Object.freeze({ appId, instanceId, snapshotId: snapshot.id,
        revision: snapshot.revision }), views: Object.freeze(observedViews(snapshot)) });
}

class RegistryFailure {
    constructor(readonly code: ObservationIssueCode, readonly path?: string, readonly message?: string) {}
}
function fail(code: ObservationIssueCode, path?: string, message?: string): never { throw new RegistryFailure(code, path, message); }
const issue = (error: unknown): ObservationIssue => Object.freeze({
    code: error instanceof RegistryFailure ? error.code : 'OBSERVATION_INTERNAL_ERROR',
    message: error instanceof RegistryFailure && error.message ? error.message
        : error instanceof RegistryFailure && error.code === 'OBSERVATION_CAPACITY'
            ? 'All open Views and their Tool metadata exceed the observation limit. Close a View or page the App content.'
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
const refKey = (ref: RefIdentity): string => JSON.stringify([ref.viewId, ref.viewInstanceId, ref.refId]);
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

interface Hold { readonly source: AppSnapshotV4; readonly lease: SnapshotLease }
export interface Reservation extends Hold {
    readonly observationId: string;
    cancelled: boolean;
}
export interface RegisteredObservation extends Hold {
    readonly observation: Observation;
    readonly metadata: ObservationGrant;
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
    const sources = new Map<string, { readonly source: AppSnapshotV4; readonly bytes: number; references: number }>();
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
    function dropObservation(key: string, value: RegisteredObservation): void {
        state.observations.delete(key);
        if (state.adoptedObservationId === key) state.adoptedObservationId = undefined;
        observationBytes -= value.publicBytes; metadataBytes -= value.metadataBytes;
        dropHold(value);
    }
    function releaseAll(): void {
        for (const value of state.reservations.values()) value.cancelled = true;
        for (const [key, value] of state.observations) dropObservation(key, value);
    }
    function isCurrent(): boolean {
        if (state.closing) return false;
        const identity = store.readAppIdentity(state.appId);
        return identity.status !== 'stopped' && (identity.status !== 'active' || identity.instanceId === state.instanceId);
    }
    function requireActive(): void {
        if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
    }
    function ready(): AppSnapshotV4 {
        const latest = store.readLatest(state.appId);
        if (latest.status !== 'ready') fail(latest.status === 'stopped' ? 'APP_STOPPED' : 'SNAPSHOT_UNREADY');
        if (latest.snapshot.instanceId !== state.instanceId) fail('APP_INSTANCE_MISMATCH');
        if (latest.snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) fail('SNAPSHOT_INVALID');
        return latest.snapshot;
    }
    function reacquire(source: AppSnapshotV4): void {
        ready();
        const result = store.acquire(source.id);
        if (result.status === 'rejected') fail(result.issue.code);
        try {
            if (result.lease.snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || result.lease.snapshot.appId !== state.appId ||
                result.lease.snapshot.instanceId !== state.instanceId) fail('APP_INSTANCE_MISMATCH');
        } finally { result.lease.release(); }
    }
    function capacity(nextSource: number, nextPublic: number, nextMetadata: number): void {
        if (nextSource > limits.maxSourceBytes || nextPublic > limits.maxObservationBytes ||
            nextMetadata > limits.maxMetadataBytes || nextSource + nextPublic + nextMetadata > limits.maxTotalBytes) fail('OBSERVATION_CAPACITY', '$.observation');
    }
    function settle(token: ReservationHandle, value: Reservation, transferred = false): void {
        state.reservations.delete(token);
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
    function project(value: Reservation, input: unknown) {
        const invalid = 'OBSERVATION_PROJECTION_INVALID';
        const grant = bounded<ObservationGrant>(input, limits.metadata, invalid).value;
        object(grant, ['refs', 'toolIds'], invalid);
        if (!Array.isArray(grant.refs) || !Array.isArray(grant.toolIds)) fail(invalid);
        if (grant.refs.length > limits.maxRefs || grant.toolIds.length > limits.maxTools) fail('OBSERVATION_CAPACITY');
        const sourceRefs = Object.values(value.source.refs);
        const originalRefs = new Set(sourceRefs.map(ref => refKey({
            viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id,
        })));
        const refs = new Set<string>();
        for (const ref of grant.refs) {
            object(ref, ['viewId', 'viewInstanceId', 'refId'], invalid);
            if (!text(ref.viewId) || !text(ref.viewInstanceId) || !text(ref.refId)) fail(invalid);
            const key = refKey(ref);
            if (!originalRefs.has(key) || refs.has(key)) fail(invalid);
            refs.add(key);
        }
        const toolIds = new Set<string>();
        for (const toolId of grant.toolIds) {
            if (!text(toolId) || !Object.hasOwn(value.source.tools, toolId) || toolIds.has(toolId)) fail(invalid);
            toolIds.add(toolId);
        }

        const counts = new Map<string, number>();
        const eligible = new Map<string, string[]>();
        for (const { id, type, toolBindings } of value.source.views) {
            counts.set(type, (counts.get(type) ?? 0) + 1);
            for (const binding of toolBindings) {
                if (!toolIds.has(binding.toolId)) continue;
                const candidates = eligible.get(binding.toolId) ?? [];
                candidates.push(id);
                eligible.set(binding.toolId, candidates);
            }
        }
        const tools = Object.values(value.source.tools).flatMap(tool => {
            const candidates = eligible.get(tool.id);
            return !candidates ? [] : [candidates.length === counts.get(tool.viewType)
                ? tool : { ...tool, eligibleViewIds: candidates }];
        });
        const projectedRefs = sourceRefs.flatMap(ref => {
            const identity = { viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id };
            return refs.has(refKey(identity)) ? [{ ...identity, refType: ref.refType, kind: ref.target.kind }] : [];
        });
        const source = { appId: value.source.appId, instanceId: value.source.instanceId, snapshotId: value.source.id, revision: value.source.revision };
        const output = bounded<Observation>({ observationId: value.observationId, source, expiresAt: null,
            views: observedViews(value.source), refs: projectedRefs, tools }, limits.observation, 'OBSERVATION_CAPACITY', '$.observation');
        const metadata = bounded<ObservationGrant>({ refs: grant.refs, toolIds: tools.map(tool => tool.id) },
            limits.metadata, 'OBSERVATION_CAPACITY', '$.observation');
        return { observation: output.value, metadata: metadata.value, publicBytes: output.bytes, metadataBytes: metadata.bytes };
    }
    return Object.freeze({
        limits,
        isCurrent, releaseAll, stats,
        begin(input: unknown) {
            let lease: SnapshotLease | undefined;
            try {
                refresh(); requireActive();
                const captured = bounded<Record<string, unknown>>(input, limits.capture, 'OBSERVATION_INVALID').value;
                if (object(captured, ['all']).all !== true) fail('OBSERVATION_INVALID');
                if (state.reservations.size || state.observations.size > (state.adoptedObservationId ? 1 : 0))
                    fail('OBSERVATION_CAPACITY');
                const source = ready();
                if (source.views.length > limits.maxViews) fail('OBSERVATION_CAPACITY', '$.views');
                const acquired = store.acquire(source.id, { lifetime: 'owner' });
                if (acquired.status === 'rejected') fail(acquired.issue.code);
                lease = acquired.lease;
                const existing = sources.get(source.id);
                const bytes = existing?.bytes ?? bounded(source, limits.source, 'OBSERVATION_CAPACITY', '$.snapshot').bytes;
                capacity(sourceBytes + (existing ? 0 : bytes), observationBytes + limits.observation.maxCanonicalBytes,
                    metadataBytes + limits.metadata.maxCanonicalBytes);
                const token = Object.freeze({ reservation: true as const });
                const value = { source, lease, observationId: id('observation'), cancelled: false };
                if (existing) existing.references++;
                else { sources.set(source.id, { source, bytes, references: 1 }); sourceBytes += bytes; }
                state.reservations.set(token, value);
                observationBytes += limits.observation.maxCanonicalBytes; metadataBytes += limits.metadata.maxCanonicalBytes;
                lease = undefined;
                return Object.freeze({ status: 'reserved' as const, reservation: token, source });
            } catch (error) { return rejected(error); }
            finally { lease?.release(); }
        },
        complete(token: ReservationHandle, input: unknown) {
            const value = state.reservations.get(token);
            let transferred = false;
            try {
                refresh();
                if (!value || state.closing || value.cancelled) fail('RESERVATION_UNAVAILABLE');
                reacquire(value.source);
                const projected = project(value, input);
                capacity(sourceBytes, observationBytes - limits.observation.maxCanonicalBytes + projected.publicBytes,
                    metadataBytes - limits.metadata.maxCanonicalBytes + projected.metadataBytes);
                state.observations.set(value.observationId, { ...projected, source: value.source, lease: value.lease });
                observationBytes += projected.publicBytes; metadataBytes += projected.metadataBytes;
                transferred = true;
                return Object.freeze({ status: 'observed' as const, observation: projected.observation });
            } catch (error) { return rejected(error); }
            finally { if (value) settle(token, value, transferred); }
        },
        abandon(token: ReservationHandle): void {
            try { refresh(); } catch { /* Explicit settlement remains possible with a failed clock. */ }
            const value = state.reservations.get(token);
            if (value) settle(token, value);
        },
        resolveTool({ observationId, toolId, viewId }: { observationId: string; toolId: string; viewId: string }) {
            try {
                refresh(); requireActive();
                const value = state.observations.get(observationId);
                if (!value) fail('OBSERVATION_UNAVAILABLE');
                if (state.adoptedObservationId !== observationId) fail('OBSERVATION_NOT_ADOPTED');
                const tool = value.metadata.toolIds.includes(toolId) ? value.source.tools[toolId] : undefined;
                if (!tool) fail('TOOL_UNAVAILABLE', undefined, 'The original observation did not grant this Tool.');
                const view = value.source.views.find(candidate => candidate.id === viewId && candidate.type === tool.viewType);
                const receiver = view && viewToolReceiver(view, toolId);
                if (!receiver) fail('TOOL_UNAVAILABLE', '$.view_id',
                    'The selected View could not receive this Tool in the original observation. Choose an eligible XML id.');
                const latest = ready();
                const liveView = latest.views.find(candidate => candidate.id === viewId);
                if (!liveView || liveView.viewInstanceId !== receiver.viewInstanceId)
                    fail('VIEW_INSTANCE_REVOKED', '$.view_id', 'The receiving View closed or was replaced. Observe the current Views.');
                const liveTool = latest.tools[toolId];
                if (!liveTool || !sameToolDefinition(tool, liveTool) ||
                    viewToolReceiver(liveView, toolId)?.activationId !== receiver.activationId)
                    fail('TOOL_SOURCE_STALE', '$.view_id', 'The receiving View no longer has this Tool activation. Observe the current Tools.');
                return Object.freeze({ status: 'found' as const, snapshotId: value.source.id, tool, receiver,
                    visibleRefs: value.metadata.refs });
            } catch (error) { return rejected(error); }
        },
        adoptObservation(observationId: string) {
            try {
                refresh(); requireActive();
                if (!text(observationId) || utf8Size(observationId) > 256) fail('OBSERVATION_INVALID');
                if (!state.observations.has(observationId)) fail('OBSERVATION_UNAVAILABLE');
                ready();
                if (state.adoptedObservationId === observationId) return Object.freeze({ status: 'adopted' as const });
                // Preparation and publication do not switch the consumer's source.
                // Only this explicit boundary revokes earlier qualifications.
                for (const pending of state.reservations.values()) pending.cancelled = true;
                for (const [key, value] of state.observations) {
                    if (key !== observationId) dropObservation(key, value);
                }
                state.adoptedObservationId = observationId;
                return Object.freeze({ status: 'adopted' as const });
            } catch (error) { return rejected(error); }
        },
        releaseObservation(observationId: string): void {
            try { refresh(); } catch { /* Explicit release does not require advancing time. */ }
            const value = state.observations.get(observationId);
            if (value) dropObservation(observationId, value);
        },
    });
}
