import { SnapshotDataError, type CancellationSignal, type JsonValue, type SnapshotIssue } from '@aotui/runtime/core';
import { options, type VNode } from 'preact';
import { createRefCapture, DEFAULT_SNAPSHOT_LIMITS, type AppFrameRef, type AppProjectionFrame, type PreparedProjection,
    type ProjectionCommitResult, type RuntimeContext } from '@aotui/runtime/spi';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import type { RefRegistry } from '../contexts/view-runtime-context.js';
import { capturedRefValue } from './refs.js';

// Preact 10.29.1 distribution layout. VNode __ points to the parent and __c
// points to the component. __P is cleared on unmount even for DOM-less components.
// __b/__r delimit diff and render, __e reports faults, and __c runs the hook
// commit before Preact drains each component's __h callbacks using its __v.
// The installed-package verify-preact-commit fixture exercises this boundary.
type MountedComponent = { __P?: Node | null };
type CommitVNode = VNode & { __?: CommitVNode; __c?: MountedComponent };
type CommitComponent = { __h: Array<() => void>; __v: CommitVNode };
type CommitOptions = typeof options & {
    __b?: (vnode: CommitVNode) => void;
    __r?: (vnode: CommitVNode) => void;
    __c?: (vnode: CommitVNode, queue: CommitComponent[]) => void;
    __e: (error: unknown, vnode: CommitVNode, oldVNode?: CommitVNode, info?: unknown) => void;
};

type CommitMode = 'opening' | 'restore';
type RenderRef = { id: string; refType: string | undefined; value?: JsonValue };
type RefValues = ReadonlyMap<RenderRef, JsonValue>;
type RenderWork = {
    rendered: Set<object>;
    unmounting: Set<MountedComponent>;
    capture: ReturnType<typeof createRefCapture>;
    refs: Map<RenderRef, JsonValue>;
    failure?: { error: unknown };
};
type ProjectionAttempt = {
    readonly settled: Promise<void>;
    collecting: boolean;
    work?: RenderWork;
};
type RenderOwner = {
    runtime: Pick<RuntimeContext, 'publishFrame' | 'signal'>;
    readFrame: (refs: RefValues) => AppProjectionFrame;
    refs: Set<RenderRef>;
    failed: Set<object>;
    failure?: { error: unknown };
    preparing?: RenderWork;
    attempt?: ProjectionAttempt;
};
type RenderRequest = { owner: RenderOwner; started: boolean; finishError?: { error: unknown } };
type RenderBatch = {
    root: CommitVNode;
    owner: RenderOwner;
    work: RenderWork;
    deferred: boolean;
    parent: RenderBatch | undefined;
    request: RenderRequest | undefined;
};
const owners = new WeakMap<object, RenderOwner>();
const componentKeys = new WeakMap<object, object>();
let active: RenderBatch | undefined;
let request: RenderRequest | undefined;
let runningScheduled = false;
let installed = false;
const asyncFunction = Object.getPrototypeOf(async function () {});

function componentKey(component: object): object {
    let key = componentKeys.get(component);
    if (!key) componentKeys.set(component, key = {});
    return key;
}

function ownerOf(vnode: CommitVNode): RenderOwner | undefined {
    for (let node: CommitVNode | undefined = vnode; node; node = node.__) {
        if (node.type === AppRuntimeContext.Provider) {
            return owners.get((node.props as typeof node.props & { value: object }).value);
        }
    }
}

function includes(batch: RenderBatch, vnode: CommitVNode): boolean {
    for (let node: CommitVNode | undefined = vnode; node; node = node.__) {
        if (node === batch.root) return true;
    }
    return false;
}

function projectionError(issue?: SnapshotIssue): SnapshotDataError {
    return new SnapshotDataError(issue?.code ?? 'SNAPSHOT_INVALID', issue?.path ?? '$.views',
        issue?.message ?? 'The render did not prepare a projection');
}

function synchronousUpdateError(): SnapshotDataError {
    return new SnapshotDataError('SNAPSHOT_INVALID', '$.views', 'Projection update and revert callbacks must be synchronous');
}

function createWork(): RenderWork {
    return { rendered: new Set(), unmounting: new Set(), capture: createRefCapture(), refs: new Map() };
}

