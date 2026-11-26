import { committedState, fixtureHost } from './__tests__/worker-fixture.js';
import { workerTurns } from '../../../tests/fixtures/semantic-worker-tools.js';
import { projectCompleteViews } from '@aotui/core/host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppWorkerHost } from './worker-host.js';
import { SemanticSnapshotReceiver } from '../../adapters/snapshot/receiver.js';
import { SemanticProjectionCoordinator } from '@aotui/core/producer';
import type { ToolDescriptor } from '@aotui/core';
import { compileToolParameters } from '@aotui/core';

const policy = { project: () => ({ refs: [], toolIds: [] }), authorize: () => true, canReadReceipt: () => true };
function draft(instanceId: string, seq: number, value = 'current') {
    return { schemaVersion: 8, appId: 'app', instanceId, producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
        views: [{ toolBindings: [], id: 'file', viewInstanceId: 'file-instance', type: 'File', name: 'File', region: 'dynamic',
            content: { format: 'markdown-v1', value } }], refs: {}, tools: {} };
}
const snapshotId = (host: AppWorkerHost) => {
    const state = committedState(host);
    if (state.status !== 'ready') throw new Error('Expected an accepted snapshot');
    return state.snapshot.id;
};
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });
function fixture(projectionLimits?: ConstructorParameters<typeof AppWorkerHost>[0]['projectionLimits']) {
    const directory = mkdtempSync(join(tmpdir(), 'aotui-refresh-unit-'));
    const host = fixtureHost(AppWorkerHost, { policy: policy, appId: 'app' as any, desktopId: 'desktop' as any,
        appModulePath: 'unused', config: { AOTUI_DATA_DIR: directory }, projectionLimits }, { timeoutMs: 50 });
    const worker = { postMessage: vi.fn() };
    const internals = host as any; internals.worker = worker; internals.status = 'running';
    internals.snapshotReceiver.acceptPrepared(draft(host.appInstanceId, 1));
    cleanup.push(() => { host.beginInteractionClose(); internals.snapshotReceiver.close(); rmSync(directory, { recursive: true, force: true }); });
    const opened = host.getAppInteraction(); if (opened.status !== 'ready') throw new Error(opened.issue.code);
    const sent = () => worker.postMessage.mock.calls.at(-1)![0];
    const send = (message: object) => internals.handleMessage(message);
    const publish = (seq: number, value = 'updated', correlated = true) => send({ type: 'SNAPSHOT_PREPARED',
        ...(correlated ? { requestId: sent().requestId } : {}),
        draft: draft(host.appInstanceId, seq, value) });
    const confirm = (override?: object) => send({ type: 'PROJECTION_CURRENT', requestId: sent().requestId,
        ...sent().known, ...override });
    const prime = async () => {
        const refresh = host.preview();
        publish(2);
        expect((await refresh).status).toBe('previewed');
    };
    return { host, internals, worker, client: opened.interaction, turns: workerTurns(host), sent, send, publish, confirm, prime };
}

