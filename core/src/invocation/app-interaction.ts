import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/types.js';
import { canonicalJson, checkWireJson, copyWireJson, isSnapshotDataError, utf8Size } from '../snapshot/json.js';
import { plainConfigObject } from '../snapshot/projection-limits.js';
import { RAW_TOOL_ARGUMENT_LIMITS } from '../snapshot/snapshot-support.js';
import type { AppIdentityReader, JsonValue, SnapshotStore } from '../snapshot/types.js';
import { getCapturedToolParameters } from '../tool/tool-parameters.js';
import { prepareViewTypeParameters, type SnapshotValueRefSource } from '../tool/snapshot-value-arguments.js';
import { createObservationOperations, previewCommittedApp, type ObservationState } from './observation-registry.js';
import { acquireRequestSource, registerRequestSource, requestAppIsAvailable, requestSourcesFor,
    type BoundRequestSources, type RefSourceHold, type RequestSourceAuthority } from './request-sources.js';
import { checkCurrentRefScopes, checkRefViews, refPath } from '../tool/ref-path.js';
import type { ObservationWindowSelection } from './observation-types.js';
import { exactFields, jsonObject, mapExecutionFact, unknownOutcome, type ExecutionMapping } from './invocation-outcome.js';
import type {
    AppInteractionSource, AppInvocation, ExecutionBinding, InstanceInteraction, InteractionLimits, InteractionLimitOverrides, InteractionStats,
    CancellationSignal, InvocationContext, InvocationJsonLimits, InvocationReceipt, InvocationSource, Issue, ObserveResult,
    ReceiptAccess, ReceiptMetadata, ReceiptQuery, AppInteractionPolicy, ActiveTurn,
} from './app-interaction-types.js';

