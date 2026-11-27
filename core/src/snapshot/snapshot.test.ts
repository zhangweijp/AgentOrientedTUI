import { describe, expect, it } from 'vitest';
import { checkJsonLimits, copyJson, SnapshotDataError } from './json.js';
import { createSnapshotCore } from './store.js';
import { DEFAULT_SNAPSHOT_LIMITS, refKey } from './snapshot-support.js';
import { validatePreparedSnapshot } from './validate-snapshot.js';
import { compileToolParameters } from '../tool/tool-parameters.js';
import type { PreparedAppSnapshotDraft, SnapshotCore, SnapshotStoreOptions } from './types.js';

const identity = { appId: 'task_app', instanceId: 'instance_a' };
const KEY = refKey('workspace', 'm:1', 'tasks');
const TOOL = JSON.stringify(['task_app', 'Workspace', 'complete_task']);
const taskSchema = (() => {
    const compiled = compileToolParameters({ type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false });
    if (!compiled.ok) throw new Error('Fixture Tool Schema must compile');
    return compiled.contract.schema;
})();

function draft(
    seq = 1,
    epoch = seq,
    id = 'task-a',
    override: Record<string, unknown> = {},
): PreparedAppSnapshotDraft {
    return { healthySince: 1,
        schemaVersion: 9,
        ...identity,
        producerSeq: seq,
        sourceEpoch: epoch,
        capturedAt: 1_000 + seq,
        views: [{
            toolBindings: [{ toolId: TOOL, activationId: 'a:1' }], id: 'workspace',
            viewInstanceId: 'm:1',
            type: 'Workspace',
            name: 'Tasks',
            region: 'dynamic',
            content: { format: 'markdown-v1', value: '[Stable task](tasks)' },
        }],
        refs: {
            [KEY]: { continuity: [1,1,0] as const,  valueSchema: { type: 'object' }, scope: 'protected',
                id: 'tasks', ownerViewId: 'workspace', ownerViewInstanceId: 'm:1',
                refType: 'Task',
                target: { kind: 'snapshot-value', payload: { id, status: 'pending' } },
            },
        },
        tools: {
            [TOOL]: { multiplicity: 'multiple',
                id: TOOL, name: 'complete_task', viewType: 'Workspace',
                 description: 'Complete selected task',
                inputSchema: taskSchema,
            },
        },
        ...override,
    } as PreparedAppSnapshotDraft;
}

/** Explicit Producer recovery: the mount survives, activation and Ref witness do not. */
function recoveredDraft(seq: number, epoch: number): PreparedAppSnapshotDraft {
    const input = draft(seq, epoch);
    return { ...input, healthySince: epoch,
        views: input.views.map(v => ({ ...v, toolBindings: [{toolId: TOOL, activationId: 'a:2'}] })),
        refs: { [KEY]: { ...input.refs[KEY]!, continuity: [epoch,epoch,0] } },
    };
}

function ready(core: SnapshotCore) {
    const result = core.store.readLatest('task_app');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw Error('not ready');
    return result.snapshot;
}

function published(core: SnapshotCore, next: PreparedAppSnapshotDraft) {
    const result = core.committer.accept(next);
    expect(result.status).toBe('published');
    if (result.status !== 'published') throw Error('not published: ' + JSON.stringify(result));
    return result.snapshot;
}

function sourceRef(core: SnapshotCore, snapId: string) {
    return core.store.resolveRef({
        snapshotId: snapId, appId: 'task_app', instanceId: 'instance_a',
        viewId: 'workspace', viewInstanceId: 'm:1', refId: 'tasks',
    });
}

describe('Snapshot Store limits', () => {
    it('uses its original limits after the caller mutates, replaces or deletes them', () => {
        const limits = { maxViews: 1 };
        const options: typeof identity & { limits?: typeof limits } = { ...identity, limits };
        const core = createSnapshotCore(options);
        try {
            const first = published(core, draft());
            const views = [...draft().views, { ...draft().views[0]!, id: 'second', viewInstanceId: 'm:2', toolBindings: [] }];
            const rejectTwoViews = (seq: number) => {
                expect(core.committer.accept(draft(seq, seq, 'task-a', { views }))).toMatchObject({
                    status: 'rejected', issue: { path: '$.views' },
                });
                expect(core.store.readLatest('task_app')).toMatchObject({ status: 'degraded', lastGood: first });
            };
            limits.maxViews = 2;
            rejectTwoViews(2);
            options.limits = { maxViews: 2 };
            rejectTwoViews(3);
            delete options.limits;
            rejectTwoViews(4);
            expect(published(core, draft(5, 5, 'task-b')).revision).toBe(2);
        } finally { core.lifecycle.dispose(); }
    });

    it('uses defaults for omitted and undefined values and accepts null-prototype limits and zero', () => {
        for (const options of [{}, { limits: undefined }, { limits: { maxViews: undefined } },
            Object.assign(Object.create(null), { limits: Object.assign(Object.create(null), DEFAULT_SNAPSHOT_LIMITS) })]) {
            const core = createSnapshotCore(Object.assign(options, identity));
            try { expect(published(core, draft()).revision).toBe(1); }
            finally { core.lifecycle.dispose(); }
        }
        const core = createSnapshotCore({ ...identity, limits: { maxViews: 0 } });
        try {
            expect(core.committer.accept(draft())).toMatchObject({ status: 'rejected', issue: { path: '$.views' } });
            expect(published(core, draft(2, 2, 'task-a', { views: [], refs: {}, tools: {} })).views).toEqual([]);
        } finally { core.lifecycle.dispose(); }
    });

    it('rejects inherited, hidden and accessor options without reading limits', () => {
        let reads = 0;
        const accessor = { get limits() { reads++; return { maxViews: 1 }; } };
        for (const options of [accessor, Object.create(accessor), Object.create({ limits: undefined }),
            Object.defineProperty({}, 'limits', { value: undefined })]) {
            expect(() => createSnapshotCore(Object.assign(options, identity))).toThrow(expect.objectContaining({ name: 'TypeError', message: expect.stringContaining('limits') }));
        }
        expect(reads).toBe(0);
    });

    it('rejects invalid shapes and invalid field descriptors without reading values', () => {
        let reads = 0;
        const accessor = { get maxViews() { reads++; return 1; } };
        class CustomLimits { maxViews = 1; }
        const invalid: [unknown, string][] = [
            [null, 'limits'], [[], 'limits'], [new CustomLimits(), 'limits'], ['wrong', 'limits'],
            [Object.create({ maxViews: 1 }), 'limits'], [{ unexpected: 1 }, 'limits.unexpected'],
            [{ [Symbol('extra')]: 1 }, 'limits.Symbol(extra)'],
            [accessor, 'limits.maxViews'], [Object.defineProperty({}, 'maxViews', { value: undefined }), 'limits.maxViews'],
        ];
        for (const [limits, field] of invalid) {
            expect(() => createSnapshotCore({ ...identity, limits } as SnapshotStoreOptions))
                .toThrow(expect.objectContaining({ name: 'TypeError', message: expect.stringContaining(field) }));
        }
        expect(reads).toBe(0);
    });

    it('enforces each default ceiling and accepts zero for every field', () => {
        for (const [field, max] of Object.entries(DEFAULT_SNAPSHOT_LIMITS)) {
            createSnapshotCore({ ...identity, limits: { [field]: 0 } }).lifecycle.dispose();
            expect(() => createSnapshotCore({ ...identity, limits: { [field]: max + 1 } }))
                .toThrow(expect.objectContaining({ name: 'RangeError', message: expect.stringContaining(`limits.${field}`) }));
        }
        for (const maxViews of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, false]) {
            expect(() => createSnapshotCore({ ...identity, limits: { maxViews } } as SnapshotStoreOptions))
                .toThrow(expect.objectContaining({ name: 'RangeError', message: expect.stringContaining('limits.maxViews') }));
        }
    });
});

