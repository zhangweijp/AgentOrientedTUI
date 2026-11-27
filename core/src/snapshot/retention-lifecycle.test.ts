import { describe, expect, it, vi } from 'vitest';
import { createSnapshotCore } from './store.js';
import { refKey } from './snapshot-support.js';
import { validatePreparedSnapshot } from './validate-snapshot.js';
import { canonicalJson, utf8Size } from './json.js';
import type { JsonValue } from './types.js';

function draft(appId = 'a', instanceId = 'i', seq = 1, value = 'old') {
    return { healthySince: 1,  schemaVersion: 9 as const, appId, instanceId, producerSeq: seq, sourceEpoch: seq, capturedAt: 0,
        views: [{ toolBindings: [], id: 'v', viewInstanceId: 'm:1', type: 'Detail', name: value, region: 'dynamic' as const,
            content: { format: 'markdown-v1' as const, value } }],
        refs: { [refKey('v', 'm:1', 'r')]: { continuity: [1,1,0] as const,  valueSchema: { type: 'object' }, scope: 'protected', id: 'r', ownerViewId: 'v', ownerViewInstanceId: 'm:1', refType: 'Value',
            target: { kind: 'snapshot-value' as const, payload: { value } } } }, tools: {} };
}
const size = (d: ReturnType<typeof draft>) => utf8Size(canonicalJson(d as unknown as JsonValue));
function published(c: ReturnType<typeof createSnapshotCore>, d = draft()) {
    const r = c.committer.accept(d); expect(r.status).toBe('published');
    if (r.status === 'rejected') throw Error(r.issue.message);
    return r.snapshot;
}
const identity = { appId: 'a', instanceId: 'i' };

