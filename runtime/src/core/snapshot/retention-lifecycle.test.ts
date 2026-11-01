import { describe, expect, it, vi } from 'vitest';
import { createSnapshotCore, refKey, validatePreparedV2Draft } from './index.js';
import { canonicalJson, utf8Size } from './json.js';
import type { JsonValue, SnapshotStoreOptions } from './types.js';

function draft(appId = 'a', instanceId = 'i', seq = 1, value = 'old') {
    return { schemaVersion: 2 as const, appId, instanceId, producerSeq: seq, sourceEpoch: seq, capturedAt: 0,
        views: [{ id: 'v', viewInstanceId: 'g', type: 'Detail', name: value, kind: 'state' as const,
            content: { format: 'markdown-v1' as const, value } }],
        refs: { [refKey('v', 'g', 'r')]: { id: 'r', ownerViewId: 'v', ownerViewInstanceId: 'g', refType: 'Value',
            target: { kind: 'snapshot-value' as const, payload: { value } } } }, tools: {} };
}
const size = (d: ReturnType<typeof draft>) => utf8Size(canonicalJson(d as unknown as JsonValue));
function published(c: ReturnType<typeof createSnapshotCore>, d = draft()) {
    const r = c.committer.accept(d); expect(r.status).toBe('published');
    if (r.status === 'rejected') throw Error(r.issue.message);
    return r.snapshot;
}
const caps = { maxAppRecords: 1024, maxInstanceIds: 65536, maxIdentityBytes: 8 * 1024 * 1024, maxCurrentBytes: 32 * 1024 * 1024 };

