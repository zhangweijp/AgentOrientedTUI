import { EventEmitter } from 'node:events';
import { committedState, fixtureHost } from './__tests__/worker-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppWorkerHost } from './worker-host.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'aotui-publication-'));
    const worker=Object.assign(new EventEmitter(),{postMessage:vi.fn(),terminate:vi.fn(async()=>{worker.emit('exit',0);return 0;})});
    const host = fixtureHost(AppWorkerHost, { appId: 'app' as any, desktopId: 'desktop' as any,
        appModulePath: 'unused', config: { AOTUI_DATA_DIR: directory } },{worker:worker as any,attach:true});
    (host as any).initializeSent=true;
    cleanups.push(() => { host.terminate();(host as any).snapshotReceiver.close();rmSync(directory, { recursive: true, force: true }); });
    const send = (message: unknown) => worker.emit('message',message);
    const draft = (seq: number, content = 'current') => ({ schemaVersion: 9, healthySince: 1, appId: 'app',
        instanceId: (host as any).appInstanceId, producerSeq: seq, sourceEpoch: seq, capturedAt: 1,
        views: [{ toolBindings: [], id: 'file', viewInstanceId: 'm:1', type: 'File', name: 'File', region: 'dynamic',
            content: { format: 'markdown-v1', value: content } }], refs: {}, tools: {} });
    const publish = (seq: number, content = 'current') =>
        send({ type: 'SNAPSHOT_PREPARED',draft:draft(seq, content),...(seq===1?{viewTypes:[{name:'File',multiplicity:'single'}]}:{}) });
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
        f.host.onUpdate = () => observed.push(committedState(f.host));
        f.publish(1);
        expect(committedState(f.host)).toMatchObject({ status: 'ready', snapshot: { revision: 1, views: [expect.any(Object)] } });
        f.publish(2);
        expect(observed).toHaveLength(1);
        f.publish(3, 'changed in the same millisecond');
        expect(observed).toHaveLength(1);
        expect(committedState(f.host)).toMatchObject({ status: 'ready', snapshot: { revision: 2 } });
        f.publish(2, 'late');
        f.send({ type: 'SNAPSHOT_PREPARED', draft: { ...f.draft(4), instanceId: 'foreign' } });
        f.send({ type: 'SNAPSHOT_PREPARED', draft: { ...f.draft(5), appId: 'foreign' } });
        expect(observed).toHaveLength(1);
        expect(committedState(f.host)).toMatchObject({
            status: 'ready', snapshot: { revision: 2, views: [{ content: { value: 'changed in the same millisecond' } }] },
        });
    });

    it('keeps passive publications fresh without emitting an update', () => {
        const f = fixture(), update = vi.fn();f.host.onUpdate = update;
        f.publish(1, 'passive');
        expect(committedState(f.host)).toMatchObject({ status: 'ready', snapshot: { revision: 1 } });
        expect(update).toHaveBeenCalledTimes(1);
        f.publish(2, 'passive changed');
        expect(committedState(f.host)).toMatchObject({ status: 'ready', snapshot: { revision: 2 } });
        expect(update).toHaveBeenCalledTimes(1);
    });

    it('reports one fault while two identical failures are received and opens a new period on identical repair', () => {
        const f = fixture(), health: unknown[] = [];
        f.host.onUpdate = () => health.push(committedState(f.host).status);
        f.publish(1);
        const fail = (seq: number) => f.send({ type: 'SNAPSHOT_PREPARE_FAILED', appId: 'app',
            instanceId: f.draft(seq).instanceId, producerSeq: seq, sourceEpoch: seq,
            error: { code: 'SNAPSHOT_SERIALIZATION_ERROR', message: 'Cannot serialize capture' } });
        fail(2);fail(3);
        expect(health).toEqual(['ready','degraded','degraded']);
        f.send({ type: 'SNAPSHOT_PREPARED', draft: { ...f.draft(4), healthySince: 4 } });
        expect(health).toEqual(['ready','degraded','degraded','ready']);
        expect(committedState(f.host)).toMatchObject({ status: 'ready', snapshot: { revision: 2, admissionSinceRevision: 2 } });
    });

    it('publishes the last View closing as a legal empty state', () => {
        const f = fixture(), update = vi.fn();f.host.onUpdate = update;
        f.publish(1);
        f.send({ type: 'SNAPSHOT_PREPARED', draft: { ...f.draft(2), views: [] } });
        expect(update).toHaveBeenCalledTimes(1);
        expect(committedState(f.host)).toMatchObject({ status: 'ready', snapshot: { revision: 2, views: [], tools: {} } });
    });

    it('records unexpected receiver failure instead of silently keeping a usable source', () => {
        const f = fixture(), update = vi.fn();f.host.onUpdate = update;
        vi.spyOn((f.host as any).snapshotReceiver, 'acceptPrepared').mockImplementation(() => { throw new Error('receiver'); });
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            f.publish(1);
            expect(f.host.getStatus()).toBe('error');
            expect(committedState(f.host).status).toBe('stopped');
            expect(update).toHaveBeenCalledTimes(1);
        } finally { log.mockRestore(); }
    });
});
