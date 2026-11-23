import { isInstanceName, SNAPSHOT_SCHEMA_VERSION } from '../snapshot/types.js';
import { canonicalJson, copyJson, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import { modelToolSchema, programToolInput } from '../tool/tool-parameters.js';
import type { AppIdentityReader, AppSnapshot, JsonValue, PreparedAppSnapshotDraft, RefDescriptor, SnapshotHold, SnapshotPrepareIssue, SnapshotStore } from '../snapshot/types.js';
import { sameToolDefinition, viewToolReceiver } from '../tool/source-binding.js';
import { formatRefPath, isArrayElementPath, isRefPath, pathStartsWith, readRefPath, scopeAllows, type RefPath } from '../tool/ref-parameters.js';
import type { AppPreviewResult } from './app-interaction-types.js';
import { programRefSchema } from './program-ref-schema.js';
import { DEFAULT_SNAPSHOT_LIMITS as snapshotLimits, OBSERVATION_METADATA_BYTES, snapshotId } from '../snapshot/snapshot-support.js';
import type {
    Observation, ObservationGrant, ObservationIssue, ObservationSource, ObservedView,
    ObservationIssueCode, ObservationJsonLimits, ObservationRegistryLimits,
    ObservationRegistryOptions, ObservationRegistryStats, ObservationRejected,
    ObservedRef, ProgramRefPath, ProjectionLimits, RefGrant, RefIdentity, ReservationHandle, ViewIdentity, ViewWindowAccess,
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
const { maxViews, maxRefs, maxTools, observation, metadata } = DEFAULT_OBSERVATION_REGISTRY_LIMITS;
export const DEFAULT_PROJECTION_LIMITS: ProjectionLimits = Object.freeze({ maxViews, maxRefs, maxTools, observation, metadata });

type ObservationFrame = Pick<AppSnapshot, 'views' | 'refs' | 'tools'>;
export const hostedObservationNamespace = (instanceId: string): string => 'host:' + instanceId;
const observationId = (namespace: string, sequence: number): string => namespace + ':observation:' + sequence;

/** The default Host grants the full set of executable data and Tools. */
export const projectCompleteViews = ({ source }: { source: Pick<ObservationFrame, 'refs' | 'tools'> }): ObservationGrant => ({
    refs: Object.values(source.refs).map(ref => ({
        viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id,
    })),
    toolIds: Object.keys(source.tools),
});

function observedViews(source: Pick<ObservationFrame, 'views'>): readonly ObservedView[] {
    return source.views.map(({ id, viewInstanceId, type, name, region, content, canClose }) =>
        Object.freeze({ id, viewInstanceId, type, name, region, content, ...(canClose ? { canClose } : {}) }));
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
function object(value: unknown, keys: readonly string[], code: ObservationIssueCode = 'OBSERVATION_INVALID',
    optional: readonly string[] = []): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
    const record = value as Record<string, unknown>;
    if (keys.some(key => !Object.hasOwn(record, key)) ||
        Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))) fail(code);
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
function checkViewCount(frame: Pick<ObservationFrame, 'views'>, limits: ProjectionLimits): void {
    if (frame.views.length > limits.maxViews) fail('OBSERVATION_CAPACITY', '$.views');
}

function validateRefGrant(ref: RefGrant, appId: string): void {
    const invalid = 'OBSERVATION_PROJECTION_INVALID';
    object(ref, ['viewId', 'viewInstanceId', 'refId'], invalid, ['paths']);
    if (!text(ref.viewId) || !text(ref.viewInstanceId) || !text(ref.refId)) fail(invalid);
    if (ref.paths === undefined) return;
    if (!Array.isArray(ref.paths)) fail(invalid, '$.refs.paths', 'Expected Ref paths to be an array.');
    const root = '$' + appId + '.' + ref.viewId + formatRefPath([ref.refId]);
    for (const path of ref.paths) {
        const entry = object(path, ['path'], invalid, ['consumer']);
        if (!isRefPath(entry.path, root)) fail(invalid, '$.refs.paths', 'Expected a bounded sequence of field names and nonnegative array indices.');
        if (entry.consumer === undefined || entry.consumer === 'console') continue;
        const consumer = object(entry.consumer, ['appId', 'instanceId', 'viewId', 'viewInstanceId'], invalid);
        if (!isInstanceName(consumer.appId) || !isInstanceName(consumer.viewId) ||
            !text(consumer.instanceId) || !text(consumer.viewInstanceId))
            fail(invalid, '$.refs.paths.consumer', 'Expected the actual receiving App instance and View mount.');
    }
}

function declaredPathType(schema: JsonValue | undefined, path: RefPath): string | undefined {
    const record = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined =>
        value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, JsonValue>> : undefined;
    for (const part of path) {
        const node = record(schema);
        if (!node || node.anyOf !== undefined) return;
        if (typeof part === 'number') {
            if (node.type !== 'array') return;
            schema = node.items === false
                ? Array.isArray(node.prefixItems) ? node.prefixItems[part] : undefined
                : node.items;
        } else {
            const properties = record(node.properties);
            if (node.type !== 'object' || !properties || !Object.hasOwn(properties, part)) return;
            schema = properties[part];
        }
    }
    const type = record(schema)?.type;
    return type === 'null' || type === 'boolean' || type === 'string' || type === 'integer' ||
        type === 'number' || type === 'object' || type === 'array' ? type : undefined;
}

function projectRef(ref: RefDescriptor, grant: RefGrant, source: ObservationSource, programTools: boolean): ObservedRef | undefined {
    const { refType, scope, array, valueSchema } = ref;
    const available = programTools && scope === 'public'
        ? grant.paths?.filter(entry => entry.consumer === undefined || entry.consumer === 'console').map(entry => entry.path) ?? [[]]
        : [];
    const programPaths: ProgramRefPath[] = [];
    for (const path of available.sort((a, b) => a.length - b.length)) {
        if (programPaths.some(grant => pathStartsWith(path, grant.path)) || !readRefPath(ref.target.payload, path).found) continue;
        const schema = programRefSchema(valueSchema ?? (array ? { type: 'array' } : undefined), path);
        programPaths.push({ path, ...(schema === undefined ? {} : { schema }) });
    }
    const identity = { viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id, scope, kind: ref.target.kind,
        ...(programPaths.length ? { programPaths } : {}) };
    if (grant.paths === undefined) return { ...identity, refType, ...(array ? { array } : {}),
        ...(valueSchema === undefined ? {} : { valueSchema }) };
    const paths = grant.paths.flatMap(entry => {
        const target = entry.consumer;
        if (target === 'console' || (target && !scopeAllows(scope, ref.ownerViewInstanceId, target.viewInstanceId,
            source.appId === target.appId && source.instanceId === target.instanceId))) return [];
        if (!readRefPath(ref.target.payload, entry.path).found) return [];
        const valueType = declaredPathType(valueSchema, entry.path);
        const whole = !entry.path.length;
        return [{ path: entry.path, ...(target === undefined ? {} : { consumer: target }), ...(valueType === undefined ? {} : { valueType }),
            ...(whole || (array && isArrayElementPath(entry.path)) ? { refType } : {}), ...(whole && array ? { array } : {}) }];
    });
    return paths.length || programPaths.length ? { ...identity, paths } : undefined;
}

function projectObservation(frame: ObservationFrame, source: ObservationSource, id: string,
    grant: ObservationGrant, limits: ProjectionLimits, programTools = false) {
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
        validateRefGrant(ref, source.appId);
        const key = refKey(ref);
        if (!originalRefs.has(key) || refs.has(key)) fail(invalid);
        refs.set(key, ref);
    }
    const toolIds = new Set<string>();
    for (const toolId of grant.toolIds) {
        if (!text(toolId) || !Object.hasOwn(frame.tools, toolId) || toolIds.has(toolId)) fail(invalid);
        toolIds.add(toolId);
    }

    const counts = new Map<string, number>();
    const eligible = new Map<string, string[]>();
    for (const { id, type, toolBindings } of frame.views) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
        for (const binding of toolBindings) {
            if (!toolIds.has(binding.toolId)) continue;
            const candidates = eligible.get(binding.toolId) ?? [];
            candidates.push(id);
            eligible.set(binding.toolId, candidates);
        }
    }
    const tools = Object.values(frame.tools).flatMap(tool => {
        const candidates = eligible.get(tool.id);
        if (!candidates) return [];
        try {
            return [{ ...tool, inputSchema: modelToolSchema(tool.inputSchema, tool.viewType, tool.multiplicity),
                ...(programTools ? { programInput: programToolInput(tool.inputSchema, tool.viewType, tool.multiplicity) } : {}),
                ...(candidates.length === counts.get(tool.viewType) ? {} : { eligibleViewIds: candidates }) }];
        } catch (error) {
            if (error instanceof SnapshotDataError) fail(error.code === 'TOOL_SCHEMA_CAPACITY' ? 'TOOL_SCHEMA_CAPACITY' : 'TOOL_SCHEMA_INVALID',
                'Tool ' + tool.viewType + '.' + tool.name + '.inputSchema', error.message);
            throw error;
        }
    });
    const projectedRefs = sourceRefs.flatMap(ref => {
        const grant = refs.get(refKey({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id }));
        const projected = grant && projectRef(ref, grant, source, programTools);
        return projected ? [projected] : [];
    });
    const output = bounded<Observation>({ observationId: id, source, expiresAt: null,
        views: observedViews(frame), refs: projectedRefs, tools }, limits.observation, 'OBSERVATION_CAPACITY', '$.observation');
    const metadata = bounded<ObservationGrant>({ refs: grant.refs, toolIds: tools.map(tool => tool.id) },
        limits.metadata, 'OBSERVATION_CAPACITY', '$.metadata');
    return { observation: output.value, metadata: metadata.value, publicBytes: output.bytes, metadataBytes: metadata.bytes };
}

