import { describe, expect, it, vi } from 'vitest';
import { commitAppFrame, SemanticProjectionCoordinator, type AppFrameRef, type CompleteProjectionFrame } from './coordinator.js';
import { hostedObservationCapacityIssue } from '../invocation/observation-projection.js';
import { createSnapshotCore } from '../snapshot/store.js';
import type { JsonValue, ViewSnapshot } from '../snapshot/types.js';
import type { ProjectionOptions } from './coordinator.js';
import { createViewOwnedTools } from '../tool/view-owned-tools.js';
import { viewToolReceiver } from '../tool/source-binding.js';
import { SnapshotDataError } from '../snapshot/json.js';

const aa = { viewId: 'aa', viewInstanceId: 'a1' };
const bb = { viewId: 'bb', viewInstanceId: 'b1' };
const view = (owner = aa, value = 'body'): ViewSnapshot => ({
    toolBindings: [], id: owner.viewId, name: owner.viewId, type: 'File', viewInstanceId: owner.viewInstanceId,
    region: 'dynamic', content: { format: 'markdown-v1', value },
});
const ref = (owner: typeof aa, id: string, value: JsonValue) => ({ ...owner, id, value, scope: 'protected' as const,
    valueSchema: { anyOf: [{ type: 'null' }, { type: 'number' }, { type: 'boolean' }, { type: 'string' }, { type: 'object' }] } });

function fixture(checkCapacity?: typeof hostedObservationCapacityIssue) {
    const identity = () => ({ appId: 'app', instanceId: 'run' });
    const c = new SemanticProjectionCoordinator({ identity, ...(checkCapacity ? { checkCapacity } : {}) });
    const core = createSnapshotCore(identity());
    const frame = (views = [view(), view(bb)], refs: CompleteProjectionFrame['refs'] = [], accept?: () => void) =>
        ({ views, tools: [], refs, ...(accept ? { accept } : {}) });
    return { c, frame, core, publish: () => c.publishTo(core.committer) };
}

const preparedRefs = (projection: SemanticProjectionCoordinator) => Object.values(projection['prepared']?.refs ?? {});

