import { isSnapshotDataError, SnapshotDataError } from '../snapshot/json.js';
import { captureSnapshotPrepareIssue, DEFAULT_SNAPSHOT_LIMITS as limits, isSnapshotPrepareIssueCode, refKey, nextRefContinuity } from '../snapshot/snapshot-support.js';
import {
    SNAPSHOT_SCHEMA_VERSION,
    type JsonValue, type PreparedAppSnapshotDraft, type PreparedSnapshotFailure,
    type RefDescriptor, type RefScope, type SnapshotCommitter, type SnapshotDraftEnvelope, type SnapshotIssue,
    type ToolDescriptor, type ViewSnapshot,
} from '../snapshot/types.js';
import { validatePreparedSnapshot } from '../snapshot/validate-snapshot.js';
import { ViewToolContractError, type AppFrameBinding, type createViewOwnedTools } from '../tool/view-owned-tools.js';
import type { ToolResult } from '../tool/tool-result.js';

export interface AppFrameRef {
    readonly id: string;
    readonly value: JsonValue;
    readonly refType?: string | undefined;
    readonly scope: RefScope;
    readonly array?: true;
    readonly valueSchema: JsonValue;
}

/** Completed author data. The app runtime supplies mounted identities and Tool activations. */
export interface AppFrameView extends Omit<ViewSnapshot, 'id' | 'name' | 'viewInstanceId' | 'toolBindings' | 'closeActivationId'> {
    readonly id?: string;
    readonly idPrefix?: string;
    readonly name?: string;
    readonly owner: object;
    readonly bindings: readonly AppFrameBinding[];
    readonly refs: readonly AppFrameRef[];
    readonly bindingKey?: string | number;
    readonly onClose?: () => ToolResult | Promise<ToolResult>;
}
export interface AppProjectionFrame {
    readonly views: readonly AppFrameView[];
}
export type PublishMode = 'authoritative' | 'candidate';
export type ProjectionOptions = Readonly<{ mode?: PublishMode | undefined }>;
export type PublishResult = Readonly<{ ok: true; epoch: number; viewId(handle: object): string | undefined }> |
    Readonly<{ ok: false; state: 'preserved' | 'degraded'; issue: SnapshotIssue; cause?: unknown }>;

function success(epoch: number, ids: WeakMap<object, string>): Extract<PublishResult, {ok: true}> {
    return Object.freeze({ ok: true, epoch, viewId: (handle: object) => ids.get(handle) });
}

export function stoppedPublication(): Extract<PublishResult, {ok: false}> {
    return Object.freeze({ ok: false, state: 'preserved', issue: Object.freeze({ code: 'APP_STOPPED', message: 'App projection is stopped' }) });
}
export interface ProjectionSource {
    identity(): { readonly appId: string; readonly instanceId: string };
    checkCapacity?(draft: PreparedAppSnapshotDraft): SnapshotIssue | undefined;
    isStopped?(): boolean;
}

/** Complete candidate with prospective identities from the View registry. */
export interface CompleteProjectionFrame {
    readonly views: readonly ViewSnapshot[];
    readonly refs: readonly (AppFrameRef & { readonly viewId: string; readonly viewInstanceId: string })[];
    readonly tools: readonly ToolDescriptor[];
    readonly accept?: () => void;
    readonly ids?: WeakMap<object, string>;
}

type ProjectionToken = Readonly<{ epoch: number; ready: boolean }>;
type Publication = { draft: PreparedAppSnapshotDraft } | { failure: PreparedSnapshotFailure };
const asyncFunction = Object.getPrototypeOf(async function () {});

