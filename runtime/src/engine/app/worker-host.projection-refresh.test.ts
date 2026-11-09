import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppWorkerHost } from './worker-host.js';
import { SemanticSnapshotReceiver } from '../../adapters/snapshot/receiver.js';
import { SemanticProjectionCoordinator } from '../../core/projection/coordinator.js';
import { refKey } from '../../core/snapshot/snapshot-support.js';
import { compileOrdinarySchema } from '../../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../../core/tool/ordinary-parameter-profile.js';

const policy = { project: ({ source }: any) => ({ views: source.views.map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
    refs: [], toolBindings: [], content: source.views.map((v: any) => ({ view: { viewId: v.id, viewInstanceId: v.viewInstanceId }, decision: 'retain' })) }),
    authorize: () => true, canReadReceipt: () => true };
function draft(instanceId: string, seq: number, value = 'current') {
    return { schemaVersion: 3, appId: 'app', instanceId, producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
        views: [{ id: 'file', viewInstanceId: 'file-instance', type: 'File', name: 'File', kind: 'state',
            content: { format: 'markdown-v1', value } }], refs: {}, tools: {} };
}
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'aotui-refresh-unit-'));
    const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'desktop' as any,
        appModulePath: 'unused', timeout: 50, config: { AOTUI_DATA_DIR: directory } });
    const worker = { postMessage: vi.fn() };
    const internals = host as any; internals.worker = worker; internals.status = 'running';
    internals.snapshotReceiver.acceptPrepared(draft(host.appInstanceId, 1));
    cleanup.push(() => { host.beginInteractionClose(); internals.snapshotReceiver.close(); rmSync(directory, { recursive: true, force: true }); });
    const opened = host.createInteractionScope(policy); if (opened.status !== 'opened') throw new Error(opened.issue.code);
    const publish = (seq: number, value = 'updated') => internals.handleMessage({ type: 'SNAPSHOT_PREPARED',
        requestId: worker.postMessage.mock.calls.at(-1)![0].requestId,
        draft: draft(host.appInstanceId, seq, value), suppressSignal: true });
    return { host, internals, worker, client: opened.client, publish };
}