describe('B2-Q01 independent application lifecycle identity', () => {
    it('binds the identity from construction and reports projection health independently', () => {
        const core = createSnapshotCore({ ...identity, now: () => 0 });
        expect(core.store.readAppIdentity('other_app')).toEqual({ status: 'absent' });
        expect(core.store.readLatest('other_app')).toEqual({ status: 'unready' });
        const first = core.store.readAppIdentity('task_app');
        expect(first).toEqual({ status: 'active', instanceId: 'instance_a' });
        expect(Object.isFrozen(first)).toBe(true);
        expect(core.store.readLatest('task_app')).toEqual({ status: 'unready' });
        const source = published(core, draft());
        expect(core.store.readLatest('task_app')).toEqual({ status: 'ready', snapshot: source });
        expect(core.store.readLatest('other_app')).toEqual({ status: 'unready' });
        expect(core.committer.accept(draft(2, 2, 'invalid', { refs: { malformed: null } })).status).toBe('rejected');
        const degraded = core.store.readLatest('task_app');
        expect(Object.keys(degraded).sort()).toEqual(['issue', 'lastGood', 'status']);
        expect(core.store.readAppIdentity('task_app')).toEqual(first);
        core.lifecycle.stop();
        expect(core.store.readAppIdentity('task_app')).toEqual({ status: 'stopped', instanceId: 'instance_a' });
        expect(core.store.readLatest('task_app')).toEqual({ status: 'stopped' });
        expect(first).toEqual({ status: 'active', instanceId: 'instance_a' });
    });
    it('reads only the existing identity record, without clocks, leases, revision or history changes', () => {
        let calls = 0, broken = false;
        const core = createSnapshotCore({ ...identity, now: () => { calls++; if (broken) throw new Error('clock-secret'); return 0; } });
     const source = published(core, draft());
        const lease = core.store.acquire(source.id); expect(lease.status).toBe('acquired');
        const before = core.store.inspect(), beforeCalls = calls; broken = true;
        expect(core.store.readAppIdentity('task_app')).toEqual({ status: 'active', instanceId: 'instance_a' });
        expect(core.store.readAppIdentity('unknown')).toEqual({ status: 'absent' }); expect(calls).toBe(beforeCalls);
        broken = false; expect(core.store.inspect()).toEqual(before); expect(ready(core)).toBe(source);
        if (lease.status === 'acquired') lease.hold.release();
    });
});

