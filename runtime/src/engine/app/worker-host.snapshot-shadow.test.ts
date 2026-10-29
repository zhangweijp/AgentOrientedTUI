import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';

describe('M2 AppWorkerHost versioned snapshot shadow transport', () => {
    it('is fully opt-in and does not affect the legacy Snapshot path by default', () => {
        const host = new AppWorkerHost({
            appId: 'app_0' as any,
            desktopId: 'desktop_0' as any,
            appModulePath: 'unused.ts',
        });
        expect(host.getSnapshotShadowReport()).toBeNull();
        (host as any).handleMessage({
            type: 'SNAPSHOT_PREPARED', draft: { appId: 'app_0' },
        });
        expect(host.getSnapshotShadowReport()).toBeNull();
        (host as any).handleMessage({
            type: 'SNAPSHOT_FRAGMENT', appId: 'app_0', timestamp: 100,
            markup: 'original legacy', indexMap: {},
        });
        expect(host.getSnapshotFragment()?.markup).toBe('original legacy');
        host.terminate();
    });

    it('validates instance-bound PREPARED on a REAL worker_threads channel without changing legacy notifications', async () => {
        const workerScript = `
            const { parentPort } = require('node:worker_threads');
            parentPort.on('message', (request) => {
                if (request.type === 'INIT') {
                    parentPort.postMessage({type:'INIT_RESPONSE', requestId:request.requestId, success:true});
                    const draft = (seq, label) => ({
                        schemaVersion:1, appId:request.appId, instanceId:request.appInstanceId,
                        producerSeq:seq, sourceEpoch:seq, capturedAt:100+seq,
                        views:[{id:'workspace',generation:'gen1',type:'Workspace',name:label,
                            kind:'state',content:{format:'markdown-v1',value:label}}],
                        refs:{},tools:{}
                    });
                    parentPort.postMessage({type:'SNAPSHOT_FRAGMENT',appId:request.appId,
                        timestamp:100,markup:'legacy-1',indexMap:{},views:[],
                        shadowCaptureSeq:1,shadowInstanceId:request.appInstanceId});
                    parentPort.postMessage({type:'SNAPSHOT_PREPARED',draft:draft(1,'first')});
                    parentPort.postMessage({type:'SNAPSHOT_FRAGMENT',appId:request.appId,
                        timestamp:100,markup:'legacy-accepted-same-ms',indexMap:{},views:[],
                        shadowCaptureSeq:2,shadowInstanceId:request.appInstanceId});
                    parentPort.postMessage({type:'SNAPSHOT_PREPARED',draft:draft(2,'second')});
                    parentPort.postMessage({type:'SNAPSHOT_PREPARED',
                        draft:{...draft(3,'wrong app'),appId:'another_app'}});
                    parentPort.postMessage({type:'SNAPSHOT_PREPARED',
                        draft:{...draft(4,'wrong instance'),instanceId:'old-instance'}});
                } else if (request.type === 'TERMINATE') {
                    process.exit(0);
                }
            });
        `;
        const worker = new Worker(workerScript, { eval: true });
        const host = new AppWorkerHost({
            appId: 'app_0' as any,
            desktopId: 'desktop_0' as any,
            appModulePath: 'unused.ts', existingWorker: worker,
            snapshotShadow: true,
        });
        // AppWorkerHost constructor intentionally replaces Worker listeners;
        // install this test listener AFTER construction.
        const exit = new Promise<void>(resolve => worker.once('exit', () => resolve()));
        const update = vi.fn();
        host.onUpdateRequest = update;
        try {
            await host.start();
            await vi.waitFor(() => {
                const report = host.getSnapshotShadowReport();
                expect(report?.published).toBe(2);
                expect(report?.wrongSource).toBe(2);
            }, { timeout: 2_000 });
            const report = host.getSnapshotShadowReport()!;
            expect(report).toMatchObject({
                appId: 'app_0', instanceId: host.appInstanceId,
                health: 'ready', revision: 2, prepared: 4,
                published: 2, rejected: 2, wrongSource: 2,
                pairedLegacyFrames: 2, unpairedPreparedFrames: 0,
            });
            expect(host.getSnapshotFragment()?.markup).toBe('legacy-accepted-same-ms');
            expect(update).toHaveBeenCalledTimes(2);
            expect(report.snapshotId).toContain(host.appInstanceId);
        } finally {
            host.terminate();
            await exit;
        }
    });

    it('keeps PREPARE_FAILED side-channel errors out of legacy data flow', () => {
        const host = new AppWorkerHost({
            appId: 'app_0' as any, desktopId: 'desktop_0' as any,
            appModulePath: 'unused.ts', snapshotShadow: true,
        });
        const update = vi.fn();
        host.onUpdateRequest = update;
        (host as any).handleMessage({
            type: 'SNAPSHOT_FRAGMENT', appId: 'app_0', timestamp: 20,
            markup: 'legacy-safe', indexMap: {}, views: [],
        });
        (host as any).handleMessage({
            type: 'SNAPSHOT_PREPARE_FAILED',
            appId: 'app_0', instanceId: host.appInstanceId, producerSeq: 1, sourceEpoch: 1,
            error: { code: 'SNAPSHOT_SERIALIZATION_ERROR', message: 'Unsupported ref' },
        });
        expect(host.getSnapshotShadowReport()).toMatchObject({
            health: 'degraded', prepareFailed: 1, lastIssueCode: 'SNAPSHOT_SERIALIZATION_ERROR',
        });
        expect(host.getSnapshotFragment()?.markup).toBe('legacy-safe');
        expect(update).toHaveBeenCalledTimes(1);
        host.terminate();
        expect(host.getSnapshotShadowReport()?.health).toBe('stopped');
    });
});


