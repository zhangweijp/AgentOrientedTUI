import { isInstanceName, SNAPSHOT_SCHEMA_VERSION } from '../snapshot/types.js';
import { utf8Size } from '../snapshot/json.js';
import type { AppIdentityReader, AppSnapshot, SnapshotHold, SnapshotStore } from '../snapshot/types.js';
import { currentPublishedSnapshot } from '../snapshot/store.js';
import { sameToolDefinition, viewToolReceiver } from '../tool/source-binding.js';
import type { AppPreviewResult, Issue } from './app-interaction-types.js';
import { refKey as rawRefKey } from '../snapshot/snapshot-support.js';
import { DEFAULT_PROJECTION_LIMITS, normalizeProjectionLimits,
    plainConfigObject as configuration } from '../snapshot/projection-limits.js';
import {
    boundedObservationJson as bounded,
    checkViewCount,
    failRegistry as fail,
    hostedObservationCapacityIssue,
    hostedObservationNamespace,
    observationId,
    observationIssue as issue,
    observedViews,
    projectCompleteViews,
    projectObservedTools,
    RegistryFailure,
} from './observation-projection.js';
import type {
    Observation, ObservationGrant,
    ObservationRegistryOptions, ObservationRegistryStats, ObservationRejected, ObservationSource, ObservationIssue,
    ObservedRef, ProjectionLimits, RefGrant, RefIdentity, ReservationHandle, ViewIdentity,
} from './observation-types.js';

export {
    DEFAULT_PROJECTION_LIMITS,
    hostedObservationCapacityIssue,
    hostedObservationNamespace,
    normalizeProjectionLimits,
    projectCompleteViews,
};

type ObservationFrame = Pick<AppSnapshot, 'views' | 'refs' | 'tools'>;

export function previewCommittedApp(store: SnapshotStore, appId: string, instanceId: string): AppPreviewResult {
    const result = store.readLatest(appId);
    if (result.status === 'degraded') return { status: 'rejected', issue: result.issue };
    if (result.status !== 'ready' || result.snapshot.instanceId !== instanceId) return { status: 'rejected',
        issue: { code: 'APP_INTERACTION_UNAVAILABLE', message: 'Current App projection is unavailable' } };
    const snapshot = result.snapshot;
    return Object.freeze({ status: 'previewed', source: Object.freeze({ appId, instanceId, snapshotId: snapshot.id,
        revision: snapshot.revision }), views: Object.freeze(observedViews(snapshot)) });
}

const rejected = (error: unknown): ObservationRejected => Object.freeze({ status: 'rejected', issue: issue(error) });
function object(value: unknown, keys: readonly string[], code: Parameters<typeof fail>[0] = 'OBSERVATION_INVALID',
    optional: readonly string[] = []): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
    const record = value as Record<string, unknown>;
    if (keys.some(key => !Object.hasOwn(record, key)) ||
        Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))) fail(code);
    return record;
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const refKey = (ref: RefIdentity): string => rawRefKey(ref.viewId, ref.viewInstanceId, ref.refId);

function validateRefGrant(ref: RefGrant): void {
    const invalid = 'OBSERVATION_PROJECTION_INVALID';
    object(ref, ['viewId', 'viewInstanceId', 'refId'], invalid, ['consumers']);
    if (!text(ref.viewId) || !text(ref.viewInstanceId) || !text(ref.refId)) fail(invalid);
    if (ref.consumers === undefined) return;
    if (!Array.isArray(ref.consumers)) fail(invalid, '$.refs.consumers', 'Expected a list of receiving View mounts.');
    for (const entry of ref.consumers) {
        const consumer = object(entry, ['appId', 'instanceId', 'viewId', 'viewInstanceId'], invalid);
        if (!isInstanceName(consumer.appId) || !isInstanceName(consumer.viewId) ||
            !text(consumer.instanceId) || !text(consumer.viewInstanceId))
            fail(invalid, '$.refs.consumers', 'Expected the actual receiving App instance and View mount.');
    }
}

