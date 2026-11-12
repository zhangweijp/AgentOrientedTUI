import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppWorkerHost } from './worker-host.js';
import { SemanticSnapshotReceiver } from '../../adapters/snapshot/receiver.js';
import { SemanticProjectionCoordinator } from '../../core/projection/coordinator.js';
import type { ToolDescriptorV3 } from '../../core/snapshot/types.js';
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
    const opened = host.getAppInteraction(policy); if (opened.status !== 'ready') throw new Error(opened.issue.code);
    const publish = (seq: number, value = 'updated') => internals.handleMessage({ type: 'SNAPSHOT_PREPARED',
        requestId: worker.postMessage.mock.calls.at(-1)![0].requestId,
        draft: draft(host.appInstanceId, seq, value), suppressSignal: true });
    return { host, internals, worker, client: opened.interaction, publish };
}

describe('refresh before the existing Scope observation', () => {
    it('ordinary TS observes the synchronously committed source without any notification', async () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        try {
            receiver.acceptPrepared(draft('instance', 1));
            const interaction = receiver.interaction(policy, { resolve: () => null });
            receiver.acceptPrepared(draft('instance', 2, 'latest TS commit'));
            const observed = await interaction.observe({ all: true });
            expect(observed.status).toBe('observed'); expect(JSON.stringify(observed)).toContain('latest TS commit');
            interaction.close();
            expect(receiver.getInteractionStats()).toMatchObject({ combinedBytes: 0 });
        } finally { receiver.close(); }
    });

    it('ordinary TS publishes compatible View/Ref/Tool after a commit, reuses unchanged data, and reports projection failure without redoing business', async () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        const owner = new AbortController();
        const compiled = compileOrdinarySchema({ type: 'object', properties: {}, additionalProperties: false }, 'view-type-parameters-v1');
        if (!compiled.ok) throw new Error('fixture Schema');
        const profile = ordinaryParameterProfile(compiled.contract);
        const target = { viewId: 'file', viewInstanceId: 'file-instance' };
        let value = 1;
        const projection = new SemanticProjectionCoordinator({
            identity: () => ({ appId: 'app', instanceId: 'instance' }),
            readFrame: () => ({
                views: [{ id: target.viewId, viewInstanceId: target.viewInstanceId, type: 'File', name: 'File', kind: 'state',
                    content: { format: 'markdown-v1', value: 'body:' + value } }],
                tools: [{ id: JSON.stringify(['app', 'File', 'edit']), name: 'edit', viewType: 'File', description: 'Edit',
                    inputSchema: profile, execution: { kind: 'view-type', activationId: 'active-' + value } } satisfies ToolDescriptorV3],
            }),
        });
        const publish = () => {
            const publication = projection.nextPublication();
            return 'draft' in publication ? receiver.acceptPrepared(publication.draft) : receiver.acceptPrepareFailure(publication.failure);
        };
        let selected!: ReturnType<typeof projection.registerRef>;
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
            projection.commit(() => { selected = projection.registerRef(target, 'selected', { value }, 'Record'); });
            expect(publish().status).toBe('published');
            const interaction = receiver.interaction(fullPolicy, { resolve: () => binding });
            const initial = await interaction.observe({ all: true });
            if (initial.status !== 'observed') throw new Error(initial.issue.code);
            expect(interaction.adoptObservation(initial.observation.observationId)).toEqual({ status: 'adopted' });
            const business = await interaction.invoke({ invocationId: 'ts-business', observationId: initial.observation.observationId,
                bindingId: initial.observation.bindings[0]!.bindingId, input: {} });
            expect(business).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
            projection.beginCommit(); let completed = false;
            const committed = projection.whenCommitted(owner.signal).then(() => { completed = true; });
            value = 2; selected.update({ value });
            expect(completed).toBe(false); projection.endCommit(); await committed;
            expect(publish().status).toBe('published');
            const current = await interaction.observe({ all: true }); expect(current.status).toBe('observed');
            if (current.status === 'observed') interaction.releaseObservation(current.observation.observationId);
            expect(JSON.stringify(current)).toContain('body:2'); expect(JSON.stringify(current)).toContain('active-2');
            const latest = (receiver as any).core.store.readLatest('app').snapshot;
            expect(Object.values(latest.refs)).toMatchObject([{ target: { payload: { value: 2 } } }]);
            const id = receiver.report().snapshotId;
            expect(publish().status).toBe('unchanged');
            expect(receiver.report().snapshotId).toBe(id);
            expect(projection.commit(() => selected.update({ invalid: () => 0 }))).toBe('failed');
            expect(publish().status).toBe('rejected');
            expect((await interaction.observe({ all: true })).status).toBe('rejected');
            expect(business).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
            expect(businessCalls).toBe(1);
            projection.commit(() => { value = 5; selected.update({ value }); });
            expect(publish().status).toBe('published');
            expect((await interaction.observe({ all: true })).status).toBe('observed');
            interaction.close(); expect(receiver.getInteractionStats()).toMatchObject({ combinedBytes: 0 });
        } finally { owner.abort(); projection.close(); receiver.close(); }
    });

    it('joins reception of a correlated fresh snapshot instead of reading old data or waiting for a notification', async () => {
        const x = fixture(); x.host.onUpdateRequest = vi.fn();
        const observing = x.client.observe({ all: true });
        expect(x.worker.postMessage).toHaveBeenCalledWith({ type: 'FLUSH_PROJECTION', requestId: expect.any(String) });
        x.publish(2); const observed = await observing;
        expect(observed.status).toBe('observed'); expect(JSON.stringify(observed)).toContain('updated');
        expect(x.host.onUpdateRequest).not.toHaveBeenCalled();
        const id = x.host.getSemanticSnapshotReport()!.snapshotId;
        if (observed.status === 'observed') x.client.releaseObservation(observed.observation.observationId);
        const same = x.client.observe({ all: true }); x.publish(3); await same;
        expect(x.host.getSemanticSnapshotReport()!.snapshotId).toBe(id);
        x.host.beginInteractionClose(); expect(x.host.getInteractionReport()!.core).toMatchObject({ closed: true, combinedBytes: 0 });
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

    it('App close rejects pending refresh and drains the request', async () => {
        const x = fixture(); const waiting = x.client.observe({ all: true });
        x.host.beginInteractionClose();
        expect(await waiting).toMatchObject({ status: 'rejected', issue: { code: 'PROJECTION_CLOSED' } });
        expect(x.host.getInteractionReport()!.core).toMatchObject({ closed: true, combinedBytes: 0 });
        expect(x.internals.pendingRequests.size).toBe(0);
        expect(x.internals.projectionRefresh).toBeUndefined();
    });

    it('shares the refresh with read-only preview without competing for an observation', async () => {
        const x = fixture(); const again = x.host.getAppInteraction(policy);
        expect(again).toMatchObject({ status: 'ready', interaction: x.client });
        const observation = x.client.observe({ all: true }), preview = x.client.preview();
        expect(await x.client.observe({ all: true })).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_BUSY' } });
        expect(x.worker.postMessage).toHaveBeenCalledTimes(1);
        x.publish(2);
        expect((await preview).status).toBe('previewed');
        expect((await observation).status).toBe('observed');
        expect(x.host.getInteractionReport()!.core.observations).toMatchObject({ observations: 1, reservations: 0 });
    });

    it('does not treat a generic response as a fresh Snapshot and releases its failed request for an explicit retry', async () => {
        const x = fixture(); const waiting = x.client.observe({ all: true });
        x.internals.handleMessage({ type: 'ERROR_RESPONSE', requestId: x.worker.postMessage.mock.calls[0][0].requestId,
            success: false, error: { code: 'WORKER_ERROR', message: 'fixture refresh failed' } });
        expect(await waiting).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_REFRESH_FAILED', message: 'Committed projection could not be observed' } });
        expect(x.internals.pendingRequests.size).toBe(0); expect(x.internals.projectionRefresh).toBeUndefined();
        const retry = x.client.observe({ all: true }); x.publish(2); expect((await retry).status).toBe('observed');
    });
});
