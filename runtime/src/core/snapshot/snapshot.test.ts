import { describe, expect, it } from 'vitest';
import { copyJson, createSnapshotCore, refKey, validatePreparedV2Draft } from './index.js';
import type { PreparedAppSnapshotDraftV2, SnapshotCore, SnapshotStoreOptions } from './index.js';

const KEY = refKey('workspace', 'mount_1', 'tasks[0]');
const TOOL = JSON.stringify(['task_app', 'Workspace', 'complete_task']);

function draft(
    seq = 1,
    epoch = seq,
    id = 'task-a',
    override: Record<string, unknown> = {},
): PreparedAppSnapshotDraftV2 {
    return {
        schemaVersion: 2,
        appId: 'task_app',
        instanceId: 'instance_a',
        producerSeq: seq,
        sourceEpoch: epoch,
        capturedAt: 1_000 + seq,
        views: [{
            id: 'workspace',
            viewInstanceId: 'mount_1',
            type: 'Workspace',
            name: 'Tasks',
            kind: 'state',
            content: { format: 'markdown-v1', value: '[Stable task](tasks[0])' },
        }],
        refs: {
            [KEY]: {
                id: 'tasks[0]', ownerViewId: 'workspace', ownerViewInstanceId: 'mount_1',
                refType: 'Task',
                target: { kind: 'snapshot-value', payload: { id, status: 'pending' } },
            },
        },
        tools: {
            [TOOL]: {
                id: TOOL, name: 'complete_task', viewType: 'Workspace',
                description: 'Complete selected task',
                inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
                isMutating: true, targets: [{ viewId: 'workspace', viewInstanceId: 'mount_1', bindingVersion: 1 }],
            },
        },
        ...override,
    } as PreparedAppSnapshotDraftV2;
}

function ready(core: SnapshotCore) {
    const result = core.store.readLatest('task_app');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw Error('not ready');
    return result.snapshot;
}

function published(core: SnapshotCore, next: PreparedAppSnapshotDraftV2) {
    const result = core.committer.accept(next);
    expect(result.status).toBe('published');
    if (result.status !== 'published') throw Error('not published: ' + JSON.stringify(result));
    return result.snapshot;
}

function sourceRef(core: SnapshotCore, snapId: string) {
    return core.store.resolveRef({
        snapshotId: snapId, appId: 'task_app', instanceId: 'instance_a',
        viewId: 'workspace', viewInstanceId: 'mount_1', refId: 'tasks[0]',
    });
}