describe('W09-A Snapshot finite retention', () => {
    it('releases retired payload immediately when publication leaves it without a holder', () => {
        const c = createSnapshotCore({ ...identity, now: () => 0 });
        const old = published(c), next = published(c, draft('a', 'i', 2, 'new'));
        expect(c.store.getById(old.id)).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_UNAVAILABLE' } });
        expect(c.store.inspect()).toMatchObject({ heldSnapshots: 0, heldSnapshotBytes: 0 });
        expect(c.store.getById(next.id).status).toBe('found'); c.lifecycle.dispose();
    });
    it('drops the retired snapshot on the last release while preserving a second holder and current data', () => {
        const c = createSnapshotCore({ ...identity, now: () => 0 });
        const old = published(c), a = c.store.acquire(old.id), b = c.store.acquire(old.id);
        if (a.status !== 'acquired' || b.status !== 'acquired') throw Error('holders');
        const next = published(c, draft('a', 'i', 2, 'new'));
        a.hold.release(); expect(c.store.getById(old.id).status).toBe('found');
        b.hold.release(); b.hold.release();
        expect(c.store.getById(old.id).status).toBe('rejected');
        expect(c.store.inspect()).toMatchObject({ heldSnapshots: 0, heldSnapshotBytes: 0, currentSnapshots: 1, activeHolds: 0 });
        expect(c.store.getById(next.id).status).toBe('found'); c.lifecycle.dispose();
    });
    it('A01 captures the current snapshot byte limit at construction', () => {
        const hard = 32 * 1024 * 1024;
        for (const value of [0, 1, hard]) createSnapshotCore({ ...identity, maxCurrentBytes: value }).lifecycle.dispose();
        for (const value of [NaN, Infinity, -1, 0.5, hard + 1]) {
            expect(() => createSnapshotCore({ ...identity, maxCurrentBytes: value })).toThrow(RangeError);
        }
        const options = { ...identity, maxCurrentBytes: 0 };
        const core = createSnapshotCore(options);
        options.maxCurrentBytes = hard;
        expect(core.committer.accept(draft())).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_CAPACITY' } });
    });
    it.each([-1, 0, 1])('A04 bounds the fixed pair by exact Unicode bytes with budget delta %s', delta => {
        const limits = { appId: '中', instanceId: '😀', maxIdentityBytes: utf8Size('中') + utf8Size('😀') + delta };
        if (delta < 0) expect(() => createSnapshotCore(limits)).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
        else expect(createSnapshotCore(limits).store.readAppIdentity('中')).toEqual({ status: 'active', instanceId: '😀' });
    });
    it('A04 validates the identity ceiling and rejects oversized input before encoding', () => {
        for (const maxIdentityBytes of [NaN, Infinity, -1, 0.5, 8 * 1024 * 1024 + 1]) {
            expect(() => createSnapshotCore({ ...identity, maxIdentityBytes })).toThrow(RangeError);
        }
        expect(() => createSnapshotCore({ ...identity, maxIdentityBytes: 0 }))
            .toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
        const encoder = vi.spyOn(TextEncoder.prototype, 'encode');
        try {
            expect(() => createSnapshotCore({ appId: '中', instanceId: 'x'.repeat(1_000_000), maxIdentityBytes: 7 }))
                .toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
            expect(encoder).not.toHaveBeenCalled();
        } finally { encoder.mockRestore(); }
    });
    it('A05 charges only this run’s current Draft and preserves its Ref on rejection', () => {
        const first = draft('a', 'i', 1, 'first-value'), cap = size(first);
        const core = createSnapshotCore({ ...identity, now: () => 0, maxCurrentBytes: cap });
        const other = createSnapshotCore({ appId: 'b', instanceId: 'j', now: () => 0, maxCurrentBytes: cap });
        const old = published(core, first), peer = published(other, draft('b', 'j'));
        expect(core.store.inspect().currentBytes).toBe(cap);
        expect(core.committer.accept(draft('a', 'i', 999, 'first-value'))).toMatchObject({ status: 'unchanged', snapshot: old });
        expect(core.store.inspect().currentBytes).toBe(cap);
        expect(core.committer.accept(draft('a', 'i', 1000, 'x'.repeat(100)))).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_CAPACITY' } });
        expect(core.store.readLatest('a')).toMatchObject({ status: 'degraded', lastGood: old });
        expect(core.store.inspect().currentBytes).toBe(cap);
        expect(core.committer.accept(draft('a', 'i', 1000, 'new'))).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_SEQUENCE_STALE' } });
        expect(core.store.resolveRef({ snapshotId: old.id, appId: 'a', instanceId: 'i', viewId: 'v', viewInstanceId: 'm:1', refId: 'r' }))
            .toMatchObject({ status: 'resolved', target: { payload: { value: 'first-value' } } });
        const next = draft('a', 'i', 1001, 'new');
        expect(published(core, next).revision).toBe(2);
        expect(core.store.inspect().currentBytes).toBe(size(next));
        core.lifecycle.dispose();
        expect(other.store.readLatest('b')).toEqual({ status: 'ready', snapshot: peer });
        expect(other.store.readAppIdentity('a')).toEqual({ status: 'absent' });
    });
    it.each([-1, 0, 1])('A05 current N-1/N/N+1 delta %s', delta => {
        const c = createSnapshotCore({ ...identity, maxCurrentBytes: size(draft()) + delta });
        expect(c.committer.accept(draft()).status).toBe(delta < 0 ? 'rejected' : 'published');
    });
    it.each([false, true])('A06 stop retains only held data even with a failed clock=%s', broken => {
        const bytes = size(draft());
        let clockFailed = false;
        const c = createSnapshotCore({ ...identity, now: () => { if (clockFailed) throw Error('clock'); return 0; },
            maxCurrentBytes: bytes, maxHeldSnapshotBytes: 0 });
        const old = published(c), lease = c.store.acquire(old.id);
        if (lease.status !== 'acquired') throw Error('Expected lease');
        clockFailed = broken;
        c.lifecycle.stop();
        c.lifecycle.stop();
        clockFailed = false;
        expect(c.committer.accept(draft('a', 'i', 2))).toMatchObject({ status: 'rejected', issue: { code: 'APP_STOPPED' } });
        expect(c.store.inspect()).toMatchObject({ currentBytes: 0, heldSnapshotBytes: bytes, activeHolds: 1 });
        expect(c.store.getById(old.id).status).toBe('found');
        lease.hold.release();
        expect(c.store.inspect()).toMatchObject({ currentBytes: 0, heldSnapshotBytes: 0, activeHolds: 0 });
    });
    it.each([509, 510, 511, 512, 513, 200000])('A07 bounds prepare diagnostic text %s with exact byte accounting', length => {
        const c = createSnapshotCore({ ...identity, now: () => 0 });
        const message = 'm'.repeat(length), path = '😀'.repeat(length);
        const result = c.committer.reportPrepareFailure({ appId: 'a', instanceId: 'i', producerSeq: 1, sourceEpoch: 1,
            issue: { code: 'SNAPSHOT_INVALID', message, path } });
        expect(result.status).toBe('rejected'); if (result.status !== 'rejected') throw Error();
        expect(utf8Size(result.issue.message)).toBeLessThanOrEqual(512); expect(utf8Size(result.issue.path!)).toBeLessThanOrEqual(512);
        if (length <= 512) expect(result.issue.message).toBe(message);
        else expect(result.issue.message).toBe('m'.repeat(509) + '…');
        expect(result.issue.path).toBe('😀'.repeat(127) + '…');
        expect(c.store.inspect().diagnosticBytes).toBe(utf8Size(result.issue.code + result.issue.message + result.issue.path));
        published(c, { ...draft('a','i',2), healthySince: 2, refs: { [refKey('v','m:1','r')]: { ...Object.values(draft().refs)[0]!, continuity: [2,2,0] as const } } }); expect(c.store.inspect().diagnosticBytes).toBe(0);
    });
    it.each(['', '$', '$.x'])('A07 keeps short and empty diagnostic strings byte-for-byte: %s', path => {
        const c = createSnapshotCore(identity);
        expect(c.committer.reportPrepareFailure({ appId: 'a', instanceId: 'i', producerSeq: 1, sourceEpoch: 1,
            issue: { code: 'SNAPSHOT_INVALID', message: '', path } })).toEqual({ status: 'rejected',
                issue: { appId: 'a', instanceId: 'i', code: 'SNAPSHOT_INVALID', message: '', path } });
        expect(c.store.inspect().diagnosticBytes).toBe(utf8Size('SNAPSHOT_INVALID' + path));
    });
    it.each([null, 123, 'x'.repeat(65), '😀'.repeat(17)])('A07 normalizes invalid trusted failure code %s', code => {
        const c = createSnapshotCore(identity);
        expect(c.committer.reportPrepareFailure({ appId: 'a', instanceId: 'i', producerSeq: 1, sourceEpoch: 1,
            issue: { code, message: 'short', path: '$.x' } } as any)).toMatchObject({ issue: { code: 'SNAPSHOT_INVALID', message: 'short', path: '$.x' } });
        c.lifecycle.stop(); expect(c.store.inspect().diagnosticBytes).toBe(0);
    });
    it('A07 bounds actual invalid Draft diagnostics and clears them on identical-content recovery', () => {
        const c = createSnapshotCore(identity); published(c);
        const bad = { ...draft('a', 'i', 2), refs: { ['key'.repeat(70000)]: {} } };
        const r = c.committer.accept(bad); expect(r.status).toBe('rejected'); if (r.status !== 'rejected') throw Error();
        expect(utf8Size(r.issue.path ?? '')).toBeLessThanOrEqual(512); expect(utf8Size(r.issue.message)).toBeLessThanOrEqual(512);
        expect(c.store.inspect().diagnosticBytes).toBeGreaterThan(0);
        expect(c.committer.accept(draft('a', 'i', 3))).toMatchObject({ status: 'published', snapshot: { revision: 2, admissionSinceRevision: 2 } }); expect(c.store.inspect().diagnosticBytes).toBe(0);
        expect(validatePreparedSnapshot(draft()).ok).toBe(true);
    });
    it.each([false, true])('A08/A09 permanent disposal works with failing clock=%s without reading hostile input', broken => {
        let badClock = false, reads = 0;
        const c = createSnapshotCore({ ...identity, now: () => { reads++; if (badClock) throw Error('clock'); return 0; } });
        const snapshot = published(c), lease = c.store.acquire(snapshot.id);
        expect(lease.status).toBe('acquired'); if (lease.status !== 'acquired') throw Error();
        badClock = broken; const before = reads; c.lifecycle.dispose(); c.lifecycle.dispose();
        const hostile = new Proxy({}, { get() { throw Error('input read'); }, getOwnPropertyDescriptor() { throw Error('input descriptor read'); } });
        expect(c.committer.accept(hostile)).toMatchObject({ issue: { code: 'APP_STOPPED' } });
        expect(c.committer.reportPrepareFailure(hostile as any)).toMatchObject({ issue: { code: 'APP_STOPPED' } });
        c.lifecycle.stop(); lease.hold.release(); lease.hold.release();
        expect(c.store.readLatest('a')).toEqual({ status: 'stopped' }); expect(c.store.readAppIdentity('a')).toEqual({ status: 'absent' });
        expect(c.store.getById(snapshot.id)).toMatchObject({ issue: { code: 'SNAPSHOT_UNAVAILABLE' } });
        expect(c.store.acquire(snapshot.id)).toMatchObject({ issue: { code: 'SNAPSHOT_UNAVAILABLE' } });
        expect(c.store.resolveRef(hostile as any)).toMatchObject({ issue: { code: 'SNAPSHOT_UNAVAILABLE' } });
        const stats = c.store.inspect(); expect(stats.state).toBe('disposed');
        for (const [key, value] of Object.entries(stats)) if (key !== 'state') expect(value).toBe(0);
        expect(Object.isFrozen(stats)).toBe(true); expect(c.store.inspect()).not.toBe(stats); expect(reads).toBe(before);
        expect(snapshot.refs[refKey('v', 'm:1', 'r')].target).toEqual({ kind: 'snapshot-value', payload: { value: 'old' } });
    });
});


