import { describe, expect, it } from 'vitest';
import { SemanticSnapshotReceiver } from './receiver.js';

function draft(seq: number, text = 'current') {
    return { schemaVersion: 2, appId: 'app', instanceId: 'instance',
        producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
        views: [{ id: 'file', viewInstanceId: 'file-instance', type: 'File', name: 'File', kind: 'state',
            content: { format: 'markdown-v1', value: text } }], refs: {}, tools: {} };
}

const policy = {
    project: () => ({ views: [{ viewId: 'file', viewInstanceId: 'file-instance' }], refs: [], targets: [], content: [] }),
    authorize: () => true, canReadReceipt: () => true,
};
const execution = { resolve: () => null };

describe('Semantic snapshot acceptance', () => {
    it('reports committed publication, unchanged data, degradation and recovery separately', () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        expect(receiver.acceptPrepared(draft(1))).toMatchObject({ status: 'published', healthChanged: true });
        const id = receiver.report().snapshotId;
        expect(receiver.acceptPrepared(draft(2))).toMatchObject({ status: 'unchanged', healthChanged: false });
        const failure = (seq: number) => ({ appId: 'app', instanceId: 'instance', producerSeq: seq, sourceEpoch: seq,
            issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR' as const, message: 'Capture failed' } });
        expect(receiver.acceptPrepareFailure(failure(3))).toMatchObject({ status: 'rejected', healthChanged: true });
        expect(receiver.report().health).toBe('degraded');
        expect(receiver.acceptPrepareFailure(failure(4))).toMatchObject({ status: 'rejected', healthChanged: false });
        expect(receiver.acceptPrepared(draft(5))).toMatchObject({ status: 'unchanged', healthChanged: true });
        expect(receiver.report()).toMatchObject({ health: 'ready', snapshotId: id });
        expect(receiver.acceptPrepared(draft(6, 'updated'))).toMatchObject({ status: 'published', healthChanged: false });
        receiver.close();
    });

    it('does not replace a valid source or emit a health change for foreign or stale input', () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        receiver.acceptPrepared(draft(1));const id = receiver.report().snapshotId;
        expect(receiver.acceptPrepared({ ...draft(2), instanceId: 'other' })).toMatchObject({
            status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' }, healthChanged: false });
        expect(receiver.acceptPrepared(draft(1))).toMatchObject({
            status: 'rejected', issue: { code: 'SNAPSHOT_SEQUENCE_STALE' }, healthChanged: false });
        const getter = { get appId() { throw new Error('must not execute'); }, instanceId: 'instance' };
        expect(receiver.acceptPrepared(getter)).toMatchObject({ status: 'rejected', healthChanged: false });
        expect(receiver.report()).toMatchObject({ health: 'ready', snapshotId: id, wrongSource: 2 });
        receiver.close();
        expect(receiver.acceptPrepared(draft(3))).toMatchObject({ status: 'rejected', issue: { code: 'APP_STOPPED' }, healthChanged: false });
        expect(receiver.report().health).toBe('stopped');
    });

    it('retains bounded rejection details and recovers only after a valid new capture', () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        receiver.acceptPrepared(draft(1));
        expect(receiver.acceptPrepared({ ...draft(2), views: null })).toMatchObject({ status: 'rejected', healthChanged: true });
        expect(receiver.report()).toMatchObject({ health: 'degraded', lastIssueCode: 'SNAPSHOT_INVALID' });
        expect(receiver.acceptPrepared(draft(1))).toMatchObject({ status: 'rejected', healthChanged: false });
        expect(receiver.report().health).toBe('degraded');
        expect(receiver.acceptPrepared(draft(3))).toMatchObject({ status: 'unchanged', healthChanged: true });
        receiver.close();
    });
});

describe('receiver-owned interaction lifetime', () => {
    it('keeps reporting lazy and permanently stops scope admission before first use', () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        expect(receiver.getInteractionStats()).toBeNull();
        receiver.closeInteractions();receiver.closeInteractions();
        expect(receiver.getInteractionStats()).toBeNull();
        expect(receiver.createInteractionScope(policy, execution).status).toBe('rejected');
        receiver.close();
    });

    it('shares a bounded authority and reuses capacity after a scope releases', () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance', () => 0);
        const opened = Array.from({ length: 16 }, () => receiver.createInteractionScope(policy, execution));
        expect(opened.every(item => item.status === 'opened')).toBe(true);
        const authority = (receiver as any).interactions;
        expect(receiver.createInteractionScope(policy, execution).status).toBe('rejected');
        if (opened[0].status === 'opened') opened[0].client.close();
        expect(receiver.createInteractionScope(policy, execution).status).toBe('opened');
        expect((receiver as any).interactions).toBe(authority);
        receiver.closeInteractions();
        expect(receiver.getInteractionStats()).toMatchObject({ closed: true, scopes: 0, combinedBytes: 0 });
        expect(receiver.createInteractionScope(policy, execution).status).toBe('rejected');
        receiver.close();
    });

    it('uses the injected clock without expiring observations still owned by their context', async () => {
        let time = 0;
        const receiver = new SemanticSnapshotReceiver('app', 'instance', () => time);
        receiver.acceptPrepared(draft(1));
        const core = (receiver as any).core, id = receiver.report().snapshotId!;
        const opened = receiver.createInteractionScope(policy, execution);
        expect(opened.status).toBe('opened');if (opened.status !== 'opened') throw new Error('scope');
        const first = await opened.client.observe({ all: true });
        expect(first.status).toBe('observed');if (first.status !== 'observed') throw new Error('observation');
        time = 60001;
        expect(core.store.inspect().activeLeases).toBe(1);
        const second = await opened.client.observe({ all: true });
        expect(second.status).toBe('observed');if (second.status !== 'observed') throw new Error('observation');
        expect(first.observation.observationId.startsWith('host:instance:')).toBe(true);
        receiver.acceptPrepared(draft(2, 'new current'));
        time = 660002;
        const retained = core.store.acquire(id);
        expect(retained.status).toBe('acquired');retained.lease.release();
        opened.client.releaseObservation(first.observation.observationId);
        opened.client.releaseObservation(second.observation.observationId);
        expect(core.store.acquire(id).status).toBe('rejected');
        expect((await opened.client.observe({ all: true })).status).toBe('observed');
        receiver.close();
        expect(receiver.getInteractionStats()).toMatchObject({ scopes: 0, combinedBytes: 0 });
    });

    it.each([-1, NaN, 9])('fails closed with invalid injected clock %s and still cleans up', timeAfter => {
        let time = 10;const receiver = new SemanticSnapshotReceiver('app', 'instance', () => time);
        expect(receiver.createInteractionScope(policy, execution).status).toBe('opened');time = timeAfter;
        expect(receiver.createInteractionScope(policy, execution).status).toBe('rejected');
        receiver.closeInteractions();
        expect(receiver.getInteractionStats()).toMatchObject({ scopes: 0, combinedBytes: 0 });
        receiver.close();
    });
});
