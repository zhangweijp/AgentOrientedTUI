import { describe, expect, it, vi } from 'vitest';
import { SemanticProjectionCoordinator, type CompleteProjectionFrame } from './coordinator.js';
import { hostedObservationCapacityIssue } from '../invocation/observation-registry.js';
import { createSnapshotCore } from '../snapshot/store.js';
import type { JsonValue, ViewSnapshot } from '../snapshot/types.js';
import type { ProjectionOptions } from './coordinator.js';

const aa = { viewId: 'aa', viewInstanceId: 'a1' };
const bb = { viewId: 'bb', viewInstanceId: 'b1' };
const view = (owner = aa, value = 'body'): ViewSnapshot => ({
    toolBindings: [], id: owner.viewId, name: owner.viewId, type: 'File', viewInstanceId: owner.viewInstanceId,
    kind: 'state', content: { format: 'markdown-v1', value },
});
const ref = (owner: typeof aa, id: string, value: JsonValue) => ({ ...owner, id, value });

function fixture(checkCapacity?: typeof hostedObservationCapacityIssue) {
    const identity = () => ({ appId: 'app', instanceId: 'run' });
    const c = new SemanticProjectionCoordinator({ identity, ...(checkCapacity ? { checkCapacity } : {}) });
    const core = createSnapshotCore(identity());
    const frame = (views = [view(), view(bb)], refs: CompleteProjectionFrame['refs'] = [], accept?: () => void) =>
        ({ views, tools: [], refs, ...(accept ? { accept } : {}) });
    return { c, frame, core, publish: () => c.publishTo(core.committer) };
}

