import { SnapshotDataError, type CancellationSignal } from '@aotui/runtime/core';
import { options, type VNode } from 'preact';
import type { IProjectionPort, PreparedProjection } from '@aotui/runtime/spi';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';

// Preact 10's distributed builds expose these options and fields under minified names.
// __c runs layout effects through preact/hooks before Preact drains __h (class callbacks).
type MountedComponent = { __P?: Node | null };
type CommitVNode = VNode & { __?: CommitVNode; __c?: MountedComponent };
type CommitComponent = { __h: Array<() => void>; __v: CommitVNode };
type CommitOptions = typeof options & {
    __b?: (vnode: CommitVNode) => void;
    __r?: (vnode: CommitVNode) => void;
    __c?: (vnode: CommitVNode, queue: CommitComponent[]) => void;
    __e: (error: unknown, vnode: CommitVNode, oldVNode?: CommitVNode, info?: unknown) => void;
};

type CommitResult = ReturnType<IProjectionPort['endCommit']>;
type CommitMode = Parameters<IProjectionPort['endCommit']>[2];
type RenderWork = {
    rendered: Set<object>;
    unmounting: Set<MountedComponent>;
    failure?: { error: unknown };
};
type ProjectionAttempt = {
    readonly settled: Promise<void>;
    collecting: boolean;
    work?: RenderWork;
};
type RenderOwner = { projection: IProjectionPort; failed: Set<object>; attempt?: ProjectionAttempt };
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
let scheduledRun: { escaped?: { error: unknown } } | undefined;
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

function projectionError(issue?: IProjectionPort['failure']): SnapshotDataError {
    return new SnapshotDataError(issue?.code ?? 'SNAPSHOT_INVALID', issue?.path ?? '$.views',
        issue?.message ?? 'The render did not prepare a projection');
}

function synchronousUpdateError(): SnapshotDataError {
    return new SnapshotDataError('SNAPSHOT_INVALID', '$.views', 'Projection update and revert callbacks must be synchronous');
}

function finishProjection(owner: RenderOwner, { rendered, unmounting, failure }: RenderWork, mode?: CommitMode): CommitResult {
    const removed = new Set([...unmounting].filter(component => !component.__P).map(componentKey));
    for (const key of removed) owner.failed.delete(key);
    const blocked = [...owner.failed].some(key => !rendered.has(key));
    const result = owner.projection.endCommit(failure, blocked, mode);
    if (result === 'failed') {
        for (const key of rendered) if (!removed.has(key)) owner.failed.add(key);
    } else if (typeof result === 'string') {
        for (const key of rendered) owner.failed.delete(key);
    }
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
                const work = attempt?.work ?? { rendered: new Set<object>(), unmounting: new Set<MountedComponent>() };
                if (!attempt?.work) {
                    owner.projection.beginCommit();
                    if (attempt) attempt.work = work;
                }
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
                finish(batch);
                if (scheduledRun && !batch.request) scheduledRun.escaped = { error: unhandled };
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

export function createRenderCommit(projection: IProjectionPort, context: object): (render: () => void) => void {
    installCommitHooks();
    const owner: RenderOwner = { projection, failed: new Set() };
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
    // Preact's default defer is a resolved Promise.
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
                const previousRun = scheduledRun;
                const run: NonNullable<typeof scheduledRun> = {};
                scheduledRun = run;
                try { callback(); }
                catch (error) {
                    const managed = (run.escaped && Object.is(run.escaped.error, error)) || (active && active !== parent);
                    while (active && active !== parent) {
                        active.work.failure ??= { error };
                        finish(active);
                    }
                    // The managed failure is already recorded by the producer.
                    if (!managed) throw error;
                } finally {
                    scheduledRun = previousRun;
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
    update: () => unknown, mode?: CommitMode): Promise<CommitResult | undefined> {
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
    let result: CommitResult | undefined;
    if (work) {
        if (failure) work.failure ??= failure;
        result = finishProjection(owner, work, mode);
    } else if (mode === 'restore' && !signal.aborted) {
        owner.projection.beginCommit();
        result = owner.projection.endCommit(failure ?? {
            error: new SnapshotDataError('SNAPSHOT_INVALID', '$.views', 'The opening rollback did not commit a render'),
        });
    }
    if (failure) throw failure.error;
    return result;
}

export async function prepareRenderProjection(context: object, signal: CancellationSignal,
    update: () => unknown, opening?: { readonly revert: () => unknown }): Promise<PreparedProjection> {
    const owner = owners.get(context)!;
    if (owner.attempt) throw Object.assign(new Error('A projection update is already in progress'), { code: 'PROJECTION_BUSY' });
    const revert = opening?.revert;
    if (Object.getPrototypeOf(update) === asyncFunction || (revert && Object.getPrototypeOf(revert) === asyncFunction)) {
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
        if (revert && typeof result === 'object') {
            const restored = await commitUpdate(owner, attempt, signal, revert, 'restore');
            throw projectionError(restored === 'restored' ? result.issue : owner.projection.failure);
        }
        if (result !== 'prepared') throw projectionError(owner.projection.failure);
        return Object.freeze({ status: 'prepared', sourceEpoch: owner.projection.token().epoch });
    } finally { delete owner.attempt; settle(); }
}