/** Measure the managed Worker's full projection before accepting a frame. */
export function hostedObservationCapacityIssue(draft: PreparedAppSnapshotDraft,
    limits: ProjectionLimits = DEFAULT_PROJECTION_LIMITS): SnapshotPrepareIssue | undefined {
    const revision = Number.MAX_SAFE_INTEGER;
    const { appId, instanceId } = draft;
    // Use the Host's exact encodings at their largest counter widths.
    const id = observationId(hostedObservationNamespace(instanceId), Number.MAX_SAFE_INTEGER);
    const source = { appId, instanceId, snapshotId: snapshotId(appId, instanceId, revision), revision };
    try {
        checkViewCount(draft, limits);
        const grant = bounded<ObservationGrant>(projectCompleteViews({ source: draft }), limits.metadata,
            'OBSERVATION_CAPACITY', '$.metadata').value;
        projectObservation(draft, source, id, grant, limits);
    } catch (error) {
        if (!(error instanceof RegistryFailure) || error.code !== 'OBSERVATION_CAPACITY') throw error;
        return { ...issue(error), code: error.code };
    }
}

function invalidLimit(path: string, message: string): never {
    throw Object.assign(new TypeError(message), { path });
}
function configuration(input: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalidLimit(path, 'Expected a plain object');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
        const field = `${path}.${String(key)}`;
        if (typeof key !== 'string' || !allowed.includes(key)) invalidLimit(field, 'Unknown field');
        if (!descriptors[key]!.enumerable || !('value' in descriptors[key]!)) invalidLimit(field, 'Expected an enumerable data property');
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value]));
}