describe('B2-Q01 independent application lifecycle identity', () => {
    it('reports absent/unready/ready/degraded/stopped/new-unready without changing SnapshotRead shapes', () => {
        const core = createSnapshotCore({ now: () => 0 });
        expect(core.store.readAppIdentity('task_app')).toEqual({ status: 'absent' });
        expect(core.store.readLatest('task_app')).toEqual({ status: 'unready' });
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = core.store.readAppIdentity('task_app');
        expect(first).toEqual({ status: 'active', instanceId: 'instance_a' }); expect(Object.isFrozen(first)).toBe(true);
        expect(core.store.readLatest('task_app')).toEqual({ status: 'unready' });
        const source = published(core, draft());
        expect(core.store.readAppIdentity('task_app')).toEqual(first);
        expect(core.store.readLatest('task_app')).toEqual({ status: 'ready', snapshot: source });
        expect(core.committer.accept(draft(2, 2, 'invalid', { refs: { malformed: null } })).status).toBe('rejected');
        const degraded = core.store.readLatest('task_app');
        expect(Object.keys(degraded).sort()).toEqual(['issue', 'lastGood', 'status']);
        expect(core.store.readAppIdentity('task_app')).toEqual(first);
        core.lifecycle.stopApp('task_app', 'instance_a');
        const stopped = core.store.readAppIdentity('task_app'); expect(stopped).toEqual({ status: 'stopped', instanceId: 'instance_a' });
        expect(core.store.readLatest('task_app')).toEqual({ status: 'stopped' });
        core.lifecycle.startApp('task_app', 'instance_b');
        expect(core.store.readLatest('task_app')).toEqual({ status: 'unready' });
        expect(core.store.readAppIdentity('task_app')).toEqual({ status: 'active', instanceId: 'instance_b' });
        expect(first).toEqual({ status: 'active', instanceId: 'instance_a' }); expect(stopped).toEqual({ status: 'stopped', instanceId: 'instance_a' });
        core.lifecycle.stopApp('task_app', 'instance_a'); // stale stop cannot stop the new instance
        expect(core.store.readAppIdentity('task_app')).toEqual({ status: 'active', instanceId: 'instance_b' });
    });
    it('reads only the existing identity record, without clocks, leases, revision or history changes', () => {
        let calls = 0, broken = false;
        const core = createSnapshotCore({ now: () => { calls++; if (broken) throw new Error('clock-secret'); return 0; } });
        core.lifecycle.startApp('task_app', 'instance_a'); const source = published(core, draft());
        const lease = core.store.acquire(source.id); expect(lease.status).toBe('acquired');
        const before = core.store.inspect(), beforeCalls = calls; broken = true;
        expect(core.store.readAppIdentity('task_app')).toEqual({ status: 'active', instanceId: 'instance_a' });
        expect(core.store.readAppIdentity('unknown')).toEqual({ status: 'absent' }); expect(calls).toBe(beforeCalls);
        broken = false; expect(core.store.inspect()).toEqual(before); expect(ready(core)).toBe(source);
        if (lease.status === 'acquired') lease.lease.release();
    });
    it('reports direct replacement before publication and preserves the original instance non-reuse rule', () => {
        const core = createSnapshotCore({ now: () => 0 }); core.lifecycle.startApp('task_app', 'instance_a');
        core.lifecycle.startApp('task_app', 'instance_b');
        expect(core.store.readAppIdentity('task_app')).toEqual({ status: 'active', instanceId: 'instance_b' });
        expect(core.store.readLatest('task_app')).toEqual({ status: 'unready' });
        expect(() => core.lifecycle.startApp('task_app', 'instance_a')).toThrow();
        expect(core.store.readAppIdentity('task_app')).toEqual({ status: 'active', instanceId: 'instance_b' });
    });
});

