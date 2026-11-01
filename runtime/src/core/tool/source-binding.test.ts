import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { acquireToolSource } from './source-binding.js';

const appId = 'ide';
const instanceId = 'ide-run-1';
const toolId = JSON.stringify([appId, 'FileDetail', 'lsp_hover']);
const vid = 'vi:v1:["ide-run-1",1]';

function v2(
    seq = 1, epoch = seq, viewInstanceId = vid,
    bindingVersion = 1, value = 'A',
) {
    return {
        schemaVersion: 2, appId, instanceId,
        producerSeq: seq, sourceEpoch: epoch, capturedAt: seq,
        views: [{
            id: 'fd_0', viewInstanceId, type: 'FileDetail', name: 'App.tsx',
            kind: 'state', content: { format: 'markdown-v1', value },
        }],
        refs: {},
        tools: {
            [toolId]: {
                id: toolId, name: 'lsp_hover', viewType: 'FileDetail',
                description: 'Hover in current file', inputSchema: { type: 'object' },
                isMutating: false,
                targets: [{ viewId: 'fd_0', viewInstanceId, bindingVersion }],
            },
        },
    };
}
function start() {
    const core = createSnapshotCore();
    core.lifecycle.startApp(appId, instanceId);
    return core;
}
function commit(core: ReturnType<typeof start>, draft = v2()) {
    const result = core.committer.accept(draft);
    expect(result.status).toBe('published');
    if (result.status !== 'published') throw Error(JSON.stringify(result));
    return result.snapshot;
}
function query(snapshotId: string, viewId = 'fd_0', requestedTool = toolId) {
    return { snapshotId, appId, instanceId, toolId: requestedTool, viewId };
}

