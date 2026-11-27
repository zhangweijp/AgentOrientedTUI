import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/types.js';
import { currentPublishedSnapshot } from '../snapshot/store.js';
import { canonicalJson, checkWireJson, copyWireJson, isSnapshotDataError, utf8Size } from '../snapshot/json.js';
import { plainConfigObject } from '../snapshot/projection-limits.js';
import { normalizeInteractionLimits, RECEIPT_BYTES } from './interaction-limits.js';
import { RAW_TOOL_ARGUMENT_LIMITS } from '../snapshot/snapshot-support.js';
import type { AppIdentityReader, JsonValue, SnapshotStore } from '../snapshot/types.js';
import { getCapturedToolParameters } from '../tool/tool-parameters.js';
import { prepareViewTypeParameters, type SnapshotValueRefSource } from '../tool/snapshot-value-arguments.js';
import { createObservationOperations, previewCommittedApp, type ObservationState } from './observation-registry.js';
import { acquireRequestSource, registerRequestSource, requestAppIsAvailable, requestSourcesFor,
    type BoundRequestSources, type RefSourceHold, type RequestSourceAuthority } from './request-sources.js';
import { checkCurrentRefScopes, checkRefViews, refPath } from '../tool/ref-path.js';
import type { ObservationWindowSelection, ObservationOptions } from './observation-types.js';
import { exactFields, jsonObject, mapExecutionFact, unknownOutcome, type ExecutionMapping } from './invocation-outcome.js';
import type {
    AppInteractionSource, InvocationRequest, ReceiptOperation, ExecutionBinding, InstanceInteraction, InteractionLimits, InteractionLimitOverrides, InteractionStats,
    CancellationSignal, InvocationContext, InvocationJsonLimits, InvocationReceipt, InvocationSource, Issue, ObserveResult,
    ReceiptAccess, ReceiptMetadata, ReceiptQuery, AppInteractionPolicy, ActiveTurn,
} from './app-interaction-types.js';

const KiB = 1024;
const profile = (maxDepth: number, maxNodes: number, bytes: number): InvocationJsonLimits => Object.freeze({
    maxDepth, maxNodes, maxCanonicalBytes: bytes,
});
const CAPTURE_LIMITS = Object.freeze({
    request: profile(33, 10005, 136 * KiB), rawInput: RAW_TOOL_ARGUMENT_LIMITS,
    metadata: profile(8, 256, 32 * KiB), fact: profile(52, 32032, 520 * KiB), receipt: profile(54, 33000, RECEIPT_BYTES),
});
const MESSAGE = 'The App interaction could not be completed';
class InteractionFailure {
    constructor(readonly code: string, readonly message: string = MESSAGE, readonly path?: string) {}
}
function fail(code: string, message?: string, path?: string): never { throw new InteractionFailure(code, message, path); }
const problem = (error: unknown): Issue => error instanceof InteractionFailure
    ? Object.freeze({ code: error.code, message: error.message, ...(error.path === undefined ? {} : { path: error.path }) })
    : Object.freeze({ code: 'OBSERVATION_INTERNAL_ERROR', message: MESSAGE });
const unavailable = (code: string, message = MESSAGE): ReceiptAccess => Object.freeze({ kind: 'unavailable', code, message });
const waitDeadline = new InteractionFailure('INVOCATION_WAIT_TIMEOUT',
    'Waiting for the invocation receipt timed out. Use readReceipt with the original observationId and invocationId.');
const waitCancelled = new InteractionFailure('INVOCATION_WAIT_CANCELLED',
    'Waiting for the original invocation was cancelled. Read its receipt before retrying.');
function dataProperties(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    const data = plainConfigObject(raw, [...required, ...optional], '$');
    if (required.some(key => !Object.hasOwn(data, key))) throw 0;
    return data;
}
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const validRequestId = (value: unknown): value is string => nonEmpty(value) && utf8Size(value) <= 256;
function capture<T>(raw: unknown, limits: InvocationJsonLimits, code: string): T {
    try { return copyWireJson(raw, limits) as T; }
    catch (error) {
        if (code === 'INVOCATION_INVALID' || code === 'ACTION_INPUT_INVALID') {
            const path = isSnapshotDataError(error) && error.path.length <= 512 ? error.path : '$';
            return fail(code, 'Expected bounded JSON invocation parameters.', path);
        }
        return fail(code);
    }
}
function invalidInvocationJson(error: unknown, code: string): never {
    const path = isSnapshotDataError(error) ? error.path.slice(0, 512) : '$';
    return fail(code, 'Expected bounded JSON invocation parameters.', path);
}
function binding(raw: unknown, kind: InvocationSource['kind']): ExecutionBinding {
    if (raw === null) fail(kind === 'closeView' ? 'VIEW_CLOSE_UNAVAILABLE' : 'TOOL_EXECUTION_UNAVAILABLE');
    try {
        const data = dataProperties(raw, ['identity', 'isLive', 'execute']);
        if (!data.identity || !['object', 'function'].includes(typeof data.identity) ||
            typeof data.isLive !== 'function' || typeof data.execute !== 'function') throw 0;
        return Object.freeze(data) as unknown as ExecutionBinding;
    } catch { return fail('EXECUTION_BINDING_FAILED'); }
}
function sameBinding(a: ExecutionBinding, b: ExecutionBinding): boolean {
    return a.identity === b.identity && a.isLive === b.isLive && a.execute === b.execute;
}
interface Entry {
    readonly fingerprint: string;
    readonly requestSourcesId: symbol | undefined;
    expiresAt?: number;
    metadata: ReceiptMetadata;
    phase: InvocationReceipt['executionPhase'];
    readonly waiters: Set<() => void>;
    admissionWake?: () => void;
    reads: number;
    receiptBytes: number;
    terminalStatus?: ExecutionMapping['outcome']['status'];
    completedAt?: number;
    task?: { request: CapturedInvocation; source: InvocationSource; controller: AbortController; requestSources: BoundRequestSources | undefined };
    readonly deadline?: number;
    admissionIssue?: Issue;
    running: boolean;
    expired: boolean;
    unavailable: boolean;
    receipt?: InvocationReceipt;
}
interface State extends ObservationState {
    policy?: AppInteractionPolicy;
    resolve?: (source: InvocationSource) => ExecutionBinding | null;
    readonly entries: Map<string, Entry>;
    readonly controllers: Set<AbortController>;
    readonly queue: Entry[];
    head?: Entry;
    dispatchIssue?: Issue;
    closing: boolean;
    invocations: number;
    reads: number;
    projects: number;
}
type CapturedInvocation = InvocationRequest;
const EMPTY_INPUT = Object.freeze({});
const EMPTY_REFS = Object.freeze([]) as readonly SnapshotValueRefSource[];

