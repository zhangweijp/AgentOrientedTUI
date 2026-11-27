import { checkWireJson, copyJson } from '../snapshot/json.js';
import { DEFAULT_PROJECTION_LIMITS } from '../snapshot/projection-limits.js';
import { snapshotId } from '../snapshot/snapshot-support.js';
import type { AppSnapshot, PreparedAppSnapshotDraft, SnapshotPrepareIssue } from '../snapshot/types.js';
import type {
    Observation, ObservationGrant, ObservationIssue, ObservationIssueCode, ObservationJsonLimits,
    ObservationSource, ObservedRef, ObservedTool, ObservedView, ProjectionLimits,
} from './observation-types.js';

export type ObservationFrame = Pick<AppSnapshot, 'views' | 'refs' | 'tools'>;
export const hostedObservationNamespace = (instanceId: string): string => 'host:' + instanceId;
export const observationId = (namespace: string, sequence: number): string => namespace + ':observation:' + sequence;

/** The default Host grants the full set of executable data and Tools. */
export const projectCompleteViews = ({ source }: { source: Pick<ObservationFrame, 'refs' | 'tools'> }): ObservationGrant => ({
    refs: Object.values(source.refs).map(ref => ({
        viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id,
    })),
    toolIds: Object.keys(source.tools),
});

export function observedViews(source: Pick<ObservationFrame, 'views'>, closeViews?: ReadonlySet<string>): readonly ObservedView[] {
    return source.views.map(({ id, viewInstanceId, type, name, region, content, closeActivationId }) =>
        Object.freeze({ id, viewInstanceId, type, name, region, content, ...(closeActivationId && (!closeViews || closeViews.has(viewInstanceId)) ? { canClose: true as const } : {}) }));
}

export class RegistryFailure {
    constructor(readonly code: ObservationIssueCode, readonly path?: string, readonly message?: string) {}
}

export function failRegistry(code: ObservationIssueCode, path?: string, message?: string): never {
    throw new RegistryFailure(code, path, message);
}

export const observationIssue = (error: unknown): ObservationIssue => Object.freeze({
    code: error instanceof RegistryFailure ? error.code : 'OBSERVATION_INTERNAL_ERROR',
    message: error instanceof RegistryFailure && error.message ? error.message
        : error instanceof RegistryFailure && error.code === 'OBSERVATION_CAPACITY'
            ? 'All open Views and their Tool metadata exceed the observation limit. Close a View or page the App content.'
            : 'Observation registry request could not be completed',
    ...(error instanceof RegistryFailure && error.path ? { path: error.path } : {}),
});

export function boundedObservationJson<T>(input: unknown, limits: ObservationJsonLimits, code: ObservationIssueCode,
    path?: string): { value: T } {
    try {
        const value = copyJson(input, limits);
        checkWireJson(value, limits);
        return { value: value as T };
    } catch {
        return failRegistry(code, path);
    }
}

export function checkViewCount(frame: Pick<ObservationFrame, 'views'>, limits: ProjectionLimits): void {
    if (frame.views.length > limits.maxViews) failRegistry('OBSERVATION_CAPACITY', '$.views');
}

export function projectObservedTools(
    frame: Pick<ObservationFrame, 'views' | 'tools'>,
    toolIds: ReadonlySet<string>,
): ObservedTool[] {
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
    return Object.values(frame.tools).flatMap(tool => {
        const candidates = eligible.get(tool.id);
        if (!candidates) return [];
        return [{ ...tool, inputSchema: tool.inputSchema as ObservedTool['inputSchema'],
            ...(candidates.length === counts.get(tool.viewType) ? {} : { eligibleViewIds: candidates }) }];
    });
}

/** Measure the managed Worker's full projection before accepting a frame. */
export function hostedObservationCapacityIssue(draft: PreparedAppSnapshotDraft,
    limits: ProjectionLimits = DEFAULT_PROJECTION_LIMITS): SnapshotPrepareIssue | undefined {
    const revision = Number.MAX_SAFE_INTEGER;
    const { appId, instanceId } = draft;
    // Use the Host's exact encodings at their largest counter widths.
    const id = observationId(hostedObservationNamespace(instanceId), Number.MAX_SAFE_INTEGER);
    const source: ObservationSource = { appId, instanceId, snapshotId: snapshotId(appId, instanceId, revision), revision };
    try {
        checkViewCount(draft, limits);
        const grant = boundedObservationJson<ObservationGrant>({ ...projectCompleteViews({ source: draft }),
            closeViews: draft.views.filter(view => view.closeActivationId).map(view => ({viewId:view.id,viewInstanceId:view.viewInstanceId})) }, limits.metadata,
            'OBSERVATION_CAPACITY', '$.metadata').value;
        if (grant.refs.length > limits.maxRefs) failRegistry('OBSERVATION_CAPACITY', '$.refs');
        if (grant.toolIds.length > limits.maxTools) failRegistry('OBSERVATION_CAPACITY', '$.tools');
        const tools = projectObservedTools(draft, new Set(grant.toolIds));
        const refs: ObservedRef[] = Object.values(draft.refs).map(({ ownerViewId: viewId, ownerViewInstanceId: viewInstanceId,
            id: refId, scope, refType, array, valueSchema }) => ({
            viewId, viewInstanceId, refId, scope, refType, ...(array ? { array } : {}), valueSchema,
        }));
        boundedObservationJson<Observation>({ observationId: id, source,
            views: observedViews(draft), refs, tools }, limits.observation, 'OBSERVATION_CAPACITY', '$.observation');
    } catch (error) {
        if (!(error instanceof RegistryFailure)) throw error;
        if (error.code === 'OBSERVATION_CAPACITY' || error.code === 'TOOL_SCHEMA_CAPACITY' || error.code === 'TOOL_SCHEMA_INVALID') {
            return { ...observationIssue(error), code: error.code };
        }
        throw error;
    }
}