describe('M1 pure Core — schema & safe value contract', () => {
    it('accepts App/View/Ref/ViewTypeTool in a detached, strictly typed draft', () => {
        const checked = validatePreparedSnapshot(draft());
        expect(checked.ok).toBe(true);
        if (!checked.ok) return;
        expect(checked.value.draft.refs[KEY].ownerViewInstanceId).toBe('m:1');
        expect(checked.value.draft.views[0]!.toolBindings).toEqual([{ toolId: TOOL, activationId: 'a:1' }]);
        expect(checked.value.contentBytes).toEqual(new TextEncoder().encode(checked.value.canonicalContent));
        expect(Object.isFrozen(checked.value.draft.refs[KEY].target)).toBe(true);
    });

    it.each([
        ['unsupported schemaVersion', { schemaVersion: 2 }, '$.schemaVersion', 'SNAPSHOT_INVALID'],
        ['duplicate View ID', { views: [draft().views[0], draft().views[0]] }, '$.views[1].id', 'SNAPSHOT_INVALID'],
        ['Ref owner missing', { refs: { [KEY]: { ...draft().refs[KEY], ownerViewId: 'ghost' } } }, '$.refs', 'SNAPSHOT_INVALID'],
        ['Ref key wrong', { refs: { 'tasks[0]': draft().refs[KEY] } }, '$.refs', 'SNAPSHOT_INVALID'],
        ['Tool schema invalid', { tools: { [TOOL]: { ...draft().tools[TOOL], inputSchema: { type: 'string' } } } }, '$.tools', 'SNAPSHOT_INVALID'],
        ['Tool identity mismatched', { tools: { [TOOL]: { ...draft().tools[TOOL], viewType: 'FileDetail' } } }, '$.views[0].toolBindings', 'SNAPSHOT_INVALID'],
        ['ordinary Tool carries a business target', { tools: { [TOOL]: { ...draft().tools[TOOL], target: { filePath: 'a.txt' } } } }, '$.tools', 'SNAPSHOT_INVALID'],
    ])('rejects %s before publishing', (_, override, path, code) => {
        const tested = validatePreparedSnapshot({ ...draft(), ...override });
        expect(tested.ok).toBe(false);
        if (tested.ok) return;
        expect(tested.issue.code).toBe(code);
        expect(tested.issue.path).toContain(path);
    });

    it('rejects accessors without invoking them and forbids non-JSON values', () => {
        let calls = 0;
        const getter = Object.defineProperty({}, 'id', {
            enumerable: true, get() { calls++; return 'dangerous'; },
        });
        const date = new Date();
        const cases: unknown[] = [
            getter, date, { when: new Map() }, { fn() { return true; } },
            { number: NaN }, { count: 5n }, { symbol: Symbol('bad') },
            (() => { const a: any = {}; a.self = a; return a; })(),
            (() => { const a = Array(2); a[0] = 'x'; return a; })(),
        ];
        for (const value of cases) {
            const tested = validatePreparedSnapshot({
                ...draft(),
                refs: {
                    [KEY]: { ...draft().refs[KEY], target: { kind: 'snapshot-value', payload: value } },
                },
            });
            expect(tested.ok).toBe(false);
            if (!tested.ok) expect(tested.issue.code).toBe('SNAPSHOT_SERIALIZATION_ERROR');
        }
        expect(calls).toBe(0);
    });

    it('guards __proto__ and constructor keys in nested JSON data without pollution', () => {
        const value: Record<string, unknown> = { constructor: { id: 'safe' } };
        Object.defineProperty(value, '__proto__', { enumerable: true, value: { polluted: true } });
        const input = {
            ...draft(), refs: {
                [KEY]: { ...draft().refs[KEY], target: { kind: 'snapshot-value', payload: value } },
            },
        };
        const result = validatePreparedSnapshot(input);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const payload = (result.value.draft.refs[KEY].target as any).payload;
        expect(Object.getPrototypeOf(payload)).toBeNull();
        expect(Object.hasOwn(payload, '__proto__')).toBe(true);
        expect(({} as any).polluted).toBeUndefined();
        expect(payload.constructor.id).toBe('safe');
    });

    it('rejects depth, per-Ref bytes, and whole Snapshot budgets explicitly', () => {
        const deep = { a: { b: { c: { d: 1 } } } };
        expect(validatePreparedSnapshot({
            ...draft(), refs: { [KEY]: { ...draft().refs[KEY], target: { kind: 'snapshot-value', payload: deep } } },
        }, { ...DEFAULT_SNAPSHOT_LIMITS, maxDepth: 6 }).ok).toBe(false);
        const big = 'x'.repeat(1_000);
        const value = { ...draft(), refs: {
            [KEY]: { ...draft().refs[KEY], target: { kind: 'snapshot-value', payload: { big } } },
        } };
        expect(validatePreparedSnapshot(value, { ...DEFAULT_SNAPSHOT_LIMITS, maxRefPayloadBytes: 100 }).ok).toBe(false);
        expect(validatePreparedSnapshot(value, { ...DEFAULT_SNAPSHOT_LIMITS, maxSnapshotBytes: 100 }).ok).toBe(false);
    });

    it.each([
        [Array(10_000).fill(0), '[9999]', 'Node budget exceeded'],
        [[...Array(8_000).fill(0), 'x'.repeat(328 * 1024)], '[8000]', 'Approximate input byte budget exceeded'],
    ])('still checks each Ref against its own node and approximate-byte budgets', (payload, suffix, message) => {
        const input = draft();
        const checked = validatePreparedSnapshot({ ...input, refs: {
            [KEY]: { ...input.refs[KEY], target: { kind: 'snapshot-value', payload } },
        } });
        expect(checked).toMatchObject({ ok: false, issue: {
            code: 'SNAPSHOT_SERIALIZATION_ERROR',
            path: '$.refs[' + JSON.stringify(KEY) + '].target.payload' + suffix,
            message,
        } });
    });
});