function assembleAppInteraction(store: SnapshotStore & AppIdentityReader, options: Readonly<AppInteractionSource & {
    namespace: string; now: () => number;
    observationLimits?: import('./observation-types.js').ProjectionLimitOverrides;
    limits?: InteractionLimitOverrides;
    refreshProjection?: () => Promise<void>;
    canExposeTools?: () => boolean;
}>) {
    let config: Record<string, unknown>, limits: InteractionLimits, policy: AppInteractionPolicy, resolver: State['resolve'];
    try {
        config = dataProperties(options, ['namespace', 'now', 'appId', 'instanceId', 'policy', 'execution'],
            ['observationLimits', 'limits', 'refreshProjection', 'canExposeTools']);
        if (config.refreshProjection !== undefined && typeof config.refreshProjection !== 'function') throw 0;
        if (config.canExposeTools !== undefined && typeof config.canExposeTools !== 'function') throw 0;
        if (!nonEmpty(config.namespace) || utf8Size(config.namespace) > 128 || typeof config.now !== 'function' ||
            !nonEmpty(config.appId) || !nonEmpty(config.instanceId)) throw 0;
        const p = dataProperties(config.policy, ['project', 'authorize', 'canReadReceipt']);
        const e = dataProperties(config.execution, ['resolve']);
        if (Object.values(p).some(value => typeof value !== 'function') || typeof e.resolve !== 'function') throw 0;
        const service = config.policy as AppInteractionPolicy;
        const project = p.project as AppInteractionPolicy['project'];
        const authorize = p.authorize as AppInteractionPolicy['authorize'];
        const canReadReceipt = p.canReadReceipt as AppInteractionPolicy['canReadReceipt'];
        policy = {
            project: context => project.call(service, context),
            authorize: context => authorize.call(service, context),
            canReadReceipt: (metadata, signal) => canReadReceipt.call(service, metadata, signal),
        };
        resolver = e.resolve as State['resolve'];
    } catch { throw new TypeError('Invalid App interaction configuration'); }
    limits = normalizeInteractionLimits(config.limits);
    const now = config.now as () => number;
    const refreshProjection = config.refreshProjection as typeof options.refreshProjection;
    const canExposeTools = config.canExposeTools as typeof options.canExposeTools;
    let lastNow = -1;
    function clock(): number {
        let value: number;
        try { value = now(); } catch { return fail('OBSERVATION_INTERNAL_ERROR'); }
        if (!Number.isSafeInteger(value) || value < 0 || value < lastNow) fail('OBSERVATION_INTERNAL_ERROR');
        lastNow = value; return value;
    }
    const state: State = { appId: config.appId as string, instanceId: config.instanceId as string,
        policy, resolve: resolver, observations: new Map(), reservations: new Map(),
        entries: new Map(), controllers: new Set(), queue: [], closing: false, invocations: 0, reads: 0, projects: 0 };
    let closed = false;
    let closingInvocation: InteractionStats['closingInvocation'];
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let scheduledExpiry: number | undefined;
    const observations = createObservationOperations(store, { namespace: config.namespace as string,
        limits: config.observationLimits as import('./observation-types.js').ProjectionLimitOverrides | undefined },
        state, refresh);
    const externalHolds = new Set<{ dispatched: boolean; release(): void }>();
    try { clock(); } catch { throw new RangeError('Invalid observation registry clock'); }
    let completeClosed: (() => void) | undefined;
    const closedCompletion = new Promise<void>(resolve => { completeClosed = resolve; });
    function settleClosed(): void {
        if (closed && state.closing && !state.invocations && !state.reads && !state.projects && !externalHolds.size) {
            completeClosed?.(); completeClosed = undefined;
        }
    }
    function dropContent(entry: Entry, expired = false): void {
        entry.receipt = undefined;
        entry.receiptBytes = 0;
        if (expired) entry.expired = true;
    }
    function forget(state: State, entry: Entry): void {
        dropContent(entry);
        if (state.entries.get(entry.metadata.invocationId) === entry) state.entries.delete(entry.metadata.invocationId);
    }
    function clean(state: State): void {
        if (!state.closing || state.invocations || state.reads || state.projects) return;
        for (const entry of state.entries.values()) forget(state, entry);
        state.policy = undefined; state.resolve = undefined;
        settleClosed();
    }
    function revoke(state: State): void {
        if (state.closing) return;
        clearTimeout(expiry);
        expiry = undefined;
        scheduledExpiry = undefined;
        state.closing = true;
        blockDispatch({ code: 'APP_STOPPED', message: 'The App stopped before dispatch.' });
        observations.releaseAll();
        // Borrowed snapshots remain owned by the actual task, including a
        // preparation task that ignores cancellation. Revocation is not release.
        for (const entry of state.entries.values()) if (!entry.running) dropContent(entry);
        for (const controller of state.controllers) controller.abort();
        clean(state);
    }
    function expireEntry(entry: Entry, time: number): void {
        if (entry.running || entry.expiresAt === undefined || time < entry.expiresAt) return;
        dropContent(entry, true);
        if (!state.observations.has(entry.metadata.observationId) && entry.reads === 0)
            forget(state, entry);
    }
    function expireReceipts(time: number): void {
        if (state.closing) return;
        let next: number | undefined;
        for (const entry of state.entries.values()) {
            expireEntry(entry, time);
            if (!entry.running && entry.expiresAt !== undefined && time < entry.expiresAt)
                next = Math.min(next ?? Infinity, entry.expiresAt);
        }
        if (next === scheduledExpiry) return;
        clearTimeout(expiry);
        scheduledExpiry = next;
        expiry = next === undefined ? undefined : setTimeout(() => {
            scheduledExpiry = undefined;
            expiry = undefined;
            try { expireReceipts(clock()); } catch { /* The next valid operation can prune expired receipts. */ }
        }, Math.max(0, next - time));
        const handle: unknown = expiry;
        if (handle && typeof handle === 'object' && 'unref' in handle && typeof handle.unref === 'function') handle.unref();
    }
    function refresh(): number {
        if (!state.closing && !observations.isCurrent()) revoke(state);
        if (state.closing) return lastNow;
        const time = clock();
        expireReceipts(time);
        return time;
    }
    function active(state: State): void {
        refresh(); if (state.closing || closed) fail('APP_INTERACTION_UNAVAILABLE');
    }
    const authority: RequestSourceAuthority = {
        appId: state.appId,
        prepare: observations.prepareAdoption,
        revokeWindows: observations.revokeWindows,
        detach(id) {
            const release = observations.detach(id);
            if (release) return () => { try { release(); } finally { expireReceipts(lastNow); } };
        },
        acquire(observationId) {
            const found = observations.readAdopted(observationId);
            if (found.status === 'rejected') return { issue: found.issue };
            const { source } = found.value;
            const acquired = store.acquire(source.id);
            if (acquired.status === 'rejected') return { issue: acquired.issue };
            const held = {
                dispatched: false,
                release() {
                    if (!externalHolds.delete(held)) return;
                    try { acquired.hold.release(); } finally { settleClosed(); }
                },
            };
            externalHolds.add(held);
            const { appId, instanceId, id: snapshotId } = source;
            return {
                snapshot: source,
                source: { appId, instanceId, snapshotId, observationId, store, visibleRefs: observations.visibleRefs(found.value) },
                ...(refreshProjection ? { refresh: refreshProjection } : {}),
                current() {
                    if (!externalHolds.has(held)) return;
                    const latest = observations.readAdopted(observationId);
                    return latest.status === 'found' ? latest.latest : undefined;
                },
                isRefView(viewId, viewInstanceId) {
                    return externalHolds.has(held) && observations.isRefView(observationId, { viewId, viewInstanceId });
                },
                stillEligible(viewId, viewInstanceId) { return externalHolds.has(held) && observations.stillEligible(observationId, {viewId, viewInstanceId}); },
                markDispatched() { held.dispatched = true; },
                release: held.release,
            };
        },
    };
    function resolve(state: State, source: InvocationSource): ExecutionBinding {
        let value: unknown;
        try { value = state.resolve!(source); } catch { return fail('EXECUTION_BINDING_FAILED'); }
        return binding(value, source.kind);
    }
    function live(current: ExecutionBinding, source: InvocationSource): void {
        let value: unknown;
        try { value = current.isLive(source); }
        catch { return fail('LIVE_BINDING_CHECK_FAILED'); }
        if (typeof value !== 'boolean') fail('LIVE_BINDING_CHECK_FAILED');
        if (!value) fail(source.kind === 'closeView' ? 'VIEW_CLOSE_SOURCE_STALE' : 'TOOL_SOURCE_STALE');
    }
    function captureSource(request: CapturedInvocation) {
        const result = 'kind' in request ? observations.captureClose(request.observationId, request)
            : observations.captureTool(request);
        if (result.status === 'rejected') fail(result.issue.code, result.issue.message, result.issue.path);
        return result;
    }
    function verifySource(request: CapturedInvocation, source: InvocationSource) {
        const current = store.readLatest(state.appId);
        const issue = observations.verifyOperation(request.observationId, source,
            current.status === 'ready' ? current.snapshot : undefined);
        if (issue) fail(issue.code, issue.message, issue.path);
    }
    function checkGate() {
        if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
        if (state.dispatchIssue) fail(state.dispatchIssue.code, state.dispatchIssue.message);
    }
    const deadlineIssue = { code: 'INVOCATION_DEADLINE_EXCEEDED', message: 'Invocation deadline elapsed before dispatch' };
    const cancelIssue = { code: 'INVOCATION_CANCELLED', message: 'Invocation was cancelled before dispatch' };
    const locator = (entry: Entry): ReceiptQuery => Object.freeze({
        observationId: entry.metadata.observationId, invocationId: entry.metadata.invocationId,
    });
    function accessIssue(entry: Entry, issue: Issue, notDispatched = false): ReceiptAccess {
        return Object.freeze({ kind: 'unavailable', code: issue.code, message: issue.message, locator: locator(entry),
            ...(notDispatched ? { executionPhase: 'not-dispatched' as const } : {}) });
    }
    function rejectedMapping(issue: Issue): ExecutionMapping {
        return { executionPhase: 'not-dispatched', outcome: Object.freeze({ status: 'rejected', ...issue }) };
    }
    function notifyAdmission(entry: Entry): void { entry.admissionWake?.(); }
    function expireAdmission(entry: Entry, controller: AbortController, issue: Issue = deadlineIssue): void {
        if (!entry.running || entry.phase !== 'not-dispatched' || entry.admissionIssue) return;
        entry.admissionIssue = issue;
        if (state.queue.includes(entry)) {
            let completedAt: number | undefined;
            try { completedAt = clock(); } catch { /* Keep unexpired index on clock failure. */ }
            finishQueued(entry, completedAt);
        }
        notifyAdmission(entry);
        controller.abort();
    }
    function checkAdmission(entry: Entry, controller: AbortController): void {
        if (state.dispatchIssue) expireAdmission(entry, controller, state.dispatchIssue);
        if (!entry.admissionIssue) {
            const time = clock();
            if (entry.deadline !== undefined && time >= entry.deadline) expireAdmission(entry, controller);
        }
        if (entry.admissionIssue) fail(entry.admissionIssue.code, entry.admissionIssue.message, entry.admissionIssue.path);
    }
    function blockDispatch(issue: Issue): void {
        if (state.dispatchIssue) return;
        state.dispatchIssue = Object.freeze({ ...issue });
        const stopped = [...(state.head ? [state.head] : []), ...state.queue]
            .filter(entry => entry.running && entry.phase === 'not-dispatched');
        // Fix every reason and remove queued inventory before callbacks can reenter.
        const controllers = stopped.map(entry => entry.task?.controller);
        for (const entry of stopped) entry.admissionIssue ??= state.dispatchIssue;
        let completedAt: number | undefined;
        try { completedAt = clock(); } catch { /* No fabricated expiry. */ }
        for (const entry of [...state.queue]) finishQueued(entry, completedAt);
        for (const entry of stopped) notifyAdmission(entry);
        for (const controller of controllers) controller?.abort();
    }
    function pruneQueue(time: number): void {
        for (const entry of [...state.queue]) {
            const observed = state.observations.get(entry.metadata.observationId);
            const source = entry.task?.source;
            const stale = observed && source ? observations.verifyOperation(entry.metadata.observationId, source, currentPublishedSnapshot(observed.source)) : undefined;
            const issue = entry.admissionIssue ?? state.dispatchIssue ??
                (entry.deadline !== undefined && time >= entry.deadline ? deadlineIssue :
                    entry.task?.requestSources && !entry.task.requestSources.isCurrent()
                        ? { code: 'TURN_NOT_ACTIVE', message: 'The original turn is no longer active.' } :
                        state.adoptedObservationId !== entry.metadata.observationId
                            ? { code: 'OBSERVATION_NOT_ADOPTED', message: 'The original observation is no longer adopted.' } : stale);
            if (issue) { entry.admissionIssue = issue; finishQueued(entry, time); }
        }
    }
    function pump(): void {
        if (state.head || state.dispatchIssue || state.closing) return;
        const entry = state.queue.shift();
        if (!entry) return;
        state.head = entry;
        const task = entry.task!;
        // Enter the head only after admission has returned and its original waiter is installed.
        void Promise.resolve().then(() => run(state, entry, task.request, task.source, task.controller, task.requestSources));
    }
    function finishQueued(entry: Entry, time: number | undefined): void {
        const index = state.queue.indexOf(entry);
        if (index < 0) return;
        state.queue.splice(index, 1);
        finishEntry(entry, rejectedMapping(entry.admissionIssue!), time);
        expireReceipts(lastNow);
        // No queued task has entered external code. Defer waiter callbacks until
        // the synchronous new-admission/stop transition is complete.
        queueMicrotask(() => { notifyAdmission(entry); for (const notify of [...entry.waiters]) notify(); clean(state); pump(); });
    }
    function finishEntry(entry: Entry, mapping: ExecutionMapping, completedAt: number | undefined): void {
        if (!entry.running) return;
        entry.phase = mapping.executionPhase;
        entry.terminalStatus = mapping.outcome.status;
        if (completedAt !== undefined) {
            entry.completedAt = completedAt;
            const expiresAt = completedAt + limits.receiptTtlMs;
            if (Number.isSafeInteger(expiresAt)) entry.expiresAt = expiresAt;
        }
        try {
            if (entry.expiresAt === undefined || state.closing) fail('RESULT_UNAVAILABLE');
            const receipt = makeReceipt(entry, mapping, entry.completedAt!);
            entry.receiptBytes = utf8Size(canonicalJson(receipt as unknown as JsonValue));
            entry.receipt = receipt;
        } catch { entry.unavailable = true; }
        const task = entry.task;
        if (task) state.controllers.delete(task.controller);
        delete entry.task;
        entry.running = false;
        state.invocations--;
        if (state.head === entry) delete state.head;
    }
    function makeReceipt(entry: Entry, mapping: ExecutionMapping, completedAt: number) {
        const expiresAt = completedAt + limits.receiptTtlMs;
        if (!Number.isSafeInteger(expiresAt)) fail('RESULT_UNAVAILABLE');
        const { invocationId, observationId, operation, source } = entry.metadata;
        return capture<InvocationReceipt>({ invocationId, observationId, operation, source, completedAt, expiresAt,
            executionPhase: mapping.executionPhase, outcome: mapping.outcome }, CAPTURE_LIMITS.receipt, 'RESULT_UNAVAILABLE');
    }
    async function run(state: State, entry: Entry, request: CapturedInvocation, source: InvocationSource, controller: AbortController,
        requestSources: BoundRequestSources | undefined): Promise<void> {
        let release: (() => void) | undefined;
        const foreign = new Map<string, RefSourceHold>();
        let mapping: ExecutionMapping = { executionPhase: 'not-dispatched', outcome: unknownOutcome() };
        try {
            checkAdmission(entry, controller);
            if (requestSources && !requestAppIsAvailable(requestSources, state.appId)) fail('TURN_NOT_ACTIVE');
            const rawInput = 'kind' in request ? EMPTY_INPUT : request.input;
            try { checkWireJson(rawInput, CAPTURE_LIMITS.rawInput); }
            catch (error) { invalidInvocationJson(error, 'ACTION_INPUT_INVALID'); }
            active(state);
            verifySource(request, source);
            const selected = captureSource(request);
            const acquired = store.acquire(source.snapshotId);
            if (acquired.status === 'rejected') fail(acquired.issue.code);
            const snapshot = acquired.hold.snapshot;
            if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) { acquired.hold.release(); fail('SNAPSHOT_INVALID'); }
            release = acquired.hold.release;
            const initial = resolve(state, source);
            let effectiveInput: Readonly<Record<string, JsonValue>> = EMPTY_INPUT;
            let refSources: readonly SnapshotValueRefSource[] = EMPTY_REFS;
            if (source.kind === 'tool') {
                const contract = getCapturedToolParameters(source.tool.inputSchema);
                if (!contract) fail('REF_CONTRACT_UNSUPPORTED');
                const prepared = prepareViewTypeParameters(store, source, contract, rawInput, selected.visibleRefs, request.observationId,
                    requestSources && (appId => {
                        const held = acquireRequestSource(requestSources, appId);
                        if (!held || 'issue' in held) return held;
                        foreign.set(appId, held);
                        return held.source;
                    }));
                if (prepared.status === 'rejected') fail(prepared.issue.code, prepared.issue.message, prepared.issue.path);
                effectiveInput = prepared.effectiveArgs;
                refSources = prepared.refSources;
            }
            const byApp = new Map<string, SnapshotValueRefSource[]>();
            for (const ref of refSources) {
                const group = byApp.get(ref.appId);
                if (group) group.push(ref);
                else byApp.set(ref.appId, [ref]);
            }
            const refreshes: Array<() => Promise<void>> = [];
            if (refreshProjection) refreshes.push(async () => {
                try { await refreshProjection(); }
                catch {
                    verifySource(request, source);
                    fail(source.kind === 'closeView' ? 'VIEW_CLOSE_UNAVAILABLE' : 'TOOL_EXECUTION_UNAVAILABLE', 'The current App projection could not be confirmed.');
                }
            });
            for (const [id, hold] of foreign) {
                if (hold.refresh) refreshes.push(async () => {
                    try { await hold.refresh!(); }
                    catch {
                        const ref = byApp.get(id)![0]!;
                        fail('REF_VIEW_UNAVAILABLE', 'The current Ref source could not be confirmed.', refPath(ref.param, ref.index));
                    }
                });
            }
            function recheck(): void {
                checkAdmission(entry, controller);
                if (requestSources && !requestSources.isCurrent()) fail('TURN_NOT_ACTIVE');
                verifySource(request, source);
                if (requestSources && !requestAppIsAvailable(requestSources, state.appId)) fail('TOOL_SOURCE_STALE');
                for (const [appId, refs] of byApp) {
                    const external = foreign.get(appId);
                    const local = !external ? store.readLatest(state.appId) : undefined;
                    const latest = external?.current() ?? (local?.status === 'ready' ? local.snapshot : undefined);
                    if (!latest) fail('REF_VIEW_UNAVAILABLE', 'The original Ref source is no longer available for this request.',
                        refPath(refs[0]!.param, refs[0]!.index));
                    const issue = checkRefViews(refs, (id, instanceId) =>
                        latest.views.some(view => view.id === id && view.viewInstanceId === instanceId) &&
                        (external ? external.isRefView(id, instanceId)
                            : observations.isRefView(request.observationId, { viewId: id, viewInstanceId: instanceId })));
                    if (issue) fail(issue.code, issue.message, issue.path);
                    const scope = checkCurrentRefScopes(refs, source.receiver, latest, !external);
                    if (scope) fail(scope.code, scope.message, scope.path);
                }
                const latest = resolve(state, source);
                if (!sameBinding(initial, latest)) fail(source.kind === 'closeView' ? 'VIEW_CLOSE_SOURCE_STALE' : 'TOOL_SOURCE_STALE');
                live(latest, source);
            }
            async function refreshAll() {
                await Promise.allSettled(refreshes.map(async check => {
                    try { await check(); } catch (error) { expireAdmission(entry, controller, problem(error)); }
                }));
                checkAdmission(entry, controller);
            }
            if (refreshes.length) await refreshAll();
            recheck();
            const context: InvocationContext = Object.freeze({ invocationId: request.invocationId, observationId: request.observationId,
                source, rawInput, effectiveInput, refSources, signal: controller.signal });
            let authorized: unknown;
            try { authorized = await state.policy!.authorize(context); } catch { return fail(source.kind === 'closeView' ? 'VIEW_CLOSE_AUTHORIZATION_FAILED' : 'TOOL_AUTHORIZATION_FAILED'); }
            checkAdmission(entry, controller);
            if (authorized === true && refreshes.length) await refreshAll();
            recheck();
            if (authorized !== true) fail(source.kind === 'closeView' ? 'VIEW_CLOSE_PERMISSION_DENIED' : 'TOOL_PERMISSION_DENIED');
            checkAdmission(entry, controller);
            if (requestSources && !requestAppIsAvailable(requestSources, state.appId)) fail('TURN_NOT_ACTIVE');
            // Final synchronous gate after all externally callable checks.
            if (entry.admissionIssue || controller.signal.aborted) fail(entry.admissionIssue?.code ?? 'INVOCATION_CANCELLED');
            if (requestSources && !requestSources.isCurrent()) fail('TURN_NOT_ACTIVE');
            const current = currentPublishedSnapshot(snapshot);
            const originalIssue = observations.verifyOperation(request.observationId, source, current);
            if (originalIssue) fail(originalIssue.code, originalIssue.message, originalIssue.path);
            for (const [id, refs] of byApp) {
                const hold = foreign.get(id), original = hold?.snapshot ?? snapshot;
                const latest = currentPublishedSnapshot(original);
                if (!latest || latest.admissionSinceRevision !== original.admissionSinceRevision)
                    fail('REF_VIEW_UNAVAILABLE', 'The original Ref admission period ended.', refPath(refs[0]!.param, refs[0]!.index));
                const revoked = checkRefViews(refs, (viewId, viewInstanceId) => hold
                    ? hold.stillEligible(viewId, viewInstanceId)
                    : observations.stillEligible(request.observationId, {viewId, viewInstanceId}));
                if (revoked) fail(revoked.code, revoked.message, revoked.path);
                const scope = checkCurrentRefScopes(refs, source.receiver, latest, !hold);
                if (scope) fail(scope.code, scope.message, scope.path);
            }
            for (const source of foreign.values()) source.markDispatched();
            entry.phase = 'unknown'; // The business adapter may have entered from this point onward.
            try { mapping = mapExecutionFact(await initial.execute(context), CAPTURE_LIMITS.fact, source.kind); }
            catch { mapping = { executionPhase: 'unknown', outcome: unknownOutcome() }; }
        } catch (error) {
            mapping = entry.phase === 'not-dispatched' ? { executionPhase: 'not-dispatched',
                outcome: Object.freeze({ status: 'rejected', ...(entry.admissionIssue ?? problem(error)) }) }
                : { executionPhase: 'unknown', outcome: unknownOutcome() };
        } finally {
            if (state.closing && entry.phase !== 'not-dispatched') {
                const { observationId, invocationId } = entry.metadata;
                closingInvocation = Object.freeze({ observationId, invocationId, executionPhase: mapping.executionPhase,
                    status: mapping.outcome.status });
            }
            for (const source of foreign.values()) try { source.release(); } catch { /* Other holds still need release. */ }
            try { release?.(); } catch { /* Preserve the original operation's settlement. */ }
            let completedAt: number | undefined;
            try { completedAt = clock(); } catch { /* No fabricated expiry on an invalid clock. */ }
            finishEntry(entry, mapping, completedAt);
            expireReceipts(lastNow);
            for (const notify of [...entry.waiters]) notify();
            clean(state);
            pump();
        }
    }

    function checkReceiptAccess(state: State, entry: Entry, deadline?: number): void {
        if (state.closing || closed) fail('APP_INTERACTION_UNAVAILABLE');
        try { active(state); } catch (error) {
            if (entry.unavailable && !state.closing && problem(error).code === 'OBSERVATION_INTERNAL_ERROR') fail('RESULT_UNAVAILABLE');
            throw error;
        }
        if (deadline !== undefined && lastNow >= deadline) throw waitDeadline;
        if (entry.expired) fail('RESULT_EXPIRED');
        if (entry.unavailable || !entry.receipt) fail('RESULT_UNAVAILABLE');
    }
    async function permitted(state: State, entry: Entry, controller: AbortController, check: () => void): Promise<void> {
        let allowed: unknown;
        try { allowed = await state.policy!.canReadReceipt(entry.metadata, controller.signal); }
        catch { check(); return fail('RECEIPT_READ_FAILED'); }
        check();
        if (allowed !== true) fail('RECEIPT_PERMISSION_DENIED');
    }
    function admitRead(state: State, entry: Entry): AbortController {
        if (state.reads >= limits.maxReads) fail('RECEIPT_READ_CAPACITY');
        const controller = new AbortController(); state.controllers.add(controller); state.reads++; entry.reads++;
        return controller;
    }
    function waitForTerminal(entry: Entry, deadline?: number, admission?: AbortController, signal?: CancellationSignal): Promise<boolean> {
        if (admission && entry.admissionIssue) return Promise.resolve(false);
        if (!entry.running) return Promise.resolve(true);
        const delay = deadline === undefined ? undefined : Math.max(0, deadline - lastNow);
        return new Promise(resolve => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let ended = false;
            const settle = (settled: boolean) => {
                if (ended) return;
                ended = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                entry.waiters.delete(done);
                if (admission && entry.admissionWake === wake) delete entry.admissionWake;
                resolve(settled);
            };
            const done = () => settle(true);
            const wake = () => settle(false);
            const cancel = () => { if (admission) expireAdmission(entry, admission, cancelIssue); settle(false); };
            const timedOut = () => { if (admission) expireAdmission(entry, admission); settle(false); };
            if (signal?.aborted) { cancel(); return; }
            if (delay === 0) { timedOut(); return; }
            timer = delay === undefined ? undefined : setTimeout(timedOut, delay);
            entry.waiters.add(done);
            if (admission) entry.admissionWake = wake;
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) cancel();
            else if (admission && entry.admissionIssue) wake();
        });
    }
    async function read(state: State, entry: Entry, controller: AbortController, deadline?: number, admission?: AbortController,
        signal?: CancellationSignal): Promise<ReceiptAccess> {
        let permission: Promise<void> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let removeCancel: (() => void) | undefined;
        try {
            const settled = await waitForTerminal(entry, deadline, admission, signal);
            const expiredAdmission = admission && entry.admissionIssue;
            if (expiredAdmission) return accessIssue(entry, expiredAdmission, true);
            if (!settled) {
                throw signal?.aborted ? waitCancelled : waitDeadline;
            }
            if (signal?.aborted) throw waitCancelled;
            const check = () => checkReceiptAccess(state, entry, deadline);
            check();
            permission = permitted(state, entry, controller, check);
            const exits = [permission];
            if (deadline !== undefined) exits.push(new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(waitDeadline), deadline - lastNow);
            }));
            if (signal) exits.push(new Promise<never>((_, reject) => {
                const cancel = () => reject(waitCancelled);
                removeCancel = () => signal.removeEventListener('abort', cancel);
                signal.addEventListener('abort', cancel, { once: true });
                if (signal.aborted) cancel();
            }));
            await Promise.race(exits);
            check();
            return Object.freeze({ kind: 'receipt', receipt: entry.receipt!, locator: locator(entry) });
        } catch (error) {
            if (error === waitDeadline || error === waitCancelled) controller.abort();
            const { code, message } = problem(error);
            return accessIssue(entry, { code, message });
        }
        finally {
            clearTimeout(timer);
            removeCancel?.();
            const release = () => {
                state.reads--; entry.reads--;
                state.controllers.delete(controller);
                try { expireEntry(entry, clock()); } catch { /* Do not forget using an invalid clock. */ }
                clean(state);
            };
            // Ending the observer's wait does not end its Host permission callback.
            if (permission) void permission.then(release, release);
            else release();
        }
    }
    function capturedRequest(raw: unknown) {
        let request: CapturedInvocation;
        try { request = copyWireJson(raw, CAPTURE_LIMITS.request) as unknown as CapturedInvocation; }
        catch (error) { return invalidInvocationJson(error, 'INVOCATION_INVALID'); }
        if (!jsonObject(request) || ![request.invocationId, request.observationId].every(validRequestId)) fail('INVOCATION_INVALID');
        if ('kind' in request) {
            if (request.kind !== 'closeView' || !exactFields(request, ['kind','invocationId','observationId','viewId','viewInstanceId']) ||
                !validRequestId(request.viewId) || !validRequestId(request.viewInstanceId)) fail('INVOCATION_INVALID');
        } else {
            const fields = ['invocationId', 'observationId', 'toolId', 'input'];
            if (!exactFields(request, request.viewId === undefined ? fields : [...fields, 'viewId']) ||
                !nonEmpty(request.toolId) || !jsonObject(request.input) ||
                (request.viewId !== undefined && typeof request.viewId !== 'string')) fail('INVOCATION_INVALID');
        }
        return request;
    }

    function deadline(timeoutMs: number | undefined, now: number): number | undefined {
        if (timeoutMs === undefined) return;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isSafeInteger(now + timeoutMs))
            fail('INVOCATION_INVALID');
        return now + timeoutMs;
    }

    function findEntry(request: CapturedInvocation, fingerprint: string, requestSourcesId: symbol | undefined): Entry | undefined {
        const entry = state.entries.get(request.invocationId);
        if (entry && (entry.fingerprint !== fingerprint || entry.requestSourcesId !== requestSourcesId))
            fail('INVOCATION_ID_CONFLICT', 'This call ID is already bound to different input or a different request.');
        return entry;
    }

    function readReceipt(raw: unknown, timeoutMs?: number): Promise<ReceiptAccess> {
        try {
            const end = deadline(timeoutMs, refresh());
            if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
            const query = capture<ReceiptQuery>(raw, CAPTURE_LIMITS.request, 'INVOCATION_INVALID');
            if (!jsonObject(query) || !exactFields(query, ['observationId', 'invocationId']) ||
                !validRequestId(query.observationId) || !validRequestId(query.invocationId)) fail('INVOCATION_INVALID');
            const entry = state.entries.get(query.invocationId);
            if (!entry || entry.metadata.observationId !== query.observationId) fail('RESULT_UNAVAILABLE');
            if (entry.expired) return Promise.resolve(accessIssue(entry, { code: 'RESULT_EXPIRED', message: MESSAGE }));
            try { return read(state, entry, admitRead(state, entry), end); }
            catch (error) { return Promise.resolve(accessIssue(entry, problem(error))); }
        } catch (error) { return Promise.resolve(unavailable(problem(error).code)); }
    }

    function capacity(path: keyof InteractionLimits, message: string): never {
        return fail('INVOCATION_CAPACITY', message, 'interactionLimits.' + path);
    }
    function bodies() {
        let receiptContents = 0, receiptBytes = 0, receiptReservations = 0;
        for (const entry of state.entries.values()) {
            if (entry.running) receiptReservations++;
            if (entry.receipt) { receiptContents++; receiptBytes += entry.receiptBytes; }
        }
        return { receiptContents, receiptBytes, receiptReservations, receiptReservedBytes: receiptReservations * RECEIPT_BYTES };
    }
    function invoke(raw: unknown, timeoutMs?: number, token?: ActiveTurn, signal?: CancellationSignal): Promise<import('./app-interaction-types.js').InvokeResult> {
        try {
            const request = capturedRequest(raw);
            const requestSources = token === undefined ? undefined : requestSourcesFor(token, authority, request.observationId);
            if ((token !== undefined || 'kind' in request) && !requestSources) fail('TURN_SELECTION_INVALID', 'The target observation must belong to the active turn.');
            if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
            let time: number;
            let timeError: unknown;
            try { time = refresh(); } catch (error) { timeError = error; time = lastNow; }
            if (timeError !== undefined && !state.entries.has(request.invocationId)) throw timeError;
            const selected = captureSource(request);
            const source = selected.source;
            const fingerprint = canonicalJson({ request, operation: source.kind, receiver: source.receiver } as unknown as JsonValue);
            if (utf8Size(fingerprint) > CAPTURE_LIMITS.request.maxCanonicalBytes) fail('INVOCATION_INVALID', 'Invocation fingerprint exceeds its fixed limit.');
            function repeat(found: Entry, end?: number): Promise<ReceiptAccess> {
                if (signal?.aborted) return Promise.resolve(accessIssue(found, waitCancelled));
                if (found.expired) return Promise.resolve(accessIssue(found, { code: 'RESULT_EXPIRED', message: MESSAGE }));
                try { return read(state, found, admitRead(state, found), end, undefined, signal); }
                catch (error) { return Promise.resolve(accessIssue(found, problem(error))); }
            }
            let found = findEntry(request, fingerprint, requestSources?.identity);
            if (timeError !== undefined) {
                if (found && !found.running && found.unavailable) return Promise.resolve(accessIssue(found, {code:'RESULT_UNAVAILABLE',message:MESSAGE}));
                throw timeError;
            }
            if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
            const end = deadline(timeoutMs, time);
            found = findEntry(request, fingerprint, requestSources?.identity);
            if (found) return repeat(found, end);
            if (signal?.aborted) fail(cancelIssue.code, cancelIssue.message);
            checkGate();
            verifySource(request, source);
            // Synchronous original-source lookup can call an injected store/clock.
            // Recheck registration and the original source after those boundaries.
            found = findEntry(request, fingerprint, requestSources?.identity);
            if (found) return repeat(found, end);
            checkGate();
            if (requestSources && !requestSources.isCurrent()) fail('TURN_NOT_ACTIVE');
            if (signal?.aborted) fail(cancelIssue.code, cancelIssue.message);
            const observed = state.observations.get(request.observationId);
            if (!observed || state.adoptedObservationId !== request.observationId || observed.source.id !== selected.snapshotId)
                fail('OBSERVATION_UNAVAILABLE');
            const originalIssue = observations.verifyOperation(request.observationId, source, currentPublishedSnapshot(observed.source));
            if (originalIssue) fail(originalIssue.code, originalIssue.message, originalIssue.path);
            pruneQueue(lastNow);
            if (state.invocations >= limits.maxPendingInvocations)
                capacity('maxPendingInvocations', 'The App invocation queue is full.');
            const currentCount = [...state.entries.values()].filter(entry => entry.metadata.observationId === request.observationId).length;
            if (currentCount >= limits.maxEntriesPerScope)
                capacity('maxEntriesPerScope', 'The current observation has reached its call limit.');
            if (state.entries.size >= limits.maxEntries)
                capacity('maxEntries', 'Retained call history is full.');
            if (state.reads >= limits.maxReads) fail('RECEIPT_READ_CAPACITY', undefined, 'interactionLimits.maxReads');
            const budget = bodies();
            if (budget.receiptContents + budget.receiptReservations + 1 > limits.maxReceiptContents)
                capacity('maxReceiptContents', 'Receipt content capacity is full.');
            if (budget.receiptBytes + budget.receiptReservedBytes + RECEIPT_BYTES > limits.maxReceiptBytes)
                capacity('maxReceiptBytes', 'Receipt byte capacity is full.');
            const initial = capture<ReceiptMetadata>({ appId: state.appId, instanceId: state.instanceId,
                invocationId: request.invocationId, observationId: request.observationId,
                operation: source.kind === 'closeView' ? { kind: 'closeView', viewType: source.viewType, receiver: source.receiver } satisfies ReceiptOperation :
                    { kind: 'tool', toolId: source.tool.id, ...(!('kind' in request) && request.viewId !== undefined ? {viewId: request.viewId} : {}) } satisfies ReceiptOperation,
                source: observed.observation.source }, CAPTURE_LIMITS.metadata, 'INVOCATION_CAPACITY');
            const controller = new AbortController(), readController = new AbortController();
            const entry: Entry = { fingerprint, requestSourcesId: requestSources?.identity, metadata: initial,
                phase: 'not-dispatched', waiters: new Set(), ...(end === undefined ? {} : { deadline: end }),
                running: true, expired: false, unavailable: false, reads: 1, receiptBytes: 0,
                task: {request, source, controller, requestSources} };
            state.entries.set(request.invocationId, entry);
            state.controllers.add(controller); state.controllers.add(readController);
            state.invocations++; state.reads++;
            state.queue.push(entry);
            const waiting = read(state, entry, readController, end, controller, signal);
            pump();
            return waiting;
        } catch (error) { return Promise.resolve(Object.freeze({ kind: 'refused', ...problem(error) })); }
    }

    async function observe(options?: ObservationOptions): Promise<ObserveResult> {
        let controller: AbortController | undefined, token: import('./observation-types.js').ReservationHandle | undefined;
        try {
            active(state);
            if (state.projects || state.observations.size > (state.adoptedObservationId ? 1 : 0))
                fail('OBSERVATION_CAPACITY', 'Release or adopt the prepared observation before preparing another.');
            const captured = observations.captureOptions(options);
            if (captured.status === 'rejected') return captured;
            const reserved = observations.begin();
            if (reserved.status === 'rejected') return reserved;
            token = reserved.reservation; controller = new AbortController(); state.controllers.add(controller); state.projects++;
            const grant = await state.policy!.project(Object.freeze({ source: reserved.source, signal: controller.signal }));
            return observations.complete(token, grant, canExposeTools, captured.options);
        } catch (error) { return Object.freeze({ status: 'rejected', issue: problem(error) }); }
        finally {
            if (token) observations.abandon(token);
            if (controller) {
                state.controllers.delete(controller); state.projects--;
            }
            clean(state);
        }
    }
    function stats(error?: unknown): InteractionStats {
        const observationStats = observations.stats(error);
        return Object.freeze({ closed, activeInvocations: state.invocations, activeReads: state.reads, receiptEntries: state.entries.size,
            ...bodies(), queuedInvocations: state.queue.length,
            fingerprintBytes: [...state.entries.values()].reduce((sum, entry) => sum + utf8Size(entry.fingerprint), 0),
            metadataBytes: [...state.entries.values()].reduce((sum, entry) => sum + utf8Size(canonicalJson(entry.metadata as unknown as JsonValue)), 0),
            borrowedSnapshots: externalHolds.size,
            observations: observationStats, ...(closingInvocation ? { closingInvocation } : {}),
            ...(error === undefined ? {} : { issue: problem(error) }) });
    }
    function inspect() { try { refresh(); return stats(); } catch (error) { return stats(error); } }
    const interaction = Object.freeze({
        observe, invoke, readReceipt, inspect,
        async preview() {
            try { active(state); return previewCommittedApp(store, state.appId, state.instanceId); }
            catch (error) { return Object.freeze({ status: 'rejected' as const, issue: problem(error) }); }
        },
        adoptObservation(observationId: string, windows?: ObservationWindowSelection) {
            const result = observations.adoptObservation(observationId, windows);
            if (result.status === 'adopted') expireReceipts(lastNow);
            return result;
        },
        releaseObservation(observationId: string): void {
            observations.releaseObservation(observationId);
            try { refresh(); } catch { /* Explicit release remains possible with a failed clock. */ }
        },
        close() {
            closed = true;
            revoke(state);
            settleClosed();
            return stats();
        },
        whenClosed() { return closedCompletion; },
    });
    registerRequestSource(interaction, authority);
    return Object.freeze({ interaction, control: Object.freeze({ blockDispatch, readStats: () => stats() }) });
}

export function createAppInteraction(store: Parameters<typeof assembleAppInteraction>[0],
    options: Parameters<typeof assembleAppInteraction>[1]): InstanceInteraction {
    return assembleAppInteraction(store, options).interaction;
}

export function createHostedAppInteraction(store: Parameters<typeof assembleAppInteraction>[0],
    options: Parameters<typeof assembleAppInteraction>[1]) {
    return assembleAppInteraction(store, options);
}