const KiB = 1024;
// 32 entries cap retained receipt content at 17.5 MiB of encoded JSON, plus bounded fingerprints and identity metadata.
const profile = (maxDepth: number, maxNodes: number, bytes: number): InvocationJsonLimits => Object.freeze({
    maxDepth, maxNodes, maxCanonicalBytes: bytes,
});
export const DEFAULT_INTERACTION_LIMITS: InteractionLimits = Object.freeze({
    maxReceiptsPerObservation: 32, maxReceipts: 32, maxReads: 8, receiptTtlMs: 60_000,
    request: profile(33, 10005, 136 * KiB), rawInput: RAW_TOOL_ARGUMENT_LIMITS,
    metadata: profile(8, 256, 32 * KiB), fact: profile(52, 32032, 520 * KiB), receipt: profile(54, 33000, 560 * KiB),
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
function binding(raw: unknown): ExecutionBinding {
    if (raw === null) fail('TOOL_EXECUTION_UNAVAILABLE');
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
    closing: boolean;
    invocations: number;
    reads: number;
    projects: number;
}
type CapturedInvocation = Omit<AppInvocation, 'input'> & { readonly input: Readonly<Record<string, JsonValue>> };

export function createAppInteraction(store: SnapshotStore & AppIdentityReader, options: Readonly<AppInteractionSource & {
    namespace: string; now: () => number;
    observationLimits?: import('./observation-types.js').ProjectionLimitOverrides;
    limits?: InteractionLimitOverrides;
    refreshProjection?: () => Promise<void>;
    canExposeTools?: () => boolean;
}>): InstanceInteraction {
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
        const overrides = config.limits === undefined ? {} : dataProperties(config.limits, [], Object.keys(DEFAULT_INTERACTION_LIMITS));
        const effective: Record<string, number | InvocationJsonLimits> = {};
        for (const [key, hard] of Object.entries(DEFAULT_INTERACTION_LIMITS)) {
            if (typeof hard === 'number') {
                const value = overrides[key] === undefined ? hard : overrides[key];
                if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > hard) throw 0;
                effective[key] = value as number;
            } else {
                const lower = overrides[key] === undefined ? {} : dataProperties(overrides[key], [], Object.keys(hard));
                const p = { ...hard };
                for (const field of Object.keys(hard) as (keyof InvocationJsonLimits)[]) {
                    const value = lower[field] === undefined ? hard[field] : lower[field];
                    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > hard[field]) throw 0;
                    Object.assign(p, { [field]: value });
                }
                effective[key] = Object.freeze(p);
            }
        }
        limits = Object.freeze(effective) as unknown as InteractionLimits;
    } catch { throw new TypeError('Invalid App interaction configuration'); }
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
        entries: new Map(), controllers: new Set(), closing: false, invocations: 0, reads: 0, projects: 0 };
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
        if (expired) entry.expired = true;
    }
    function forget(state: State, entry: Entry): void {
        dropContent(entry);
        state.entries.delete(entry.metadata.invocationId);
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
        state.closing = true; observations.releaseAll();
        // Closing a publisher must not wait on another App's pending Host authorization.
        for (const held of externalHolds) if (!held.dispatched) {
            try { held.release(); } catch { /* Revocation still applies to the remaining sources. */ }
        }
        for (const entry of state.entries.values()) if (!entry.running) dropContent(entry);
        for (const controller of state.controllers) controller.abort();
        clean(state);
    }
    function expireReceipts(time: number): void {
        if (state.closing) return;
        let next: number | undefined;
        for (const entry of state.entries.values()) {
            if (entry.running || entry.expiresAt === undefined) continue;
            if (time >= entry.expiresAt) {
                if (entry.metadata.observationId === state.adoptedObservationId) dropContent(entry, true);
                else forget(state, entry);
            } else next = Math.min(next ?? Infinity, entry.expiresAt);
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
                markDispatched() { held.dispatched = true; },
                release: held.release,
            };
        },
    };
    function resolve(state: State, source: InvocationSource): ExecutionBinding {
        let value: unknown;
        try { value = state.resolve!(source); } catch { return fail('EXECUTION_BINDING_FAILED'); }
        return binding(value);
    }
    function live(current: ExecutionBinding, source: InvocationSource): void {
        let value: unknown;
        try { value = current.isLive(source); }
        catch { return fail('LIVE_BINDING_CHECK_FAILED'); }
        if (typeof value !== 'boolean') fail('LIVE_BINDING_CHECK_FAILED');
        if (!value) fail('TOOL_SOURCE_STALE');
    }
    function sourceFor(state: State, request: CapturedInvocation) {
        active(state);
        const result = observations.resolveTool({ observationId: request.observationId, toolId: request.toolId, viewId: request.viewId });
        if (result.status === 'rejected') fail(result.issue.code, result.issue.message, result.issue.path);
        return result;
    }
    const deadlineIssue = { code: 'INVOCATION_DEADLINE_EXCEEDED', message: 'Invocation deadline elapsed before dispatch' };
    const cancelIssue = { code: 'INVOCATION_CANCELLED', message: 'Invocation was cancelled before dispatch' };
    function expireAdmission(entry: Entry, controller: AbortController, issue = deadlineIssue): void {
        if (!entry.running || entry.phase !== 'not-dispatched' || entry.admissionIssue) return;
        entry.admissionIssue = issue;
        controller.abort();
    }
    function checkAdmission(entry: Entry, controller: AbortController): void {
        if (entry.deadline !== undefined && clock() >= entry.deadline) expireAdmission(entry, controller);
        if (entry.admissionIssue) fail(entry.admissionIssue.code, entry.admissionIssue.message);
    }
    function makeReceipt(entry: Entry, mapping: ExecutionMapping, completedAt: number) {
        const expiresAt = completedAt + limits.receiptTtlMs;
        if (!Number.isSafeInteger(expiresAt)) fail('RESULT_UNAVAILABLE');
        const { invocationId, observationId, toolId, source } = entry.metadata;
        return capture<InvocationReceipt>({ invocationId, observationId, toolId, source, completedAt, expiresAt,
            executionPhase: mapping.executionPhase, outcome: mapping.outcome }, limits.receipt, 'RESULT_UNAVAILABLE');
    }
    async function run(state: State, entry: Entry, request: CapturedInvocation, controller: AbortController,
        requestSources: BoundRequestSources | undefined): Promise<void> {
        let release: (() => void) | undefined;
        const foreign = new Map<string, RefSourceHold>();
        let mapping: ExecutionMapping = { executionPhase: 'not-dispatched', outcome: unknownOutcome() };
        try {
            checkAdmission(entry, controller);
            if (requestSources && !requestAppIsAvailable(requestSources, state.appId)) fail('TURN_NOT_ACTIVE');
            try { checkWireJson(request.input, limits.rawInput); }
            catch (error) { invalidInvocationJson(error, 'ACTION_INPUT_INVALID'); }
            const selected = sourceFor(state, request);
            const acquired = store.acquire(selected.snapshotId);
            if (acquired.status === 'rejected') fail(acquired.issue.code);
            const snapshot = acquired.hold.snapshot;
            if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) { acquired.hold.release(); fail('SNAPSHOT_INVALID'); }
            release = acquired.hold.release;
            entry.metadata = capture<ReceiptMetadata>({ ...entry.metadata, source: {
                appId: snapshot.appId, instanceId: snapshot.instanceId, snapshotId: snapshot.id, revision: snapshot.revision,
            } }, limits.metadata, 'INVOCATION_CAPACITY');
            const source: InvocationSource = Object.freeze({ appId: state.appId, instanceId: state.instanceId,
                snapshotId: snapshot.id, tool: selected.tool, receiver: selected.receiver });
            const contract = getCapturedToolParameters(source.tool.inputSchema);
            if (!contract) fail('REF_CONTRACT_UNSUPPORTED');
            const initial = resolve(state, source);
            const prepared = prepareViewTypeParameters(store, source, contract, request.input, selected.visibleRefs, request.observationId,
                requestSources && (appId => {
                    const held = acquireRequestSource(requestSources, appId);
                    if (!held || 'issue' in held) return held;
                    foreign.set(appId, held);
                    return held.source;
                }));
            if (prepared.status === 'rejected') fail(prepared.issue.code, prepared.issue.message, prepared.issue.path);
            const { effectiveArgs: effectiveInput, refSources } = prepared;
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
                    sourceFor(state, request);
                    fail('TOOL_EXECUTION_UNAVAILABLE', 'The current App projection could not be confirmed.');
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
                sourceFor(state, request);
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
                if (!sameBinding(initial, latest)) fail('TOOL_SOURCE_STALE');
                live(latest, source);
            }
            if (refreshes.length) await Promise.all(refreshes.map(check => check()));
            recheck();
            const context: InvocationContext = Object.freeze({ invocationId: request.invocationId, observationId: request.observationId,
                source, rawInput: request.input, effectiveInput, refSources, signal: controller.signal });
            let authorized: unknown;
            try { authorized = await state.policy!.authorize(context); } catch { return fail('TOOL_AUTHORIZATION_FAILED'); }
            if (authorized === true && refreshes.length) await Promise.all(refreshes.map(check => check()));
            recheck();
            if (authorized !== true) fail('TOOL_PERMISSION_DENIED');
            checkAdmission(entry, controller);
            if (requestSources && !requestAppIsAvailable(requestSources, state.appId)) fail('TURN_NOT_ACTIVE');
            for (const source of foreign.values()) source.markDispatched();
            entry.phase = 'unknown'; // The business adapter may have entered from this point onward.
            try { mapping = mapExecutionFact(await initial.execute(context), limits.fact); }
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
            entry.phase = mapping.executionPhase;
            try {
                const completedAt = clock();
                entry.expiresAt = completedAt + limits.receiptTtlMs;
                if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
                entry.receipt = makeReceipt(entry, mapping, completedAt);
            } catch {
                entry.unavailable = true;
                // Retain a current fingerprint even if the clock or result cannot settle a readable receipt.
                entry.expiresAt ??= lastNow + limits.receiptTtlMs;
            }
            for (const source of foreign.values()) try { source.release(); } catch { /* Other holds still need release. */ }
            try { release?.(); } catch { /* Preserve the original operation's settlement. */ }
            state.invocations--;
            state.controllers.delete(controller); entry.running = false;
            expireReceipts(lastNow);
            for (const notify of entry.waiters) notify();
            clean(state);
        }
    }

    function checkReceiptAccess(state: State, entry: Entry, deadline?: number): void {
        if (state.closing || closed) fail('APP_INTERACTION_UNAVAILABLE');
        if (entry.unavailable) fail('RESULT_UNAVAILABLE');
        active(state);
        if (deadline !== undefined && lastNow >= deadline) throw waitDeadline;
        if (entry.expired) fail('RESULT_EXPIRED');
        if (!entry.receipt) fail('RESULT_UNAVAILABLE');
    }
    async function permitted(state: State, entry: Entry, controller: AbortController, check: () => void): Promise<void> {
        let allowed: unknown;
        try { allowed = await state.policy!.canReadReceipt(entry.metadata, controller.signal); }
        catch { check(); return fail('RECEIPT_READ_FAILED'); }
        check();
        if (allowed !== true) fail('RECEIPT_PERMISSION_DENIED');
    }
    function admitRead(state: State): AbortController {
        if (state.reads >= limits.maxReads) fail('RECEIPT_READ_CAPACITY');
        const controller = new AbortController(); state.controllers.add(controller); state.reads++;
        return controller;
    }
    function waitForTerminal(entry: Entry, deadline?: number, admission?: AbortController, signal?: CancellationSignal): Promise<boolean> {
        if (!entry.running) return Promise.resolve(true);
        const delay = deadline === undefined ? undefined : Math.max(0, deadline - clock());
        return new Promise(resolve => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const settle = (settled: boolean) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                entry.waiters.delete(done);
                resolve(settled);
            };
            const done = () => settle(true);
            const cancel = () => { if (admission) expireAdmission(entry, admission, cancelIssue); settle(false); };
            const timedOut = () => { if (admission) expireAdmission(entry, admission); settle(false); };
            if (signal?.aborted) { cancel(); return; }
            if (delay === 0) { timedOut(); return; }
            timer = delay === undefined ? undefined : setTimeout(timedOut, delay);
            entry.waiters.add(done);
            signal?.addEventListener('abort', cancel, { once: true });
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
            if (expiredAdmission || !settled) {
                active(state);
                if (expiredAdmission) return unavailable(expiredAdmission.code, expiredAdmission.message);
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
            return Object.freeze({ kind: 'receipt', receipt: entry.receipt! });
        } catch (error) {
            if (error === waitDeadline || error === waitCancelled) controller.abort();
            const { code, message } = problem(error);
            return unavailable(code, message);
        }
        finally {
            clearTimeout(timer);
            removeCancel?.();
            const release = () => {
                state.reads--;
                state.controllers.delete(controller);
                clean(state);
            };
            // Ending the observer's wait does not end its Host permission callback.
            if (permission) void permission.then(release, release);
            else release();
        }
    }
    function capturedRequest(raw: unknown) {
        let request: CapturedInvocation;
        try { request = copyWireJson(raw, limits.request) as unknown as CapturedInvocation; }
        catch (error) { return invalidInvocationJson(error, 'INVOCATION_INVALID'); }
        const fields = ['invocationId', 'observationId', 'toolId', 'input'];
        if (!jsonObject(request) || !exactFields(request, request.viewId === undefined ? fields : [...fields, 'viewId']) ||
            ![request.invocationId, request.observationId].every(validRequestId) || !nonEmpty(request.toolId) ||
            !jsonObject(request.input) || (request.viewId !== undefined && typeof request.viewId !== 'string')) fail('INVOCATION_INVALID');
        return { request, fingerprint: canonicalJson(request as unknown as JsonValue) };
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
            const query = capture<ReceiptQuery>(raw, limits.request, 'INVOCATION_INVALID');
            if (!jsonObject(query) || !exactFields(query, ['observationId', 'invocationId']) ||
                !validRequestId(query.observationId) || !validRequestId(query.invocationId)) fail('INVOCATION_INVALID');
            const entry = state.entries.get(query.invocationId);
            if (!entry || entry.metadata.observationId !== query.observationId) fail('RESULT_UNAVAILABLE');
            return read(state, entry, admitRead(state), end);
        } catch (error) { return Promise.resolve(unavailable(problem(error).code)); }
    }

    function invoke(raw: unknown, timeoutMs?: number, token?: ActiveTurn, signal?: CancellationSignal): Promise<import('./app-interaction-types.js').InvokeResult> {
        try {
            if (signal?.aborted) fail(cancelIssue.code, cancelIssue.message);
            const { request, fingerprint } = capturedRequest(raw);
            const requestSources = token === undefined ? undefined : requestSourcesFor(token, authority, request.observationId);
            if (token !== undefined && !requestSources) fail('TURN_SELECTION_INVALID', 'The target observation must belong to the active turn.');
            let now: number;
            try { now = refresh(); } catch (error) {
                const entry = state.entries.get(request.invocationId);
                if (entry?.fingerprint === fingerprint && entry.unavailable) return Promise.resolve(unavailable('RESULT_UNAVAILABLE'));
                throw error;
            }
            if (state.closing) fail('APP_INTERACTION_UNAVAILABLE');
            const end = deadline(timeoutMs, now);
            const found = findEntry(request, fingerprint, requestSources?.identity);
            if (found) {
                try { return read(state, found, admitRead(state), end, undefined, signal); }
                catch (error) { return Promise.resolve(unavailable(problem(error).code)); }
            }
            if (state.invocations) fail('INVOCATION_CAPACITY', 'An App operation is still in progress. Read its receipt or wait for it to finish.');
            if (request.observationId !== state.adoptedObservationId) {
                fail(state.observations.has(request.observationId) ? 'OBSERVATION_NOT_ADOPTED' : 'OBSERVATION_UNAVAILABLE');
            }
            const currentCount = [...state.entries.values()].filter(entry => entry.metadata.observationId === request.observationId).length;
            if (currentCount >= limits.maxReceiptsPerObservation)
                fail('INVOCATION_CAPACITY', 'The current observation has reached its call limit. Prepare and adopt a new observation.');
            if (state.entries.size >= limits.maxReceipts)
                fail('INVOCATION_CAPACITY', 'Retained call history is full. Wait for earlier receipts to expire.');
            if (state.reads >= limits.maxReads) fail('RECEIPT_READ_CAPACITY');
            const initial = capture<ReceiptMetadata>({ appId: state.appId, instanceId: state.instanceId,
                invocationId: request.invocationId, observationId: request.observationId,
                toolId: request.toolId, source: null }, limits.metadata, 'INVOCATION_CAPACITY');
            const controller = new AbortController(), readController = new AbortController();
            const entry: Entry = { fingerprint, requestSourcesId: requestSources?.identity, metadata: initial,
                phase: 'not-dispatched', waiters: new Set(), ...(end === undefined ? {} : { deadline: end }),
                running: true, expired: false, unavailable: false };
            state.entries.set(request.invocationId, entry);
            state.controllers.add(controller); state.controllers.add(readController); state.invocations++; state.reads++;
            void Promise.resolve().then(() => run(state, entry, request, controller, requestSources));
            return read(state, entry, readController, end, controller, signal);
        } catch (error) { return Promise.resolve(Object.freeze({ kind: 'refused', ...problem(error) })); }
    }

    async function observe(): Promise<ObserveResult> {
        let controller: AbortController | undefined, token: import('./observation-types.js').ReservationHandle | undefined;
        try {
            active(state);
            if (state.projects || state.observations.size > (state.adoptedObservationId ? 1 : 0))
                fail('OBSERVATION_CAPACITY', 'Release or adopt the prepared observation before preparing another.');
            const reserved = observations.begin();
            if (reserved.status === 'rejected') return reserved;
            token = reserved.reservation; controller = new AbortController(); state.controllers.add(controller); state.projects++;
            const grant = await state.policy!.project(Object.freeze({ source: reserved.source, signal: controller.signal }));
            return observations.complete(token, grant, canExposeTools);
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
            receiptContents: [...state.entries.values()].filter(entry => entry.receipt).length,
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
    return interaction;
}
