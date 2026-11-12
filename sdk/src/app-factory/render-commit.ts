import type { CancellationSignal } from '@aotui/runtime/core';
import { options, type VNode } from 'preact';
import type { IProjectionPort } from '@aotui/runtime/spi';
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

type RenderOwner = { projection: IProjectionPort; failed: Set<object> };
type RenderRequest = { owner: RenderOwner; started: boolean; finishError?: { error: unknown } };
type RenderBatch = {
    root: CommitVNode;
    owner: RenderOwner;
    rendered: Set<object>;
    unmounting: Set<MountedComponent>;
    parent: RenderBatch | undefined;
    request: RenderRequest | undefined;
    failure?: { error: unknown };
};
const owners = new WeakMap<object, RenderOwner>();
const componentKeys = new WeakMap<object, object>();
let active: RenderBatch | undefined;
let request: RenderRequest | undefined;
let scheduledRun: { escaped?: { error: unknown } } | undefined;
let installed = false;

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

function finish(batch: RenderBatch): void {
    active = batch.parent;
    const { owner, rendered, unmounting, failure } = batch;
    const removed = new Set([...unmounting].filter(component => !component.__P).map(componentKey));
    for (const key of removed) owner.failed.delete(key);
    const blocked = [...owner.failed].some(key => !rendered.has(key));
    try {
        if (owner.projection.endCommit(failure, blocked) === 'failed') {
            for (const key of rendered) if (!removed.has(key)) owner.failed.add(key);
        } else {
            for (const key of rendered) owner.failed.delete(key);
        }
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
                owner.projection.beginCommit();
                if (explicit) explicit.started = true;
                active = { root: vnode, owner, rendered: new Set(), unmounting: new Set(), parent: active, request: explicit };
            }
        }
        beforeDiff?.(vnode);
    };
    hooks.__r = vnode => {
        if (active && vnode.__c && vnode.type !== AppRuntimeContext.Provider && ownerOf(vnode) === active.owner) {
            active.rendered.add(componentKey(vnode.__c));
        }
        beforeRender?.(vnode);
    };
    hooks.unmount = vnode => {
        const node = vnode as CommitVNode;
        if (active && node.__c && ownerOf(node) === active.owner) active.unmounting.add(node.__c);
        unmount?.(vnode);
    };
    hooks.__e = (error, vnode, oldVNode, info) => {
        const batch = active && (includes(active, vnode) || ownerOf(vnode) === active.owner) ? active : undefined;
        if (batch) {
            batch.failure ??= { error };
            if (vnode.__c) batch.rendered.add(componentKey(vnode.__c));
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
                batch.failure ??= { error };
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
                active.failure ??= { error };
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
                        active.failure ??= { error };
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

export async function whenRenderCommitted(signal: CancellationSignal): Promise<void> {
    const closed = () => Object.assign(new Error('Projection owner closed'), { code: 'PROJECTION_CLOSED' });
    while (scheduled) {
        if (signal.aborted) throw closed();
        const pending = scheduled;
        await new Promise<void>((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(closed()); };
            signal.addEventListener('abort', abort, { once: true });
            void pending.then(() => { signal.removeEventListener('abort', abort); resolve(); });
        });
    }
    if (signal.aborted) throw closed();
}
