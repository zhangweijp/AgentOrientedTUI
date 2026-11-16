import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';

describe('Wave 2A: current Store lease and historical-source contract', () => {
    function setup() {
        let time = 0;
        const core = createSnapshotCore({ now: () => time, historyTtlMs: 20, leaseTtlMs: 100 });
        core.lifecycle.startApp('app', 'instance');
        const publish = (seq: number) => {
            const result = core.committer.accept({
                schemaVersion: 5, appId: 'app', instanceId: 'instance', producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
                views: [{ toolBindings: [], id: 'detail', viewInstanceId: 'mount', type: 'Detail', name: 'Detail', kind: 'state', content: { format: 'markdown-v1', value: String(seq) } }],
                refs: {}, tools: {},
            });
            if (result.status !== 'published') throw new Error('Expected a committed snapshot');
            return result.snapshot.id;
        };
        const select = (snapshotId: string) => core.store.acquire(snapshotId);
        return { core, publish, select, time(value: number) { time = value; } };
    }

    it('a pinned historical entry is retained data, but cannot be acquired as a new source after history TTL', () => {
        const env = setup(); const oldId = env.publish(1); const selected = env.select(oldId);
        if (selected.status !== 'acquired') throw new Error('Expected source');
        env.time(1); env.publish(2); env.time(21);
        expect(env.core.store.getById(oldId).status).toBe('found');
        expect(env.core.store.inspect().activeLeases).toBe(1);
        expect(env.select(oldId)).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_EXPIRED' } });
        selected.lease.release(); selected.lease.release();
        expect(env.core.store.getById(oldId)).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_EXPIRED' } });
        expect(env.core.store.inspect().activeLeases).toBe(0);
    });

    it('expiration of one lease does not expire a still-current Snapshot; execution must freshly acquire it', () => {
        const env = setup(); const id = env.publish(1); const old = env.select(id);
        if (old.status !== 'acquired') throw new Error('Expected source');
        env.time(100);
        expect(env.core.store.inspect().activeLeases).toBe(0);
        const fresh = env.select(id);
        expect(fresh.status).toBe('acquired');
        if (fresh.status !== 'acquired') throw new Error('Expected fresh lease on current source');
        expect(env.core.store.inspect().activeLeases).toBe(1);
        old.lease.release();
        expect(env.core.store.inspect().activeLeases).toBe(1);
        fresh.lease.release();
        expect(env.core.store.inspect().activeLeases).toBe(0);
    });
});
