import type { AppFrameRef } from '../../spi/app/app-instance.interface.js';
import type { IRefBinding, RefValueCheck } from '../../spi/app/ref-exporter.interface.js';
import type { IProjectionPort, ProjectionToken } from '../../spi/runtime/projection.interface.js';
import type { CancellationSignal } from '../invocation/app-interaction-types.js';
import { copyJson, createJsonCopier, SnapshotDataError } from '../snapshot/json.js';
import { captureSnapshotPrepareIssue, DEFAULT_SNAPSHOT_LIMITS as limits, isSnapshotPrepareIssueCode, refKey } from '../snapshot/snapshot-support.js';
import {
    SNAPSHOT_SCHEMA_VERSION,
    type JsonValue, type PreparedAppSnapshotDraftV3, type PreparedSnapshotFailure,
    type RefDescriptorV2, type SnapshotCommitter, type SnapshotIssue,
    type ToolDescriptorV3, type ViewSnapshotV2,
} from '../snapshot/types.js';
import { validatePreparedV3Draft } from '../snapshot/v3-validator.js';

export interface ProjectionSource {
    identity(): { readonly appId: string; readonly instanceId: string };
    /** Return the complete rendered frame at the successful commit boundary. */
    readFrame(): { readonly views: readonly ViewSnapshotV2[]; readonly tools: readonly ToolDescriptorV3[] };
}

type RefOwner = { readonly viewId: string; readonly viewInstanceId: string };
/** Complete data producer candidate with prospective identities from the View registry. */
export type CompleteProjectionFrame = ReturnType<ProjectionSource['readFrame']> & {
    readonly refs: readonly (RefOwner & AppFrameRef)[];
};
type RefEntry = RefOwner & { readonly id: string; readonly refType: string | undefined; captured?: JsonValue; published?: boolean };
type RefCapture = { value: JsonValue } | { issue: SnapshotIssue };
type Batch = {
    pending: Map<RefEntry, JsonValue | undefined>;
    captures: WeakMap<object, RefCapture>;
    copy: (input: unknown) => JsonValue;
    preparing: boolean;
    issue?: SnapshotIssue;
};
type Publication = { draft: PreparedAppSnapshotDraftV3 } | { failure: PreparedSnapshotFailure };
const copyLimits = { ...limits, maxApproxBytes: limits.maxSnapshotBytes * 2 };
class CapturedRef {} // An expired token cannot be mistaken for plain JSON.
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

/** One producer's successful commit boundary and latest prepared frame. Core owns published snapshots. */
export class SemanticProjectionCoordinator implements IProjectionPort {
    private epoch = 0;
    private producerSeq = 0;
    private batch?: Batch;
    private prepared?: PreparedAppSnapshotDraftV3;
    private issue?: SnapshotIssue;
    private closed = false;
    private readonly refs = new Map<string, RefEntry>();
    private readonly failedRefs = new Set<RefEntry>();
    private queuedNotice = false;
    private readonly listeners = new Set<(token: ProjectionToken) => void>();
    private readonly commits = new Set<() => void>();

    constructor(private readonly source: ProjectionSource) {}

    beginCommit(): void {
        if (this.closed) throw closedError();
        if (this.batch) throw new Error('Projection commit already active');
        this.batch = { pending: new Map(), captures: new WeakMap(), copy: createJsonCopier(copyLimits), preparing: false };
    }

    /** Synchronous explicit producer entry. Returning normally submits a complete View and Tool frame. */
    commit<Result>(operation: () => Result & (Extract<Result, PromiseLike<unknown>> extends never ? unknown : never)): ReturnType<IProjectionPort['endCommit']> {
        const asyncError = () => new SnapshotDataError('SNAPSHOT_INVALID', '$', 'Projection commit callback must be synchronous');
        this.beginCommit();
        try {
            if (Object.getPrototypeOf(operation) === asyncFunction) throw asyncError();
            const result = operation();
            if (result != null && typeof (result as Partial<PromiseLike<unknown>>).then === 'function') {
                // Observe rejection from an incorrectly typed callback without retaining its batch.
                void Promise.resolve(result).catch(() => {});
                throw asyncError();
            }
        } catch (error) {
            this.endCommit({ error });
            throw error;
        }
        return this.endCommit();
    }

