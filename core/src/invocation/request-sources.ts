import type { AppSnapshot } from '../snapshot/types.js';
import type { RefArgumentSource } from '../tool/snapshot-value-arguments.js';
import type { ActiveTurn, AdoptTurnResult, AppInteraction, AppInvocation, CancellationSignal, ConsoleInputs, InvokeResult,
    Issue, ObservationCandidate, PrepareObservationResult, InspectRefMode, InspectRefResult, TurnSelection } from './app-interaction-types.js';
import type { ObservedRef, ViewIdentity } from './observation-types.js';
import { installObservationAdoptions, noObservationCleanupIssues, releaseObservationHolds, type ObservationAdoption } from './observation-registry.js';
import { inspectTurnRef, readConsoleInputs } from './console-inputs.js';

export interface RefSourceHold {
    readonly source: RefArgumentSource;
    readonly snapshot: AppSnapshot;
    refresh?(): Promise<void>;
    current(): AppSnapshot | undefined;
    isRefView(viewId: string, viewInstanceId: string): boolean;
    markDispatched(): void;
    release(): void;
}

export interface RequestSourceAuthority {
    readonly appId: string;
    acquire(observationId: string): RefSourceHold | { issue: Issue };
    prepare(observationId: string, windows: unknown): { status: 'ready'; plan: ObservationAdoption } | { status: 'rejected'; issue: Issue };
    revokeWindows(target?: ViewIdentity): void;
    detach(observationId: string): (() => void) | undefined;
}

type RequestSourceClient = Pick<AppInteraction, 'observe' | 'invoke'>;

interface BoundApp {
    readonly client: WeakRef<RequestSourceClient>;
    readonly authority: WeakRef<RequestSourceAuthority>;
    readonly observationId: string;
    readonly instanceId: string;
    readonly visibleRefs: readonly ObservedRef[];
    readonly isLive: () => boolean;
}
export interface BoundRequestSources {
    readonly identity: symbol;
    readonly apps: Map<string, BoundApp>;
    readonly isCurrent: () => boolean;
}

const authorities = new WeakMap<RequestSourceClient, RequestSourceAuthority>();
const bindings = new WeakMap<ActiveTurn, BoundRequestSources>();

export function registerRequestSource(client: RequestSourceClient, authority: RequestSourceAuthority): void {
    authorities.set(client, authority);
}

export function forwardRequestSource(client: RequestSourceClient, original: RequestSourceClient): void {
    const authority = authorities.get(original);
    if (authority) registerRequestSource(client, authority);
}

function dataField(object: unknown, name: string): unknown {
    if (object === null || typeof object !== 'object') return undefined;
    const field = Object.getOwnPropertyDescriptor(object, name);
    return field?.enumerable && 'value' in field ? field.value : undefined;
}

export function requestSourcesFor(token: ActiveTurn, target: RequestSourceAuthority, observationId: string): BoundRequestSources | undefined {
    const binding = bindings.get(token);
    const app = binding?.apps.get(target.appId);
    return binding?.isCurrent() && app?.authority.deref() === target && app.observationId === observationId ? binding : undefined;
}

export function requestAppIsAvailable(binding: BoundRequestSources, appId: string): boolean {
    const entry = binding.apps.get(appId);
    return binding.isCurrent() && !!entry?.client.deref() && entry.isLive() && binding.isCurrent();
}

export function acquireRequestSource(binding: BoundRequestSources, appId: string): RefSourceHold | { issue: Issue } | undefined {
    const entry = binding.apps.get(appId);
    const client = entry?.client.deref();
    const authority = entry?.authority.deref();
    if (!entry || !client || !authority || !requestAppIsAvailable(binding, appId)) return;
    const hold = authority.acquire(entry.observationId);
    if ('issue' in hold) return hold;
    return { ...hold, current: () => requestAppIsAvailable(binding, appId) ? hold.current() : undefined };
}

const inactive = Object.freeze({ code: 'TURN_NOT_ACTIVE', message: 'Use the current adopted Desktop turn.' });
const invalidTurn = Object.freeze({ code: 'TURN_SELECTION_INVALID', message: 'Select one retained candidate per App from this Desktop.' });
const unavailable = Object.freeze({ code: 'OBSERVATION_UNAVAILABLE', message: 'The original observation is no longer available.' });
const rejectTurn = (issue: Issue) => Object.freeze({ status: 'rejected' as const, issue });
const refused = (issue: Issue): InvokeResult => Object.freeze({ kind: 'refused', ...issue });

type PreparedSource = Omit<BoundApp, 'visibleRefs'>;