describe('P0: legacy Fragment source identity and collision-free capture order', () => {
    it('accepts two same-ms updates without Shadow, but rejects a forged App or instance', () => {
        const host = new AppWorkerHost({
            appId: 'app_0' as any, desktopId: 'desktop_0' as any,
            appModulePath: 'unused.ts', snapshotShadow: false,
        });
        const update = vi.fn();
        host.onUpdateRequest = update;
        const send = (overrides: Record<string, unknown>) => {
            (host as any).handleMessage({
                type: 'SNAPSHOT_FRAGMENT',
                appId: 'app_0', appInstanceId: host.appInstanceId,
                timestamp: 900,
                markup: 'initial',
                indexMap: {},
                ...overrides,
            });
        };

        send({ markup: 'first' });
        send({ markup: 'second' });
        expect(host.getSnapshotFragment()?.markup).toBe('second');
        expect(update).toHaveBeenCalledTimes(2);

        send({ appId: 'wrong_app', markup: 'forged app' });
        send({ appInstanceId: 'old-runtime-instance', markup: 'forged instance' });
        send({
            shadowInstanceId: 'old-runtime-instance', markup: 'forged shadow instance',
        });
        expect(host.getSnapshotFragment()?.markup).toBe('second');
        expect(update).toHaveBeenCalledTimes(2);

        // Timestamp is a diagnostic, not an authorization token. Even an
        // older millisecond timestamp from the same Worker channel is valid.
        send({ timestamp: 899, markup: 'third' });
        expect(host.getSnapshotFragment()?.markup).toBe('third');
        expect(update).toHaveBeenCalledTimes(3);
        host.terminate();
    });

    it('rejects duplicate and out-of-order explicit capture sequences', () => {
        const host = new AppWorkerHost({
            appId: 'app_0' as any, desktopId: 'desktop_0' as any,
            appModulePath: 'unused.ts', snapshotShadow: true,
        });
        const update = vi.fn();
        host.onUpdateRequest = update;
        const send = (seq: number, label: string) => {
            (host as any).handleMessage({
                type: 'SNAPSHOT_FRAGMENT',
                appId: 'app_0', appInstanceId: host.appInstanceId,
                shadowInstanceId: host.appInstanceId, shadowCaptureSeq: seq,
                timestamp: 101, markup: label, indexMap: {},
            });
        };
        send(1, 'first');
        send(1, 'duplicate');
        send(0, 'stale');
        send(2, 'latest');
        expect(host.getSnapshotFragment()?.markup).toBe('latest');
        expect(update).toHaveBeenCalledTimes(2);
        host.terminate();
    });
});