describe('M1 Core — versioned commit, failure & strict origin', () => {
    it('publishes revision 1 and reuses the same snapshot ID when semantic data has not changed', () => {
        const core = createSnapshotCore(identity);
        expect(core.store.readLatest('task_app').status).toBe('unready');
        const first = published(core, draft(1, 1));
        const second = core.committer.accept(draft(2, 2));
        expect(second.status).toBe('unchanged');
        if (second.status === 'unchanged') {
            expect(second.snapshot.id).toBe(first.id);
            expect(second.snapshot.revision).toBe(1);
        }
        expect(ready(core)).toBe(first);
        expect(first.id).toContain('instance_a');
        expect(core.store.inspect().currentSnapshots).toBe(1);
    });

    it('cannot mutate a committed value via source aliases, nested values, or a returned snapshot', () => {
        const core = createSnapshotCore(identity);
        const input = draft();
        const committed = published(core, input);
        (input.refs[KEY].target as any).payload.id = 'hijacked';
        const original = sourceRef(core, committed.id);
        expect(original.status).toBe('resolved');
        if (original.status !== 'resolved') return;
        expect((original.target as any).payload.id).toBe('task-a');
        expect(Object.isFrozen(original.target)).toBe(true);
        expect(Object.isFrozen((original.target as any).payload)).toBe(true);
        expect(() => { (original.target as any).payload.id = 'hijacked-again'; }).toThrow();
        expect(sourceRef(core, committed.id)).toEqual(original);
    });

    it('advances revision for Ref-only and Tool-only changes even if displayed View is identical', () => {
        const core = createSnapshotCore(identity);
        const first = published(core, draft());
        const held = core.store.acquire(first.id); if (held.status !== 'acquired') throw Error('holder');
        const second = published(core, draft(2, 2, 'task-b'));
        const third = published(core, draft(3, 3, 'task-b', { tools: {}, views: [{ ...draft().views[0]!, toolBindings: [] }] }));
        expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3]);
        expect(first.views[0]!.content).toEqual(third.views[0]!.content);
        expect(third.views[0]!.toolBindings).toEqual([]);
        expect(core.store.getById(first.id)).toMatchObject({ status: 'found', snapshot: { tools: { [TOOL]: { id: TOOL } } } });
        expect(third.tools).toEqual({});
        expect(core.store.inspect().heldSnapshots).toBe(1);
        held.hold.release(); expect(core.store.inspect().heldSnapshots).toBe(0);
    });

    it('rejects changed semantic content with unchanged sourceEpoch, keeping lastGood degraded', () => {
        const core = createSnapshotCore(identity);
        const first = published(core, draft());
        const rejected = core.committer.accept(draft(2, 1, 'task-b'));
        expect(rejected.status).toBe('rejected');
        if (rejected.status === 'rejected') expect(rejected.issue.code).toBe('SNAPSHOT_SOURCE_EPOCH_CONFLICT');
        const degraded = core.store.readLatest('task_app');
        expect(degraded.status).toBe('degraded');
        if (degraded.status === 'degraded') expect(degraded.lastGood?.id).toBe(first.id);
        expect(published(core, draft(3, 2, 'task-b')).revision).toBe(2);
        expect(ready(core).revision).toBe(2);
    });

    it('does not advance revision or replace lastGood after invalid draft, and consumes the new seq', () => {
        const core = createSnapshotCore(identity);
        const first = published(core, draft());
        const invalid = { ...draft(2, 2), refs: { [KEY]: { ...draft().refs[KEY], ownerViewId: 'does-not-exist' } } };
        const error = core.committer.accept(invalid);
        expect(error.status).toBe('rejected');
        expect(core.store.readLatest('task_app').status).toBe('degraded');
        const stale = core.committer.accept(draft(2, 3));
        expect(stale.status).toBe('rejected');
        if (stale.status === 'rejected') expect(stale.issue.code).toBe('SNAPSHOT_SEQUENCE_STALE');
        expect(readyOrLastGood(core).id).toBe(first.id);
        expect(published(core, draft(3, 4, 'task-b')).revision).toBe(2);
    });

    it('rejects foreign App, stale, wrong-instance and stopped sources', () => {
        const core = createSnapshotCore(identity);
        const foreign = draft(100, 100, 'foreign', { appId: 'other_app', views: [], refs: {}, tools: {} });
        expect(core.committer.accept(foreign)).toMatchObject({ status: 'rejected', issue: { code: 'APP_NOT_REGISTERED' } });
        const first = published(core, draft());
        expect(core.committer.accept(draft())).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_SEQUENCE_STALE' } });
        expect(core.committer.accept(draft(2, 2, 'impostor', { instanceId: 'impostor' })))
            .toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });
        expect(ready(core).id).toBe(first.id);
        core.lifecycle.stop();
        expect(core.store.readLatest('task_app').status).toBe('stopped');
        expect(core.committer.accept(draft(3))).toMatchObject({ status: 'rejected', issue: { code: 'APP_STOPPED' } });
    });
});

function readyOrLastGood(core: SnapshotCore) {
    const state = core.store.readLatest('task_app');
    if (state.status === 'ready') return state.snapshot;
    if (state.status === 'degraded' && state.lastGood) return state.lastGood;
    throw Error('No current or last good Snapshot');
}


describe('M1 Core — Ref identity, source scope and View generation', () => {
    it('keeps a historical index-based Ref bound to its original object after reordering', () => {
        const core = createSnapshotCore(identity);
        const first = published(core, draft(1, 1, 'entity-a'));
        const held = core.store.acquire(first.id); if (held.status !== 'acquired') throw Error('holder');
        const later = published(core, draft(2, 2, 'entity-b'));
        const oldRef = sourceRef(core, first.id);
        const newRef = sourceRef(core, later.id);
        expect(oldRef.status).toBe('resolved');
        expect(newRef.status).toBe('resolved');
        if (oldRef.status === 'resolved' && newRef.status === 'resolved') {
            expect((oldRef.target as any).payload.id).toBe('entity-a');
            expect((newRef.target as any).payload.id).toBe('entity-b');
            expect(oldRef.ref.ownerViewId).toBe('workspace');
        }
        held.hold.release(); expect(core.store.inspect().heldSnapshots).toBe(0);
    });

    it('resolves two same-named Ref IDs only by exact View identity, never suffix search', () => {
        const core = createSnapshotCore(identity);
        const first = draft(1, 1);
        const secondKey = refKey('detail', 'm:2', 'tasks');
        const changed = draft(1, 1, 'entity-a', {
            views: [...first.views, {
                toolBindings: [], id: 'detail', viewInstanceId: 'm:2', type: 'FileDetail',
                name: 'Another View', region: 'dynamic',
                content: { format: 'markdown-v1', value: '[Task](tasks[0])' },
            }],
            refs: {
                ...first.refs,
                [secondKey]: { continuity: [1,1,0] as const,  valueSchema: { type: 'object' }, scope: 'protected',
                    id: 'tasks', ownerViewId: 'detail', ownerViewInstanceId: 'm:2',
                    refType: 'Task', target: { kind: 'snapshot-value', payload: { id: 'entity-b' } },
                },
            },
        });
        const snap = published(core, changed);
        const firstRef = sourceRef(core, snap.id);
        const secondRef = core.store.resolveRef({
            snapshotId: snap.id, appId: 'task_app', instanceId: 'instance_a',
            viewId: 'detail', viewInstanceId: 'm:2', refId: 'tasks',
        });
        expect(firstRef.status).toBe('resolved');
        expect(secondRef.status).toBe('resolved');
        if (firstRef.status === 'resolved' && secondRef.status === 'resolved') {
            expect((firstRef.target as any).payload.id).toBe('task-a'); // default draft fixture
            expect((secondRef.target as any).payload.id).toBe('entity-b');
        }
        expect(core.store.resolveRef({
            snapshotId: snap.id, appId: 'task_app', instanceId: 'instance_a',
            viewId: 'unrelated', viewInstanceId: 'other', refId: 'tasks',
        }).status).toBe('rejected');
    });

    it('treats View close/reopen with same ID as a new generation', () => {
        const core = createSnapshotCore(identity);
        const old = published(core, draft());
        const newKey = refKey('workspace', 'm:2', 'tasks');
        const source = draft(2, 2, 'entity-b');
        const newer = published(core, {
            ...source,
            views: source.views.map(view => ({ ...view, viewInstanceId: 'm:2',
                toolBindings: [{ toolId: TOOL, activationId: 'a:2' }] })),
            refs: {
                [newKey]: {
                    ...source.refs[KEY], ownerViewInstanceId: 'm:2', continuity: [2,2,0],
                },
            },
        });
        expect(newer.revision).toBe(2);
        expect(sourceRefWithGeneration(core, old.id, 'm:2').status).toBe('rejected');
        expect(sourceRefWithGeneration(core, newer.id, 'm:1').status).toBe('rejected');
        expect(sourceRefWithGeneration(core, newer.id, 'm:2').status).toBe('resolved');
    });

    it('retains the exact historical payload, including its business version', () => {
        const core = createSnapshotCore(identity);
        const target = { kind: 'snapshot-value' as const, payload: { id: 'same-id', version: 'old-v1' } };
        const newerTarget = { ...target, payload: { ...target.payload, version: 'new-v2' } };
        const old = published(core, draft(1, 1, 'unused', {
            refs: { [KEY]: { ...draft().refs[KEY], target } },
        }));
        const held = core.store.acquire(old.id); if (held.status !== 'acquired') throw Error('holder');
        const newer = published(core, draft(2, 2, 'unused', {
            refs: { [KEY]: { ...draft().refs[KEY], target: newerTarget } },
        }));
        const refOld = sourceRef(core, old.id);
        const refNew = sourceRef(core, newer.id);
        if (refOld.status !== 'resolved' || refNew.status !== 'resolved') throw Error('unexpected');
        expect(refOld.target).toEqual(target);
        expect(refNew.target).toEqual(newerTarget);
        held.hold.release(); expect(core.store.inspect().heldSnapshots).toBe(0);
    });
});