describe('shared complete projection frame', () => {
    it('reports real failures and preserves their diagnostic on a reversible staged opening', () => {
        const { c, frame, core, publish } = fixture(hostedObservationCapacityIssue);
        const accept = vi.fn();
        const complete = (views: ViewSnapshot[], options?: ProjectionOptions) => c.commit(() => frame(views, [], accept), options);
        expect(complete([view()])).toMatchObject({ status: 'prepared', sourceEpoch: 1 });
        expect(publish().status).toBe('published');
        const large = [view(aa, 'a'.repeat(400 * 1024)), view(bb, 'b'.repeat(400 * 1024))];

        expect(complete(large)).toMatchObject({ status: 'failed' });
        expect(publish()).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY' } });
        expect(complete([view(aa, 'a'.repeat(513 * 1024))], { opening: true })).toMatchObject({ status: 'failed' });
        const diagnostic = c.failure;
        expect(diagnostic).toMatchObject({ code: 'SNAPSHOT_SERIALIZATION_ERROR' });
        expect(publish()).toMatchObject({ status: 'rejected', issue: diagnostic });
        expect(complete(large, { opening: true })).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY' } });
        expect(c.failure).toBe(diagnostic);
        expect(publish()).toMatchObject({ status: 'rejected', issue: diagnostic });
        expect(c.token().epoch).toBe(1);
        expect(accept).toHaveBeenCalledTimes(1);
        expect(core.store.readLatest('app')).toMatchObject({ status: 'degraded', lastGood: { views: [view()] } });
    });

    it('keeps observation admission in the managed assembly', () => {
        const views = [view(aa, 'a'.repeat(400 * 1024)), view(bb, 'b'.repeat(400 * 1024))];
        const direct = fixture(), hosted = fixture(hostedObservationCapacityIssue);
        expect(direct.c.commit(() => direct.frame(views))).toMatchObject({ status: 'prepared' });
        expect(direct.publish().status).toBe('published');
        expect(hosted.c.commit(() => hosted.frame(views))).toMatchObject({ status: 'failed' });
        expect(hosted.publish()).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY' } });
    });

    it.each(['remount', 'different rollback'] as const)('reports a real projection failure on %s', failure => {
        const before = view(aa, 'a'.repeat(400 * 1024));
        const { c, frame, core, publish } = fixture(hostedObservationCapacityIssue);
        expect(c.commit(() => frame([before]))).toMatchObject({ status: 'prepared' });
        expect(publish().status).toBe('published');
        const first = failure === 'remount' ? { ...before, viewInstanceId: 'a2' } : before;
        const next = c.commit(() => frame([first, view(bb, 'b'.repeat(400 * 1024))]), { opening: true, retainViews: true });
        let code = 'OBSERVATION_CAPACITY';
        if (failure === 'remount') expect(next).toMatchObject({ status: 'failed' });
        else {
            expect(next).toMatchObject({ status: 'rejected', issue: { code } });
            expect(c.commit(() => frame([view(aa, 'a different rollback')]), { restore: true })).toMatchObject({ status: 'failed' });
            code = 'SNAPSHOT_INVALID';
        }
        expect(publish()).toMatchObject({ status: 'rejected', issue: { code } });
        expect(c.token().epoch).toBe(1);
        expect(core.store.readLatest('app')).toMatchObject({ status: 'degraded', lastGood: { views: [before] } });
    });

    it('keeps first null and non-null → null transitions, including falsy replacements', () => {
        const { c, frame, publish, core } = fixture();
        for (const value of [null, 7, null, false, 0, ''] as const) {
            expect(c.commit(() => frame([view()], [ref(aa, 'selected', value)]))).toMatchObject({ status: 'prepared' });
            expect(publish().status).toBe('published');
            const snapshot = core.store.readLatest('app');
            if (snapshot.status !== 'ready') throw Error('Expected a published value');
            expect(Object.values(snapshot.snapshot.refs)[0]?.target).toEqual({ kind: 'snapshot-value', payload: value });
        }
    });

    it('rejects async producers and disguised Promise results without accepting their frames', () => {
        const { c, frame, core, publish } = fixture();
        c.commit(() => frame());
        expect(publish().status).toBe('published');
        const latest = core.store.readLatest('app');
        const native = vi.fn();
        const operation = async () => { native(); return frame(); };
        // @ts-expect-error A candidate builder is synchronous.
        expect(c.commit(operation)).toMatchObject({ status: 'failed', issue: { message: expect.stringContaining('must be synchronous') } });
        expect(native).not.toHaveBeenCalled();
        const disguised = () => Promise.reject(new Error('rejected author work')) as unknown as CompleteProjectionFrame;
        expect(c.commit(disguised)).toMatchObject({ status: 'failed', issue: { message: expect.stringContaining('must be synchronous') } });
        expect(publish().status).toBe('rejected');
        expect(core.store.readLatest('app')).toMatchObject({ status: 'degraded', lastGood: latest.status === 'ready' ? latest.snapshot : undefined });
    });

    it('discards its prepared payload on close and rejects late submissions', () => {
        const { c, frame } = fixture();
        c.commit(() => frame([view()], [ref(aa, 'selected', { value: 1 })]));
        c.close();
        expect(c.getViewRefs()).toEqual([]);
        expect(() => c.commit(() => frame())).toThrow(expect.objectContaining({ code: 'PROJECTION_CLOSED' }));
        expect(() => c.nextPublication()).toThrow(expect.objectContaining({ code: 'PROJECTION_CLOSED' }));
    });

    it('notifies once after completed synchronous submissions and isolates faulty listeners', async () => {
        const { c, frame } = fixture();
        const seen: number[] = [];
        c.subscribe(() => { throw new Error('Listener failure'); });
        const unsubscribe = c.subscribe(token => seen.push(token.epoch));
        c.commit(() => frame());
        c.commit(() => {
            expect(c.token()).toEqual({ epoch: 1, ready: false });
            expect(seen).toEqual([]);
            return frame();
        });
        await Promise.resolve();
        expect(seen).toEqual([2]);
        unsubscribe();
        c.commit(() => frame());
        await Promise.resolve();
        expect(seen).toEqual([2]);
    });

    it('detaches Ref payloads and resends only the accepted frame without calling the producer', () => {
        const { c, frame, publish } = fixture();
        const a = { value: 1 };
        const b = { value: 2 };
        const build = vi.fn(() => frame([view(), view(bb)], [ref(aa, 'items[0]', a), ref(bb, 'selected', b)]));
        c.commit(build);
        expect(publish().status).toBe('published');
        a.value = 3;
        expect(publish().status).toBe('unchanged');
        expect(build).toHaveBeenCalledTimes(1);
        expect(c.getViewRefs().map(ref => ref.value)).toEqual([{ value: 1 }, { value: 2 }]);
        b.value = 4;
        c.commit(build);
        expect(publish().status).toBe('published');
        expect(c.getViewRefs().map(ref => ref.value)).toEqual([{ value: 3 }, { value: 4 }]);
        expect(Object.isFrozen(a)).toBe(false);
    });

    it('rejects reentrant submissions even when the producer swallows the exception', () => {
        const { c, frame, publish } = fixture();
        c.commit(() => frame([view()], [ref(aa, 'selected', { value: 1 })]));
        expect(publish().status).toBe('published');
        const accept = vi.fn();
        expect(c.commit(() => {
            expect(() => c.commit(() => frame([], [], accept))).toThrow(/cannot change during preparation/);
            return frame([view(aa, 'uncommitted')], [ref(aa, 'selected', { value: 2 })], accept);
        })).toMatchObject({ status: 'failed' });
        expect(publish().status).toBe('rejected');
        expect(accept).not.toHaveBeenCalled();
        expect(c.getViewRefs()[0]?.value).toEqual({ value: 1 });
    });

    it('keeps addresses unambiguous while allowing brackets in local names and dots in values', () => {
        const { c, frame, publish } = fixture();
        expect(c.commit(() => frame([view()], [ref(aa, 'items.0', {})]))).toMatchObject({ status: 'failed' });
        expect(c.commit(() => frame([view({ ...aa, viewId: 'a.b' })]))).toMatchObject({ status: 'failed' });
        expect(c.nextPublication()).toMatchObject({ failure: { issue: { message: 'View ID cannot contain a dot' } } });
        expect(c.commit(() => frame([view()], [ref(aa, 'items[0]', { 'file.path': 'notes/a.txt' })])))
            .toMatchObject({ status: 'prepared' });
        expect(publish().status).toBe('published');
        expect(c.getViewRefs()).toMatchObject([{ refId: 'items[0]', value: { 'file.path': 'notes/a.txt' } }]);
    });
});