    endCommit(failure?: { readonly error: unknown }, blocked = false, frame?: CompleteProjectionFrame): 'prepared' | 'blocked' | 'failed' {
        const batch = this.batch;
        if (!batch) throw new Error('Projection commit end without begin');
        batch.preparing = true;
        try {
            if (failure || batch.issue) return this.fail(batch, batch.issue ?? failureIssue(failure?.error));
            const unrepaired = !frame && (blocked || [...this.failedRefs].some(entry => !batch.pending.has(entry)));
            const values = new Map<RefEntry, JsonValue>();
            if (frame) {
                for (const { token, id, viewId, viewInstanceId, refType } of frame.refs) {
                    const capture = batch.captures.get(token);
                    if (!capture) throw new SnapshotDataError('SNAPSHOT_INVALID', `Ref ${viewId}.${id}`, 'Ref capture is outside this commit');
                    if ('issue' in capture) return this.fail(batch, this.refIssue(viewId, id, capture.issue));
                    values.set({ id, viewId, viewInstanceId, refType }, capture.value);
                }
            } else {
                for (const entry of this.refs.values()) {
                    const value = batch.pending.has(entry) ? batch.pending.get(entry) : entry.captured;
                    if (value === undefined) {
                        if (unrepaired) continue;
                        throw new Error('Ref has no successful capture');
                    }
                    values.set(entry, value);
                }
            }
            if (unrepaired) {
                // Keep successful owner work for a later repair, within the existing snapshot copy budget.
                copyJson([...values.values()], copyLimits);
                this.remember(batch, values);
                this.issue ??= { code: 'SNAPSHOT_INVALID', message: 'Projection still requires a repair commit' };
                return 'blocked';
            }

            const { views, tools } = frame ?? this.source.readFrame();
            const refs: Record<string, RefDescriptorV2> = Object.create(null);
            for (const [entry, payload] of values) {
                const key = refKey(entry.viewId, entry.viewInstanceId, entry.id);
                if (Object.hasOwn(refs, key)) throw new SnapshotDataError('SNAPSHOT_INVALID', '$.refs', 'Duplicate Ref in App frame');
                refs[key] = {
                    id: entry.id, ownerViewId: entry.viewId, ownerViewInstanceId: entry.viewInstanceId,
                    refType: entry.refType ?? 'unknown', target: { kind: 'snapshot-value', payload },
                };
            }
            const definitions: Record<string, ToolDescriptorV3> = Object.create(null);
            for (const tool of tools) {
                if (Object.hasOwn(definitions, tool.id)) throw new Error('Duplicate Tool definition');
                definitions[tool.id] = tool;
            }
            const checked = validatePreparedV3Draft({
                schemaVersion: SNAPSHOT_SCHEMA_VERSION, ...this.source.identity(),
                sourceEpoch: this.epoch + 1, producerSeq: this.producerSeq + 1, capturedAt: Date.now(),
                views, refs, tools: definitions,
            }, limits, () => this.prepared?.tools);
            if (batch.issue) return this.fail(batch, batch.issue);
            if (!checked.ok) return this.fail(batch, checked.issue);

            this.prepared = checked.value.draft;
            this.epoch = this.prepared.sourceEpoch;
            this.issue = undefined;
            if (frame) this.refs.clear();
            for (const entry of values.keys()) {
                const key = refKey(entry.viewId, entry.viewInstanceId, entry.id);
                const ref = this.prepared.refs[key]!;
                if (ref.target.kind === 'snapshot-value') {
                    entry.captured = ref.target.payload;
                    entry.published = true;
                    if (frame) this.refs.set(key, entry);
                }
            }
            this.failedRefs.clear();
            return 'prepared';
        } catch (error) {
            return this.fail(batch, failureIssue(error));
        } finally {
            this.batch = undefined;
            for (const complete of this.commits) complete();
            this.scheduleNotice();
        }
    }

    private refIssue(viewId: string, id: string, issue: SnapshotIssue): SnapshotIssue {
        return { ...issue, path: `Ref ${viewId}.${id}${issue.path ? ' ' + issue.path : ''}` };
    }

    private remember(batch: Batch, values: Map<RefEntry, JsonValue>): void {
        for (const entry of batch.pending.keys()) {
            entry.captured = values.get(entry);
            this.failedRefs.delete(entry);
        }
    }

    private fail(batch: Batch, issue: SnapshotIssue): 'failed' {
        for (const entry of batch.pending.keys()) this.failedRefs.add(entry);
        this.issue = issue;
        return 'failed';
    }

    captureRef(data: unknown, check?: RefValueCheck): object {
        const batch = this.requireBatch();
        const capture = new CapturedRef();
        batch.captures.set(capture, this.copyRef(batch, data, check));
        return capture;
    }