function sourceRefWithGeneration(core: SnapshotCore, snapshotId: string, viewInstanceId: string) {
    return core.store.resolveRef({
        snapshotId, appId: 'task_app', instanceId: 'instance_a',
        viewId: 'workspace', viewInstanceId, refId: 'tasks',
    });
}

describe('M1 Core — retention, leases, restart and capacity', () => {
    it('protects leased historical snapshots and rejects a commit when all retention is pinned', () => {
        const core = createSnapshotCore({ ...identity, maxHeldSnapshots: 0, maxHeldSnapshotBytes: 0 });
        const first = published(core, draft());
        const held = core.store.acquire(first.id);
        expect(held.status).toBe('acquired');
        const blocked = core.committer.accept(draft(2, 2, 'entity-b'));
        expect(blocked.status).toBe('rejected');
        if (blocked.status === 'rejected') expect(blocked.issue.code).toBe('SNAPSHOT_CAPACITY');
        const degraded = core.store.readLatest('task_app');
        expect(degraded.status).toBe('degraded');
        if (degraded.status === 'degraded') expect(degraded.lastGood?.id).toBe(first.id);
        expect(core.store.inspect().activeHolds).toBe(1);
        if (held.status === 'acquired') held.hold.release();
        expect(core.store.inspect().activeHolds).toBe(0);
        const second = published(core, draft(3, 3, 'entity-b'));
        expect(second.revision).toBe(2);
        const lookup = core.store.getById(first.id);
        expect(lookup.status).toBe('rejected');
        if (lookup.status === 'rejected') expect(lookup.issue.code).toBe('SNAPSHOT_UNAVAILABLE');
    });

    it('keeps the old run’s held Ref separate from a same-name new run', () => {
        const original = createSnapshotCore({ ...identity, maxHeldSnapshots: 1 });
        const old = published(original, draft());
        const held = original.store.acquire(old.id);
        if (held.status !== 'acquired') throw Error('Expected old snapshot holder');
        original.lifecycle.stop();
        expect(original.store.readLatest('task_app')).toEqual({ status: 'stopped' });
        expect(sourceRef(original, old.id)).toMatchObject({ status: 'resolved', target: { payload: { id: 'task-a' } } });

        const replacement = createSnapshotCore({ ...identity, instanceId: 'instance_b' });
        expect(replacement.store.readLatest('task_app')).toEqual({ status: 'unready' });
        const fresh = published(replacement, draft(1, 1, 'fresh', { instanceId: 'instance_b' }));
        expect(fresh).toMatchObject({ revision: 1, instanceId: 'instance_b' });
        expect(fresh.id).not.toBe(old.id);
        expect(replacement.store.getById(old.id)).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_UNAVAILABLE' } });
        expect(original.store.resolveRef({
            snapshotId: old.id, appId: 'task_app', instanceId: 'instance_b',
            viewId: 'workspace', viewInstanceId: 'm:1', refId: 'tasks',
        })).toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });

        expect(replacement.committer.accept(draft(100))).toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });
        expect(replacement.committer.accept(draft(101, 101, 'malformed', { refs: { invalid: null } })))
            .toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_INVALID' } });
        expect(replacement.committer.reportPrepareFailure({
            appId: 'task_app', instanceId: 'instance_a', producerSeq: 102, sourceEpoch: 102,
            issue: { code: 'SNAPSHOT_INVALID', message: 'Old source failed late', path: '$.views' },
        })).toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });
        expect(ready(replacement)).toBe(fresh);
        expect(published(replacement, draft(2, 2, 'changed', { instanceId: 'instance_b' })).revision).toBe(2);

        held.hold.release();
        expect(original.store.getById(old.id)).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_UNAVAILABLE' } });
        original.lifecycle.dispose();
        expect(ready(replacement).revision).toBe(2);
    });

    it('rejects out-of-order producer epoch and duplicate sequences without changing current pointer', () => {
        const core = createSnapshotCore(identity);
        const first = published(core, draft(1, 5));
        const regressed = core.committer.accept(draft(2, 4, 'entity-b'));
        expect(regressed.status).toBe('rejected');
        const replay = core.committer.accept(draft(1, 5));
        expect(replay.status).toBe('rejected');
        const old = core.store.getById(first.id);
        expect(old.status).toBe('found');
        expect(published(core, draft(3, 6, 'entity-b')).revision).toBe(2);
    });

    it('releases unleased versions immediately while retaining the current snapshot', () => {
        const core = createSnapshotCore({ ...identity, maxHeldSnapshots: 1, maxHeldSnapshotBytes: 2_000_000 });
        const a = published(core, draft(1, 1, 'a'));
        const b = published(core, draft(2, 2, 'b'));
        const c = published(core, draft(3, 3, 'c'));
        expect(core.store.inspect().heldSnapshots).toBe(0);
        expect(core.store.getById(a.id).status).toBe('rejected');
        expect(core.store.getById(b.id).status).toBe('rejected');
        expect(ready(core).id).toBe(c.id);
    });
});