describe('refresh before the existing Scope observation', () => {
    it('ordinary TS observes the synchronously committed source without any notification', async () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        try {
            receiver.acceptPrepared(draft('instance', 1));
            const interaction = receiver.interaction(policy, { resolve: () => null });
            receiver.acceptPrepared(draft('instance', 2, 'latest TS commit'));
            const observed = await interaction.observe();
            expect(observed.status).toBe('observed'); expect(JSON.stringify(observed)).toContain('latest TS commit');
            interaction.close();
            expect(receiver.getInteractionStats()?.observations.observationSlots).toBe(0);
        } finally { receiver.close(); }
    });

    it('ordinary TS publishes compatible View/Ref/Tool after a commit, reuses unchanged data, and reports projection failure without redoing business', async () => {
        const receiver = new SemanticSnapshotReceiver('app', 'instance');
        const compiled = compileToolParameters({ type: 'object', properties: {}, additionalProperties: false });
        if (!compiled.ok) throw new Error('fixture Schema');
        const profile = compiled.contract.schema;
        const target = { viewId: 'file', viewInstanceId: 'file-instance' };
        const toolId = JSON.stringify(['app', 'File', 'edit']);
        let value = 1;
        const projection = new SemanticProjectionCoordinator({ identity: () => ({ appId: 'app', instanceId: 'instance' }) });
        const prepare = (payload = { value }) => projection.commit(() => ({
                views: [{ toolBindings: [{ toolId, activationId: 'active-' + value }], id: target.viewId, viewInstanceId: target.viewInstanceId, type: 'File', name: 'File', region: 'dynamic',
                    content: { format: 'markdown-v1', value: 'body:' + value } }],
                refs: [{ ...target, scope: 'protected', id: 'selected', refType: 'Record', valueSchema: { type: 'object' }, value: payload }],
                tools: [{ multiplicity: 'multiple', id: toolId, name: 'edit', viewType: 'File',  description: 'Edit',
                    inputSchema: profile } satisfies ToolDescriptor],
        }));
        const publish = () => {
            const publication = projection.nextPublication();
            return 'draft' in publication ? receiver.acceptPrepared(publication.draft) : receiver.acceptPrepareFailure(publication.failure);
        };
        const fullPolicy = { ...policy, project: projectCompleteViews };
        let businessCalls = 0;
        const binding = { identity: {},
            isLive: () => true, execute: () => ({ kind: 'tool-result' as const, phase: 'entered-returned' as const,
                result: { success: true, data: { calls: ++businessCalls } } }) };
        try {
            expect(prepare()).toMatchObject({ status: 'prepared' });
            expect(publish().status).toBe('published');
            const interaction = receiver.interaction(fullPolicy, { resolve: () => binding });
            const initial = await interaction.observe();
            if (initial.status !== 'observed') throw new Error(initial.issue.code);
            expect(interaction.adoptObservation(initial.observation.observationId)).toEqual({ status: 'adopted' });
            const business = await interaction.invoke({ invocationId: 'ts-business', observationId: initial.observation.observationId,
                toolId: initial.observation.tools[0]!.id, viewId: 'file', input: {  } });
            expect(business).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
            value = 2;
            expect(prepare()).toMatchObject({ status: 'prepared' });
            expect(publish().status).toBe('published');
            const current = await interaction.observe(); expect(current.status).toBe('observed');
            if (current.status === 'observed') interaction.releaseObservation(current.observation.observationId);
            expect(JSON.stringify(current)).toContain('body:2');
            const latest = (receiver as any).core.store.readLatest('app').snapshot;
            expect(latest.views[0].toolBindings).toEqual([{ toolId, activationId: 'active-2' }]);
            expect(Object.values(latest.refs)).toMatchObject([{ target: { payload: { value: 2 } } }]);
            const before = receiver['core'].store.readLatest('app');
            if (before.status !== 'ready') throw Error('Expected a committed snapshot');
            expect(publish().status).toBe('unchanged');
            expect(receiver['core'].store.readLatest('app')).toMatchObject({ status: 'ready', snapshot: { id: before.snapshot.id } });
            expect(prepare({ invalid: () => 0 } as any)).toMatchObject({ status: 'failed' });
            expect(publish().status).toBe('rejected');
            expect((await interaction.observe()).status).toBe('rejected');
            expect(business).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { data: { calls: 1 } } } } });
            expect(businessCalls).toBe(1);
            value = 5;
            expect(prepare()).toMatchObject({ status: 'prepared' });
            expect(publish().status).toBe('published');
            expect((await interaction.observe()).status).toBe('observed');
            interaction.close(); expect(receiver.getInteractionStats()?.observations.observationSlots).toBe(0);
        } finally { projection.close(); receiver.close(); }
    });

    it('joins reception of a correlated fresh snapshot instead of reading old data or waiting for a notification', async () => {
        const x = fixture(); x.host.onUpdate = vi.fn();
        const observing = x.turns.prepare();
        expect(x.worker.postMessage).toHaveBeenCalledWith({ type: 'FLUSH_PROJECTION', requestId: expect.any(String) });
        x.publish(2); const observed = await observing;
        expect(observed.status).toBe('prepared'); expect(JSON.stringify(observed)).toContain('updated');
        expect(x.host.onUpdate).not.toHaveBeenCalled();
        const id = snapshotId(x.host);
        if (observed.status === 'prepared') observed.candidate.discard();
        const same = x.turns.prepare(); x.publish(3); await same;
        expect(snapshotId(x.host)).toBe(id);
        x.host.beginInteractionClose();
        expect(x.host.getResourceReport().interactions).toEqual({ closed: true, retainedOperations: 0 });
    });

    it('applies the installed byte limit at the Host even for a complete Worker snapshot', async () => {
        const x = fixture({ observation: { maxCanonicalBytes: 4096 } });
        const over = x.turns.prepare(); x.publish(2, 'x'.repeat(5000));
        expect(await over).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY', path: '$.observation' } });
        expect(x.host.getResourceReport().interactions.retainedOperations).toBe(0);
        const fits = x.turns.prepare(); x.publish(3, 'fits the limit');
        expect(await fits).toMatchObject({ status: 'prepared', candidate: { observation: { views: [{ content: { value: 'fits the limit' } }] } } });
    });

    it('keeps the App wait slot after timeout; retries do not accumulate work, and a late terminal permits recovery', async () => {
        vi.useFakeTimers(); const x = fixture();
        const observing = x.turns.prepare();
        await vi.advanceTimersByTimeAsync(50);
        expect(await observing).toMatchObject({ status: 'rejected', issue: { code: 'PROJECTION_TIMEOUT' } });
        for (let i = 0; i < 5; i++) expect(await x.turns.prepare()).toMatchObject({ status: 'rejected' });
        expect(x.worker.postMessage).toHaveBeenCalledTimes(1); expect(x.internals.pendingRequests.size).toBe(1);
        x.publish(2); expect(x.internals.pendingRequests.size).toBe(0);
        const recovered = x.turns.prepare(); x.publish(3); expect((await recovered).status).toBe('prepared');
        expect(x.worker.postMessage).toHaveBeenCalledTimes(2);
    });

    it('App close rejects pending refresh and drains the request', async () => {
        const x = fixture(); const waiting = x.turns.prepare();
        x.host.beginInteractionClose();
        expect(await waiting).toMatchObject({ status: 'rejected', issue: { code: 'PROJECTION_CLOSED' } });
        expect(x.host.getResourceReport().interactions).toMatchObject({ closed: true, retainedOperations: 0 });
        expect(x.internals.pendingRequests.size).toBe(0);
        expect(x.internals.projectionRefresh).toBeUndefined();
    });

    it('shares the refresh with read-only preview without competing for an observation', async () => {
        const x = fixture(); const again = x.host.getAppInteraction();
        expect(again).toMatchObject({ status: 'ready', interaction: x.client });
        const observation = x.turns.prepare(), preview = x.host.preview();
        expect(await x.turns.prepare()).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_BUSY' } });
        expect(x.worker.postMessage).toHaveBeenCalledTimes(1);
        x.publish(2);
        expect((await preview).status).toBe('previewed');
        expect((await observation).status).toBe('prepared');
        expect(x.host.getResourceReport().interactions.retainedOperations).toBe(1);
    });

    it('uses the newest accepted publication, including an unchanged push, without publishing or equating the observations', async () => {
        const x = fixture();
        await x.prime();
        const report = committedState(x.host);
        x.publish(3, 'updated', false);
        expect(snapshotId(x.host)).toBe(report.status === 'ready' ? report.snapshot.id : undefined);
        x.host.onUpdate = vi.fn();
        const before = committedState(x.host);
        const first = x.turns.prepare();
        const preview = x.host.preview();
        expect(x.sent().known).toEqual({ appId: 'app', instanceId: x.host.appInstanceId, sourceEpoch: 3, producerSeq: 3 });
        expect(x.worker.postMessage).toHaveBeenCalledTimes(2);
        x.confirm({ requestId: 'unowned' });
        expect(x.internals.pendingRequests.size).toBe(1);
        x.confirm();
        expect((await preview).status).toBe('previewed');
        const a = await first;
        if (a.status !== 'prepared') throw new Error(a.issue.code);
        x.turns.adopt(a.candidate);
        const next = x.turns.prepare();
        x.confirm();
        const b = await next;
        if (b.status !== 'prepared') throw new Error(b.issue.code);
        x.turns.adopt(b.candidate);
        expect(b.candidate.observation.source).toEqual(a.candidate.observation.source);
        expect(b.candidate.observation.observationId).not.toBe(a.candidate.observation.observationId);
        expect(committedState(x.host)).toEqual(before);
        expect(x.host.onUpdate).not.toHaveBeenCalled();
    });

    it.each([
        ['before first full', false, {}],
        ['foreign App', true, { appId: 'other' }],
        ['old mount', true, { instanceId: 'old' }],
        ['wrong epoch', true, { sourceEpoch: 1 }],
        ['wrong sequence', true, { producerSeq: 3 }],
        ['additional data', true, { draft: {} }],
    ])('rejects an active confirmation with %s and falls back to a full refresh', async (_name, prime, fields) => {
        const x = fixture();
        if (prime) await x.prime();
        const waiting = x.turns.prepare();
        x.confirm(fields);
        expect(await waiting).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_REFRESH_FAILED' } });
        const next = x.turns.prepare();
        expect(x.sent().known).toBeUndefined();
        x.publish(3);
        expect((await next).status).toBe('prepared');
    });

    it.each(['advanced', 'degraded'])('rejects an answer whose resident publication has %s', async (mode) => {
        const x = fixture();
        await x.prime();
        const waiting = x.turns.prepare();
        if (mode === 'advanced') x.publish(3, 'new body', false);
        else x.send({ type: 'SNAPSHOT_PREPARE_FAILED', ...x.sent().known, producerSeq: 3,
            error: { code: 'SNAPSHOT_INVALID', message: 'source fault', path: '$.views' } });
        x.confirm();
        expect(await waiting).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_REFRESH_FAILED' } });
        const recovered = x.turns.prepare();
        expect(x.sent().known).toBeUndefined();
        x.publish(4);
        expect((await recovered).status).toBe('prepared');
    });

    it('consumes only the original slot for a late confirmation, without clearing a healthy basis or completing a later slot', async () => {
        vi.useFakeTimers();
        const x = fixture();
        await x.prime();
        const waiting = x.turns.prepare();
        const expired = x.sent();
        await vi.advanceTimersByTimeAsync(50);
        expect(await waiting).toMatchObject({ status: 'rejected', issue: { code: 'PROJECTION_TIMEOUT' } });
        x.confirm({ producerSeq: 999 });
        expect(x.internals.pendingRequests.size).toBe(0);
        const next = x.turns.prepare();
        expect(x.sent().known).toEqual(expired.known);
        x.confirm({ requestId: expired.requestId });
        expect(x.internals.pendingRequests.size).toBe(1);
        x.confirm();
        expect((await next).status).toBe('prepared');
    });

    it('discards a previous lifecycle response and requires a full refresh for the successor', async () => {
        const x = fixture();
        await x.prime();
        const waiting = x.turns.prepare();
        x.internals.lifecycleContextVersion++;
        x.confirm();
        expect(await waiting).toMatchObject({ status: 'rejected', issue: { code: 'PROJECTION_CLOSED' } });
        const next = x.turns.prepare();
        expect(x.sent().known).toBeUndefined();
        x.publish(3);
        expect((await next).status).toBe('prepared');
    });

    it('does not treat a generic response as a fresh Snapshot and releases its failed request for an explicit retry', async () => {
        const x = fixture(); const waiting = x.turns.prepare();
        x.internals.handleMessage({ type: 'ERROR_RESPONSE', requestId: x.worker.postMessage.mock.calls[0][0].requestId,
            success: false, error: { code: 'WORKER_ERROR', message: 'fixture refresh failed' } });
        expect(await waiting).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_REFRESH_FAILED', message: 'Committed projection could not be observed' } });
        expect(x.internals.pendingRequests.size).toBe(0); expect(x.internals.projectionRefresh).toBeUndefined();
        const retry = x.turns.prepare(); x.publish(2); expect((await retry).status).toBe('prepared');
    });
});