describe('W09-A Snapshot finite retention', () => {
    it.each(Object.entries(caps))('A01 captures %s with zero, lowered and hard upper boundary', (key, hard) => {
        for (const value of [0, 1, hard]) expect(() => createSnapshotCore({ [key]: value })).not.toThrow();
        for (const value of [NaN, Infinity, -1, 0.5, hard + 1]) expect(() => createSnapshotCore({ [key]: value })).toThrow(RangeError);
        const options: any = { [key]: 0 }; const c = createSnapshotCore(options); options[key] = hard;
        if (key === 'maxCurrentBytes') { c.lifecycle.startApp('a', 'i'); expect(c.committer.accept(draft())).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_CAPACITY' } }); }
        else expect(() => c.lifecycle.startApp('a', 'i')).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
    });
    it('A02 counts stopped Apps; capacity rejection preserves active source and does not consume IDs', () => {
        const c = createSnapshotCore({ now: () => 0, maxAppRecords: 2 });
        c.lifecycle.startApp('a', 'i'); const old = published(c);
        c.lifecycle.startApp('b', 'j'); c.lifecycle.stopApp('b', 'j');
        c.lifecycle.startApp('a', 'i');
        expect(() => c.lifecycle.startApp('c', 'free')).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
        expect(c.store.inspect()).toMatchObject({ appRecords: 2, issuedInstanceIds: 2, activeApps: 1 });
        expect(c.store.getById(old.id)).toMatchObject({ status: 'found' });
        c.lifecycle.startApp('b', 'free'); expect(c.store.readAppIdentity('b')).toEqual({ status: 'active', instanceId: 'free' });
    });
    it('A02 reaches actual default 1024 Apps without evicting stopped records', () => {
        const c = createSnapshotCore({ now: () => 0 });
        for (let n = 0; n < 1024; n++) { c.lifecycle.startApp('a' + n, 'i' + n); c.lifecycle.stopApp('a' + n, 'i' + n); }
        expect(c.store.inspect()).toMatchObject({ appRecords: 1024, activeApps: 0 });
        expect(() => c.lifecycle.startApp('extra', 'new')).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
        c.lifecycle.startApp('a0', 'new'); expect(c.store.inspect().appRecords).toBe(1024);
    });
    it('A03 reaches the actual default 65536 issued IDs and never forgets stopped identities', () => {
        const c = createSnapshotCore({ now: () => 0, historyTtlMs: 0 });
        for (let n = 0; n < 65536; n++) c.lifecycle.startApp('a', 'i' + n);
        c.lifecycle.startApp('a', 'i65535'); expect(c.store.inspect().issuedInstanceIds).toBe(65536);
        expect(() => c.lifecycle.startApp('a', 'next')).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
        c.lifecycle.stopApp('a', 'i65535');
        expect(() => c.lifecycle.startApp('a', 'i0')).toThrow(/APP_INSTANCE_MISMATCH/);
        expect(() => c.lifecycle.startApp('a', 'next')).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
    });
    it('A03 small N-1/N/N+1 preserves the old current on identity exhaustion', () => {
        const c = createSnapshotCore({ now: () => 0, maxInstanceIds: 2 }); c.lifecycle.startApp('a', 'i');
        c.lifecycle.startApp('a', 'j'); const old = published(c, draft('a', 'j'));
        expect(() => c.lifecycle.startApp('a', 'k')).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
        expect(c.store.readLatest('a')).toEqual({ status: 'ready', snapshot: old });
        expect(() => c.lifecycle.startApp('b', 'j')).toThrow(/APP_INSTANCE_MISMATCH/);
    });
    it.each([-1, 0, 1])('A04 measures exact Unicode identity bytes with budget delta %s', delta => {
        const need = utf8Size('中') + utf8Size('😀'); const c = createSnapshotCore({ now: () => 0, maxIdentityBytes: need + delta });
        if (delta < 0) expect(() => c.lifecycle.startApp('中', '😀')).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
        else { c.lifecycle.startApp('中', '😀'); expect(c.store.inspect().identityBytes).toBe(need); }
    });
    it('A04 charges an App name once, rejects huge IDs before encoding and keeps old source', () => {
        const c = createSnapshotCore({ now: () => 0, maxIdentityBytes: 7 });
        c.lifecycle.startApp('中', 'a'); c.lifecycle.startApp('中', 'b'); expect(c.store.inspect().identityBytes).toBe(5);
        const old = published(c, draft('中', 'b')); const encoder = vi.spyOn(TextEncoder.prototype, 'encode');
        expect(() => c.lifecycle.startApp('中', 'x'.repeat(1_000_000))).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CAPACITY' }));
        expect(encoder).not.toHaveBeenCalled(); encoder.mockRestore();
        expect(c.store.readLatest('中')).toEqual({ status: 'ready', snapshot: old });
        c.lifecycle.startApp('中', 'cc'); expect(c.store.inspect().identityBytes).toBe(7);
    });
    it('A05 charges complete accepted Draft bytes, preserves unchanged charge and old Ref after rejection', () => {
        const a = draft(), b = draft('b', 'j'); const cap = size(a) + size(b);
        const c = createSnapshotCore({ now: () => 0, maxCurrentBytes: cap });
        c.lifecycle.startApp('a', 'i'); c.lifecycle.startApp('b', 'j'); const old = published(c); published(c, b);
        expect(c.store.inspect().currentBytes).toBe(cap);
        expect(c.committer.accept(draft('a', 'i', 999))).toMatchObject({ status: 'unchanged', snapshot: old });
        expect(c.store.inspect().currentBytes).toBe(cap);
        expect(c.committer.accept(draft('a', 'i', 1000, 'x'.repeat(100)))).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_CAPACITY' } });
        expect(c.store.readLatest('a')).toMatchObject({ status: 'degraded', lastGood: old });
        expect(c.store.inspect().currentBytes).toBe(cap);
        expect(c.committer.accept(draft('a', 'i', 1000, 'new'))).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_SEQUENCE_STALE' } });
        expect(c.store.resolveRef({ snapshotId: old.id, appId: 'a', instanceId: 'i', viewId: 'v', viewInstanceId: 'g', refId: 'r' }))
            .toMatchObject({ status: 'resolved', target: { payload: { value: 'old' } } });
        c.lifecycle.stopApp('b', 'j'); const next = published(c, draft('a', 'i', 1001, 'new'));
        expect(next.revision).toBe(2); expect(c.store.inspect().currentBytes).toBe(size(draft('a', 'i', 1001, 'new')));
    });
    it.each([-1, 0, 1])('A05 current N-1/N/N+1 delta %s', delta => {
        const c = createSnapshotCore({ maxCurrentBytes: size(draft()) + delta }); c.lifecycle.startApp('a', 'i');
        expect(c.committer.accept(draft()).status).toBe(delta < 0 ? 'rejected' : 'published');
    });
    it('A06 history can temporarily exceed its budget under live leases without increasing total ownership bytes', () => {
        const bytes = size(draft()); const c = createSnapshotCore({ now: () => 0, maxCurrentBytes: bytes, maxHistoryBytes: 0 });
        c.lifecycle.startApp('a', 'i'); const old = published(c), lease = c.store.acquire(old.id);
        expect(lease.status).toBe('acquired'); if (lease.status !== 'acquired') throw Error();
        c.lifecycle.startApp('a', 'j'); expect(c.store.inspect()).toMatchObject({ currentBytes: 0, historicalBytes: bytes, activeLeases: 1 });
        expect(c.committer.accept(draft('a', 'j'))).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_CAPACITY' } });
        expect(c.store.getById(old.id).status).toBe('found'); lease.lease.release(); lease.lease.release();
        published(c, draft('a', 'j', 2)); const stats = c.store.inspect();
        expect(stats.historicalBytes + stats.currentBytes).toBeLessThanOrEqual(bytes);
    });
    it.each([509, 510, 511, 512, 513, 200000])('A07 bounds prepare diagnostic text %s with exact byte accounting', length => {
        const c = createSnapshotCore({ now: () => 0 }); c.lifecycle.startApp('a', 'i');
        const message = 'm'.repeat(length), path = '😀'.repeat(length);
        const result = c.committer.reportPrepareFailure({ appId: 'a', instanceId: 'i', producerSeq: 1, sourceEpoch: 1,
            issue: { code: 'SNAPSHOT_INVALID', message, path } });
        expect(result.status).toBe('rejected'); if (result.status !== 'rejected') throw Error();
        expect(utf8Size(result.issue.message)).toBeLessThanOrEqual(512); expect(utf8Size(result.issue.path!)).toBeLessThanOrEqual(512);
        if (length <= 512) expect(result.issue.message).toBe(message);
        else expect(result.issue.message).toBe('m'.repeat(509) + '…');
        expect(result.issue.path).toBe('😀'.repeat(127) + '…');
        expect(c.store.inspect().diagnosticBytes).toBe(utf8Size(result.issue.code + result.issue.message + result.issue.path));
        published(c, draft('a', 'i', 2)); expect(c.store.inspect().diagnosticBytes).toBe(0);
    });
    it.each(['', '$', '$.x'])('A07 keeps short and empty diagnostic strings byte-for-byte: %s', path => {
        const c = createSnapshotCore(); c.lifecycle.startApp('a', 'i');
        expect(c.committer.reportPrepareFailure({ appId: 'a', instanceId: 'i', producerSeq: 1, sourceEpoch: 1,
            issue: { code: 'SNAPSHOT_INVALID', message: '', path } })).toEqual({ status: 'rejected',
                issue: { appId: 'a', instanceId: 'i', code: 'SNAPSHOT_INVALID', message: '', path } });
        expect(c.store.inspect().diagnosticBytes).toBe(utf8Size('SNAPSHOT_INVALID' + path));
    });
    it.each([null, 123, 'x'.repeat(65), '😀'.repeat(17)])('A07 normalizes invalid trusted failure code %s', code => {
        const c = createSnapshotCore(); c.lifecycle.startApp('a', 'i');
        expect(c.committer.reportPrepareFailure({ appId: 'a', instanceId: 'i', producerSeq: 1, sourceEpoch: 1,
            issue: { code, message: 'short', path: '$.x' } } as any)).toMatchObject({ issue: { code: 'SNAPSHOT_INVALID', message: 'short', path: '$.x' } });
        c.lifecycle.stopApp('a', 'i'); expect(c.store.inspect().diagnosticBytes).toBe(0);
    });
    it('A07 bounds actual invalid Draft diagnostics and clears unchanged recovery', () => {
        const c = createSnapshotCore(); c.lifecycle.startApp('a', 'i'); published(c);
        const bad = { ...draft('a', 'i', 2), refs: { ['key'.repeat(70000)]: {} } };
        const r = c.committer.accept(bad); expect(r.status).toBe('rejected'); if (r.status !== 'rejected') throw Error();
        expect(utf8Size(r.issue.path ?? '')).toBeLessThanOrEqual(512); expect(utf8Size(r.issue.message)).toBeLessThanOrEqual(512);
        expect(c.store.inspect().diagnosticBytes).toBeGreaterThan(0);
        expect(c.committer.accept(draft('a', 'i', 3)).status).toBe('unchanged'); expect(c.store.inspect().diagnosticBytes).toBe(0);
        expect(validatePreparedV2Draft(draft()).ok).toBe(true);
    });
    it.each([false, true])('A08/A09 permanent disposal works with failing clock=%s without reading hostile input', broken => {
        let badClock = false, reads = 0;
        const c = createSnapshotCore({ now: () => { reads++; if (badClock) throw Error('clock'); return 0; } });
        c.lifecycle.startApp('a', 'i'); const snapshot = published(c), lease = c.store.acquire(snapshot.id);
        expect(lease.status).toBe('acquired'); if (lease.status !== 'acquired') throw Error();
        badClock = broken; const before = reads; c.lifecycle.dispose(); c.lifecycle.dispose();
        const hostile = new Proxy({}, { get() { throw Error('input read'); }, getOwnPropertyDescriptor() { throw Error('input descriptor read'); } });
        expect(() => c.lifecycle.startApp(hostile as any, hostile as any)).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CORE_CLOSED' }));
        expect(c.committer.accept(hostile)).toMatchObject({ issue: { code: 'APP_STOPPED' } });
        expect(c.committer.reportPrepareFailure(hostile as any)).toMatchObject({ issue: { code: 'APP_STOPPED' } });
        c.lifecycle.stopApp('a', 'i'); lease.lease.release(); lease.lease.release();
        expect(c.store.readLatest('a')).toEqual({ status: 'stopped' }); expect(c.store.readAppIdentity('a')).toEqual({ status: 'absent' });
        expect(c.store.getById(snapshot.id)).toMatchObject({ issue: { code: 'SNAPSHOT_EXPIRED' } });
        expect(c.store.acquire(snapshot.id)).toMatchObject({ issue: { code: 'SNAPSHOT_EXPIRED' } });
        expect(c.store.resolveRef(hostile as any)).toMatchObject({ issue: { code: 'SNAPSHOT_EXPIRED' } });
        expect(c.store.getTool(hostile as any)).toMatchObject({ issue: { code: 'SNAPSHOT_EXPIRED' } });
        const stats = c.store.inspect(); expect(stats.state).toBe('disposed');
        for (const [key, value] of Object.entries(stats)) if (key !== 'state') expect(value).toBe(0);
        expect(Object.isFrozen(stats)).toBe(true); expect(c.store.inspect()).not.toBe(stats); expect(reads).toBe(before);
        expect(snapshot.refs[refKey('v', 'g', 'r')].target).toEqual({ kind: 'snapshot-value', payload: { value: 'old' } });
    });
});