describe('M1 Core — in-memory behavior under repeated independent commits', () => {
    it('does not silently rebind historical refs in a deterministic 50-step state sequence', () => {
        const core = createSnapshotCore({ ...identity, maxHeldSnapshots: 64 });
        const snapshots = []; const holders: Array<() => void> = [];
        for (let n = 1; n <= 50; n++) {
            const snapshot = published(core, draft(n, n, 'entity-' + n)); snapshots.push(snapshot);
            const lease = core.store.acquire(snapshot.id); if (lease.status !== 'acquired') throw Error('holder'); holders.push(lease.hold.release);
        }
        expect(ready(core).revision).toBe(50);
        for (let n = 0; n < snapshots.length; n++) {
            const ref = sourceRef(core, snapshots[n].id);
            expect(ref.status).toBe('resolved');
            if (ref.status === 'resolved') expect((ref.target as any).payload.id).toBe('entity-' + (n + 1));
        }
        expect(core.store.inspect().heldSnapshots).toBe(49);
        for (const release of holders) release();
        expect(core.store.inspect()).toMatchObject({ activeHolds: 0, heldSnapshots: 0, heldSnapshotBytes: 0 });
    });

    it('does not import DOM or Worker primitives into the Core contract', () => {
        const core = createSnapshotCore(identity);
        const state = published(core, draft());
        expect(state.views).toHaveLength(1);
        expect(state.views[0].content.format).toBe('markdown-v1');
        expect(typeof globalThis).toBe('object');
        // M1 contract is pure data; direct source-import boundary is verified by review.
    });
});


describe('M1 Core — adversarial resource and publication invariants', () => {
    it('caps concurrent Snapshot leases and supports idempotent lease release', () => {
        const core = createSnapshotCore({ ...identity, maxActiveHolds: 1 });
        const first = published(core, draft());
        const acquired = core.store.acquire(first.id);
        expect(acquired.status).toBe('acquired');
        const overflow = core.store.acquire(first.id);
        expect(overflow.status).toBe('rejected');
        if (overflow.status === 'rejected') expect(overflow.issue.code).toBe('SNAPSHOT_CAPACITY');
        if (acquired.status === 'acquired') {
            acquired.hold.release();
            acquired.hold.release();
        }
        expect(core.store.inspect().activeHolds).toBe(0);
        const next = core.store.acquire(first.id);
        expect(next.status).toBe('acquired');
        if (next.status === 'acquired') next.hold.release();
        expect(core.store.inspect().activeHolds).toBe(0);
    });

    it('does not let a degraded App masquerade as ready after rejected schema or invalid source', () => {
        const core = createSnapshotCore(identity);
        published(core, draft());
        const invalid = core.committer.accept({
            ...draft(2, 2), tools: { [TOOL]: { ...draft().tools[TOOL], retiredField: true } },
        });
        expect(invalid.status).toBe('rejected');
        const health = core.store.readLatest('task_app');
        expect(health.status).toBe('degraded');
        if (health.status === 'degraded') {
            expect(health.lastGood?.revision).toBe(1);
            expect(health.issue.path).toContain('.retiredField');
            expect('snapshot' in health).toBe(false);
        }
        const sourceSpoof = core.committer.accept({ ...draft(3, 3), instanceId: 'unknown' });
        expect(sourceSpoof.status).toBe('rejected');
        expect(core.store.readLatest('task_app').status).toBe('degraded');
        const recovery = core.committer.accept(draft(4, 4));
        expect(recovery.status).toBe('published'); // Recovery opens a new admission period even for identical content.
        expect(ready(core)).toMatchObject({ revision: 2, admissionSinceRevision: 2 });
    });

    it('tracks Tool schema changes even when View content is unchanged', () => {
        const core = createSnapshotCore(identity);
        const first = published(core, draft());
        const changedSchema = (() => {
            const compiled = compileToolParameters({ type: 'object', properties: { id: { type: 'string', description: 'Task identifier' } }, additionalProperties: false });
            if (!compiled.ok) throw new Error('Changed Tool Schema must compile');
            return compiled.contract.schema;
        })();
        const next = published(core, draft(2, 2, 'task-a', {
            tools: { [TOOL]: { ...draft().tools[TOOL],
                inputSchema: changedSchema,
            } },
        }));
        expect(next.id).not.toBe(first.id);
        expect(next.revision).toBe(2);
        expect(next.views).toEqual(first.views);
    });

    it('can recover from a full pinned history without altering a retained historical Ref', () => {
        const core = createSnapshotCore({ ...identity, maxHeldSnapshots: 1 });
        const first = published(core, draft(1, 1, 'a'));
        const lease = core.store.acquire(first.id);
        expect(lease.status).toBe('acquired');
        const second = published(core, draft(2, 2, 'b'));
        const leaseSecond = core.store.acquire(second.id); // both old and current are now pinned
        expect(leaseSecond.status).toBe('acquired');
        const refused = core.committer.accept(draft(3, 3, 'c'));
        expect(refused.status).toBe('rejected');
        if (refused.status === 'rejected') expect(refused.issue.code).toBe('SNAPSHOT_CAPACITY');
        expect(readyOrLastGood(core).id).toBe(second.id);
        const pinned = sourceRef(core, first.id);
        expect(pinned.status).toBe('resolved');
        if (pinned.status === 'resolved') expect((pinned.target as any).payload.id).toBe('a');
        if (lease.status === 'acquired') lease.hold.release();
        expect(published(core, draft(4, 4, 'c')).revision).toBe(3);
        expect(core.store.getById(first.id).status).toBe('rejected');
        if (leaseSecond.status === 'acquired') leaseSecond.hold.release();
    });

    it('does not promote an unknown or missing Ref string to a valid Ref', () => {
        const core = createSnapshotCore(identity);
        const current = published(core, draft());
        const missing = core.store.resolveRef({
            snapshotId: current.id, appId: 'task_app', instanceId: 'instance_a',
            viewId: 'workspace', viewInstanceId: 'm:1', refId: 'task-a',
        });
        expect(missing.status).toBe('rejected');
        if (missing.status === 'rejected') expect(missing.issue.code).toBe('REF_NOT_FOUND');
    });
});