function refValue(entry: RenderRef, values: RefValues): JsonValue | undefined {
    const next = values.get(entry);
    return next === undefined ? entry.value : next;
}

/** Registry attached to one Preact View. Runtime sees only its completed JSON values. */
export function createViewRefs(context: object, viewId: string) {
    const owner = owners.get(context)!;
    const entries = new Map<string, RenderRef>();
    const writable = () => {
        if (owner.preparing) {
            const error = new Error('Projection bindings cannot change during preparation');
            owner.preparing.failure ??= { error };
            throw error;
        }
    };
    const work = () => {
        writable();
        if (active?.owner !== owner) throw new Error('Ref writes require an active projection commit');
        return active.work;
    };
    const release = (entry: RenderRef) => {
        writable();
        entries.delete(entry.id);
        owner.refs.delete(entry);
        if (active?.owner === owner) active.work.refs.delete(entry);
        delete entry.value;
    };
    const registry: RefRegistry = {
        captureRef: (data, check) => work().capture(data, check),
        registerRef(id, data, refType) {
            work();
            if (!viewId.trim() || viewId.includes('.') || !id.trim() || id.includes('.')) {
                throw Object.assign(new Error('View and Ref IDs must be non-empty and cannot contain a dot'), { code: 'REF_ID_INVALID' });
            }
            if (entries.has(id)) {
                throw Object.assign(new Error(`Ref '${id}' is already registered in View '${viewId}'`),
                    { name: 'RefRegistrationError', code: 'REF_ALREADY_REGISTERED' });
            }
            if (owner.refs.size >= DEFAULT_SNAPSHOT_LIMITS.maxRefs) throw new Error('Ref capacity exceeded');
            const entry = { id, refType };
            entries.set(id, entry);
            owner.refs.add(entry);
            const update = (value: Parameters<RefRegistry['registerRef']>[1]) => {
                if (entries.get(id) !== entry) throw new Error(`Ref binding '${id}' in View '${viewId}' is no longer active`);
                const current = work();
                try { current.refs.set(entry, capturedRefValue(viewId, id, value)); }
                catch (error) { current.failure ??= { error }; }
            };
            update(data);
            return { update, release: () => { if (entries.get(id) === entry) release(entry); } };
        },
    };
    return {
        registry,
        readRefs(values: RefValues): AppFrameRef[] {
            return [...entries.values()].map(entry => {
                const value = refValue(entry, values);
                if (value === undefined) throw new Error('Ref has no successful capture');
                return { id: entry.id, refType: entry.refType, value };
            });
        },
        release() { for (const entry of entries.values()) release(entry); },
    };
}

function finishProjection(owner: RenderOwner, work: RenderWork, mode?: CommitMode): ProjectionCommitResult | undefined {
    if (owner.runtime.signal.aborted) return;
    const { rendered, unmounting } = work;
    const removed = new Set([...unmounting].filter(component => !component.__P).map(componentKey));
    for (const key of removed) owner.failed.delete(key);
    const blocked = [...owner.failed].some(key => !rendered.has(key));
    let result: ProjectionCommitResult | undefined;
    try {
        if (blocked && !work.failure) {
            // Retain successful repair work within the same detached JSON budget.
            const values = [...owner.refs].map(entry => refValue(entry, work.refs)).filter(value => value !== undefined);
            const retained = createRefCapture()(values);
            if ('issue' in retained) work.failure = { error: projectionError(retained.issue) };
        }
        if (work.failure || !blocked) {
            owner.preparing = work;
            result = owner.runtime.publishFrame(() => {
                const check = () => { if (work.failure) throw work.failure.error; };
                check();
                const frame = owner.readFrame(work.refs);
                check();
                return frame;
            }, mode === 'opening' ? { opening: true, retainViews: true } : mode === 'restore' ? { restore: true } : undefined);
            if (result.status === 'failed') throw projectionError(result.issue);
        }
    } catch (error) {
        owner.failure = { error };
        for (const key of rendered) if (!removed.has(key)) owner.failed.add(key);
        return;
    } finally {
        delete owner.preparing;
    }
    if (result?.status === 'rejected') return result;
    for (const [entry, value] of work.refs) entry.value = value;
    for (const key of rendered) owner.failed.delete(key);
    if (result) delete owner.failure;
    return result;
}