    private copyRef(batch: Batch, data: unknown, check?: RefValueCheck): RefCapture {
        try {
            const value = batch.copy(data);
            const failure = check?.(value);
            return failure ? { issue: { code: 'SNAPSHOT_INVALID', ...failure } } : { value };
        }
        catch (error) { return { issue: failureIssue(error) }; }
    }

    registerRef(owner: RefOwner, id: string, data: unknown, refType?: string): IRefBinding {
        this.requireBatch();
        const { viewId, viewInstanceId } = owner;
        if (!viewId.trim() || viewId.includes('.') || !id.trim() || id.includes('.')) {
            throw Object.assign(new Error('View and Ref IDs must be non-empty and cannot contain a dot'), { code: 'REF_ID_INVALID' });
        }
        const key = refKey(viewId, viewInstanceId, id);
        if (this.refs.has(key)) {
            throw Object.assign(new Error(`Ref '${id}' is already registered in View '${viewId}'`),
                { name: 'RefRegistrationError', code: 'REF_ALREADY_REGISTERED' });
        }
        if (this.refs.size >= limits.maxRefs) throw new Error('Ref capacity exceeded');
        const entry: RefEntry = { viewId, viewInstanceId, id, refType };
        this.refs.set(key, entry);
        const update = (next: unknown) => {
            if (this.refs.get(key) !== entry) throw new Error(`Ref binding '${id}' in View '${viewId}' is no longer active`);
            const batch = this.requireBatch();
            const token = next !== null && typeof next === 'object' ? batch.captures.get(next) : undefined;
            const capture = token ?? this.copyRef(batch, next);
            if ('issue' in capture) {
                batch.pending.set(entry, undefined);
                batch.issue ??= this.refIssue(viewId, id, capture.issue);
            } else {
                batch.pending.set(entry, capture.value);
            }
        };
        update(data);
        return { update, release: () => { if (this.refs.get(key) === entry) this.releaseRef(key, entry); } };
    }

    assertWritable(): void {
        if (this.batch?.preparing) {
            const error = new Error('Projection bindings cannot change during preparation');
            this.batch.issue ??= failureIssue(error);
            throw error;
        }
    }

    private requireBatch(): Batch {
        if (this.closed) throw closedError();
        if (!this.batch) throw new Error('Ref writes require an active projection commit');
        this.assertWritable();
        return this.batch;
    }

    private releaseRef(key: string, entry: RefEntry): void {
        this.assertWritable();
        this.refs.delete(key);
        this.batch?.pending.delete(entry);
        this.failedRefs.delete(entry);
        entry.captured = undefined;
    }

    releaseView(viewInstanceId: string): void {
        for (const [key, entry] of this.refs) {
            if (entry.viewInstanceId === viewInstanceId) this.releaseRef(key, entry);
        }
    }

    getViewRefs() {
        return Object.entries(this.prepared?.refs ?? {}).flatMap(([key, ref]) => {
            const entry = this.refs.get(key);
            if (!entry?.published || ref.target.kind !== 'snapshot-value') return [];
            return [{ viewId: ref.ownerViewId, refId: ref.id, value: ref.target.payload,
                ...(entry.refType === undefined ? {} : { refType: ref.refType }) }];
        });
    }

    nextPublication(): Publication {
        if (this.closed) throw closedError();
        if (this.batch) throw new Error('Projection commit is still active');
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
        for (const [key, entry] of this.refs) this.releaseRef(key, entry);
        this.batch = undefined;
        this.prepared = undefined;
        this.issue = undefined;
        this.listeners.clear();
        for (const complete of this.commits) complete();
    }

    whenCommitted(signal: CancellationSignal): Promise<void> {
        if (this.closed || signal.aborted) return Promise.reject(closedError());
        if (!this.batch) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const cleanup = () => { this.commits.delete(complete); signal.removeEventListener('abort', abort); };
            const complete = () => { cleanup(); if (this.closed) reject(closedError()); else resolve(); };
            const abort = () => { cleanup(); reject(closedError()); };
            this.commits.add(complete);
            signal.addEventListener('abort', abort, { once: true });
        });
    }

    token(): ProjectionToken {
        return Object.freeze({ epoch: this.epoch, ready: !this.closed && !this.batch });
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
            if (this.batch) return;
            const token = this.token();
            for (const listener of [...this.listeners]) {
                try { listener(token); } catch { /* Subscriber errors do not invalidate a prepared frame. */ }
            }
        });
    }
}
