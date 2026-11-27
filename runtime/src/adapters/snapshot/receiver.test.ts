import { describe, expect, it } from 'vitest';
import { SemanticSnapshotReceiver } from './receiver.js';

function draft(seq: number, text = 'current') {
    return { healthySince: 1,  schemaVersion: 9, appId: 'app', instanceId: 'instance',
        producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
        views: [{ toolBindings: [], id: 'file', viewInstanceId: 'm:1', type: 'File', name: 'File', region: 'dynamic',
            content: { format: 'markdown-v1', value: text } }], refs: {}, tools: {} };
}

const policy = {
    project: () => ({ refs: [], toolIds: [] }),
    authorize: () => true, canReadReceipt: () => true,
};
const execution = { resolve: () => null };
const state = (receiver: SemanticSnapshotReceiver) => receiver['core'].store.readLatest(receiver.appId);
function readyId(receiver: SemanticSnapshotReceiver) {
    const result = state(receiver);
    if (result.status !== 'ready') throw new Error('Expected a ready snapshot');
    return result.snapshot.id;
}

describe('Semantic snapshot acceptance', () => {
    it('reports committed publication, unchanged data, degradation and recovery separately', () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        expect(receiver.acceptPrepared(draft(1), 'authoritative', [{ name: 'File', multiplicity: 'single' }])).toMatchObject({ status: 'published', healthChanged: true });
        const id = readyId(receiver);
        expect(receiver.acceptPrepared(draft(2))).toMatchObject({ status: 'unchanged', healthChanged: false });
        const failure = (seq: number) => ({ appId: 'app', instanceId: 'instance', producerSeq: seq, sourceEpoch: seq,
            issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR' as const, message: 'Capture failed' } });
        expect(receiver.acceptPrepareFailure(failure(3))).toMatchObject({ status: 'rejected', healthChanged: true });
        expect(state(receiver).status).toBe('degraded');
        expect(receiver.acceptPrepareFailure(failure(4))).toMatchObject({ status: 'rejected', healthChanged: false });
        expect(receiver.acceptPrepared({ ...draft(5), healthySince: 5 })).toMatchObject({ status: 'published', healthChanged: true });
        expect(state(receiver)).toMatchObject({ status: 'ready', snapshot: { revision: 2, admissionSinceRevision: 2 } });
        expect(readyId(receiver)).not.toBe(id);
        expect(receiver.acceptPrepared({ ...draft(6, 'updated'), healthySince: 5 })).toMatchObject({ status: 'published', healthChanged: false });
        receiver.close();
    });

    it('does not replace a valid source or emit a health change for foreign or stale input', () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        receiver.acceptPrepared(draft(1), 'authoritative', [{ name: 'File', multiplicity: 'single' }]);const id = readyId(receiver);
        expect(receiver.acceptPrepared({ ...draft(2), instanceId: 'other' })).toMatchObject({
            status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' }, healthChanged: false });
        expect(receiver.acceptPrepared(draft(1))).toMatchObject({
            status: 'rejected', issue: { code: 'SNAPSHOT_SEQUENCE_STALE' }, healthChanged: false });
        const getter = { get appId() { throw new Error('must not execute'); }, instanceId: 'instance' };
        expect(receiver.acceptPrepared(getter)).toMatchObject({ status: 'rejected', healthChanged: false });
        expect(state(receiver)).toMatchObject({ status: 'ready', snapshot: { id } });
        receiver.close();
        expect(receiver.acceptPrepared(draft(3))).toMatchObject({ status: 'rejected', issue: { code: 'APP_STOPPED' }, healthChanged: false });
        expect(state(receiver).status).toBe('stopped');
    });

    it('retains bounded rejection details and recovers only after a valid new capture', () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        receiver.acceptPrepared(draft(1), 'authoritative', [{ name: 'File', multiplicity: 'single' }]);
        expect(receiver.acceptPrepared({ ...draft(2), views: null })).toMatchObject({ status: 'rejected', healthChanged: true });
        expect(state(receiver)).toMatchObject({ status: 'degraded', issue: { code: 'SNAPSHOT_INVALID' } });
        expect(receiver.acceptPrepared(draft(1))).toMatchObject({ status: 'rejected', healthChanged: false });
        expect(state(receiver).status).toBe('degraded');
        expect(receiver.acceptPrepared(draft(3))).toMatchObject({ status: 'published', healthChanged: true, snapshot: { admissionSinceRevision: 2 } });
        receiver.close();
    });
});

describe('receiver-owned interaction lifetime', () => {
    it('permanently stops interaction admission before first use', async () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        receiver.acceptPrepared(draft(1), 'authoritative', [{ name: 'File', multiplicity: 'single' }]);
        expect(receiver.getInteractionStats()).toBeNull();
        await receiver.closeInteractions();
        expect(receiver.getInteractionStats()).toBeNull();
        expect(() => receiver.interaction(policy, execution)).toThrow('unavailable');
        await receiver.close();
    });

    it('shares one interaction and permits one prepared observation alongside the current one', async () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance', () => 0);
        receiver.acceptPrepared(draft(1), 'authoritative', [{ name: 'File', multiplicity: 'single' }]);
        const interaction = receiver.interaction(policy, execution);
        expect(receiver.interaction(policy, execution)).toBe(interaction);
        const first = await interaction.observe();
        expect(first.status).toBe('observed');
        if (first.status !== 'observed') throw Error(first.issue.code);
        expect((await interaction.observe()).status).toBe('rejected');
        expect(interaction.adoptObservation(first.observation.observationId)).toEqual({ status: 'adopted' });
        const next = await interaction.observe();
        expect(next.status).toBe('observed');
        expect((await interaction.observe()).status).toBe('rejected');
        await receiver.close();
        expect(receiver.getInteractionStats()).toMatchObject({ closed: true, });
    });

    it('uses the injected clock without expiring the current observation', async () => {
        let time = 0;
        const receiver = new SemanticSnapshotReceiver('app', 'instance', () => time);
        receiver.acceptPrepared(draft(1), 'authoritative', [{ name: 'File', multiplicity: 'single' }]);
        const core = (receiver as any).core, id = readyId(receiver)!;
        const interaction = receiver.interaction(policy, execution);
        const first = await interaction.observe();
        if (first.status !== 'observed') throw Error(first.issue.code);
        expect(interaction.adoptObservation(first.observation.observationId)).toEqual({ status: 'adopted' });
        time = 60001;
        expect(core.store.inspect().activeHolds).toBe(1);
        receiver.acceptPrepared(draft(2, 'new current'));
        const second = await interaction.observe();
        if (second.status !== 'observed') throw Error(second.issue.code);
        time = 660002;
        const retained = core.store.acquire(id);
        expect(retained.status).toBe('acquired'); retained.hold.release();
        interaction.releaseObservation(first.observation.observationId);
        interaction.releaseObservation(second.observation.observationId);
        expect(core.store.acquire(id).status).toBe('rejected');
        expect((await interaction.observe()).status).toBe('observed');
        await receiver.close();
        expect(receiver.getInteractionStats()?.observations.observationSlots).toBe(0);
    });

    it.each([-1, NaN, 9])('fails closed with invalid injected clock %s and still cleans up', async timeAfter => {
        let time = 10;
        const receiver = new SemanticSnapshotReceiver('app', 'instance', () => time);
        receiver.acceptPrepared(draft(1), 'authoritative', [{ name: 'File', multiplicity: 'single' }]);
        const interaction = receiver.interaction(policy, execution);
        const first = await interaction.observe();
        expect(first.status).toBe('observed');
        time = timeAfter;
        expect(await interaction.observe()).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_INTERNAL_ERROR' } });
        expect(await interaction.invoke({ invocationId: 'bad', observationId: 'bad', toolId: 'bad', input: {} }))
            .toMatchObject({ kind: 'refused', code: 'OBSERVATION_INTERNAL_ERROR' });
        await receiver.close();
        expect(receiver.getInteractionStats()).toMatchObject({ closed: true, });
        expect(state(receiver).status).toBe('stopped');
    });
});

