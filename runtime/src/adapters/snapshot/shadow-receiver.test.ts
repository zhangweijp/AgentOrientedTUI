import { describe, expect, it } from 'vitest';
import { SnapshotShadowReceiver } from './shadow-receiver.js';
import { refKey } from '../../core/snapshot/index.js';

describe('C receiver interaction lifetime', () => {
    it('keeps reporting lazy and closes the authority permanently before first use', () => {
        const receiver: any = new SnapshotShadowReceiver('task_app', 'instance_c');
        expect(receiver.getInteractionStats()).toBeNull(); receiver.closeInteractions(); receiver.closeInteractions();
        expect(receiver.getInteractionStats()).toBeNull();
        expect(receiver.createInteractionScope({}, {})).toMatchObject({ status: 'rejected' });
        receiver.close();
    });
    it('shares the authority across sixteen Scopes and retains its identity after slots are freed', () => {
        const r = new SnapshotShadowReceiver('task_app', 'instance_slots', () => 0);
        const policy = { project: () => ({ views: [], refs: [], targets: [], content: [] }), authorize: () => true, canReadReceipt: () => true };
        const opened = Array.from({ length: 16 }, () => r.createInteractionScope(policy, { resolve: () => null }));
        expect(opened.every(x => x.status === 'opened')).toBe(true); const authority = (r as any).interactions;
        expect(r.createInteractionScope(policy, { resolve: () => null }).status).toBe('rejected');
        const first = opened[0]!; if (first.status === 'opened') first.client.close();
        expect(r.createInteractionScope(policy, { resolve: () => null }).status).toBe('opened');
        expect((r as any).interactions).toBe(authority); r.closeInteractions();
        expect(r.getInteractionStats()).toMatchObject({ closed: true, scopes: 0, combinedBytes: 0 });
        expect(r.createInteractionScope(policy, { resolve: () => null }).status).toBe('rejected'); r.close();
    });
    it('uses one injected clock for current leases, retired history and observation/Scope deadlines', async () => {
        let time = 0;
        const r = new SnapshotShadowReceiver('task_app', 'instance_clock', () => time);
        const make = (seq: number) => ({ schemaVersion: 2, appId: 'task_app', instanceId: 'instance_clock', producerSeq: seq, sourceEpoch: seq, capturedAt: time,
            views: [{ id: 'v', viewInstanceId: 'vi', type: 'File', name: String(seq), kind: 'state', content: { format: 'markdown-v1', value: 'source' } }], refs: {}, tools: {} });
        r.acceptPrepared(make(1)); const core = (r as any).core, id = r.report().snapshotId!;
        const policy = { project: () => ({ views: [{ viewId: 'v', viewInstanceId: 'vi' }], refs: [], targets: [], content: [] }), authorize: () => true, canReadReceipt: () => true };
        const opened = r.createInteractionScope(policy, { resolve: () => null }); expect(opened.status).toBe('opened'); if (opened.status !== 'opened') return;
        const first = await opened.client.observe({ viewIds: ['v'] }); expect(first.status).toBe('observed');
        if (first.status === 'observed') expect(first.observation.observationId.startsWith('host:instance_clock:')).toBe(true);
        time = 60001; expect(core.store.inspect().activeLeases).toBe(0);
        const second = await opened.client.observe({ viewIds: ['v'] }); expect(second.status).toBe('observed');
        const lease = core.store.acquire(id); expect(lease.status).toBe('acquired'); lease.lease.release();
        r.acceptPrepared(make(2)); const authority = (r as any).interactions;
        time = 660002;
        expect(core.store.acquire(id).status).toBe('rejected');
        expect((await opened.client.observe({ viewIds: ['v'] })).status).toBe('rejected');
        expect(r.createInteractionScope(policy, { resolve: () => null }).status).toBe('opened'); expect((r as any).interactions).toBe(authority);
        r.close(); expect(r.getInteractionStats()).toMatchObject({ scopes: 0, combinedBytes: 0 });
    });
    it.each([-1, NaN, 9])('fails closed with injected clock %s and still allows explicit cleanup', timeAfter => {
        let time = 10; const r = new SnapshotShadowReceiver('task_app', 'instance_badclock', () => time);
        const policy = { project: () => ({ views: [], refs: [], targets: [], content: [] }), authorize: () => true, canReadReceipt: () => true };
        expect(r.createInteractionScope(policy, { resolve: () => null }).status).toBe('opened'); time = timeAfter;
        expect(r.createInteractionScope(policy, { resolve: () => null }).status).toBe('rejected');
        r.closeInteractions(); expect(r.getInteractionStats()).toMatchObject({ scopes: 0, combinedBytes: 0 });
        expect(r.createInteractionScope(policy, { resolve: () => null }).status).toBe('rejected');
    });
});

