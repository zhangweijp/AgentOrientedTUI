import { describe, expect, it, vi } from 'vitest';
import { commitAppFrame, SemanticProjectionCoordinator, type AppFrameRef, type CompleteProjectionFrame } from './coordinator.js';
import { hostedObservationCapacityIssue } from '../invocation/observation-projection.js';
import { createSnapshotCore } from '../snapshot/store.js';
import type { JsonValue, ViewSnapshot } from '../snapshot/types.js';
import type { ProjectionOptions } from './coordinator.js';
import { createViewOwnedTools } from '../tool/view-owned-tools.js';
import { viewToolReceiver } from '../tool/source-binding.js';
import { SnapshotDataError } from '../snapshot/json.js';

const aa = { viewId: 'aa', viewInstanceId: 'm:1' };
const bb = { viewId: 'bb', viewInstanceId: 'm:2' };
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
    it('reads the routing ID of the actual mounted owner even when names match', () => {
        const { c } = fixture();
        const registry = createViewOwnedTools('app', 'run');
        registry.defineViewTypes([{ name: 'File', multiplicity: 'multiple', tools: [] }]);
        const a = {}, b = {}, unused = {};
        const commit = (owners: readonly object[]) => commitAppFrame(c, registry, () => ({
            views: owners.map(owner => ({ owner, type: 'File', name: 'index.ts', region: 'dynamic',
                content: { format: 'markdown-v1', value: '' }, refs: [], bindings: [] })),
        }));
        expect(c.readViewId(a, registry)).toBeUndefined();
        expect(commit([a, b])).toMatchObject({ok:true});
        expect(c.readViewId(a, registry)).toBe('File_1');
        expect(c.readViewId(b, registry)).toBe('File_2');
        expect(c.readViewId(unused, registry)).toBeUndefined();
        commit([a]);
        expect(c.readViewId(b, registry)).toBeUndefined();
        c.commit(() => { throw new Error('render fault'); });
        expect(c.readViewId(a, registry)).toBeUndefined();
        commit([a]);
        expect(c.readViewId(a, registry)).toBe('File_1');
        c.close();
        expect(c.readViewId(a, registry)).toBeUndefined();
        registry.dispose();
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
        expect(publish()).toMatchObject({ status: 'published', snapshot: { revision: 2, admissionSinceRevision: 2 } });
        expect(core.currentPublication()).toEqual({ ...first, producerSeq: 4, sourceEpoch: 3 });
        c.close();
        expect(c.confirmsPublication(core.currentPublication()!)).toBe(false);
        core.lifecycle.stop();
        expect(core.currentPublication()).toBeUndefined();
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
            expect(commit(owner, 'test.txt')).toMatchObject({ok:true});
            expect(publish().status).toBe('published');
            const source = core.store.readLatest('app');
            if (source.status !== 'ready') throw new Error('Expected a published editor');
            const tool = Object.values(source.snapshot.tools)[0]!;
            const receiver = viewToolReceiver(source.snapshot.views[0]!, tool.id)!;
            const selected = { id: 'selected', value: 1, valueSchema: { type: 'number' }, scope: 'private' as const };

            // A replacement mount is valid in the registry. Its duplicate Ref fails in the coordinator.
            expect(commit({}, 'discarded.txt', [selected, selected])).toMatchObject({
                ok: false, state: 'degraded', issue: { code: 'SNAPSHOT_INVALID', path: '$.refs' },
            });
            expect(publish().status).toBe('rejected');
            expect(registry.getView('editor_1')?.viewInstanceId).toBe(receiver.viewInstanceId);
            // Probe the registry directly to identify which handler it retained while the source is degraded.
            expect(await registry.invokeTypeTool(tool, receiver, {})).toMatchObject({ result: { data: { file: 'test.txt' } } });

            expect(commit(owner, 'notes.txt')).toMatchObject({ok:true});
            expect(publish().status).toBe('published');
            const recovered = core.store.readLatest('app');
            if (recovered.status !== 'ready') throw new Error('Expected the recovered editor');
            const recoveredReceiver = viewToolReceiver(recovered.snapshot.views[0]!, tool.id)!;
            expect(recoveredReceiver.viewInstanceId).toBe(receiver.viewInstanceId);
            expect(await registry.invokeTypeTool(tool, receiver, {})).toMatchObject({ result: { error: { code: 'TOOL_SOURCE_STALE' } } });
            expect(await registry.invokeTypeTool(tool, recoveredReceiver, {})).toMatchObject({ result: { data: { file: 'notes.txt' } } });
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
        expect(complete([view()])).toMatchObject({ ok: true });
        expect(publish().status).toBe('published');
        const large = [view(aa, 'a'.repeat(400 * 1024)), view(bb, 'b'.repeat(400 * 1024))];

        const preserved = complete([view(aa), view(bb, 'b'.repeat(513 * 1024))], { mode: 'candidate' });
        expect(preserved).toMatchObject({ok:false,state:'preserved'});
        expect(c.failure).toBeUndefined();
        const failure = complete([view(aa), view(bb, 'b'.repeat(513 * 1024))]);
        expect(failure).toMatchObject({ ok: false, state: 'degraded' });
        const diagnostic = c.failure;
        expect(diagnostic).toMatchObject({ code: 'SNAPSHOT_SERIALIZATION_ERROR' });
        expect(publish()).toMatchObject({ status: 'rejected', issue: diagnostic });
        const whileFailed = vi.fn(() => frame(large));
        expect(c.commit(whileFailed, { mode: 'candidate' })).toMatchObject({ok:false,state:'preserved',issue:{code:'SNAPSHOT_UNREADY'}});
        expect(complete([view(), view(bb)], { mode: 'candidate' })).toMatchObject({ok:false,state:'preserved',issue:{code:'SNAPSHOT_UNREADY'}});
        expect(whileFailed).not.toHaveBeenCalled();
        expect(c.failure).toBe(diagnostic);
        expect(publish()).toMatchObject({ status: 'rejected', issue: diagnostic });
        expect(c.token().epoch).toBe(1);
        expect(accept).toHaveBeenCalledTimes(1);
        expect(core.store.readLatest('app')).toMatchObject({ status: 'degraded', lastGood: { views: [view()] } });
        expect(complete([view()])).toMatchObject({ ok: true });
        expect(publish()).toMatchObject({ status: 'published', snapshot: { revision: 2, admissionSinceRevision: 2 } });
        c.close();
        expect(complete(large, {mode:'candidate'})).toMatchObject({ok:false,state:'preserved',issue:{code:'APP_STOPPED'}});
    });

    it('keeps observation admission in the managed assembly', () => {
        const views = [view(aa, 'a'.repeat(400 * 1024)), view(bb, 'b'.repeat(400 * 1024))];
        const direct = fixture(), hosted = fixture(hostedObservationCapacityIssue);
        expect(direct.c.commit(() => direct.frame(views))).toMatchObject({ ok: true });
        expect(direct.publish().status).toBe('published');
        expect(hosted.c.commit(() => hosted.frame(views))).toMatchObject({ ok: false, state: 'degraded' });
        expect(hosted.publish()).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY' } });
    });

    it.each([false, true])('keeps the prior frame on a capacity rejection (same-route replacement: %s)', replace => {
        const before = view(aa, 'a'.repeat(300 * 1024));
        const { c, frame, core, publish } = fixture(hostedObservationCapacityIssue);
        const opening = { mode: 'candidate' } as const;
        expect(c.commit(() => frame([before]), opening)).toMatchObject({ ok: true });
        expect(publish().status).toBe('published');
        const first = replace ? { ...before, viewInstanceId: 'm:3' } : before;
        const accept = vi.fn();
        expect(c.commit(() => frame([first, view(bb, 'b'.repeat(450 * 1024))], [], accept), opening))
            .toMatchObject({ ok:false,state:'preserved', issue: { code: 'OBSERVATION_CAPACITY' } });
        expect(accept).not.toHaveBeenCalled();
        expect(publish().status).toBe('unchanged');
        expect(c.token().epoch).toBe(1);
        expect(core.store.readLatest('app')).toMatchObject({ status: 'ready', snapshot: { views: [before] } });
        expect(c.commit(() => frame([first, view(bb)]), opening)).toMatchObject({ ok: true });
        expect(publish().status).toBe('published');
        expect(core.store.readLatest('app')).toMatchObject({ status: 'ready', snapshot: { views: [first, view(bb)] } });
    });

    it.each([false, true])('preserves candidates regardless of prior healthy frame (prior healthy frame: %s)', hasBaseline => {
        const { c, frame } = fixture(hostedObservationCapacityIssue);
        if (hasBaseline) c.commit(() => frame());
        const large = [view(aa, 'a'.repeat(400 * 1024)), view(bb, 'b'.repeat(400 * 1024))];
        expect(c.commit(() => frame(large), { mode: 'candidate' }))
            .toMatchObject({ ok: false, state: 'preserved', issue: { code: 'OBSERVATION_CAPACITY' } });
    });

    it('reports other capacity errors and a close during admission through the failure path', () => {
        const hardLimit = { code: 'SNAPSHOT_CAPACITY', message: 'Hard limit reached' } as const;
        const capacity = vi.fn<typeof hostedObservationCapacityIssue>(() => undefined);
        const { c, frame } = fixture(capacity);
        c.commit(() => frame([view()]));
        capacity.mockReturnValueOnce(hardLimit);
        expect(c.commit(() => frame(), { mode: 'candidate' })).toMatchObject({ ok: false, state: 'preserved', issue: hardLimit });
        c.commit(() => frame([view()]));
        capacity.mockImplementationOnce(() => {
            c.close();
            return { code: 'OBSERVATION_CAPACITY', message: 'Observation limit reached' };
        });
        expect(c.commit(() => frame(), { mode: 'candidate' }))
            .toMatchObject({ ok:false,state:'preserved',issue:{code:'APP_STOPPED'} });
    });

    it('keeps first null and non-null → null transitions, including falsy replacements', () => {
        const { c, frame, publish, core } = fixture();
        for (const value of [null, 7, null, false, 0, ''] as const) {
            expect(c.commit(() => frame([view()], [ref(aa, 'selected', value)]))).toMatchObject({ ok: true });
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
        expect(c.commit(operation)).toMatchObject({ ok: false, state: 'degraded', issue: { message: expect.stringContaining('must be synchronous') } });
        expect(native).not.toHaveBeenCalled();
        const disguised = () => Promise.reject(new Error('rejected author work')) as unknown as CompleteProjectionFrame;
        expect(c.commit(disguised)).toMatchObject({ ok: false, state: 'degraded', issue: { message: expect.stringContaining('must be synchronous') } });
        expect(publish().status).toBe('rejected');
        expect(core.store.readLatest('app')).toMatchObject({ status: 'degraded', lastGood: latest.status === 'ready' ? latest.snapshot : undefined });
    });

    it('discards its prepared payload on close and rejects late submissions', () => {
        const { c, frame } = fixture();
        c.commit(() => frame([view()], [ref(aa, 'selected', { value: 1 })]));
        c.close();
        expect(preparedRefs(c)).toEqual([]);
        expect(c.commit(() => frame())).toMatchObject({ok:false,state:'preserved',issue:{code:'APP_STOPPED'}});
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
        const build = vi.fn(() => frame([view(), view(bb)], [ref(aa, 'items', a), ref(bb, 'selected', b)]));
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
            expect(c.commit(() => frame([], [], accept))).toMatchObject({ok:false,state:'preserved',issue:{message:expect.stringContaining('cannot change during preparation')}});
            return frame([view(aa, 'uncommitted')], [ref(aa, 'selected', { value: 2 })], accept);
        })).toMatchObject({ ok: false, state: 'degraded' });
        expect(publish().status).toBe('rejected');
        expect(accept).not.toHaveBeenCalled();
        expect(preparedRefs(c)[0]?.target.payload).toEqual({ value: 1 });
    });

    it('requires unambiguous IDs while keeping dotted keys in JSON values', () => {
        const { c, frame, publish } = fixture();
        for (const id of ['items.0', 'items[0]']) {
            expect(c.commit(() => frame([view()], [ref(aa, id, {})]))).toMatchObject({ ok: false, state: 'degraded' });
        }
        expect(c.commit(() => frame([view({ ...aa, viewId: 'a.b' })]))).toMatchObject({ ok: false, state: 'degraded' });
        expect(c.nextPublication()).toMatchObject({ failure: { issue: { code: 'SNAPSHOT_INVALID' } } });
        expect(c.commit(() => frame([view()], [ref(aa, 'items', { 'file.path': 'notes/a.txt' })])))
            .toMatchObject({ ok: true });
        expect(publish().status).toBe('published');
        expect(preparedRefs(c)).toMatchObject([{ id: 'items', target: { payload: { 'file.path': 'notes/a.txt' } } }]);
    });
});
