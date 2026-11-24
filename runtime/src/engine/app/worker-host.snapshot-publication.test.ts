import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppWorkerHost } from './worker-host.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'aotui-publication-'));
    const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'desktop' as any,
        appModulePath: 'unused', config: { AOTUI_DATA_DIR: directory } });
    cleanups.push(() => { (host as any).snapshotReceiver.close();rmSync(directory, { recursive: true, force: true }); });
    const send = (message: unknown) => (host as any).handleMessage(message);
    const draft = (seq: number, content = 'current') => ({ schemaVersion: 8, appId: 'app',
        instanceId: (host as any).appInstanceId, producerSeq: seq, sourceEpoch: seq, capturedAt: 1,
        views: [{ toolBindings: [], id: 'file', viewInstanceId: 'view-instance', type: 'File', name: 'File', region: 'dynamic',
            content: { format: 'markdown-v1', value: content } }], refs: {}, tools: {} });
    const publish = (seq: number, content = 'current') =>
        send({ type: 'SNAPSHOT_PREPARED', draft: draft(seq, content) });
    return { host, send, draft, publish };
}

describe('Semantic commit notifications', () => {
    it('does not expose direct View lifecycle routes on WorkerHost', () => {
        const { host } = fixture();
        expect(host).not.toHaveProperty('dismountView');
        expect(host).not.toHaveProperty('mountViewByLink');
    });

    it('accepts only this instance’s newer frame without notifying another reader', () => {
        const f = fixture(), observed: unknown[] = [];
        f.host.onUpdate = () => observed.push(f.host.getSemanticSnapshotReport());
        f.publish(1);
        expect(f.host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', revision: 1, lastViewCount: 1 });
        f.publish(2);
        expect(observed).toHaveLength(0);
        f.publish(3, 'changed in the same millisecond');
        expect(observed).toHaveLength(0);
        expect(f.host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', revision: 2 });
        f.publish(2, 'late');
        f.send({ type: 'SNAPSHOT_PREPARED', draft: { ...f.draft(4), instanceId: 'foreign' } });
        f.send({ type: 'SNAPSHOT_PREPARED', draft: { ...f.draft(5), appId: 'foreign' } });
        expect(observed).toHaveLength(0);
        expect(f.host.getSemanticSnapshotReport()).toMatchObject({
            health: 'ready', revision: 2, published: 2, rejected: 3, wrongSource: 2,
        });
    });

    it('keeps passive publications fresh without emitting an update', () => {
        const f = fixture(), update = vi.fn();f.host.onUpdate = update;
        f.publish(1, 'passive');
        expect(f.host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', revision: 1 });
        expect(update).not.toHaveBeenCalled();
        f.publish(2, 'passive changed');
        expect(f.host.getSemanticSnapshotReport()).toMatchObject({ revision: 2 });
        expect(update).not.toHaveBeenCalled();
    });

    it('reports one fault while two identical failures are received and accepts an unchanged repair', () => {
        const f = fixture(), health: unknown[] = [];
        f.host.onUpdate = () => health.push(f.host.getSemanticSnapshotReport()?.health);
        f.publish(1);
        const fail = (seq: number) => f.send({ type: 'SNAPSHOT_PREPARE_FAILED', appId: 'app',
            instanceId: f.draft(seq).instanceId, producerSeq: seq, sourceEpoch: seq,
            error: { code: 'SNAPSHOT_SERIALIZATION_ERROR', message: 'Cannot serialize capture' } });
        fail(2);fail(3);
        expect(health).toEqual(['degraded']);
        f.publish(4);
        expect(health).toEqual(['degraded']);
        expect(f.host.getSemanticSnapshotReport()).toMatchObject({ revision: 1, unchanged: 1 });
    });

    it('publishes the last View closing as a legal empty state', () => {
        const f = fixture(), update = vi.fn();f.host.onUpdate = update;
        f.publish(1);
        f.send({ type: 'SNAPSHOT_PREPARED', draft: { ...f.draft(2), views: [] } });
        expect(update).not.toHaveBeenCalled();
        expect(f.host.getSemanticSnapshotReport()).toMatchObject({ health: 'ready', revision: 2, lastViewCount: 0, lastToolCount: 0 });
    });

    it('records unexpected receiver failure instead of silently keeping a usable source', () => {
        const f = fixture(), update = vi.fn();f.host.onUpdate = update;
        vi.spyOn((f.host as any).snapshotReceiver, 'acceptPrepared').mockImplementation(() => { throw new Error('receiver'); });
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            f.publish(1);
            expect(f.host.getStatus()).toBe('error');
            expect(f.host.getSemanticSnapshotReport()?.health).toBe('stopped');
            expect(update).not.toHaveBeenCalled();
        } finally { log.mockRestore(); }
    });
});