describe('B1 fused candidate acceptance and Receiver admission period', () => {
    it('keeps inventory and watermarks after actual retention rejection, then accepts the same candidate epoch', () => {
        const core = createSnapshotCore({ ...identity, maxHeldSnapshots: 0, now: () => 0 });
        const first = published(core);
        const stamp = core.currentPublication();
        const hold = core.store.acquire(first.id);
        if (hold.status !== 'acquired') throw Error('Expected held snapshot');
        const before = core.store.inspect();
        const next = draft('a', 'i', 2, 'new');
        expect(core.committer.accept(next, 'candidate')).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_CAPACITY' } });
        expect(core.currentPublication()).toEqual(stamp);
        expect(core.store.inspect()).toEqual(before);
        expect(core.store.readLatest('a')).toEqual({ status: 'ready', snapshot: first });
        hold.hold.release();
        expect(core.committer.accept(next, 'candidate')).toMatchObject({ status: 'published', snapshot: { revision: 2, admissionSinceRevision: 1 } });
        core.lifecycle.dispose();
    });
    it('does not consume rejected candidate epochs but requires a new epoch after authoritative rejection', () => {
        const core = createSnapshotCore(identity);
        const first = published(core);
        const before = core.currentPublication();
        const invalid = { ...draft('a', 'i', 2), refs: { malformed: {} } };
        expect(core.committer.accept(invalid, 'candidate').status).toBe('rejected');
        expect(core.currentPublication()).toEqual(before);
        expect(core.store.readLatest('a')).toEqual({ status: 'ready', snapshot: first });
        expect(core.committer.accept(invalid, 'authoritative').status).toBe('rejected');
        expect(core.store.readLatest('a')).toMatchObject({ status: 'degraded', lastGood: first });
        expect(core.committer.accept({ ...draft('a', 'i', 2), producerSeq: 3 }, 'candidate').status).toBe('rejected');
        expect(core.committer.accept(draft('a', 'i', 4), 'candidate')).toMatchObject({
            status: 'published', snapshot: { revision: 2, admissionSinceRevision: 2 },
        });
        expect(core.committer.accept(draft('a', 'i', 5), 'authoritative')).toMatchObject({
            status: 'unchanged', snapshot: { revision: 2, admissionSinceRevision: 2 },
        });
        core.lifecycle.dispose();
    });
});
