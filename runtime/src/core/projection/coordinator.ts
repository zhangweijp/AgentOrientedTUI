import { canonicalJson, SnapshotDataError } from '../snapshot/json.js';
import { captureSnapshotPrepareIssue, DEFAULT_SNAPSHOT_LIMITS as limits, isSnapshotPrepareIssueCode, refKey } from '../snapshot/snapshot-support.js';
import {
    SNAPSHOT_SCHEMA_VERSION,
    type JsonValue, type PreparedAppSnapshotDraft, type PreparedSnapshotFailure,
    type RefDescriptor, type SnapshotCommitter, type SnapshotIssue,
    type ToolDescriptor, type ViewSnapshot,
} from '../snapshot/types.js';
import { validatePreparedSnapshot } from '../snapshot/validate-snapshot.js';
import type { AppFrameBinding, createViewOwnedTools } from '../tool/view-owned-tools.js';

export interface AppFrameRef {
    readonly id: string;
    readonly value: JsonValue;
    readonly refType?: string | undefined;
}

/** Completed author data. The app runtime supplies mounted identities and Tool activations. */
export interface AppFrameView extends Omit<ViewSnapshot, 'viewInstanceId' | 'toolBindings'> {
    readonly owner: object;
    readonly bindings: readonly AppFrameBinding[];
    readonly refs: readonly AppFrameRef[];
}
export interface AppProjectionFrame {
    readonly views: readonly AppFrameView[];
}
export type PreparedProjection = Readonly<{ status: 'prepared'; sourceEpoch: number }>;
export type ProjectionOptions =
    | Readonly<{ opening: true; retainViews?: true }>
    | Readonly<{ restore: true }>;
export type ProjectionCommitResult = PreparedProjection
    | Readonly<{ status: 'restored'; sourceEpoch: number }>
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>
    | Readonly<{ status: 'failed'; issue: SnapshotIssue; cause?: { readonly error: unknown } }>;

export interface ProjectionSource {
    identity(): { readonly appId: string; readonly instanceId: string };
    checkCapacity?(draft: PreparedAppSnapshotDraft): SnapshotIssue | undefined;
}

/** Complete candidate with prospective identities from the View registry. */
export interface CompleteProjectionFrame {
    readonly views: readonly ViewSnapshot[];
    readonly refs: readonly (AppFrameRef & { readonly viewId: string; readonly viewInstanceId: string })[];
    readonly tools: readonly ToolDescriptor[];
    readonly accept?: () => void;
}

type ProjectionToken = Readonly<{ epoch: number; ready: boolean }>;
type Publication = { draft: PreparedAppSnapshotDraft } | { failure: PreparedSnapshotFailure };
const asyncFunction = Object.getPrototypeOf(async function () {});

function failureIssue(error: unknown): SnapshotIssue {
    try {
        if (error instanceof SnapshotDataError) return { code: error.code, path: error.path, message: error.message };
        if (error instanceof Error) {
            const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
            const message = Object.getOwnPropertyDescriptor(error, 'message')?.value;
            if (isSnapshotPrepareIssueCode(code)) {
                const reason = Object.getOwnPropertyDescriptor(error, 'reason')?.value;
                const path = Object.getOwnPropertyDescriptor(error, 'path')?.value;
                return captureSnapshotPrepareIssue({ code, message: typeof reason === 'string' ? reason : message, path });
            }
            if (typeof message === 'string' && message.startsWith('NESTED_VIEW_UNSUPPORTED:')) return { code: 'SNAPSHOT_INVALID', message };
        }
    } catch { /* Diagnostic capture cannot replace the App's error. */ }
    return { code: 'SNAPSHOT_INVALID', message: 'Semantic projection commit failed' };
}

const closedError = () => Object.assign(new Error('Projection owner closed'), { code: 'PROJECTION_CLOSED' });