function failureIssue(error: unknown): SnapshotIssue {
    try {
        if (isSnapshotDataError(error)) return { code: error.code, path: error.path, message: error.message };
        if (error instanceof ViewToolContractError) return { code: 'SNAPSHOT_INVALID', path: error.path, message: error.message };
        if (error instanceof Error) {
            const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
            const message = Object.getOwnPropertyDescriptor(error, 'message')?.value;
            if (isSnapshotPrepareIssueCode(code)) {
                const reason = Object.getOwnPropertyDescriptor(error, 'reason')?.value;
                const path = Object.getOwnPropertyDescriptor(error, 'path')?.value;
                return captureSnapshotPrepareIssue({ code, message: typeof reason === 'string' ? reason : message, path });
            }
        }
    } catch { /* Diagnostic capture cannot replace the App's error. */ }
    return { code: 'SNAPSHOT_INVALID', path: '$.build', message: 'Semantic projection commit failed' };
}

const closedError = () => Object.assign(new Error('Projection owner closed'), { code: 'PROJECTION_CLOSED' });

/** Stage live bindings with their View and Ref identities. Only a valid complete frame can install them. */
export function commitAppFrame(projection: SemanticProjectionCoordinator, registry: ReturnType<typeof createViewOwnedTools>,
    build: () => AppProjectionFrame, options?: ProjectionOptions): PublishResult {
    return projection.commit(() => {
        if (typeof build !== 'function' || Object.getPrototypeOf(build) === asyncFunction)
            throw new SnapshotDataError('SNAPSHOT_INVALID', '$.build', 'Projection builder must be synchronous');
        const frame = build();
        if (frame instanceof Promise) { void Promise.prototype.then.call(frame, undefined, () => {}); }
        if (!frame || Object.keys(frame).length !== 1 || !Array.isArray(frame.views))
            throw new SnapshotDataError('SNAPSHOT_INVALID', '$', 'Expected a complete View frame');
        const views: AppProjectionFrame['views'] = frame.views;
        const plan = registry.prepareFrame(views, projection.failed);
        const ids = new WeakMap<object, string>();
        for (const [i, view] of views.entries()) ids.set(view.owner, plan.instances[i]!.viewId);
        return {
            ids,
            views: views.map(({ type, name, region, content }, index) => {
                const { viewId: id, viewInstanceId, toolBindings, closeActivationId } = plan.instances[index]!;
                return { id, type, name: name === undefined ? id : name, region, content, viewInstanceId, toolBindings,
                    ...(closeActivationId ? { closeActivationId } : {}) };
            }),
            refs: views.flatMap(({ refs }, index) => {
                const { viewId, viewInstanceId } = plan.instances[index]!;
                return refs.map(ref => ({ ...ref, viewId, viewInstanceId }));
            }),
            tools: plan.tools,
            accept: plan.accept,
        };
    }, options);
}

/** Validate and accept one complete frame. Core owns the published snapshot. */
export class SemanticProjectionCoordinator {
    private epoch = 0;
    private producerSeq = 0;
    private committing = false;
    private commitIssue?: SnapshotIssue;
    private prepared?: PreparedAppSnapshotDraft;
    private fault?: SnapshotIssue;
    private closed = false;
    private poisoned = false;
    private queuedNotice = false;
    private readonly listeners = new Set<(token: ProjectionToken) => void>();

    constructor(private readonly source: ProjectionSource) {}

    readViewId(owner: object, registry: ReturnType<typeof createViewOwnedTools>): string | undefined {
        if (!this.stopped && !this.fault && this.prepared) return registry.readViewId(owner);
    }

    assertWritable(): void {
        if (this.stopped) throw closedError();
        if (this.committing) {
            const error = new SnapshotDataError('SNAPSHOT_INVALID', '$', 'Projection bindings cannot change during preparation');
            this.commitIssue ??= failureIssue(error);
            throw error;
        }
    }

    private get stopped(): boolean { return this.closed || this.poisoned || this.source.isStopped?.() === true; }