describe('M4 Stage 2: source is ONLY a Runtime committed/pinned V2 snapshot', () => {
    it('returns a frozen, lease-backed selection without any Handler or execute method', () => {
        const c = start();
        const old = commit(c);
        const selection = acquireToolSource(c.store, query(old.id));
        expect(selection).toMatchObject({
            status: 'found', snapshotId: old.id,
            target: { viewInstanceId: vid, bindingVersion: 1, viewId: 'fd_0' },
        });
        expect(c.store.inspect().activeLeases).toBe(1);
        if (selection.status !== 'found') throw Error('Expected found');
        expect('handler' in selection).toBe(false);
        expect('execute' in selection).toBe(false);
        expect(Object.isFrozen(selection.tool)).toBe(true);
        selection.release();
        selection.release();
        expect(c.store.inspect().activeLeases).toBe(0);
    });

    it('old observation remains usable when only Ref or displayed View content changes', () => {
        const c = start();
        const old = commit(c);
        commit(c, v2(2, 2, vid, 1, 'New markup'));
        const selection = acquireToolSource(c.store, query(old.id));
        expect(selection.status).toBe('found');
        if (selection.status === 'found') selection.release();
    });

    it('rejects old source when same View gets a new Tool registration version', () => {
        const c = start();
        const old = commit(c);
        commit(c, v2(2, 2, vid, 2));
        expect(acquireToolSource(c.store, query(old.id)))
            .toMatchObject({ status: 'rejected', issue: { code: 'TOOL_SOURCE_STALE' } });
        expect(c.store.inspect().activeLeases).toBe(0);
    });

    it('rejects an old fd_0 that now points to a NEW ViewInstanceId', () => {
        const c = start();
        const old = commit(c);
        commit(c, v2(2, 2, 'vi_B', 2));
        expect(acquireToolSource(c.store, query(old.id)))
            .toMatchObject({ status: 'rejected', issue: { code: 'VIEW_INSTANCE_REVOKED' } });
        expect(c.store.inspect().activeLeases).toBe(0);
    });

    it('rejects a Tool whose schema changed even if a faulty Producer reused bindingVersion', () => {
        const c = start();
        const old = commit(c);
        const changed = v2(2);
        changed.tools[toolId].inputSchema = { type: 'object', properties: { line: { type: 'number' } } };
        commit(c, changed);
        expect(acquireToolSource(c.store, query(old.id)))
            .toMatchObject({ status: 'rejected', issue: { code: 'TOOL_SOURCE_STALE' } });
    });

    it('rejects caller-invented Tool name, target viewId, or snapshotId', () => {
        const c = start();
        const old = commit(c);
        expect(acquireToolSource(c.store, query(old.id, 'fd_9')))
            .toMatchObject({ status: 'rejected', issue: { code: 'TOOL_UNAVAILABLE' } });
        expect(acquireToolSource(c.store, query(old.id, 'fd_0', 'fake_tool')))
            .toMatchObject({ status: 'rejected', issue: { code: 'TOOL_UNAVAILABLE' } });
        expect(acquireToolSource(c.store, query('not-a-real-snapshot')))
            .toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_EXPIRED' } });
        expect(c.store.inspect().activeLeases).toBe(0);
    });

    it('does not accept an old AppInstance after Runtime restart, even when historical snapshot exists', () => {
        const c = start();
        const old = commit(c);
        c.lifecycle.startApp(appId, 'ide-run-2');
        expect(acquireToolSource(c.store, query(old.id)))
            .toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_UNREADY' } });
        c.committer.accept({
            ...v2(1), instanceId: 'ide-run-2',
            views: [{
                ...v2().views[0], viewInstanceId: 'vi-run-2',
            }],
            tools: {
                [toolId]: {
                    ...v2().tools[toolId],
                    targets: [{ viewId: 'fd_0', viewInstanceId: 'vi-run-2', bindingVersion: 1 }],
                },
            },
        });
        expect(acquireToolSource(c.store, query(old.id)))
            .toMatchObject({ status: 'rejected', issue: { code: 'APP_INSTANCE_MISMATCH' } });
    });

    it('fails closed while latest App is degraded, rejects V1 publication, and stops', () => {
        const c = start();
        const old = commit(c);
        const invalid = { ...v2(2, 2), views: [] };
        expect(c.committer.accept(invalid).status).toBe('rejected');
        expect(acquireToolSource(c.store, query(old.id)))
            .toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_UNREADY' } });
        expect(c.committer.accept(v2(3, 3)).status).toBe('unchanged'); // recovered without changing semantic content
        const v1 = {
            schemaVersion: 1, appId, instanceId, producerSeq: 4,
            sourceEpoch: 4, capturedAt: 4,
            views: [{ id: 'fd_0', generation: 'old', type: 'FileDetail', name: 'Legacy',
                kind: 'state', content: { format: 'markdown-v1', value: 'legacy' } }],
            refs: {}, tools: {},
        };
        expect(c.committer.accept(v1).status).toBe('rejected');
        expect(acquireToolSource(c.store, query(old.id)))
            .toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_UNREADY' } });
        c.lifecycle.stopApp(appId, instanceId);
        expect(acquireToolSource(c.store, query(old.id)))
            .toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_UNREADY' } });
    });

    it('does not create a source Snapshot from a V1 descriptor', () => {
        const c = start();
        const result = c.committer.accept({
            schemaVersion: 1, appId, instanceId, producerSeq: 1,
            sourceEpoch: 1, capturedAt: 1, views: [{
                id: 'fd_0', generation: 'old', type: 'FileDetail', name: 'Legacy',
                kind: 'state', content: { format: 'markdown-v1', value: 'Legacy' },
            }], refs: {}, tools: {},
        });
        expect(result).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_INVALID', path: '$.schemaVersion' } });
        expect(c.store.readLatest(appId).status).toBe('degraded');
    });

    it('respects historical lease TTL rather than reading expired but pinned data as authority', () => {
        let now = 0;
        const c = createSnapshotCore({ now: () => now, historyTtlMs: 20, leaseTtlMs: 10 });
        c.lifecycle.startApp(appId, instanceId);
        const old = commit(c);
        now = 1;
        commit(c, v2(2, 2, vid, 1, 'second'));
        now = 25;
        expect(acquireToolSource(c.store, query(old.id)))
            .toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_EXPIRED' } });
    });
});