function normalizeLimits<T extends ProjectionLimits>(input: unknown, defaults: T, path: string, complete = false): T {
    if (input === undefined && !complete) return defaults;
    const overrides = configuration(input, Object.keys(defaults), path);
    const effectiveNumber = (value: unknown, hard: number, field: string): number => {
        if (value === undefined && !complete) return hard;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > hard) {
            invalidLimit(field, `Expected a positive safe integer up to ${hard}`);
        }
        return value;
    };
    const result: Record<string, number | ObservationJsonLimits> = {};
    for (const [key, hard] of Object.entries(defaults) as [string, number | ObservationJsonLimits][]) {
        const field = `${path}.${key}`;
        const override = overrides[key];
        if (typeof hard === 'number') result[key] = effectiveNumber(override, hard, field);
        else if (override === undefined && !complete) result[key] = hard;
        else {
            const lower = configuration(override, Object.keys(hard), field);
            const effective = { ...hard };
            for (const limit of Object.keys(hard) as (keyof ObservationJsonLimits)[]) {
                effective[limit] = effectiveNumber(lower[limit], hard[limit], `${field}.${limit}`);
            }
            result[key] = Object.freeze(effective);
        }
    }
    return Object.freeze(result) as unknown as T;
}

/** Host options are partial; a Worker message must carry every effective field. */
export function normalizeProjectionLimits(input: unknown, path: string, complete = false): ProjectionLimits {
    return normalizeLimits(input, DEFAULT_PROJECTION_LIMITS, path, complete);
}