/** One authority for the complete set of Apps exposed to a model turn. */
export function createTurnCoordinator() {
    const candidates = new WeakMap<ObservationCandidate, PreparedSource>();
    let current: BoundRequestSources | undefined;
    let revision = Symbol();
    let closed = false;

    function retire(previous: BoundRequestSources | undefined, next?: BoundRequestSources): readonly Issue[] {
        if (!previous) return noObservationCleanupIssues;
        const releases: (() => void)[] = [];
        // Detach every obsolete source before invoking any release callback.
        for (const [appId, entry] of previous.apps) {
            const retained = next?.apps.get(appId);
            const authority = entry.authority.deref();
            if (retained?.observationId === entry.observationId && retained.authority.deref() === authority) continue;
            const release = authority?.detach(entry.observationId);
            if (release) releases.push(release);
        }
        previous.apps.clear();
        return releaseObservationHolds(releases);
    }

    function release(binding: BoundRequestSources): readonly Issue[] {
        if (current !== binding) return noObservationCleanupIssues;
        current = undefined;
        revision = Symbol();
        return retire(binding);
    }

    async function prepareObservation(client: RequestSourceClient, isLive: () => boolean): Promise<PrepareObservationResult> {
        if (closed || !isLive()) return rejectTurn(unavailable);
        const result = await client.observe();
        if (result.status === 'rejected') return result;
        const authority = authorities.get(client);
        if (!authority) return rejectTurn(unavailable);
        const observation = result.observation;
        const observationId = observation.observationId;
        const discard = () => {
            const active = current?.apps.get(authority.appId);
            if (active?.authority.deref() === authority && active.observationId === observationId) return noObservationCleanupIssues;
            const drop = authority.detach(observationId);
            return releaseObservationHolds([drop]);
        };
        if (closed || !isLive()) { discard(); return rejectTurn(unavailable); }
        const candidate = Object.freeze({ observation, discard });
        candidates.set(candidate, { client: new WeakRef(client), authority: new WeakRef(authority),
            observationId, instanceId: observation.source.instanceId, isLive });
        return Object.freeze({ status: 'prepared', candidate });
    }

    function adoptTurn(input: TurnSelection): AdoptTurnResult {
        if (closed) return rejectTurn(inactive);
        const start = revision;
        const apps = new Map<string, BoundApp>();
        const plans: ObservationAdoption[] = [];
        try {
            const supplied = dataField(input, 'apps');
            if (!Array.isArray(supplied)) return rejectTurn(invalidTurn);
            for (let index = 0; index < supplied.length; index++) {
                const selection = dataField(supplied, String(index));
                const entry = candidates.get(dataField(selection, 'candidate') as ObservationCandidate);
                const authority = entry?.authority.deref();
                if (!entry || !authority || apps.has(authority.appId)) return rejectTurn(invalidTurn);
                if (!entry.client.deref() || !entry.isLive()) return rejectTurn(unavailable);
                const selected = authority.prepare(entry.observationId, dataField(selection, 'windows'));
                if (selected.status === 'rejected') return selected;
                plans.push(selected.plan);
                apps.set(authority.appId, { ...entry, visibleRefs: selected.plan.visibleRefs });
            }
            for (const app of apps.values()) if (!app.isLive()) return rejectTurn(unavailable);
        } catch { return rejectTurn(invalidTurn); }
        const failure = installObservationAdoptions(plans, () => !closed && start === revision);
        if (failure) return rejectTurn(failure);

        const binding: BoundRequestSources = { identity: Symbol(), apps, isCurrent: () => current === binding };
        // The commit uses only Core-owned closures. Cleanup can reenter after this point.
        const previous = current;
        current = binding;
        revision = Symbol();
        async function inputs(imports?: readonly string[]): Promise<ConsoleInputs> {
            if (!binding.isCurrent()) return rejectTurn(inactive);
            const result = await readConsoleInputs(apps, id => acquireRequestSource(binding, id), imports);
            return binding.isCurrent() ? result : rejectTurn(inactive);
        }
        const turn: ActiveTurn = Object.freeze({
            get isCurrent() { return binding.isCurrent(); },
            invoke(appId: string, request: AppInvocation, timeoutMs?: number, signal?: CancellationSignal) {
                const client = apps.get(appId)?.client.deref();
                if (!binding.isCurrent()) return Promise.resolve(refused(inactive));
                if (!client || !requestAppIsAvailable(binding, appId)) return Promise.resolve(refused(unavailable));
                return client.invoke(request, timeoutMs, turn, signal);
            },
            readConsoleInputs: inputs,
            async inspectRef(address: string, mode: InspectRefMode): Promise<InspectRefResult> {
                if (!binding.isCurrent()) return rejectTurn(inactive);
                const result = await inspectTurnRef(apps, id => acquireRequestSource(binding, id), address, mode);
                return binding.isCurrent() ? result : rejectTurn(inactive);
            },
            release: () => release(binding),
        });
        bindings.set(turn, binding);
        return Object.freeze({ status: 'adopted', turn, cleanupIssues: retire(previous, binding) });
    }

    return Object.freeze({ prepareObservation, adoptTurn,
        locate(turn: ActiveTurn, appId: string) {
            const source = bindings.get(turn)?.apps.get(appId);
            return source && { instanceId: source.instanceId, observationId: source.observationId };
        },
        revokeWindowAccess(turn: ActiveTurn, client: RequestSourceClient, view?: ViewIdentity): Issue | undefined {
            const target = view && { viewId: view.viewId, viewInstanceId: view.viewInstanceId };
            if (!current || bindings.get(turn) !== current) return inactive;
            const authority = authorities.get(client);
            if (!authority) return unavailable;
            authority.revokeWindows(target);
        },
        eligibilityChanged: () => { revision = Symbol(); },
        close: () => { closed = true; return current ? release(current) : noObservationCleanupIssues; },
    });
}