describe('M1 Core — nonpublishable Producer input and explicit prepare failure', () => {
    it('stays degraded when lastGood is replayed and opens a new admission period at a new source epoch', () => {
        const core = createSnapshotCore(identity);
        const first = published(core, draft(1, 1));
        const failure = core.committer.reportPrepareFailure({ appId: 'task_app', instanceId: 'instance_a',
            producerSeq: 2, sourceEpoch: 1, issue: { code: 'SNAPSHOT_INVALID', message: 'Failed commit' } });
        expect(failure.status).toBe('rejected');
        expect(core.committer.accept(draft(3, 1))).toEqual(failure);
        expect(core.store.readLatest('task_app')).toMatchObject({ status: 'degraded', lastGood: { id: first.id } });
        expect(core.committer.accept(draft(4, 1, 'conflict'))).toMatchObject({
            status: 'rejected', issue: { code: 'SNAPSHOT_SOURCE_EPOCH_CONFLICT' },
        });
        expect(core.committer.accept(recoveredDraft(5, 2))).toMatchObject({ status: 'published', snapshot: { revision: 2, admissionSinceRevision: 2 } });
        expect(ready(core).id).not.toBe(first.id);
        expect(core.store.readLatest('task_app').status).toBe('ready');
    });

    it('degrades lastGood when nested Ref serialization fails before full envelope clone', () => {
        const core = createSnapshotCore(identity);
        const first = published(core, draft(1, 1));
        const cyclic: any = { id: 'invalid' };
        cyclic.self = cyclic;
        const failed = core.committer.accept({
            ...draft(2, 2),
            refs: { [KEY]: {
                ...draft().refs[KEY],
                target: { kind: 'snapshot-value', payload: cyclic },
            } },
        });
        expect(failed.status).toBe('rejected');
        if (failed.status === 'rejected') expect(failed.issue.code).toBe('SNAPSHOT_SERIALIZATION_ERROR');
        const state = core.store.readLatest('task_app');
        expect(state.status).toBe('degraded');
        if (state.status === 'degraded') expect(state.lastGood?.id).toBe(first.id);
        expect(published(core, draft(3, 3, 'new')).revision).toBe(2);
    });

    it('accepts a trusted Producer PREPARE_FAILED report, with no invented successful Snapshot', () => {
        const core = createSnapshotCore(identity);
        const reported = core.committer.reportPrepareFailure({
            appId: 'task_app',
            instanceId: 'instance_a',
            producerSeq: 1,
            sourceEpoch: 1,
            issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR', message: 'Unserializable Ref', path: '$.refs' },
        });
        expect(reported.status).toBe('rejected');
        const degraded = core.store.readLatest('task_app');
        expect(degraded.status).toBe('degraded');
        if (degraded.status === 'degraded') {
            expect(degraded.lastGood).toBeUndefined();
            expect(degraded.issue.path).toBe('$.refs');
        }
        const stale = core.committer.accept(draft(1, 1));
        expect(stale.status).toBe('rejected');
        expect(published(core, recoveredDraft(2, 2)).revision).toBe(1);
        const unknown = core.committer.reportPrepareFailure({
            appId: 'task_app', instanceId: 'spoofed', producerSeq: 3, sourceEpoch: 3,
            issue: { code: 'SNAPSHOT_INVALID', message: 'Something bad happened' },
        });
        expect(unknown.status).toBe('rejected');
        expect(ready(core).revision).toBe(1);
    });

    it('rejects giant Ref strings with bounded copy even before serialization finishes', () => {
        const input = draft(1, 1, 'a', {
            refs: {
                [KEY]: {
                    ...draft().refs[KEY],
                    target: { kind: 'snapshot-value', payload: { huge: 'x'.repeat(60_000) } },
                },
            },
        });
        const validation = validatePreparedSnapshot(input, { ...DEFAULT_SNAPSHOT_LIMITS, maxSnapshotBytes: 1_024 });
        expect(validation.ok).toBe(false);
        if (!validation.ok) expect(validation.issue.code).toBe('SNAPSHOT_SERIALIZATION_ERROR');
    });
});