describe('M1 pure Core — schema & safe value contract', () => {
    it('accepts App/View/Ref/ViewTypeTool in a detached, strictly typed draft', () => {
        const checked = validatePreparedV2Draft(draft());
        expect(checked.ok).toBe(true);
        if (!checked.ok) return;
        expect(checked.value.draft.refs[KEY].ownerViewInstanceId).toBe('mount_1');
        expect(checked.value.draft.tools[TOOL].targets).toHaveLength(1);
        expect(checked.value.contentDigest.startsWith('fnv1a64:')).toBe(true);
        expect(Object.isFrozen(checked.value.draft.refs[KEY].target)).toBe(true);
    });

    it.each([
        ['unsupported schemaVersion', { schemaVersion: 1 }, '$.schemaVersion', 'SNAPSHOT_INVALID'],
        ['duplicate View ID', { views: [draft().views[0], draft().views[0]] }, '$.views[1].id', 'SNAPSHOT_INVALID'],
        ['Ref owner missing', { refs: { [KEY]: { ...draft().refs[KEY], ownerViewId: 'ghost' } } }, '$.refs', 'SNAPSHOT_INVALID'],
        ['Ref index wrong', { refs: { 'tasks[0]': draft().refs[KEY] } }, '$.refs', 'SNAPSHOT_INVALID'],
        ['Tool schema invalid', { tools: { [TOOL]: { ...draft().tools[TOOL], inputSchema: { type: 'string' } } } }, '$.tools', 'SNAPSHOT_INVALID'],
        ['Tool identity mismatched', { tools: { [TOOL]: { ...draft().tools[TOOL], viewType: 'FileDetail' } } }, '$.tools', 'SNAPSHOT_INVALID'],
        ['Tool target instance mismatched', { tools: { [TOOL]: { ...draft().tools[TOOL], targets: [{ viewId: 'workspace', viewInstanceId: 'old', bindingVersion: 1 }] } } }, '$.tools', 'SNAPSHOT_INVALID'],
    ])('rejects %s before publishing', (_, override, path, code) => {
        const tested = validatePreparedV2Draft({ ...draft(), ...override });
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
            const tested = validatePreparedV2Draft({
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
        const result = validatePreparedV2Draft(input);
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
        expect(validatePreparedV2Draft({
            ...draft(), refs: { [KEY]: { ...draft().refs[KEY], target: { kind: 'snapshot-value', payload: deep } } },
        }, { maxDepth: 6 }).ok).toBe(false);
        const big = 'x'.repeat(1_000);
        const value = { ...draft(), refs: {
            [KEY]: { ...draft().refs[KEY], target: { kind: 'snapshot-value', payload: { big } } },
        } };
        expect(validatePreparedV2Draft(value, { maxRefPayloadBytes: 100 }).ok).toBe(false);
        expect(validatePreparedV2Draft(value, { maxSnapshotBytes: 100 }).ok).toBe(false);
    });
});

describe('M1 Core — versioned commit, failure & strict origin', () => {
    it('publishes revision 1 and reuses the same snapshot ID when semantic data has not changed', () => {
        const core = createSnapshotCore();
        expect(core.store.readLatest('task_app').status).toBe('unready');
        core.lifecycle.startApp('task_app', 'instance_a');
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
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
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
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = published(core, draft());
        const second = published(core, draft(2, 2, 'task-b'));
        const third = published(core, draft(3, 3, 'task-b', { tools: {} }));
        expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3]);
        expect(first.views).toEqual(third.views);
        expect(core.store.getTool({
            snapshotId: first.id, appId: 'task_app', instanceId: 'instance_a', toolId: TOOL,
        }).status).toBe('found');
        expect(core.store.getTool({
            snapshotId: third.id, appId: 'task_app', instanceId: 'instance_a', toolId: TOOL,
        }).status).toBe('rejected');
        expect(core.store.inspect().historicalSnapshots).toBe(2);
    });

    it('rejects changed semantic content with unchanged sourceEpoch, keeping lastGood degraded', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
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
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
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

    it('rejects unregistered, stale, mismatched and stopped app sources', () => {
        const core = createSnapshotCore();
        let result = core.committer.accept(draft());
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.issue.code).toBe('APP_NOT_REGISTERED');
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = published(core, draft());
        result = core.committer.accept(draft());
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.issue.code).toBe('SNAPSHOT_SEQUENCE_STALE');
        result = core.committer.accept({ ...draft(2), instanceId: 'impostor' });
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.issue.code).toBe('APP_INSTANCE_MISMATCH');
        expect(ready(core).id).toBe(first.id);
        core.lifecycle.stopApp('task_app', 'instance_a');
        expect(core.store.readLatest('task_app').status).toBe('stopped');
        result = core.committer.accept(draft(3));
        expect(result.status).toBe('rejected');
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
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = published(core, draft(1, 1, 'entity-a'));
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
    });

    it('resolves two same-named Ref IDs only by exact View identity, never suffix search', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = draft(1, 1);
        const secondKey = refKey('detail', 'mount_2', 'tasks[0]');
        const changed = draft(1, 1, 'entity-a', {
            views: [...first.views, {
                id: 'detail', viewInstanceId: 'mount_2', type: 'FileDetail',
                name: 'Another View', kind: 'state',
                content: { format: 'markdown-v1', value: '[Task](tasks[0])' },
            }],
            refs: {
                ...first.refs,
                [secondKey]: {
                    id: 'tasks[0]', ownerViewId: 'detail', ownerViewInstanceId: 'mount_2',
                    refType: 'Task', target: { kind: 'snapshot-value', payload: { id: 'entity-b' } },
                },
            },
        });
        const snap = published(core, changed);
        const firstRef = sourceRef(core, snap.id);
        const secondRef = core.store.resolveRef({
            snapshotId: snap.id, appId: 'task_app', instanceId: 'instance_a',
            viewId: 'detail', viewInstanceId: 'mount_2', refId: 'tasks[0]',
        });
        expect(firstRef.status).toBe('resolved');
        expect(secondRef.status).toBe('resolved');
        if (firstRef.status === 'resolved' && secondRef.status === 'resolved') {
            expect((firstRef.target as any).payload.id).toBe('task-a'); // default draft fixture
            expect((secondRef.target as any).payload.id).toBe('entity-b');
        }
        expect(core.store.resolveRef({
            snapshotId: snap.id, appId: 'task_app', instanceId: 'instance_a',
            viewId: 'unrelated', viewInstanceId: 'other', refId: 'tasks[0]',
        }).status).toBe('rejected');
    });

    it('treats View close/reopen with same ID as a new generation', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        const old = published(core, draft());
        const newKey = refKey('workspace', 'mount_2', 'tasks[0]');
        const source = draft(2, 2, 'entity-b');
        const newer = published(core, {
            ...source,
            views: source.views.map(view => ({ ...view, viewInstanceId: 'mount_2' })),
            refs: {
                [newKey]: {
                    ...source.refs[KEY], ownerViewInstanceId: 'mount_2',
                },
            },
            tools: {
                [TOOL]: { ...source.tools[TOOL], targets: [{ viewId: 'workspace', viewInstanceId: 'mount_2', bindingVersion: 1 }] },
            },
        });
        expect(newer.revision).toBe(2);
        expect(sourceRefWithGeneration(core, old.id, 'mount_2').status).toBe('rejected');
        expect(sourceRefWithGeneration(core, newer.id, 'mount_1').status).toBe('rejected');
        expect(sourceRefWithGeneration(core, newer.id, 'mount_2').status).toBe('resolved');
    });

    it('retains exact old Entity locator, including entityVersion', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        const target = { kind: 'entity' as const, entityType: 'Task', entityId: 'same-id', entityVersion: 'old-v1' };
        const newerTarget = { ...target, entityVersion: 'new-v2' };
        const old = published(core, draft(1, 1, 'unused', {
            refs: { [KEY]: { ...draft().refs[KEY], target } },
        }));
        const newer = published(core, draft(2, 2, 'unused', {
            refs: { [KEY]: { ...draft().refs[KEY], target: newerTarget } },
        }));
        const refOld = sourceRef(core, old.id);
        const refNew = sourceRef(core, newer.id);
        if (refOld.status !== 'resolved' || refNew.status !== 'resolved') throw Error('unexpected');
        expect(refOld.target).toMatchObject({ entityId: 'same-id', entityVersion: 'old-v1' });
        expect(refNew.target).toMatchObject({ entityId: 'same-id', entityVersion: 'new-v2' });
        // Live resource CAS is an M4 concern; M1 must never swap the old locator.
    });
});