describe('refresh before the existing Scope observation', () => {
    it('ordinary TS observes the synchronously committed source without any notification', async () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        try {
            receiver.acceptPrepared(draft('instance', 1));
            const opened = receiver.createInteractionScope(policy, { resolve: () => null });
            if (opened.status !== 'opened') throw new Error(opened.issue.code);
            receiver.acceptPrepared(draft('instance', 2, 'latest TS commit'));
            const observed = await opened.client.observe({ all: true });
            expect(observed.status).toBe('observed'); expect(JSON.stringify(observed)).toContain('latest TS commit');
            opened.client.close();
            expect(receiver.getInteractionStats()).toMatchObject({ scopes: 0, combinedBytes: 0 });
        } finally { receiver.close(); }
    });

    it('ordinary TS publishes compatible View/Ref/Tool after a commit, reuses unchanged data, and reports projection failure without redoing business', async () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        const projection = new SemanticProjectionCoordinator(); const owner = new AbortController();
        const compiled = compileOrdinarySchema({ type: 'object', properties: {}, additionalProperties: false }, 'view-type-parameters-v1');
        if (!compiled.ok) throw new Error('fixture Schema');
        const make = (seq: number) => ({ ...draft('instance', seq, 'body:' + seq),
            refs: { [refKey('file', 'file-instance', 'selected')]: { id: 'selected', ownerViewId: 'file', ownerViewInstanceId: 'file-instance', refType: 'Record',
                target: { kind: 'snapshot-value', payload: { value: seq } } } },
            tools: { [JSON.stringify(['app', 'File', 'edit'])]: { id: JSON.stringify(['app', 'File', 'edit']), name: 'edit', viewType: 'File', description: 'Edit', 
                inputSchema: ordinaryParameterProfile(compiled.contract), execution: { kind: 'view-type', activationId: 'active-' + seq } } } });
        const fullPolicy = { ...policy, project: ({ source }: any) => ({
            ...policy.project({ source }),
            refs: Object.values(source.refs).map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
            toolBindings: Object.values(source.tools).map((t: any) => ({ toolId: t.id, execution: t.execution })),
        }) };
        let businessCalls = 0;
        const binding = { identity: {}, mode: 'view-type-parameters-v1' as const, validateInput: () => ({ ok: true as const, value: {} }),
            isLive: () => ({ ok: true as const }), execute: () => ({ kind: 'tool-result' as const, phase: 'entered-returned' as const,
                result: { success: true, data: { calls: ++businessCalls } } }) };
        try {
            expect(receiver.acceptPrepared(make(1)).status).toBe('published');
            const opened = receiver.createInteractionScope(fullPolicy, { resolve: () => binding });
            if (opened.status !== 'opened') throw new Error(opened.issue.code);
            const initial = await opened.client.observe({ all: true });
            if (initial.status !== 'observed') throw new Error(initial.issue.code);
            expect(opened.client.adoptObservation(initial.observation.observationId)).toEqual({ status: 'adopted' });
            const business = await opened.client.invoke({ invocationId: 'ts-business', observationId: initial.observation.observationId,
                bindingId: initial.observation.bindings[0]!.bindingId, input: {} });
            expect(business).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
            projection.beginCommit(); let completed = false;
            const committed = projection.whenCommitted(owner.signal).then(() => { completed = true; });
            projection.recordMutation('view'); projection.recordMutation('ref'); projection.recordMutation('tool');
            expect(completed).toBe(false); projection.endCommit(); await committed;
            expect(receiver.acceptPrepared(make(2)).status).toBe('published');
            const current = await opened.client.observe({ all: true }); expect(current.status).toBe('observed');
            expect(JSON.stringify(current)).toContain('body:2'); expect(JSON.stringify(current)).toContain('active-2');
            const latest = (receiver as any).core.store.readLatest('app').snapshot;
            expect(Object.values(latest.refs)).toMatchObject([{ target: { payload: { value: 2 } } }]);
            const id = receiver.report().snapshotId;
            expect(receiver.acceptPrepared({ ...make(2), producerSeq: 3 }).status).toBe('unchanged');
            expect(receiver.report().snapshotId).toBe(id);
            receiver.acceptPrepareFailure({ appId: 'app', instanceId: 'instance', producerSeq: 4, sourceEpoch: 4,
                issue: { code: 'SNAPSHOT_INVALID', message: 'fixture projection failed' } });
            expect((await opened.client.observe({ all: true })).status).toBe('rejected');
            expect(business).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
            expect(businessCalls).toBe(1);
            expect(receiver.acceptPrepared(make(5)).status).toBe('published');
            expect((await opened.client.observe({ all: true })).status).toBe('observed');
            opened.client.close(); expect(receiver.getInteractionStats()).toMatchObject({ scopes: 0, combinedBytes: 0 });
        } finally { owner.abort(); receiver.close(); }
    });

    it('joins reception of a correlated fresh snapshot instead of reading old data or waiting for a notification', async () => {
        const x = fixture(); x.host.onUpdateRequest = vi.fn();
        const observing = x.client.observe({ all: true });
        expect(x.worker.postMessage).toHaveBeenCalledWith({ type: 'FLUSH_PROJECTION', requestId: expect.any(String) });
        x.publish(2); const observed = await observing;
        expect(observed.status).toBe('observed'); expect(JSON.stringify(observed)).toContain('updated');
        expect(x.host.onUpdateRequest).not.toHaveBeenCalled();
        const id = x.host.getSemanticSnapshotReport()!.snapshotId;
        const same = x.client.observe({ all: true }); x.publish(3); await same;
        expect(x.host.getSemanticSnapshotReport()!.snapshotId).toBe(id);
        x.client.close(); expect(x.host.getInteractionReport()!.core).toMatchObject({ scopes: 0, combinedBytes: 0 });
    });

    it('keeps the App wait slot after timeout; retries do not accumulate work, and a late terminal permits recovery', async () => {
        vi.useFakeTimers(); const x = fixture();
        const observing = x.client.observe({ all: true });
        await vi.advanceTimersByTimeAsync(50);
        expect(await observing).toMatchObject({ status: 'rejected', issue: { code: 'PROJECTION_TIMEOUT' } });
        for (let i = 0; i < 5; i++) expect(await x.client.observe({ all: true })).toMatchObject({ status: 'rejected' });
        expect(x.worker.postMessage).toHaveBeenCalledTimes(1); expect(x.internals.pendingRequests.size).toBe(1);
        x.publish(2); expect(x.internals.pendingRequests.size).toBe(0);
        const recovered = x.client.observe({ all: true }); x.publish(3); expect((await recovered).status).toBe('observed');
        expect(x.worker.postMessage).toHaveBeenCalledTimes(2);
    });

    it('scope close and App close reject waits and leave no observation reservation or App request', async () => {
        const x = fixture(); const waiting = x.client.observe({ all: true }); x.client.close();
        expect(await waiting).toMatchObject({ status: 'rejected', issue: { code: 'SCOPE_UNAVAILABLE' } });
        expect(x.host.getInteractionReport()!.core).toMatchObject({ scopes: 0, combinedBytes: 0 });
        x.host.beginInteractionClose(); expect(x.internals.pendingRequests.size).toBe(0);
        expect(x.internals.projectionRefresh).toBeUndefined();
    });

    it('shares the App refresh across scopes while keeping their cancellation separate', async () => {
        const x = fixture(); const second = x.host.createInteractionScope(policy);
        if (second.status !== 'opened') throw new Error(second.issue.code);
        const firstWait = x.client.observe({ all: true }), secondWait = second.client.observe({ all: true });
        expect(await x.client.observe({ all: true })).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_BUSY' } });
        x.client.close(); expect((await firstWait).status).toBe('rejected');
        expect(x.worker.postMessage).toHaveBeenCalledTimes(1);
        x.publish(2); expect((await secondWait).status).toBe('observed');
        second.client.close(); expect(x.host.getInteractionReport()!.core).toMatchObject({ scopes: 0, combinedBytes: 0 });
    });

    it('does not treat a generic response as a fresh Snapshot and releases its failed request for an explicit retry', async () => {
        const x = fixture(); const waiting = x.client.observe({ all: true });
        x.internals.handleMessage({ type: 'ERROR_RESPONSE', requestId: x.worker.postMessage.mock.calls[0][0].requestId,
            success: false, error: { code: 'WORKER_ERROR', message: 'fixture refresh failed' } });
        expect(await waiting).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_REFRESH_FAILED' } });
        expect(x.internals.pendingRequests.size).toBe(0); expect(x.internals.projectionRefresh).toBeUndefined();
        const retry = x.client.observe({ all: true }); x.publish(2); expect((await retry).status).toBe('observed');
    });
});