it('seals only the first actually accepted declaration, even without Tools', async()=>{
    const rx=new SemanticSnapshotReceiver('app','instance');
    const types=[{name:'File',multiplicity:'single' as const}];
    const old=draft(1);
    expect(rx.acceptPrepared(old,'candidate')).toMatchObject({status:'rejected',issue:{code:'SNAPSHOT_INVALID',path:'$.viewTypes'}});
    expect(rx.acceptPrepared(old,'candidate',[...types,...types])).toMatchObject({status:'rejected',issue:{code:'SNAPSHOT_INVALID',path:'$.viewTypes[1].name'}});
    expect(rx.acceptPrepared(old,'candidate',[{name:'Other',multiplicity:'single'}])).toMatchObject({status:'rejected',issue:{code:'SNAPSHOT_INVALID',path:'$.views[0].type'}});
    expect(state(rx).status).toBe('unready');
    expect(rx.acceptPrepared(old,'candidate',types)).toMatchObject({status:'published'});
    const id=readyId(rx);
    expect(rx.acceptPrepared(draft(2),'candidate',types)).toMatchObject({status:'rejected',issue:{code:'SNAPSHOT_INVALID',path:'$.viewTypes'}});
    const double={...draft(2),views:[...old.views,{...old.views[0],id:'other',viewInstanceId:'m:2'}]};
    expect(rx.acceptPrepared(double,'candidate')).toMatchObject({status:'rejected',issue:{code:'SNAPSHOT_INVALID'}});
    expect(readyId(rx)).toBe(id);
    expect(rx.acceptPrepared({...draft(2),views:[]},'candidate')).toMatchObject({status:'published'});
    expect(rx.acceptPrepared({...draft(3),views:[{...old.views[0],type:'Other'}]},'candidate')).toMatchObject({status:'rejected',issue:{code:'SNAPSHOT_INVALID',path:'$.views[0].type'}});
    await rx.close();
});