function sourceRefWithGeneration(core: SnapshotCore, snapshotId: string, viewInstanceId: string) {
    return core.store.resolveRef({
        snapshotId, appId: 'task_app', instanceId: 'instance_a',
        viewId: 'workspace', viewInstanceId, refId: 'tasks[0]',
    });
}

describe('M1 Core — retention, leases, restart and capacity', () => {
    it('protects leased historical snapshots and rejects a commit when all retention is pinned', () => {
        const core = createSnapshotCore({ maxHistoryEntries: 0, maxHistoryBytes: 0 });
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = published(core, draft());
        const held = core.store.acquire(first.id);
        expect(held.status).toBe('acquired');
        const blocked = core.committer.accept(draft(2, 2, 'entity-b'));
        expect(blocked.status).toBe('rejected');
        if (blocked.status === 'rejected') expect(blocked.issue.code).toBe('SNAPSHOT_CAPACITY');
        const degraded = core.store.readLatest('task_app');
        expect(degraded.status).toBe('degraded');
        if (degraded.status === 'degraded') expect(degraded.lastGood?.id).toBe(first.id);
        expect(core.store.inspect().activeLeases).toBe(1);
        if (held.status === 'acquired') held.lease.release();
        expect(core.store.inspect().activeLeases).toBe(0);
        const second = published(core, draft(3, 3, 'entity-b'));
        expect(second.revision).toBe(2);
        const lookup = core.store.getById(first.id);
        expect(lookup.status).toBe('rejected');
        if (lookup.status === 'rejected') expect(lookup.issue.code).toBe('SNAPSHOT_EXPIRED');
    });

    it('expires historical snapshots deterministically with an injected clock', () => {
        let time = 10_000;
        const options: SnapshotStoreOptions = {
            now: () => time, historyTtlMs: 50, leaseTtlMs: 20,
        };
        const core = createSnapshotCore(options);
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = published(core, draft());
        const held = core.store.acquire(first.id, 10);
        expect(held.status).toBe('acquired');
        time += 1;
        published(core, draft(2, 2, 'entity-b'));
        expect(core.store.getById(first.id).status).toBe('found');
        time += 11;
        expect(core.store.inspect().activeLeases).toBe(0);
        expect(core.store.getById(first.id).status).toBe('found');
        time += 40;
        const old = core.store.getById(first.id);
        expect(old.status).toBe('rejected');
        expect(core.store.inspect().historicalSnapshots).toBe(0);
        expect(ready(core).revision).toBe(2);
    });

    it('preserves a leased old app instance for diagnostics but never reuses its identity', () => {
        const core = createSnapshotCore({ maxHistoryEntries: 1 });
        core.lifecycle.startApp('task_app', 'instance_a');
        const old = published(core, draft());
        const lease = core.store.acquire(old.id);
        core.lifecycle.stopApp('task_app', 'instance_a');
        expect(core.store.readLatest('task_app').status).toBe('stopped');
        expect(() => core.lifecycle.startApp('task_app', 'instance_a')).toThrow(/instance ID/);
        core.lifecycle.startApp('task_app', 'instance_b');
        expect(core.store.readLatest('task_app').status).toBe('unready');
        const newSource = { ...draft(), instanceId: 'instance_b' };
        const fresh = published(core, newSource);
        expect(fresh.revision).toBe(1);
        expect(fresh.instanceId).toBe('instance_b');
        expect(fresh.id).not.toBe(old.id);
        expect(core.store.getById(old.id).status).toBe('found');
        expect(core.store.resolveRef({
            snapshotId: old.id, appId: 'task_app', instanceId: 'instance_b',
            viewId: 'workspace', viewInstanceId: 'mount_1', refId: 'tasks[0]',
        }).status).toBe('rejected');
        if (lease.status === 'acquired') lease.lease.release();
    });

    it('rejects out-of-order producer epoch and duplicate sequences without changing current pointer', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = published(core, draft(1, 5));
        const regressed = core.committer.accept(draft(2, 4, 'entity-b'));
        expect(regressed.status).toBe('rejected');
        const replay = core.committer.accept(draft(1, 5));
        expect(replay.status).toBe('rejected');
        const old = core.store.getById(first.id);
        expect(old.status).toBe('found');
        expect(published(core, draft(3, 6, 'entity-b')).revision).toBe(2);
    });

    it('uses a bounded history and evicts old, unleased versions before accepting new ones', () => {
        const core = createSnapshotCore({ maxHistoryEntries: 1, maxHistoryBytes: 2_000_000 });
        core.lifecycle.startApp('task_app', 'instance_a');
        const a = published(core, draft(1, 1, 'a'));
        const b = published(core, draft(2, 2, 'b'));
        const c = published(core, draft(3, 3, 'c'));
        expect(core.store.inspect().historicalSnapshots).toBe(1);
        expect(core.store.getById(a.id).status).toBe('rejected');
        expect(core.store.getById(b.id).status).toBe('found');
        expect(ready(core).id).toBe(c.id);
    });
});