describe('shared complete projection frame', () => {
    it('reads only unambiguous IDs from the healthy accepted frame', () => {
        const { c, frame } = fixture();
        const opened = { ...view(), name: 'Second file' };
        expect(c.readPreparedViewId('File', opened.name)).toBeUndefined();
        c.commit(() => frame([opened]));
        expect(c.readPreparedViewId('File', opened.name)).toBe('aa');
        expect(c.readPreparedViewId('Other', opened.name)).toBeUndefined();
        c.commit(() => frame([opened, { ...view(bb), name: opened.name }]));
        expect(c.readPreparedViewId('File', opened.name)).toBeUndefined();
        c.commit(() => frame([opened]));
        c.commit(() => { throw new Error('render fault'); });
        expect(c.readPreparedViewId('File', opened.name)).toBeUndefined();
        c.commit(() => frame([opened]));
        c.close();
        expect(c.readPreparedViewId('File', opened.name)).toBeUndefined();
    });
    it('confirms only a healthy publication and retains the actual identity of an unchanged delivery', () => {
        const { c, frame, core } = fixture();
        const publish = () => {
            const publication = c.nextPublication();
            if (!('draft' in publication)) throw new Error('Expected a prepared projection');
            return core.committer.accept(publication.draft);
        };
        expect(core.currentPublication()).toBeUndefined();
        c.commit(() => frame());
        const initial = publish();
        if (initial.status !== 'published') throw new Error('Expected the initial snapshot');
        const first = core.currentPublication()!;
        expect(first).toEqual({ appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1 });
        expect(c.confirmsPublication(first)).toBe(true);
        expect(c.confirmsPublication({ ...first, producerSeq: 2 })).toBe(false);
        c.commit(() => {
            expect(c.confirmsPublication(first)).toBe(false);
            return frame();
        });
        expect(c.confirmsPublication(first)).toBe(false);
        const unchanged = publish();
        expect(unchanged).toEqual({ status: 'unchanged', snapshot: initial.snapshot });
        const latest = core.currentPublication()!;
        expect(latest).toEqual({ ...first, producerSeq: 2, sourceEpoch: 2 });
        expect(c.confirmsPublication(latest)).toBe(true);
        c.commit(() => { throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', '$.views', 'fixture fault'); });
        expect(c.confirmsPublication(latest)).toBe(false);
        expect(c.publishTo(core.committer)).toMatchObject({ status: 'rejected' });
        expect(core.currentPublication()).toBeUndefined();
        c.commit(() => frame());
        expect(publish().status).toBe('unchanged');
        expect(core.currentPublication()).toEqual({ ...first, producerSeq: 4, sourceEpoch: 3 });
        c.close();
        expect(c.confirmsPublication(core.currentPublication()!)).toBe(false);
        core.lifecycle.stop();
        expect(core.currentPublication()).toBeUndefined();
    });

    it('reads only an existing healthy frame without preparing or publishing it again', async () => {
        const { c, frame } = fixture();
        const notice = vi.fn(), build = vi.fn(() => frame([]));
        c.subscribe(notice);
        expect(c.token()).toEqual({ epoch: 0, ready: true });
        expect(() => c.readPreparedProjection()).toThrow(expect.objectContaining({
            code: 'SNAPSHOT_INVALID', path: '$.views', message: expect.stringContaining('first successful projection'),
        }));
        const prepared = c.commit(() => {
            expect(() => c.readPreparedProjection()).toThrow(expect.objectContaining({ code: 'PROJECTION_BUSY' }));
            return build();
        });
        await Promise.resolve();
        const first = c.nextPublication();
        expect(first).toHaveProperty('draft.producerSeq', 1);
        expect(c.readPreparedProjection()).toEqual(prepared);
        expect(c.readPreparedProjection()).toEqual({ status: 'prepared' });
        await Promise.resolve();
        expect(build).toHaveBeenCalledOnce();
        expect(notice).toHaveBeenCalledOnce();
        expect(c.nextPublication()).toHaveProperty('draft.producerSeq', 2);

        const fault = new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', '$.views[0].content', 'Fault in original frame');
        c.commit(() => { throw fault; });
        expect(c.token()).toEqual({ epoch: 1, ready: true });
        expect(() => c.readPreparedProjection()).toThrow(expect.objectContaining({
            code: fault.code, path: fault.path, message: fault.message, cause: fault,
        }));
        expect(c.commit(build)).toEqual({ status: 'prepared' });
        expect(c.readPreparedProjection()).toEqual({ status: 'prepared' });
        c.close();
        expect(() => c.readPreparedProjection()).toThrow(expect.objectContaining({ code: 'PROJECTION_CLOSED' }));
    });

    it('installs live handlers only after their complete App frame passes validation', async () => {
        const { c, core, publish } = fixture();
        const registry = createViewOwnedTools('app', 'run');
        registry.defineViewTypes([{ name: "File", multiplicity: 'multiple', tools: [{ name: 'read', description: 'Read the current file', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }]);
        const owner = {};
        const commit = (mount: object, file: string, refs: readonly AppFrameRef[] = []) => commitAppFrame(c, registry, () => ({
            views: [{ idPrefix: 'editor', type: 'File', name: 'Editor', region: 'dynamic', content: { format: 'markdown-v1', value: 'Editor' },
                owner: mount, refs, bindings: [{ name: 'read', enabled: true, execute: () => ({ success: true, data: { file } }) }] }],
        }));
        try {
            expect(commit(owner, 'test.txt').status).toBe('prepared');
            expect(publish().status).toBe('published');
            const source = core.store.readLatest('app');
            if (source.status !== 'ready') throw new Error('Expected a published editor');
            const tool = Object.values(source.snapshot.tools)[0]!;
            const receiver = viewToolReceiver(source.snapshot.views[0]!, tool.id)!;
            const selected = { id: 'selected', value: 1, valueSchema: { type: 'number' }, scope: 'private' as const };

            // A replacement mount is valid in the registry. Its duplicate Ref fails in the coordinator.
            expect(commit({}, 'discarded.txt', [selected, selected])).toMatchObject({
                status: 'failed', issue: { code: 'SNAPSHOT_INVALID', path: '$.refs' },
            });
            expect(publish().status).toBe('rejected');
            expect(registry.getView('editor_1')?.viewInstanceId).toBe(receiver.viewInstanceId);
            // Probe the registry directly to identify which handler it retained while the source is degraded.
            expect(await registry.invokeTypeTool(tool, receiver, {})).toMatchObject({ result: { data: { file: 'test.txt' } } });

            expect(commit(owner, 'notes.txt').status).toBe('prepared');
            expect(publish().status).toBe('unchanged');
            expect(await registry.invokeTypeTool(tool, receiver, {})).toMatchObject({ result: { data: { file: 'notes.txt' } } });
        } finally {
            c.close();
            registry.dispose();
            core.lifecycle.dispose();
        }
    });

    it('reports real failures and preserves their diagnostic on a reversible staged opening', () => {
        const { c, frame, core, publish } = fixture(hostedObservationCapacityIssue);
        const accept = vi.fn();
        const complete = (views: ViewSnapshot[], options?: ProjectionOptions) => c.commit(() => frame(views, [], accept), options);
        expect(complete([view()])).toMatchObject({ status: 'prepared' });
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
        expect(preparedRefs(c)).toEqual([]);
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
        expect(preparedRefs(c).map(ref => ref.target.payload)).toEqual([{ value: 1 }, { value: 2 }]);
        b.value = 4;
        c.commit(build);
        expect(publish().status).toBe('published');
        expect(preparedRefs(c).map(ref => ref.target.payload)).toEqual([{ value: 3 }, { value: 4 }]);
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
        expect(preparedRefs(c)[0]?.target.payload).toEqual({ value: 1 });
    });

    it('keeps addresses unambiguous while allowing brackets in local names and dots in values', () => {
        const { c, frame, publish } = fixture();
        expect(c.commit(() => frame([view()], [ref(aa, 'items.0', {})]))).toMatchObject({ status: 'prepared' });
        expect(c.commit(() => frame([view({ ...aa, viewId: 'a.b' })]))).toMatchObject({ status: 'failed' });
        expect(c.nextPublication()).toMatchObject({ failure: { issue: { code: 'SNAPSHOT_INVALID' } } });
        expect(c.commit(() => frame([view()], [ref(aa, 'items[0]', { 'file.path': 'notes/a.txt' })])))
            .toMatchObject({ status: 'prepared' });
        expect(publish().status).toBe('published');
        expect(preparedRefs(c)).toMatchObject([{ id: 'items[0]', target: { payload: { 'file.path': 'notes/a.txt' } } }]);
    });
});