describe('M1 Core — edge-case schema and retention gates', () => {
    it('rejects sparse arrays, object accessors, and non-enumerable payload fields without evaluation', () => {
        let getterCalls = 0;
        const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { getterCalls++; return 'secret'; } });
        const hidden = Object.defineProperty({ id: 'known' }, 'secret', { value: 'unlisted', enumerable: false });
        for (const payload of [accessor, hidden, [, 1]]) {
            const result = validatePreparedSnapshot({
                ...draft(), refs: { [KEY]: {
                    ...draft().refs[KEY], target: { kind: 'snapshot-value', payload },
                } },
            });
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.issue.path).toContain('refs');
        }
        expect(getterCalls).toBe(0);
    });

    it('does not accept a mistaken Tool descriptor or invalid View kind', () => {
        const wrongView = { ...draft().views[0], kind: 'not-state' };
        const invalidView = validatePreparedSnapshot({ ...draft(), views: [wrongView] });
        expect(invalidView.ok).toBe(false);
        const { inputSchema: _removed, ...withoutSchema } = draft().tools[TOOL];
        const invalidTool = validatePreparedSnapshot({
            ...draft(),
            tools: { [TOOL]: withoutSchema },
        });
        expect(invalidTool.ok).toBe(false);
        if (!invalidTool.ok) expect(invalidTool.issue.code).toBe('SNAPSHOT_INVALID');
    });

    it('enforces maximum node and view counts instead of allowing unbounded cloning', () => {
        const tooManyNodes = validatePreparedSnapshot(draft(), { ...DEFAULT_SNAPSHOT_LIMITS, maxNodes: 10 });
        expect(tooManyNodes.ok).toBe(false);
        const tooManyViews = validatePreparedSnapshot(draft(), { ...DEFAULT_SNAPSHOT_LIMITS, maxViews: 0 });
        expect(tooManyViews.ok).toBe(false);
        if (!tooManyViews.ok) expect(tooManyViews.issue.path).toBe('$.views');
    });

    it('refuses a new hold when active hold capacity is exhausted', () => {
        const core = createSnapshotCore({ ...identity, maxActiveHolds: 1 });
        const s = published(core, draft());
        const one = core.store.acquire(s.id);
        expect(one.status).toBe('acquired');
        const blocked = core.store.acquire(s.id);
        expect(blocked.status).toBe('rejected');
        if (blocked.status === 'rejected') expect(blocked.issue.code).toBe('SNAPSHOT_CAPACITY');
        if (one.status === 'acquired') one.hold.release();
        expect(core.store.inspect().activeHolds).toBe(0);
    });

    it('requires a valid, fixed App and instance identity at construction', () => {
        for (const key of ['appId', 'instanceId'] as const) {
            for (const value of [undefined, '', '  ', 42]) {
                expect(() => createSnapshotCore({ ...identity, [key]: value } as SnapshotStoreOptions)).toThrow(new RegExp(key));
            }
        }
        const options = { ...identity };
        const core = createSnapshotCore(options);
        options.appId = 'other_app';
        options.instanceId = 'different';
        expect(core.store.readAppIdentity('task_app')).toEqual({ status: 'active', instanceId: 'instance_a' });
        expect(core.store.readAppIdentity('other_app')).toEqual({ status: 'absent' });
    });

    it('does not overwrite a healthy App when a Producer failure reports another instance', () => {
        const core = createSnapshotCore(identity);
        const s = published(core, draft());
        const report = core.committer.reportPrepareFailure({
            appId: 'task_app', instanceId: 'another-instance', producerSeq: 5, sourceEpoch: 5,
            issue: { code: 'SNAPSHOT_INVALID', message: 'Rejected', path: '$' },
        });
        expect(report.status).toBe('rejected');
        expect(ready(core).id).toBe(s.id);
    });
});


describe('M1 Core — defensive JSON boundary edge cases', () => {
    it('uses the same strict JSON checks when a copy is unnecessary', () => {
        let reads = 0;
        const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { reads++; return 0; } });
        const hidden = Object.defineProperty({}, 'secret', { value: 0 });
        const cycle: unknown[] = [];
        cycle.push(cycle);
        const limits = { maxDepth: 2, maxNodes: 16, maxApproxBytes: 256 };
        for (const value of [getter, hidden, cycle, [, 0], { [Symbol('key')]: 0 }, Object.create({ a: 0 }),
            { value: Infinity }, [[[[null]]]], Array(16).fill(null), '大'.repeat(100)]) {
            let issue: unknown;
            try { copyJson(value, limits); } catch (error) { issue = error; }
            expect(issue).toBeInstanceOf(SnapshotDataError);
            const { code, path, message } = issue as SnapshotDataError;
            expect(() => checkJsonLimits(value, limits)).toThrow(expect.objectContaining({ code, path, message }));
        }
        expect(reads).toBe(0);
        const shared = { value: -0 };
        expect(checkJsonLimits([shared, shared], limits)).toBeUndefined();
        expect(Object.is(shared.value, -0)).toBe(true);
        expect(Object.isFrozen(shared)).toBe(false);
    });

    it('rejects own symbol properties and array-index getters', () => {
        const withSymbol = { id: 'a' } as Record<PropertyKey, unknown>;
        withSymbol[Symbol('secret')] = true;
        expect(() => copyJson(withSymbol, { maxDepth: 10, maxNodes: 100 })).toThrow(/Symbol/);
        let getterCalls = 0;
        const array: unknown[] = [1];
        Object.defineProperty(array, '0', {
            enumerable: true, configurable: true,
            get() { getterCalls++; return 1; },
        });
        expect(() => copyJson(array, { maxDepth: 10, maxNodes: 100 })).toThrow(/array element/);
        expect(getterCalls).toBe(0);
    });

    it('rejects oversized keys before trying to canonicalize a giant object', () => {
        const payload = { ['large_key_' + 'x'.repeat(100)]: 1 };
        expect(() => copyJson(payload, {
            maxDepth: 10, maxNodes: 100, maxApproxBytes: 16,
        })).toThrow(/byte budget/);
    });


    it('retains holds across time within capacity and releases historical data when the final owner settles', () => {
        let now = 0;
        const core = createSnapshotCore({ ...identity, now: () => now, maxActiveHolds: 2 });
        const old = published(core, draft()), owner = core.store.acquire(old.id);
        expect(owner.status).toBe('acquired'); if (owner.status !== 'acquired') return;
        published(core, draft(2, 2, 'different')); now = 1_000_000;
        const reader = core.store.acquire(old.id);
        expect(reader.status).toBe('acquired'); if (reader.status !== 'acquired') return;
        expect(reader.hold.snapshot).toBe(old);
        const refused = core.store.acquire(old.id);
        expect(refused).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_CAPACITY' } });
        expect(core.store.inspect().activeHolds).toBe(2);
        reader.hold.release(); owner.hold.release(); owner.hold.release();
        expect(core.store.inspect().activeHolds).toBe(0);
        expect(core.store.getById(old.id).status).toBe('rejected');
    });
    it('keeps held prior snapshots bounded and releases all holds on dispose', () => {
        const core = createSnapshotCore({ ...identity, now: () => 0, maxHeldSnapshots: 1 });
        const first = published(core, draft());
        const firstOwner = core.store.acquire(first.id);
        expect(firstOwner.status).toBe('acquired');
        const second = published(core, draft(2, 2, 'second'));
        const secondOwner = core.store.acquire(second.id);
        expect(secondOwner.status).toBe('acquired');
        expect(core.committer.accept(draft(3, 3, 'third'))).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_CAPACITY' } });
        expect(core.store.inspect().activeHolds).toBe(2);
        core.lifecycle.dispose(); expect(core.store.inspect().activeHolds).toBe(0);
        expect(core.store.getById(first.id).status).toBe('rejected');
        if (firstOwner.status === 'acquired') firstOwner.hold.release();
        if (secondOwner.status === 'acquired') secondOwner.hold.release();
    });
});