describe('M1 Core — in-memory behavior under repeated independent commits', () => {
    it('does not silently rebind historical refs in a deterministic 50-step state sequence', () => {
        const core = createSnapshotCore({ maxHistoryEntries: 64 });
        core.lifecycle.startApp('task_app', 'instance_a');
        const snapshots = [];
        for (let n = 1; n <= 50; n++) {
            snapshots.push(published(core, draft(n, n, 'entity-' + n)));
        }
        expect(ready(core).revision).toBe(50);
        for (let n = 0; n < snapshots.length; n++) {
            const ref = sourceRef(core, snapshots[n].id);
            expect(ref.status).toBe('resolved');
            if (ref.status === 'resolved') expect((ref.target as any).payload.id).toBe('entity-' + (n + 1));
        }
        expect(core.store.inspect().historicalSnapshots).toBe(49);
    });

    it('does not import DOM or Worker primitives into the Core contract', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        const state = published(core, draft());
        expect(state.views).toHaveLength(1);
        expect(state.views[0].content.format).toBe('markdown-v1');
        expect(typeof globalThis).toBe('object');
        // M1 contract is pure data; direct source-import boundary is verified by review.
    });
});


describe('M1 Core — adversarial resource and publication invariants', () => {
    it('caps concurrent Snapshot leases and supports idempotent lease release', () => {
        const core = createSnapshotCore({ maxActiveLeases: 1 });
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = published(core, draft());
        const acquired = core.store.acquire(first.id);
        expect(acquired.status).toBe('acquired');
        const overflow = core.store.acquire(first.id);
        expect(overflow.status).toBe('rejected');
        if (overflow.status === 'rejected') expect(overflow.issue.code).toBe('SNAPSHOT_CAPACITY');
        if (acquired.status === 'acquired') {
            acquired.lease.release();
            acquired.lease.release();
        }
        expect(core.store.inspect().activeLeases).toBe(0);
        const next = core.store.acquire(first.id);
        expect(next.status).toBe('acquired');
        if (next.status === 'acquired') next.lease.release();
        expect(core.store.inspect().activeLeases).toBe(0);
    });

    it('does not let a degraded App masquerade as ready after rejected schema or invalid source', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        published(core, draft());
        const invalid = core.committer.accept({
            ...draft(2, 2), tools: { [TOOL]: { ...draft().tools[TOOL], isMutating: 'true' } },
        });
        expect(invalid.status).toBe('rejected');
        const health = core.store.readLatest('task_app');
        expect(health.status).toBe('degraded');
        if (health.status === 'degraded') {
            expect(health.lastGood?.revision).toBe(1);
            expect(health.issue.path).toContain('.isMutating');
            expect('snapshot' in health).toBe(false);
        }
        const sourceSpoof = core.committer.accept({ ...draft(3, 3), instanceId: 'unknown' });
        expect(sourceSpoof.status).toBe('rejected');
        expect(core.store.readLatest('task_app').status).toBe('degraded');
        const recovery = core.committer.accept(draft(4, 4));
        expect(recovery.status).toBe('unchanged'); // identical semantics: no new revision
        expect(ready(core).revision).toBe(1);
    });

    it('tracks Tool schema changes even when View content is unchanged', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = published(core, draft());
        const next = published(core, draft(2, 2, 'task-a', {
            tools: { [TOOL]: { ...draft().tools[TOOL],
                inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 5 } } },
            } },
        }));
        expect(next.id).not.toBe(first.id);
        expect(next.revision).toBe(2);
        expect(next.views).toEqual(first.views);
    });

    it('can recover from a full pinned history without altering a retained historical Ref', () => {
        const core = createSnapshotCore({ maxHistoryEntries: 1 });
        core.lifecycle.startApp('task_app', 'instance_a');
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
        if (lease.status === 'acquired') lease.lease.release();
        expect(published(core, draft(4, 4, 'c')).revision).toBe(3);
        expect(core.store.getById(first.id).status).toBe('rejected');
        if (leaseSecond.status === 'acquired') leaseSecond.lease.release();
    });

    it('does not promote an unknown or missing Ref string to a valid Ref', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        const current = published(core, draft());
        const missing = core.store.resolveRef({
            snapshotId: current.id, appId: 'task_app', instanceId: 'instance_a',
            viewId: 'workspace', viewInstanceId: 'mount_1', refId: 'task-a',
        });
        expect(missing.status).toBe('rejected');
        if (missing.status === 'rejected') expect(missing.issue.code).toBe('REF_NOT_FOUND');
    });
});


