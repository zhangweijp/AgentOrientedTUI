import { describe, expect, it, vi } from 'vitest';
import { SemanticProjectionCoordinator } from './coordinator.js';
import { createSnapshotCore } from '../snapshot/store.js';
import type { ViewSnapshotV2 } from '../snapshot/types.js';

const aa = { viewId: 'aa', viewInstanceId: 'a1' };
const bb = { viewId: 'bb', viewInstanceId: 'b1' };
const view = (owner = aa, value = 'body'): ViewSnapshotV2 => ({
    id: owner.viewId, name: owner.viewId, type: 'File', viewInstanceId: owner.viewInstanceId,
    kind: 'state', content: { format: 'markdown-v1', value },
});

function fixture(views = [view(), view(bb)]) {
    const frame = { views };
    const identity = () => ({ appId: 'app', instanceId: 'run' });
    const readFrame = vi.fn(() => ({ views: frame.views, tools: [] }));
    const c = new SemanticProjectionCoordinator({ identity, readFrame });
    const core = createSnapshotCore();
    core.lifecycle.startApp('app', 'run');
    return { c, frame, readFrame, core, publish: () => c.publishTo(core.committer) };
}

describe('shared projection commit boundary', () => {
    it('keeps first null and non-null → null transitions, including falsy replacements', () => {
        const { c, publish, core } = fixture();
        const owner = { ...aa };
        let binding!: ReturnType<typeof c.registerRef>;
        for (const value of [null, 7, null, false, 0, ''] as const) {
            expect(c.commit(() => {
                if (binding) binding.update(value);
                else binding = c.registerRef(owner, 'selected', value);
            })).toBe('prepared');
            expect(publish().status).toBe('published');
            const snapshot = core.store.readLatest('app');
            if (snapshot.status !== 'ready') throw Error('Expected a published value');
            expect(Object.values(snapshot.snapshot.refs)[0]?.target).toEqual({ kind: 'snapshot-value', payload: value });
        }
    });

    it('refuses async and thenable commits without publishing writes before the first await', async () => {
        const { c, frame, core, publish } = fixture();
        c.commit(() => {});
        expect(publish().status).toBe('published');
        const latest = core.store.readLatest('app');
        const native = vi.fn();
        const operation = async () => { native(); };
        // @ts-expect-error The public coordinator requires a synchronous callback.
        expect(() => c.commit(operation)).toThrow('must be synchronous');
        expect(native).not.toHaveBeenCalled();
        const disguised: () => void = () => {
            frame.views = [view(aa, 'uncommitted')];
            return Promise.reject(new Error('rejected author work'));
        };
        expect(() => c.commit(disguised)).toThrow('must be synchronous');
        expect(publish().status).toBe('rejected');
        expect(core.store.readLatest('app')).toMatchObject({ status: 'degraded', lastGood: latest.status === 'ready' ? latest.snapshot : undefined });
        await Promise.resolve();
    });

    it('joins an open batch without depending on its notification', async () => {
        const { c } = fixture(), owner = new AbortController();
        c.beginCommit();
        expect(() => c.beginCommit()).toThrow(/already active/);
        let complete = false;
        const waiting = c.whenCommitted(owner.signal).then(() => { complete = true; });
        await Promise.resolve();
        expect(complete).toBe(false);
        expect(c.endCommit()).toBe('prepared');
        await waiting;
        expect(complete).toBe(true);
        expect((c as any).commits.size).toBe(0);
        const token = c.token();
        await c.whenCommitted(owner.signal);
        expect(c.token()).toEqual(token);
        expect(() => c.endCommit()).toThrow(/without begin/);
    });

    it('releases aborted waits and closes outstanding waits and bindings', async () => {
        const { c } = fixture(), owner = new AbortController();
        c.beginCommit();
        const ref = c.registerRef(aa, 'selected', { value: 1 });
        const waiting = c.whenCommitted(owner.signal);
        owner.abort();
        await expect(waiting).rejects.toMatchObject({ code: 'PROJECTION_CLOSED' });
        expect((c as any).commits.size).toBe(0);
        await expect(c.whenCommitted(owner.signal)).rejects.toMatchObject({ code: 'PROJECTION_CLOSED' });
        c.endCommit();
        c.close();
        expect(c.getViewRefs()).toEqual([]);
        expect(() => ref.update({ value: 2 })).toThrow(/no longer active/);
        expect(() => c.nextPublication()).toThrow(expect.objectContaining({ code: 'PROJECTION_CLOSED' }));
    });

    it('notifies only after a completed batch and isolates faulty listeners', async () => {
        const { c } = fixture();
        const seen: number[] = [];
        c.subscribe(() => { throw new Error('Listener failure'); });
        const unsubscribe = c.subscribe(token => seen.push(token.epoch));
        c.commit(() => {}); // queued notification must not expose the next open batch
        c.beginCommit();
        c.registerRef(aa, 'selected', { value: 1 });
        expect(c.token()).toEqual({ epoch: 1, ready: false });
        await Promise.resolve();
        expect(seen).toEqual([]);
        c.endCommit();
        await Promise.resolve();
        expect(seen).toEqual([2]);
        unsubscribe();
        c.commit(() => {});
        await Promise.resolve();
        expect(seen).toEqual([2]);
    });

    it('copies only submitted Ref values and resends a cached frame without reading the source', () => {
        const { c, frame, readFrame, publish } = fixture();
        const a = { value: 1 };
        const b = { value: 2 };
        let refA!: ReturnType<typeof c.registerRef>;
        let refB!: ReturnType<typeof c.registerRef>;
        c.commit(() => { refA = c.registerRef(aa, 'items[0]', a); refB = c.registerRef(bb, 'selected', b); });
        expect(publish().status).toBe('published');
        a.value = 3;
        expect(publish().status).toBe('unchanged');
        expect(readFrame).toHaveBeenCalledTimes(1);
        expect(c.getViewRefs().map(ref => ref.value)).toEqual([{ value: 1 }, { value: 2 }]);
        c.commit(() => { frame.views = [view(), view(bb, 'B:4')]; b.value = 4; refB.update(b); });
        expect(publish().status).toBe('published');
        expect(c.getViewRefs().map(ref => ref.value)).toEqual([{ value: 1 }, { value: 4 }]);
        c.commit(() => { frame.views = [view(aa, 'A:3'), view(bb, 'B:4')]; refA.update(a); });
        expect(publish().status).toBe('published');
        expect(c.getViewRefs().map(ref => ref.value)).toEqual([{ value: 3 }, { value: 4 }]);
        expect(Object.isFrozen(a)).toBe(false);
    });

    it.each(['throw', 'capture', 'schema'] as const)('keeps failed %s data out of unrelated commits and repairs at a new epoch', kind => {
        const { c, frame, core, publish } = fixture();
        let a!: ReturnType<typeof c.registerRef>;
        let b!: ReturnType<typeof c.registerRef>;
        c.commit(() => { a = c.registerRef(aa, 'selected', { value: 1 }); b = c.registerRef(bb, 'selected', { value: 2 }); });
        const first = publish();
        if (first.status !== 'published') throw new Error('fixture did not publish');
        const epoch = c.token().epoch;
        const update = () => c.commit(() => {
            a.update(kind === 'capture' ? { value: () => 9 } : { value: 9 });
            if (kind === 'throw') throw new Error('failed render');
            if (kind === 'schema') frame.views = [view(), view()]; // invalid duplicate View
        });
        if (kind === 'throw') expect(update).toThrow('failed render');
        else expect(update()).toBe('failed');
        expect(c.token().epoch).toBe(epoch);
        expect(publish().status).toBe('rejected');
        expect(core.store.readLatest('app')).toMatchObject({ status: 'degraded', lastGood: { id: first.snapshot.id } });
        expect(c.commit(() => { frame.views = [view(), view(bb, 'B:4')]; b.update({ value: 4 }); })).toBe('blocked');
        expect(publish().status).toBe('rejected');
        expect(c.getViewRefs().map(ref => ref.value)).toEqual([{ value: 1 }, { value: 2 }]);
        expect(c.commit(() => a.update({ value: 3 }))).toBe('prepared');
        expect(publish().status).toBe('published');
        expect(c.getViewRefs().map(ref => ref.value)).toEqual([{ value: 3 }, { value: 4 }]);
        expect(c.token().epoch).toBe(epoch + 1);
    });

    it('rejects writes during preparation even when the source swallows the error', () => {
        const { c, readFrame } = fixture();
        let binding!: ReturnType<typeof c.registerRef>;
        c.commit(() => { binding = c.registerRef(aa, 'selected', { value: 1 }); });
        readFrame.mockImplementationOnce(() => {
            expect(() => binding.update({ value: 2 })).toThrow(/cannot change during preparation/);
            return { views: [view(), view(bb)], tools: [] };
        });
        expect(c.commit(() => {})).toBe('failed');
        expect(c.getViewRefs()[0]?.value).toEqual({ value: 1 });
    });

    it('keeps addresses unambiguous while allowing brackets in local names and dots in values', () => {
        const { c, frame, publish } = fixture();
        expect(() => c.commit(() => c.registerRef(aa, 'items.0', {})))
            .toThrow(expect.objectContaining({ code: 'REF_ID_INVALID' }));
        expect(c.commit(() => {
            frame.views = [view({ ...aa, viewId: 'a.b' })];
        })).toBe('failed');
        expect(c.nextPublication()).toMatchObject({ failure: { issue: { message: 'View ID cannot contain a dot' } } });
        expect(c.commit(() => {
            frame.views = [view()];
            c.registerRef(aa, 'items[0]', { 'file.path': 'notes/a.txt' });
        })).toBe('prepared');
        expect(publish().status).toBe('published');
        expect(c.getViewRefs()).toMatchObject([{ refId: 'items[0]', value: { 'file.path': 'notes/a.txt' } }]);
    });
});