    commit(build: () => CompleteProjectionFrame, options?: ProjectionOptions): PublishResult {
        if (this.stopped) return stoppedPublication();
        if (this.committing) {
            this.commitIssue ??= { code: 'SNAPSHOT_INVALID', path: '$.build', message: 'Projection bindings cannot change during preparation' };
            return this.failureResult(this.commitIssue, 'candidate');
        }
        this.committing = true;
        let mode: PublishMode = 'authoritative';
        try {
            if (options !== undefined) {
                if (!options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options)))
                    throw new SnapshotDataError('SNAPSHOT_INVALID', '$.options.mode', 'Expected plain publish options');
                const fields = Object.getOwnPropertyDescriptors(options);
                if (Reflect.ownKeys(fields).some(key => key !== 'mode') ||
                    fields.mode && (!fields.mode.enumerable || !('value' in fields.mode) ||
                        ![undefined, 'authoritative', 'candidate'].includes(fields.mode.value)))
                    throw new SnapshotDataError('SNAPSHOT_INVALID', '$.options.mode', 'Expected authoritative or candidate');
                mode = fields.mode?.value ?? 'authoritative';
            }
            if (this.stopped) return stoppedPublication();
            if (mode === 'candidate' && this.fault)
                return this.failureResult({ code: 'SNAPSHOT_UNREADY', message: 'Repair the projection with an authoritative publish' }, mode);
            if (typeof build !== 'function' || Object.getPrototypeOf(build) === asyncFunction)
                throw new SnapshotDataError('SNAPSHOT_INVALID', '$.build', 'Projection builder must be synchronous');
            const frame = build();
            if (frame instanceof Promise) {
                void Promise.prototype.then.call(frame, undefined, () => {});
                throw new SnapshotDataError('SNAPSHOT_INVALID', '$.build', 'Projection builder must be synchronous');
            }
            if (this.commitIssue) return this.failureResult(this.commitIssue, mode);
            return this.prepare(frame, mode);
        } catch (error) {
            return this.failureResult(this.commitIssue ?? failureIssue(error), mode, { error });
        } finally {
            this.committing = false;
            this.commitIssue = undefined;
            this.scheduleNotice();
        }
    }

    private prepare({ views, refs, tools, accept, ids }: CompleteProjectionFrame, mode: PublishMode): PublishResult {
        const values: Record<string, RefDescriptor> = Object.create(null);
        for (const { id, value, viewId, viewInstanceId, refType, scope, array, valueSchema } of refs) {
            const key = refKey(viewId, viewInstanceId, id);
            if (Object.hasOwn(values, key)) throw new SnapshotDataError('SNAPSHOT_INVALID', '$.refs', 'Duplicate Ref in App frame');
            if (valueSchema === undefined) throw new SnapshotDataError('SNAPSHOT_INVALID', 'Ref ' + viewId + '.' + id + '.valueSchema', 'Declare a schema for every published Ref.');
            values[key] = { continuity: nextRefContinuity(this.fault ? undefined : this.prepared?.refs[key]?.continuity, scope, this.epoch + 1),
                id, ownerViewId: viewId, ownerViewInstanceId: viewInstanceId,
                refType: refType ?? 'unknown', scope, ...(array ? { array } : {}),
                valueSchema, target: { kind: 'snapshot-value', payload: value } };
        }
        const definitions: Record<string, ToolDescriptor> = Object.create(null);
        for (const tool of tools) {
            if (Object.hasOwn(definitions, tool.id)) throw new Error('Duplicate Tool definition');
            definitions[tool.id] = tool;
        }
        let checked: ReturnType<typeof validatePreparedSnapshot> | undefined = validatePreparedSnapshot({
            schemaVersion: SNAPSHOT_SCHEMA_VERSION, ...this.source.identity(),
            sourceEpoch: this.epoch + 1, healthySince: this.fault || !this.prepared ? this.epoch + 1 : this.prepared.healthySince, producerSeq: this.producerSeq + 1, capturedAt: Date.now(),
            views, refs: values, tools: definitions,
        }, limits, () => this.prepared?.tools);
        if (this.commitIssue) return this.failureResult(this.commitIssue, mode);
        if (!checked.ok) return this.failureResult(checked.issue, mode);

        const { draft } = checked.value;
        // Drop the temporary UTF-8 bytes before the capacity check measures the observation.
        checked = undefined;
        if (this.stopped) return stoppedPublication();
        const capacity = this.source.checkCapacity?.(draft);
        if (this.stopped) return stoppedPublication();
        if (this.commitIssue) return this.failureResult(this.commitIssue, mode);
        if (capacity) return this.failureResult(capacity, mode);
        const result = success(draft.sourceEpoch, ids ?? new WeakMap());
        // From here only the Core-owned plan installs state; if that fails,
        // the inventory cannot be certified and this execution must fail closed.
        try { accept?.(); }
        catch (error) {
            const issue = failureIssue(error);
            const failure = this.failureResult(issue, 'authoritative', {error});
            this.poisoned = true;
            return failure;
        }
        this.prepared = draft;
        this.epoch = draft.sourceEpoch;
        this.fault = undefined;
        return result;
    }

    private failureResult(issue: SnapshotIssue, mode: PublishMode, cause?: { readonly error: unknown }): Extract<PublishResult, {ok: false}> {
        if (this.stopped) return stoppedPublication();
        const diagnostic = Object.freeze({ ...issue });
        const failure = { ok: false as const, state: mode === 'candidate' ? 'preserved' as const : 'degraded' as const, issue: diagnostic };
        if (mode === 'authoritative') this.fault = diagnostic;
        if (cause) Object.defineProperty(failure, 'cause', { value: cause.error });
        return Object.freeze(failure);
    }

    refDescriptor(viewId: string, viewInstanceId: string, refId: string): RefDescriptor | undefined {
        return this.healthy ? this.prepared?.refs[refKey(viewId, viewInstanceId, refId)] : undefined;
    }

    confirmsPublication(known: SnapshotDraftEnvelope): boolean {
        const prepared = this.prepared;
        return !!prepared && this.healthy &&
            prepared.appId === known.appId && prepared.instanceId === known.instanceId &&
            prepared.sourceEpoch === known.sourceEpoch && this.producerSeq === known.producerSeq;
    }

    nextPublication(): Publication {
        if (this.closed) throw closedError();
        if (this.committing) throw new Error('Projection commit is still active');
        if (this.producerSeq >= Number.MAX_SAFE_INTEGER) throw new Error('Projection producer sequence exhausted');
        const producerSeq = ++this.producerSeq;
        if (!this.fault && this.prepared) return { draft: { ...this.prepared, producerSeq } };
        return { failure: { ...this.source.identity(), producerSeq, sourceEpoch: this.epoch,
            issue: this.fault ?? { code: 'SNAPSHOT_INVALID', message: 'Projection has no successful commit' } } };
    }

    publishTo(committer: SnapshotCommitter) {
        const publication = this.nextPublication();
        return 'draft' in publication ? committer.accept(publication.draft) : committer.reportPrepareFailure(publication.failure);
    }

    get failure(): SnapshotIssue | undefined { return this.fault; }
    get failed(): boolean { return this.fault !== undefined || this.poisoned; }
    get healthy(): boolean { return !this.stopped && !this.committing && !this.fault && !!this.prepared; }

    close(): void {
        this.closed = true;
        this.prepared = undefined;
        this.fault = undefined;
        this.listeners.clear();
    }

    token(): ProjectionToken {
        return Object.freeze({ epoch: this.epoch, ready: !this.closed && !this.committing });
    }

    subscribe(listener: (token: ProjectionToken) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private scheduleNotice(): void {
        if (this.closed || this.queuedNotice || this.listeners.size === 0) return;
        this.queuedNotice = true;
        queueMicrotask(() => {
            this.queuedNotice = false;
            if (!this.token().ready) return;
            const token = this.token();
            for (const listener of [...this.listeners]) {
                try { listener(token); } catch { /* Subscriber errors do not invalidate the projection. */ }
            }
        });
    }
}