function finish(batch: RenderBatch): void {
    active = batch.parent;
    if (batch.deferred) return;
    try {
        finishProjection(batch.owner, batch.work);
    } catch (error) {
        if (!batch.request) throw error;
        batch.request.finishError = { error };
    }
}

function installCommitHooks(): void {
    if (installed) return;
    installed = true;
    const hooks = options as CommitOptions;
    const beforeDiff = hooks.__b;
    const beforeRender = hooks.__r;
    const unmount = hooks.unmount;
    const onError = hooks.__e;
    const commit = hooks.__c;

    hooks.__b = vnode => {
        if (!active || (request && !request.started)) {
            const explicit = request && !request.started ? request : undefined;
            const owner = explicit?.owner ?? ownerOf(vnode);
            if (owner) {
                const attempt = !explicit && owner.attempt?.collecting ? owner.attempt : undefined;
                const work = attempt?.work ?? createWork();
                if (attempt) attempt.work = work;
                if (explicit) explicit.started = true;
                active = { root: vnode, owner, work, deferred: !!attempt, parent: active, request: explicit };
            }
        }
        beforeDiff?.(vnode);
    };
    hooks.__r = vnode => {
        if (active && vnode.__c && vnode.type !== AppRuntimeContext.Provider && ownerOf(vnode) === active.owner) {
            active.work.rendered.add(componentKey(vnode.__c));
        }
        beforeRender?.(vnode);
    };
    hooks.unmount = vnode => {
        const node = vnode as CommitVNode;
        if (active && node.__c && ownerOf(node) === active.owner) active.work.unmounting.add(node.__c);
        unmount?.(vnode);
    };
    hooks.__e = (error, vnode, oldVNode, info) => {
        const batch = active && (includes(active, vnode) || ownerOf(vnode) === active.owner) ? active : undefined;
        if (batch) {
            batch.work.failure ??= { error };
            if (vnode.__c) batch.work.rendered.add(componentKey(vnode.__c));
        }
        try {
            onError(error, vnode, oldVNode, info);
        } catch (unhandled) {
            if (batch && active === batch) {
                // Preact clears its entire queue if an error escapes the drain.
                // The failed owner publishes its fault at commit; other roots
                // already queued for this drain can still run.
                if (runningScheduled && !batch.request) return;
                finish(batch);
            }
            throw unhandled;
        }
    };
    hooks.__c = (vnode, queue) => {
        const batch = active?.root === vnode ? active : undefined;
        try {
            commit?.(vnode, queue);
        } catch (error) {
            if (batch && active === batch) {
                batch.work.failure ??= { error };
                finish(batch);
            }
            throw error;
        }
        if (!batch || active !== batch) return;
        queue.push({ __v: vnode, __h: [() => finish(batch)] });
    };
}

export function createRenderCommit(runtime: RenderOwner['runtime'], context: object,
    readFrame: RenderOwner['readFrame']): (render: () => void) => void {
    installCommitHooks();
    const owner: RenderOwner = { runtime, readFrame, refs: new Set(), failed: new Set() };
    owners.set(context, owner);
    return render => {
        const previous = request;
        const current: RenderRequest = { owner, started: false };
        request = current;
        try {
            render();
            if (current.finishError) throw current.finishError.error;
        } catch (error) {
            if (active?.request === current) {
                active.work.failure ??= { error };
                finish(active);
            }
            throw error;
        } finally {
            request = previous;
        }
    };
}

let scheduled: Promise<void> | undefined;
const trackedSchedules = new WeakSet<NonNullable<typeof options.debounceRendering>>();