function projectObservation(frame: ObservationFrame, source: ObservationSource, id: string,
    grant: ObservationGrant, limits: ProjectionLimits, canExposeTools?: () => boolean) {
    const invalid = 'OBSERVATION_PROJECTION_INVALID';
    object(grant, ['refs', 'toolIds'], invalid);
    if (!Array.isArray(grant.refs) || !Array.isArray(grant.toolIds)) fail(invalid);
    if (grant.refs.length > limits.maxRefs) fail('OBSERVATION_CAPACITY', '$.refs');
    if (grant.toolIds.length > limits.maxTools) fail('OBSERVATION_CAPACITY', '$.tools');
    const sourceRefs = Object.values(frame.refs);
    const originalRefs = new Set(sourceRefs.map(ref => refKey({
        viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id,
    })));
    const refs = new Map<string, RefGrant>();
    for (const ref of grant.refs) {
        validateRefGrant(ref);
        const key = refKey(ref);
        if (!originalRefs.has(key) || refs.has(key)) fail(invalid);
        refs.set(key, ref);
    }
    const toolIds = new Set<string>();
    for (const toolId of grant.toolIds) {
        if (!text(toolId) || !Object.hasOwn(frame.tools, toolId) || toolIds.has(toolId)) fail(invalid);
        toolIds.add(toolId);
    }

    const exposeTools = canExposeTools === undefined || canExposeTools();
    const tools = exposeTools ? projectObservedTools(frame, toolIds) : [];
    const projectedRefs: ObservedRef[] = sourceRefs.flatMap(ref => {
        const grant = refs.get(rawRefKey(ref.ownerViewId, ref.ownerViewInstanceId, ref.id));
        return grant ? [{ ...grant, scope: ref.scope, refType: ref.refType,
            ...(ref.array ? { array: ref.array } : {}), valueSchema: ref.valueSchema }] : [];
    });
    const output = bounded<Observation>({ observationId: id, source,
        views: observedViews(frame), refs: projectedRefs, tools }, limits.observation, 'OBSERVATION_CAPACITY', '$.observation');
    const metadata = exposeTools ? grant : Object.freeze({ refs: grant.refs, toolIds: Object.freeze([]) });
    return { observation: output.value, metadata };
}

interface Hold {
    readonly source: AppSnapshot;
    readonly hold: SnapshotHold;
    readonly revokedViews: Set<string>;
}
type SelectedWindows = Readonly<Record<'receiverViews' | 'refViews', ReadonlySet<string>>>;
export interface Reservation extends Hold {
    readonly observationId: string;
    cancelled: boolean;
}
export interface RegisteredObservation extends Hold {
    readonly observation: Observation;
    readonly metadata: ObservationGrant;
    selected?: SelectedWindows;
}
export interface ObservationState {
    readonly appId: string;
    readonly instanceId: string;
    readonly reservations: Map<ReservationHandle, Reservation>;
    readonly observations: Map<string, RegisteredObservation>;
    adoptedObservationId?: string;
    closing: boolean;
}

export interface ObservationAdoption {
    readonly visibleRefs: readonly ObservedRef[];
    verify(): ObservationIssue | undefined;
    recheck(): ObservationIssue | undefined;
    install(): void;
}

export function installObservationAdoptions(plans: readonly ObservationAdoption[], isCurrent: () => boolean) {
    for (const plan of plans) {
        const failure = plan.verify();
        if (failure) return failure;
    }
    // Verification can call an injected store. From this check through installation only Core-owned state is touched.
    if (!isCurrent()) return issue(new RegistryFailure('OBSERVATION_UNAVAILABLE'));
    for (const plan of plans) {
        const failure = plan.recheck();
        if (failure) return failure;
    }
    for (const plan of plans) plan.install();
}

const releaseFailure = Object.freeze({ code: 'OBSERVATION_RELEASE_FAILED', message: 'A retired observation could not release its source hold.' });
export const noObservationCleanupIssues: readonly Issue[] = Object.freeze([]);

export function releaseObservationHolds(releases: readonly ((() => void) | undefined)[]): readonly Issue[] {
    const issues: Issue[] = [];
    for (const release of releases) try { release?.(); } catch { issues.push(releaseFailure); }
    return issues.length ? Object.freeze(issues) : noObservationCleanupIssues;
}