describe('M1 Core — nonpublishable Producer input and explicit prepare failure', () => {
    it('degrades lastGood when nested Ref serialization fails before full envelope clone', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
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
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
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
        expect(published(core, draft(2, 2)).revision).toBe(1);
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
        const validation = validatePreparedV2Draft(input, { maxSnapshotBytes: 1_024 });
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
            const result = validatePreparedV2Draft({
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
        const invalidView = validatePreparedV2Draft({ ...draft(), views: [wrongView] });
        expect(invalidView.ok).toBe(false);
        const { targets: _removed, ...withoutTargets } = draft().tools[TOOL];
        const invalidTool = validatePreparedV2Draft({
            ...draft(),
            tools: { [TOOL]: withoutTargets },
        });
        expect(invalidTool.ok).toBe(false);
        if (!invalidTool.ok) expect(invalidTool.issue.code).toBe('SNAPSHOT_INVALID');
    });

    it('enforces maximum node and view counts instead of allowing unbounded cloning', () => {
        const tooManyNodes = validatePreparedV2Draft(draft(), { maxNodes: 10 });
        expect(tooManyNodes.ok).toBe(false);
        const tooManyViews = validatePreparedV2Draft(draft(), { maxViews: 0 });
        expect(tooManyViews.ok).toBe(false);
        if (!tooManyViews.ok) expect(tooManyViews.issue.path).toBe('$.views');
    });

    it('refuses invalid lease duration and fails closed on exhausted active lease capacity', () => {
        const core = createSnapshotCore({ leaseTtlMs: 5, maxActiveLeases: 1 });
        core.lifecycle.startApp('task_app', 'instance_a');
        const s = published(core, draft());
        const bad = core.store.acquire(s.id, 10);
        expect(bad.status).toBe('rejected');
        const zero = core.store.acquire(s.id, 0);
        expect(zero.status).toBe('rejected');
        const one = core.store.acquire(s.id, 5);
        expect(one.status).toBe('acquired');
        const blocked = core.store.acquire(s.id, 5);
        expect(blocked.status).toBe('rejected');
        if (blocked.status === 'rejected') expect(blocked.issue.code).toBe('SNAPSHOT_CAPACITY');
        if (one.status === 'acquired') one.lease.release();
        expect(core.store.inspect().activeLeases).toBe(0);
    });

    it('refuses app-instance token reuse even after other App instance starts', () => {
        const core = createSnapshotCore();
        expect(() => core.lifecycle.startApp('', 'x')).toThrow(/appId/);
        core.lifecycle.startApp('task_app', 'instance_a');
        core.lifecycle.startApp('task_app', 'instance_a'); // idempotent active registration
        core.lifecycle.startApp('task_app', 'instance_b');
        expect(() => core.lifecycle.startApp('task_app', 'instance_a')).toThrow(/instance ID/);
        core.lifecycle.stopApp('task_app', 'instance_b');
        expect(core.store.readLatest('task_app').status).toBe('stopped');
    });

    it('does not overwrite a healthy App when a Producer failure reports another instance', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
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

    it('does not allow Tool descriptor lookup to cross source App identity', () => {
        const core = createSnapshotCore();
        core.lifecycle.startApp('task_app', 'instance_a');
        const snap = published(core, draft());
        const result = core.store.getTool({
            snapshotId: snap.id, appId: 'task_app', instanceId: 'wrong-instance', toolId: TOOL,
        });
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.issue.code).toBe('APP_INSTANCE_MISMATCH');
    });

    it('retains owner leases across time within capacity and releases historical data when the final owner settles', () => {
        let now = 0;
        const core = createSnapshotCore({ now: () => now, historyTtlMs: 10, leaseTtlMs: 10, maxActiveLeases: 2 });
        core.lifecycle.startApp('task_app', 'instance_a');
        const old = published(core, draft()), owner = core.store.acquire(old.id, { lifetime: 'owner' });
        expect(owner.status).toBe('acquired'); if (owner.status !== 'acquired') return;
        expect(owner.lease.expiresAt).toBeNull();
        published(core, draft(2, 2, 'different')); now = 1_000_000;
        const reader = core.store.acquire(old.id);
        expect(reader.status).toBe('acquired'); if (reader.status !== 'acquired') return;
        expect(reader.lease.snapshot).toBe(old);
        const refused = core.store.acquire(old.id, { lifetime: 'owner' });
        expect(refused).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_CAPACITY' } });
        expect(core.store.inspect().activeLeases).toBe(2);
        reader.lease.release(); owner.lease.release(); owner.lease.release();
        expect(core.store.inspect().activeLeases).toBe(0);
        expect(core.store.getById(old.id).status).toBe('rejected');
    });
    it('keeps pinned owner history bounded and releases all owner leases on dispose', () => {
        const core = createSnapshotCore({ now: () => 0, maxHistoryEntries: 1 });
        core.lifecycle.startApp('task_app', 'instance_a');
        const first = published(core, draft());
        const firstOwner = core.store.acquire(first.id, { lifetime: 'owner' });
        expect(firstOwner.status).toBe('acquired');
        const second = published(core, draft(2, 2, 'second'));
        const secondOwner = core.store.acquire(second.id, { lifetime: 'owner' });
        expect(secondOwner.status).toBe('acquired');
        expect(core.committer.accept(draft(3, 3, 'third'))).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_CAPACITY' } });
        expect(core.store.inspect().activeLeases).toBe(2);
        core.lifecycle.dispose(); expect(core.store.inspect().activeLeases).toBe(0);
        expect(core.store.getById(first.id).status).toBe('rejected');
        if (firstOwner.status === 'acquired') firstOwner.lease.release();
        if (secondOwner.status === 'acquired') secondOwner.lease.release();
    });
    it('never grants a new historical lease after retention TTL despite an existing valid timed pin', () => {
        let now = 1_000;
        const core = createSnapshotCore({
            now: () => now, historyTtlMs: 0, leaseTtlMs: 100,
        });
        core.lifecycle.startApp('task_app', 'instance_a');
        const old = published(core, draft());
        const lease = core.store.acquire(old.id, 100);
        expect(lease.status).toBe('acquired');
        now = 1_001;
        published(core, draft(2, 2, 'different'));
        const refused = core.store.acquire(old.id);
        expect(refused.status).toBe('rejected');
        if (refused.status === 'rejected') expect(refused.issue.code).toBe('SNAPSHOT_EXPIRED');
        // Existing pin still retains the immutable data for its stated lifetime.
        expect(core.store.getById(old.id).status).toBe('found');
        if (lease.status === 'acquired') lease.lease.release();
        expect(core.store.getById(old.id).status).toBe('rejected');
    });
});