/** Observe Preact's existing queue; do not replace it with a second scheduler. */
export function trackRenderCommits(): void {
    if (options.debounceRendering && trackedSchedules.has(options.debounceRendering)) return;
    // In 10.29.1 the default defer uses a resolved Promise. Preserve an
    // installed debounceRendering hook and observe its existing callback.
    const schedule = options.debounceRendering ?? ((callback: () => void) => { void Promise.resolve().then(callback); });
    const trackedSchedule: NonNullable<typeof options.debounceRendering> = callback => {
        let complete!: () => void;
        const pending = new Promise<void>(resolve => { complete = resolve; });
        scheduled = pending;
        const settle = () => {
            complete();
            if (scheduled === pending) scheduled = undefined;
        };
        try {
            schedule(() => {
                const parent = active;
                const wasRunning = runningScheduled;
                runningScheduled = true;
                try { callback(); }
                catch (error) {
                    const managed = active && active !== parent;
                    while (active && active !== parent) {
                        active.work.failure ??= { error };
                        finish(active);
                    }
                    // The managed failure is already recorded by the producer.
                    if (!managed) throw error;
                } finally {
                    runningScheduled = wasRunning;
                    settle();
                }
            });
        } catch (error) { settle(); throw error; }
    };
    trackedSchedules.add(trackedSchedule);
    options.debounceRendering = trackedSchedule;
}

export async function whenRenderCommitted(signal: CancellationSignal, context?: object): Promise<void> {
    const closed = () => Object.assign(new Error('Projection owner closed'), { code: 'PROJECTION_CLOSED' });
    const owner = context && owners.get(context);
    for (;;) {
        if (signal.aborted) throw closed();
        const pending = owner?.attempt?.settled ?? scheduled;
        if (!pending) return;
        await new Promise<void>((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(closed()); };
            signal.addEventListener('abort', abort, { once: true });
            void pending.then(() => { signal.removeEventListener('abort', abort); resolve(); });
        });
    }
}

async function commitUpdate(owner: RenderOwner, attempt: ProjectionAttempt, signal: CancellationSignal,
    update: () => unknown, mode?: CommitMode): Promise<ProjectionCommitResult | undefined> {
    let failure: { error: unknown } | undefined;
    attempt.collecting = true;
    try {
        const result = update();
        if (result != null && typeof (result as Partial<PromiseLike<unknown>>).then === 'function') {
            void Promise.resolve(result).catch(() => {});
            throw synchronousUpdateError();
        }
    } catch (error) { failure = { error }; }
    try { await whenRenderCommitted(signal); }
    catch (error) { failure ??= { error }; }
    finally { attempt.collecting = false; }

    const work = attempt.work;
    delete attempt.work;
    let result: ProjectionCommitResult | undefined;
    if (work) {
        if (failure) work.failure ??= failure;
        result = finishProjection(owner, work, mode);
    } else if (mode === 'restore' && !signal.aborted) {
        const missed = createWork();
        missed.failure = failure ?? {
            error: new SnapshotDataError('SNAPSHOT_INVALID', '$.views', 'The opening rollback did not commit a render'),
        };
        result = finishProjection(owner, missed);
    }
    if (failure) throw failure.error;
    return result;
}

export async function prepareRenderProjection(context: object, signal: CancellationSignal,
    update: () => unknown, opening?: { readonly revert: () => unknown }): Promise<PreparedProjection> {
    const owner = owners.get(context)!;
    if (owner.attempt) throw Object.assign(new Error('A projection update is already in progress'), { code: 'PROJECTION_BUSY' });
    const revert = opening?.revert;
    if (typeof update !== 'function' || (opening && typeof revert !== 'function') ||
        Object.getPrototypeOf(update) === asyncFunction || (revert && Object.getPrototypeOf(revert) === asyncFunction)) {
        throw synchronousUpdateError();
    }
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const attempt: ProjectionAttempt = { settled, collecting: false };
    owner.attempt = attempt;
    try {
        trackRenderCommits();
        await whenRenderCommitted(signal);
        const result = await commitUpdate(owner, attempt, signal, update, revert ? 'opening' : undefined);
        if (revert && result?.status === 'rejected') {
            const restored = await commitUpdate(owner, attempt, signal, revert, 'restore');
            if (restored?.status === 'restored') throw projectionError(result.issue);
            throw owner.failure ? owner.failure.error : projectionError();
        }
        if (result?.status !== 'prepared') throw owner.failure ? owner.failure.error : projectionError();
        return result;
    } finally { delete owner.attempt; settle(); }
}