function draft(instanceId: string, seq: number, name = 'Tasks', appId = 'task_app') {
    return {
        schemaVersion: 1, appId, instanceId,
        producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
        views: [{
            id: 'workspace', generation: 'gen1', type: 'Workspace',
            name, kind: 'state',
            content: { format: 'markdown-v1', value: '<view>' + name + '</view>' },
        }],
        refs: {
            [refKey('workspace', 'gen1', 'selected')]: {
                id: 'selected', ownerViewId: 'workspace', ownerViewGeneration: 'gen1',
                refType: 'Task', target: { kind: 'snapshot-value', payload: { id: name } },
            },
        },
        tools: {
            select_task: {
                id: 'select_task', name: 'select_task', viewType: 'Workspace',
                description: 'Select task', inputSchema: { type: 'object', properties: {} },
                visible: true, isMutating: true,
            },
        },
    };
}

describe('M2 SnapshotShadowReceiver — Core-only, observational', () => {
    it('does not change the legacy path and exposes only metrics, not data or tool handlers', () => {
        const receiver = new SnapshotShadowReceiver('task_app', 'instance_a');
        receiver.observeLegacy({
            type: 'SNAPSHOT_FRAGMENT', appId: 'task_app' as any,
            timestamp: 1, markup: 'Legacy content',
            shadowCaptureSeq: 1, shadowInstanceId: 'instance_a',
            indexMap: {
                'workspace:selected': { id: 'a' },
                'tool:task_app-Workspace-select_task': { description: 'Select' },
            } as any,
            views: [{
                viewId: 'workspace' as any, viewType: 'Workspace',
                markup: 'Legacy view', timestamp: 1,
            }],
        });
        receiver.acceptPrepared(draft('instance_a', 1));
        expect(receiver.report()).toMatchObject({
            appId: 'task_app', instanceId: 'instance_a',
            mode: 'shadow', producerConsistency: 'unverified', strictEligible: false,
            health: 'ready', revision: 1, published: 1, prepared: 1,
            legacy: 1, legacyRefCount: 1, legacyToolCount: 1,
            lastRefCount: 1, lastToolCount: 1,
            pairedLegacyFrames: 1, unpairedPreparedFrames: 0,
            lastViewCountDelta: 0, lastRefCountDelta: 0, lastToolCountDelta: 0,
        });
        const report = receiver.report() as any;
        expect(report.refs).toBeUndefined();
        expect(report.tools).toBeUndefined();
        expect(report.content).toBeUndefined();
        receiver.acceptPrepared(draft('instance_a', 2));
        expect(receiver.report().unchanged).toBe(1);
        expect(receiver.report().revision).toBe(1);
    });

    it('rejects wrong App or instance and stale sequence without degrading another instance', () => {
        const receiver = new SnapshotShadowReceiver('task_app', 'instance_a');
        receiver.acceptPrepared(draft('instance_a', 1));
        receiver.acceptPrepared(draft('instance_a', 2, 'Spoof', 'wrong_app'));
        receiver.acceptPrepared(draft('wrong_instance', 3));
        const afterWrong = receiver.report();
        expect(afterWrong.wrongSource).toBe(2);
        expect(afterWrong.health).toBe('ready');
        expect(afterWrong.revision).toBe(1);
        receiver.acceptPrepared(draft('instance_a', 1));
        expect(receiver.report()).toMatchObject({
            health: 'ready', revision: 1, rejected: 3,
            lastIssueCode: 'SNAPSHOT_SEQUENCE_STALE',
        });
    });

    it('invalid Draft and PREPARE_FAILED mark only the matching App degraded', () => {
        const receiver = new SnapshotShadowReceiver('task_app', 'instance_a');
        receiver.acceptPrepared(draft('instance_a', 1));
        receiver.acceptPrepared({
            ...draft('instance_a', 2),
            refs: { dangling: { id: 'selected', ownerViewId: 'missing', ownerViewGeneration: 'x' } },
        });
        expect(receiver.report().health).toBe('degraded');
        const firstRevision = receiver.report().revision;
        expect(firstRevision).toBeUndefined(); // lastGood is diagnostic, never ready.
        receiver.acceptPrepareFailure({
            appId: 'task_app', instanceId: 'wrong_instance',
            producerSeq: 3, sourceEpoch: 3,
            issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR', message: 'Wrong source' },
        });
        expect(receiver.report().wrongSource).toBe(1);
        receiver.acceptPrepareFailure({
            appId: 'task_app', instanceId: 'instance_a',
            producerSeq: 3, sourceEpoch: 3,
            issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR', message: 'Failed transport' },
        });
        expect(receiver.report()).toMatchObject({
            health: 'degraded', prepareFailed: 1,
            lastIssueCode: 'SNAPSHOT_SERIALIZATION_ERROR',
        });
        receiver.acceptPrepared(draft('instance_a', 4, 'Recovered'));
        expect(receiver.report()).toMatchObject({ health: 'ready', revision: 2, published: 2 });
    });

    it('stops safely and ignores late Worker messages', () => {
        const receiver = new SnapshotShadowReceiver('task_app', 'instance_a');
        receiver.acceptPrepared(draft('instance_a', 1));
        receiver.close();
        receiver.close();
        receiver.acceptPrepared(draft('instance_a', 2, 'Too late'));
        expect(receiver.report()).toMatchObject({ health: 'stopped', published: 1, prepared: 1 });
    });
});