/** Stage live bindings with their View and Ref identities. Only a valid complete frame can install them. */
export function commitAppFrame(projection: SemanticProjectionCoordinator, registry: ReturnType<typeof createViewOwnedTools>,
    build: () => AppProjectionFrame, options?: ProjectionOptions): ProjectionCommitResult {
    return projection.commit(() => {
        const frame = build();
        if (!frame || Object.keys(frame).length !== 1 || !Array.isArray(frame.views))
            throw new SnapshotDataError('SNAPSHOT_INVALID', '$', 'Expected a complete View frame');
        const views: AppProjectionFrame['views'] = frame.views;
        const plan = registry.prepareFrame(views);
        return {
            views: views.map(({ id, type, name, kind, content }, index) => {
                const { viewInstanceId, toolBindings } = plan.instances[index]!;
                return { id, type, name, kind, content, viewInstanceId, toolBindings };
            }),
            refs: views.flatMap(({ id, refs }, index) => refs.map(ref => ({
                ...ref, viewId: id, viewInstanceId: plan.instances[index]!.viewInstanceId,
            }))),
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
    private issue?: SnapshotIssue;
    private closed = false;
    private queuedNotice = false;
    private readonly listeners = new Set<(token: ProjectionToken) => void>();

    constructor(private readonly source: ProjectionSource) {}

    assertWritable(): void {
        if (this.closed) throw closedError();
        if (this.committing) {
            const error = new SnapshotDataError('SNAPSHOT_INVALID', '$', 'Projection bindings cannot change during preparation');
            this.commitIssue ??= failureIssue(error);
            throw error;
        }
    }

    commit(build: () => CompleteProjectionFrame, options?: ProjectionOptions): ProjectionCommitResult {
        this.assertWritable();
        this.committing = true;
        try {
            let frame: CompleteProjectionFrame;
            try {
                const asyncError = () => new SnapshotDataError('SNAPSHOT_INVALID', '$', 'Projection commit callback must be synchronous');
                if (Object.getPrototypeOf(build) === asyncFunction) throw asyncError();
                frame = build();
                if (frame != null && typeof (frame as Partial<PromiseLike<unknown>>).then === 'function') {
                    void Promise.resolve(frame).catch(() => {});
                    throw asyncError();
                }
            } catch (error) {
                return this.fail(this.commitIssue ?? failureIssue(error), { error });
            }
            try { return this.prepare(frame, options); }
            catch (error) { return this.fail(this.commitIssue ?? failureIssue(error)); }
        } finally {
            this.committing = false;
            this.commitIssue = undefined;
            this.scheduleNotice();
        }
    }

    private prepare({ views, refs, tools, accept }: CompleteProjectionFrame, options?: ProjectionOptions): ProjectionCommitResult {
        const values: Record<string, RefDescriptor> = Object.create(null);
        for (const { id, value, viewId, viewInstanceId, refType } of refs) {
            const key = refKey(viewId, viewInstanceId, id);
            if (Object.hasOwn(values, key)) throw new SnapshotDataError('SNAPSHOT_INVALID', '$.refs', 'Duplicate Ref in App frame');
            values[key] = { id, ownerViewId: viewId, ownerViewInstanceId: viewInstanceId,
                refType: refType ?? 'unknown', target: { kind: 'snapshot-value', payload: value } };
        }
        const definitions: Record<string, ToolDescriptor> = Object.create(null);
        for (const tool of tools) {
            if (Object.hasOwn(definitions, tool.id)) throw new Error('Duplicate Tool definition');
            definitions[tool.id] = tool;
        }
        let checked: ReturnType<typeof validatePreparedSnapshot> | undefined = validatePreparedSnapshot({
            schemaVersion: SNAPSHOT_SCHEMA_VERSION, ...this.source.identity(),
            sourceEpoch: this.epoch + 1, producerSeq: this.producerSeq + 1, capturedAt: Date.now(),
            views, refs: values, tools: definitions,
        }, limits, () => this.prepared?.tools);
        if (this.commitIssue) return this.fail(this.commitIssue);
        if (!checked.ok) return this.fail(checked.issue);

        const { draft, canonicalContent } = checked.value;
        // Drop the temporary UTF-8 bytes before the capacity check measures the observation.
        checked = undefined;
        const previous = this.prepared;
        if (options && 'restore' in options) {
            if (!previous || this.issue || previous.appId !== draft.appId || previous.instanceId !== draft.instanceId ||
                canonicalJson({ schemaVersion: previous.schemaVersion, views: previous.views,
                    refs: previous.refs, tools: previous.tools } as unknown as JsonValue) !== canonicalContent) {
                return this.fail({ code: 'SNAPSHOT_INVALID', path: '$.views',
                    message: 'The render did not restore the accepted projection after refusing an opening' });
            }
            return { status: 'restored', sourceEpoch: this.epoch };
        }

        const capacity = this.source.checkCapacity?.(draft);
        if (this.commitIssue) return this.fail(this.commitIssue);
        if (capacity) {
            if (capacity.code === 'OBSERVATION_CAPACITY' && previous && options && 'opening' in options) {
                const mounted = new Set(previous.views.map(view => view.viewInstanceId));
                const next = new Set(draft.views.map(view => view.viewInstanceId));
                const addsView = [...next].some(id => !mounted.has(id));
                const retained = !options.retainViews || (!this.issue && [...mounted].every(id => next.has(id)));
                if (addsView && retained) return { status: 'rejected', issue: capacity };
            }
            return this.fail(capacity);
        }
        if (this.closed) throw closedError();
        accept?.();
        this.prepared = draft;
        this.epoch = draft.sourceEpoch;
        this.issue = undefined;
        return Object.freeze({ status: 'prepared', sourceEpoch: this.epoch });
    }

    private fail(issue: SnapshotIssue, cause?: { readonly error: unknown }): ProjectionCommitResult {
        if (!this.closed) this.issue = issue;
        return { status: 'failed', issue, ...(cause ? { cause } : {}) };
    }

    getViewRefs() {
        return Object.values(this.prepared?.refs ?? {}).flatMap(ref => ref.target.kind === 'snapshot-value'
            ? [{ viewId: ref.ownerViewId, refId: ref.id, value: ref.target.payload,
                ...(ref.refType === 'unknown' ? {} : { refType: ref.refType }) }]
            : []);
    }

    nextPublication(): Publication {
        if (this.closed) throw closedError();
        if (this.committing) throw new Error('Projection commit is still active');
        if (this.producerSeq >= Number.MAX_SAFE_INTEGER) throw new Error('Projection producer sequence exhausted');
        const producerSeq = ++this.producerSeq;
        if (!this.issue && this.prepared) return { draft: { ...this.prepared, producerSeq } };
        return { failure: { ...this.source.identity(), producerSeq, sourceEpoch: this.epoch,
            issue: this.issue ?? { code: 'SNAPSHOT_INVALID', message: 'Projection has no successful commit' } } };
    }

    publishTo(committer: SnapshotCommitter) {
        const publication = this.nextPublication();
        return 'draft' in publication ? committer.accept(publication.draft) : committer.reportPrepareFailure(publication.failure);
    }

    get failure(): SnapshotIssue | undefined { return this.issue; }
    get failed(): boolean { return this.issue !== undefined; }

    close(): void {
        this.closed = true;
        this.prepared = undefined;
        this.issue = undefined;
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