export function createObservationOperations(store: SnapshotStore & AppIdentityReader, options: ObservationRegistryOptions,
    state: ObservationState, refresh: () => number) {
    let hasIdentity = false;
    try { hasIdentity = typeof store.readAppIdentity === 'function'; } catch { /* Invalid trusted capability. */ }
    if (!hasIdentity) throw new TypeError('Invalid observation registry store');
    let namespace: string, limits: ProjectionLimits;
    try {
        const config = configuration(options, ['namespace', 'limits'], 'options');
        if (!text(config.namespace) || utf8Size(config.namespace) > 128) throw 0;
        namespace = config.namespace;
        limits = normalizeProjectionLimits(config.limits, 'options.limits');
    } catch { throw new TypeError('Invalid observation registry configuration'); }
    let sequence = 0;
    const nextObservationId = (): string => {
        if (sequence === Number.MAX_SAFE_INTEGER) fail('OBSERVATION_CAPACITY');
        const value = observationId(namespace, ++sequence);
        if (utf8Size(value) > 256) fail('OBSERVATION_CAPACITY');
        return value;
    };
    function detachObservation(key: string, value: RegisteredObservation): () => void {
        state.observations.delete(key);
        if (state.adoptedObservationId === key) state.adoptedObservationId = undefined;
        return value.hold.release;
    }
    function detach(observationId: string): (() => void) | undefined {
        const value = state.observations.get(observationId);
        return value && detachObservation(observationId, value);
    }
    function releaseAll(): void {
        for (const value of state.reservations.values()) value.cancelled = true;
        releaseObservationHolds([...state.observations].map(([key, value]) => detachObservation(key, value)));
    }
    function isCurrent(): boolean {
        if (state.closing) return false;
        const identity = store.readAppIdentity(state.appId);
        return identity.status === 'active' && identity.instanceId === state.instanceId;
    }
    function requireActive(): void {
        if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
    }
    function ready(): AppSnapshot {
        const latest = store.readLatest(state.appId);
        if (latest.status !== 'ready') fail(latest.status === 'stopped' ? 'APP_STOPPED' : 'SNAPSHOT_UNREADY');
        if (latest.snapshot.instanceId !== state.instanceId) fail('APP_INSTANCE_MISMATCH');
        if (latest.snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) fail('SNAPSHOT_INVALID');
        return latest.snapshot;
    }
    function requireSource(source: AppSnapshot): void {
        ready();
        const result = store.getById(source.id);
        if (result.status === 'rejected') fail(result.issue.code);
        if (result.snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || result.snapshot.appId !== state.appId ||
            result.snapshot.instanceId !== state.instanceId) fail('APP_INSTANCE_MISMATCH');
    }
    function adopted(observationId: string): RegisteredObservation {
        refresh(); requireActive();
        const value = state.observations.get(observationId);
        if (!value) fail('OBSERVATION_UNAVAILABLE');
        if (state.adoptedObservationId !== observationId) fail('OBSERVATION_NOT_ADOPTED');
        return value;
    }
    function eligible(value: RegisteredObservation, kind: keyof SelectedWindows, view: ViewIdentity): boolean {
        return value.selected?.[kind].has(view.viewInstanceId) === true && !value.revokedViews.has(view.viewInstanceId);
    }
    function revokeWindows(target?: ViewIdentity): void {
        for (const held of [...state.observations.values(), ...state.reservations.values()]) {
            for (const view of held.source.views) {
                if (!target || (view.id === target.viewId && view.viewInstanceId === target.viewInstanceId))
                    held.revokedViews.add(view.viewInstanceId);
            }
        }
    }
    function visibleRefs(value: RegisteredObservation) {
        return value.metadata.refs.filter(ref => eligible(value, 'refViews', ref));
    }
    function selectWindows(value: Hold, input: unknown): SelectedWindows {
        if (input === undefined) {
            const all = new Set(value.source.views.map(view => view.viewInstanceId));
            return { receiverViews: all, refViews: all };
        }
        const captured = bounded<unknown>(input, DEFAULT_PROJECTION_LIMITS.metadata, 'OBSERVATION_INVALID', '$.windows').value;
        const selection = object(captured, ['receiverViews', 'refViews']);
        const views = new Map(value.source.views.map(view => [view.viewInstanceId, view.id]));
        const list = (entries: unknown, path: string) => {
            if (!Array.isArray(entries) || entries.length > views.size) fail('OBSERVATION_INVALID', path);
            const result = new Set<string>();
            for (const entry of entries) {
                const { viewId, viewInstanceId } = object(entry, ['viewId', 'viewInstanceId']);
                if (!text(viewId) || !text(viewInstanceId) || views.get(viewInstanceId) !== viewId || result.has(viewInstanceId))
                    fail('OBSERVATION_INVALID', path, 'Select each receiving or publishing mount once from the candidate observation.');
                result.add(viewInstanceId);
            }
            return result;
        };
        return { receiverViews: list(selection.receiverViews, '$.receiverViews'), refViews: list(selection.refViews, '$.refViews') };
    }
    function prepareAdoption(observationId: string, windows?: unknown): { status: 'ready'; plan: ObservationAdoption } | ObservationRejected {
        try {
            refresh(); requireActive();
            if (!text(observationId) || utf8Size(observationId) > 256) fail('OBSERVATION_INVALID');
            const candidate = state.observations.get(observationId);
            if (!candidate) fail('OBSERVATION_UNAVAILABLE');
            const previous = state.adoptedObservationId;
            const selected = windows === undefined && candidate.selected ? candidate.selected : selectWindows(candidate, windows);
            if (candidate.selected) for (const kind of ['receiverViews', 'refViews'] as const) {
                const existing = candidate.selected[kind];
                if (existing.size !== selected[kind].size || [...selected[kind]].some(id => !existing.has(id)))
                    fail('OBSERVATION_INVALID', '$.windows', 'Prepare a new observation to change its Window selection.');
            }
            const isRetained = () => !state.closing && state.adoptedObservationId === previous &&
                state.observations.get(observationId) === candidate;
            const verify = () => {
                try {
                    if (!isRetained()) fail('OBSERVATION_UNAVAILABLE');
                    ready();
                } catch (error) { return issue(error); }
            };
            const views = candidate.source.views.filter(view => selected.receiverViews.has(view.viewInstanceId) ||
                selected.refViews.has(view.viewInstanceId));
            const changed = () => fail('OBSERVATION_WINDOW_CHANGED', '$.windows', 'A selected Window or its access changed. Prepare the request again.');
            const recheck = () => {
                try {
                    if (!isRetained()) fail('OBSERVATION_UNAVAILABLE');
                    const latest = currentPublishedSnapshot(candidate.source);
                    if (!latest) fail('SNAPSHOT_UNREADY');
                    if (views.some(view => candidate.revokedViews.has(view.viewInstanceId))) changed();
                    if (latest === candidate.source) return;
                    const live = new Map(latest.views.map(view => [view.viewInstanceId, view]));
                    const grantedTools = new Set(candidate.metadata.toolIds);
                    for (const view of views) {
                        const mount = live.get(view.viewInstanceId);
                        if (!mount || mount.id !== view.id) return changed();
                        if (!selected.receiverViews.has(view.viewInstanceId)) continue;
                        for (const { toolId, activationId } of view.toolBindings) {
                            if (!grantedTools.has(toolId)) continue;
                            const tool = latest.tools[toolId];
                            if (!tool || !sameToolDefinition(candidate.source.tools[toolId]!, tool) ||
                                !mount.toolBindings.some(binding => binding.toolId === toolId && binding.activationId === activationId)) changed();
                        }
                    }
                    for (const ref of candidate.observation.refs) {
                        if (!selected.refViews.has(ref.viewInstanceId)) continue;
                        const publication = latest.refs[refKey(ref)];
                        if (!publication || (ref.scope === 'public' && publication.scope !== 'public') ||
                            (ref.scope === 'protected' && publication.scope === 'private')) changed();
                    }
                } catch (error) { return issue(error); }
            };
            return { status: 'ready', plan: {
                visibleRefs: candidate.observation.refs.filter(ref => selected.refViews.has(ref.viewInstanceId)),
                recheck, verify,
                install() {
                    if (state.adoptedObservationId !== observationId)
                        for (const pending of state.reservations.values()) pending.cancelled = true;
                    state.adoptedObservationId = observationId;
                    candidate.selected = selected;
                },
            } };
        } catch (error) { return rejected(error); }
    }
    function settle(token: ReservationHandle, value: Reservation, transferred = false): void {
        state.reservations.delete(token);
        if (!transferred) value.hold.release();
    }
    function stats(error?: unknown): ObservationRegistryStats {
        return Object.freeze({ closed: state.closing, observations: state.observations.size, reservations: state.reservations.size,
            cancelledReservations: [...state.reservations.values()].filter(reservation => reservation.cancelled).length,
            observationSlots: state.observations.size + state.reservations.size,
            ...(error === undefined ? {} : { issue: issue(error) }) });
    }
    return Object.freeze({
        isCurrent, releaseAll, stats, visibleRefs, prepareAdoption, detach, revokeWindows,
        isRefView(observationId: string, view: ViewIdentity): boolean {
            try { return eligible(adopted(observationId), 'refViews', view); } catch { return false; }
        },
        begin() {
            let hold: SnapshotHold | undefined;
            try {
                refresh(); requireActive();
                if (state.reservations.size || state.observations.size > (state.adoptedObservationId ? 1 : 0))
                    fail('OBSERVATION_CAPACITY');
                const { id } = ready();
                const acquired = store.acquire(id);
                if (acquired.status === 'rejected') fail(acquired.issue.code);
                hold = acquired.hold;
                // The read adapter can copy a snapshot. The hold supplies the actual publication.
                const source = hold.snapshot;
                if (source.id !== id) fail('SNAPSHOT_UNAVAILABLE');
                if (source.appId !== state.appId || source.instanceId !== state.instanceId) fail('APP_INSTANCE_MISMATCH');
                if (source.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) fail('SNAPSHOT_INVALID');
                checkViewCount(source, limits);
                const token = Object.freeze({ reservation: true as const });
                const value = { source, hold, revokedViews: new Set<string>(), observationId: nextObservationId(), cancelled: false };
                state.reservations.set(token, value);
                hold = undefined;
                return Object.freeze({ status: 'reserved' as const, reservation: token, source });
            } catch (error) { return rejected(error); }
            finally { hold?.release(); }
        },
        complete(token: ReservationHandle, input: unknown, canExposeTools?: () => boolean) {
            const value = state.reservations.get(token);
            let transferred = false;
            try {
                refresh();
                if (!value || state.closing || value.cancelled) fail('RESERVATION_UNAVAILABLE');
                requireSource(value.source);
                const grant = bounded<ObservationGrant>(input, limits.metadata, 'OBSERVATION_PROJECTION_INVALID', '$.metadata').value;
                const { appId, instanceId, id: snapshotId, revision } = value.source;
                const source = { appId, instanceId, snapshotId, revision };
                const projected = projectObservation(value.source, source, value.observationId, grant, limits, canExposeTools);
                if (state.closing || value.cancelled) fail('RESERVATION_UNAVAILABLE');
                state.observations.set(value.observationId, { ...projected, source: value.source, hold: value.hold,
                    revokedViews: value.revokedViews });
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
        readAdopted(observationId: string) {
            try {
                const value = adopted(observationId);
                return { status: 'found' as const, value, latest: ready() };
            } catch (error) { return rejected(error); }
        },
        resolveTool({ observationId, toolId, viewId }: { observationId: string; toolId: string; viewId?: unknown }) {
            try {
                const value = adopted(observationId);
                const tool = value.metadata.toolIds.includes(toolId) ? value.source.tools[toolId] : undefined;
                if (!tool)
                    fail('TOOL_UNAVAILABLE', undefined, 'The original observation did not grant this Tool.');
                const single = tool.multiplicity === 'single';
                if (single ? viewId !== undefined : !isInstanceName(viewId)) fail('TOOL_INVALID_ARGS', '$.view_id',
                    single ? 'Omit view_id for a single-instance ViewType.' : 'Supply the receiving page XML view_id.');
                const view = value.source.views.find(candidate => candidate.type === tool.viewType && (single || candidate.id === viewId));
                const receiver = view && viewToolReceiver(view, toolId);
                if (!receiver || !value.selected?.receiverViews.has(receiver.viewInstanceId)) fail('TOOL_UNAVAILABLE', '$.view_id',
                    'The selected View could not receive this Tool in the original observation. Choose an eligible XML id.');
                const latest = ready();
                const liveView = latest.views.find(candidate => candidate.id === receiver.viewId);
                if (!liveView || liveView.viewInstanceId !== receiver.viewInstanceId)
                    fail('VIEW_INSTANCE_REVOKED', '$.view_id', 'The receiving View closed or was replaced. Observe the current Views.');
                if (value.revokedViews.has(receiver.viewInstanceId)) fail('TOOL_UNAVAILABLE', '$.view_id',
                    'The selected View changed visibility. Observe the current Views.');
                const liveTool = latest.tools[toolId];
                if (!liveTool || !sameToolDefinition(tool, liveTool) ||
                    viewToolReceiver(liveView, toolId)?.activationId !== receiver.activationId)
                    fail('TOOL_SOURCE_STALE', '$.view_id', 'The receiving View no longer has this Tool activation. Observe the current Tools.');
                return Object.freeze({ status: 'found' as const, snapshotId: value.source.id, tool, receiver,
                    visibleRefs: visibleRefs(value) });
            } catch (error) { return rejected(error); }
        },
        adoptObservation(observationId: string, windows?: unknown) {
            const reuse = state.adoptedObservationId === observationId;
            const prepared = prepareAdoption(observationId, windows);
            if (prepared.status === 'rejected') return prepared;
            const failure = installObservationAdoptions([prepared.plan], () => true);
            if (failure) return Object.freeze({ status: 'rejected' as const, issue: failure });
            const cleanupIssues = reuse ? noObservationCleanupIssues
                : releaseObservationHolds([...state.observations.keys()].filter(key => key !== observationId).map(detach));
            return Object.freeze({ status: 'adopted' as const, ...(cleanupIssues.length ? { cleanupIssues } : {}) });
        },
        releaseObservation(observationId: string): void {
            try { refresh(); } catch { /* Explicit release does not require advancing time. */ }
            detach(observationId)?.();
        },
    });
}