interface Hold {
    readonly source: AppSnapshot;
    readonly hold: SnapshotHold;
    readonly windows?: ReadonlyMap<string, ReturnType<ViewWindowAccess>>;
}
type SelectedWindows = Readonly<Record<'receiverViews' | 'refViews', ReadonlySet<string>>>;
export interface Reservation extends Hold {
    readonly observationId: string;
    readonly programTools: boolean;
    cancelled: boolean;
}
export interface RegisteredObservation extends Hold {
    readonly observation: Observation;
    readonly metadata: ObservationGrant;
    readonly publicBytes: number;
    readonly metadataBytes: number;
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

export function createObservationOperations(store: SnapshotStore & AppIdentityReader, options: ObservationRegistryOptions,
    state: ObservationState, refresh: () => number, windowAccess?: ViewWindowAccess) {
    let hasIdentity = false;
    try { hasIdentity = typeof store.readAppIdentity === 'function'; } catch { /* Invalid trusted capability. */ }
    if (!hasIdentity) throw new TypeError('Invalid observation registry store');
    let namespace: string, limits: ObservationRegistryLimits;
    try {
        const config = configuration(options, ['namespace', 'limits'], 'options');
        if (!text(config.namespace) || utf8Size(config.namespace) > 128) throw 0;
        namespace = config.namespace;
        limits = normalizeLimits(config.limits, DEFAULT_OBSERVATION_REGISTRY_LIMITS, 'options.limits');
    } catch { throw new TypeError('Invalid observation registry configuration'); }
    let sequence = 0;
    let sourceBytes = 0, observationBytes = 0, metadataBytes = 0;
    const sources = new Map<string, { readonly source: AppSnapshot; readonly bytes: number; references: number }>();
    const nextObservationId = (): string => {
        if (sequence === Number.MAX_SAFE_INTEGER) fail('OBSERVATION_CAPACITY');
        const value = observationId(namespace, ++sequence);
        if (utf8Size(value) > 256) fail('OBSERVATION_CAPACITY');
        return value;
    };
    function dropHold(hold: Hold): void {
        try { hold.hold.release(); } finally {
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
    function stillExpanded(value: Hold, view: ViewIdentity): boolean {
        if (!windowAccess) return true;
        const current = windowAccess(view);
        return current.expanded && current.epoch === value.windows?.get(view.viewInstanceId)?.epoch;
    }
    function eligible(value: RegisteredObservation, kind: keyof SelectedWindows, view: ViewIdentity): boolean {
        return value.selected?.[kind].has(view.viewInstanceId) === true && stillExpanded(value, view);
    }
    function visibleRefs(value: RegisteredObservation) {
        return value.metadata.refs.filter(ref => eligible(value, 'refViews', ref));
    }
    function selectWindows(value: Hold, input: unknown): SelectedWindows {
        if (input === undefined) {
            const all = new Set(value.source.views.filter(view => value.windows?.get(view.viewInstanceId)?.expanded !== false)
                .map(view => view.viewInstanceId));
            return { receiverViews: all, refViews: all };
        }
        const captured = bounded<unknown>(input, DEFAULT_OBSERVATION_REGISTRY_LIMITS.metadata, 'OBSERVATION_INVALID', '$.windows').value;
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
    return Object.freeze({
        limits,
        isCurrent, releaseAll, stats, visibleRefs,
        isRefView(observationId: string, view: ViewIdentity): boolean {
            try { return eligible(adopted(observationId), 'refViews', view); } catch { return false; }
        },
        begin(input: unknown) {
            let hold: SnapshotHold | undefined;
            try {
                refresh(); requireActive();
                const captured = bounded<Record<string, unknown>>(input, limits.capture, 'OBSERVATION_INVALID').value;
                if (object(captured, ['all'], 'OBSERVATION_INVALID', ['programTools']).all !== true ||
                    (captured.programTools !== undefined && captured.programTools !== true)) fail('OBSERVATION_INVALID');
                if (state.reservations.size || state.observations.size > (state.adoptedObservationId ? 1 : 0))
                    fail('OBSERVATION_CAPACITY');
                const source = ready();
                checkViewCount(source, limits);
                const acquired = store.acquire(source.id);
                if (acquired.status === 'rejected') fail(acquired.issue.code);
                hold = acquired.hold;
                const existing = sources.get(source.id);
                const bytes = existing?.bytes ?? bounded(source, limits.source, 'OBSERVATION_CAPACITY', '$.snapshot').bytes;
                capacity(sourceBytes + (existing ? 0 : bytes), observationBytes + limits.observation.maxCanonicalBytes,
                    metadataBytes + limits.metadata.maxCanonicalBytes);
                const token = Object.freeze({ reservation: true as const });
                const windows = windowAccess && new Map(source.views.map(({ id, viewInstanceId }) =>
                    [viewInstanceId, windowAccess({ viewId: id, viewInstanceId })] as const));
                const value = { source, hold, ...(windows ? { windows } : {}), observationId: nextObservationId(),
                    programTools: captured.programTools === true, cancelled: false };
                if (existing) existing.references++;
                else { sources.set(source.id, { source, bytes, references: 1 }); sourceBytes += bytes; }
                state.reservations.set(token, value);
                observationBytes += limits.observation.maxCanonicalBytes; metadataBytes += limits.metadata.maxCanonicalBytes;
                hold = undefined;
                return Object.freeze({ status: 'reserved' as const, reservation: token, source });
            } catch (error) { return rejected(error); }
            finally { hold?.release(); }
        },
        complete(token: ReservationHandle, input: unknown) {
            const value = state.reservations.get(token);
            let transferred = false;
            try {
                refresh();
                if (!value || state.closing || value.cancelled) fail('RESERVATION_UNAVAILABLE');
                requireSource(value.source);
                const grant = bounded<ObservationGrant>(input, limits.metadata, 'OBSERVATION_PROJECTION_INVALID', '$.metadata').value;
                const { appId, instanceId, id: snapshotId, revision } = value.source;
                const source = { appId, instanceId, snapshotId, revision };
                let projected;
                try {
                    projected = projectObservation(value.source, source, value.observationId, grant, limits, value.programTools);
                } catch (error) {
                    // Optional Console descriptions must not consume the space required by native Views and Tools.
                    if (!value.programTools || !(error instanceof RegistryFailure) || error.code !== 'OBSERVATION_CAPACITY' ||
                        error.path !== '$.observation') throw error;
                    projected = projectObservation(value.source, source, value.observationId, grant, limits);
                }
                capacity(sourceBytes, observationBytes - limits.observation.maxCanonicalBytes + projected.publicBytes,
                    metadataBytes - limits.metadata.maxCanonicalBytes + projected.metadataBytes);
                state.observations.set(value.observationId, { ...projected, source: value.source, hold: value.hold,
                    ...(value.windows ? { windows: value.windows } : {}) });
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
        readAdopted(observationId: string) {
            try {
                const value = adopted(observationId);
                return { status: 'found' as const, value, latest: ready() };
            } catch (error) { return rejected(error); }
        },
        resolveTool({ observationId, toolId, viewId, program }: { observationId: string; toolId: string; viewId?: unknown; program?: boolean }) {
            try {
                const value = adopted(observationId);
                const tool = value.metadata.toolIds.includes(toolId) ? value.source.tools[toolId] : undefined;
                if (!tool || (program && !value.observation.tools.some(entry => entry.id === toolId && entry.programInput)))
                    fail('TOOL_UNAVAILABLE', undefined, 'The original observation did not grant this Tool.');
                const single = tool.multiplicity === 'single';
                if (single ? viewId !== undefined : !isInstanceName(viewId)) fail('TOOL_INVALID_ARGS', '$.view_id',
                    single ? 'Omit view_id for a single-instance ViewType.' : 'Supply the receiving page XML view_id.');
                const view = value.source.views.find(candidate => candidate.type === tool.viewType && (single || candidate.id === viewId));
                const receiver = view && viewToolReceiver(view, toolId);
                if (!receiver || !eligible(value, 'receiverViews', receiver)) fail('TOOL_UNAVAILABLE', '$.view_id',
                    'The selected View could not receive this Tool in the original observation. Choose an eligible XML id.');
                const latest = ready();
                const liveView = latest.views.find(candidate => candidate.id === receiver.viewId);
                if (!liveView || liveView.viewInstanceId !== receiver.viewInstanceId)
                    fail('VIEW_INSTANCE_REVOKED', '$.view_id', 'The receiving View closed or was replaced. Observe the current Views.');
                const liveTool = latest.tools[toolId];
                if (!liveTool || !sameToolDefinition(tool, liveTool) ||
                    viewToolReceiver(liveView, toolId)?.activationId !== receiver.activationId)
                    fail('TOOL_SOURCE_STALE', '$.view_id', 'The receiving View no longer has this Tool activation. Observe the current Tools.');
                return Object.freeze({ status: 'found' as const, snapshotId: value.source.id, tool, receiver,
                    visibleRefs: visibleRefs(value) });
            } catch (error) { return rejected(error); }
        },
        adoptObservation(observationId: string, windows?: unknown) {
            try {
                refresh(); requireActive();
                if (!text(observationId) || utf8Size(observationId) > 256) fail('OBSERVATION_INVALID');
                const candidate = state.observations.get(observationId);
                if (!candidate) fail('OBSERVATION_UNAVAILABLE');
                const latest = ready();
                const selected = selectWindows(candidate, windows);
                if (candidate.selected) {
                    for (const kind of ['receiverViews', 'refViews'] as const) {
                        const previous = candidate.selected[kind];
                        if (previous.size !== selected[kind].size || [...selected[kind]].some(id => !previous.has(id)))
                            fail('OBSERVATION_INVALID', '$.windows', 'Prepare a new observation to change its Window selection.');
                    }
                    return Object.freeze({ status: 'adopted' as const });
                }
                const live = new Map(latest.views.map(view => [view.viewInstanceId, view.id]));
                for (const { id, viewInstanceId } of candidate.source.views) {
                    if ((selected.receiverViews.has(viewInstanceId) || selected.refViews.has(viewInstanceId)) &&
                        (live.get(viewInstanceId) !== id || !stillExpanded(candidate, { viewId: id, viewInstanceId })))
                        fail('OBSERVATION_WINDOW_CHANGED', '$.windows', 'A selected Window changed. Prepare the request again.');
                }
                // Preparation and publication do not switch the consumer's source.
                // Only this explicit boundary revokes earlier qualifications.
                for (const pending of state.reservations.values()) pending.cancelled = true;
                for (const [key, value] of state.observations) {
                    if (key !== observationId) dropObservation(key, value);
                }
                state.adoptedObservationId = observationId;
                candidate.selected = selected;
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
