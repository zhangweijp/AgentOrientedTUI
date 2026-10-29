import { performance } from 'node:perf_hooks';
import { createSnapshotCore, refKey } from '../../runtime/src/core/snapshot/index.ts';

function percentile(xs: number[], p: number) {
    const sorted = [...xs].sort((a, b) => a - b);
    return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] * 1000) / 1000;
}
for (const count of [1, 10, 50, 100]) {
    for (const version of [1, 2] as const) {
        const core = createSnapshotCore({
            maxHistoryEntries: 0, maxHistoryBytes: 0,
            limits: { maxSnapshotBytes: 16 * 1024 * 1024 },
        });
        core.lifecycle.startApp('bench', 'instance_' + count + '_' + version);
        const samples: number[] = [];
        for (let seq = 1; seq <= 25; seq++) {
            const views = Array.from({ length: count }, (_, index) => ({
                id: 'fd_' + index,
                ...version === 1
                    ? { generation: 'sdk_' + index }
                    : { viewInstanceId: 'vi:' + index },
                type: 'FileDetail', name: 'File ' + index,
                kind: 'state',
                content: { format: 'markdown-v1', value: 'x'.repeat(1_000) + seq },
            }));
            const refs: Record<string, unknown> = {};
            for (let index = 0; index < count; index++) {
                const identity = version === 1 ? 'sdk_' + index : 'vi:' + index;
                refs[refKey('fd_' + index, identity, 'selected')] = {
                    id: 'selected', ownerViewId: 'fd_' + index,
                    ...version === 1
                        ? { ownerViewGeneration: identity }
                        : { ownerViewInstanceId: identity },
                    refType: 'File',
                    target: { kind: 'snapshot-value', payload: { id: index, version: seq } },
                };
            }
            const toolId = JSON.stringify(['bench', 'FileDetail', 'inspect']);
            const tools = {
                [toolId]: {
                    id: toolId, name: 'inspect', viewType: 'FileDetail',
                    description: 'Inspect', inputSchema: { type: 'object', properties: {} },
                    isMutating: false,
                    ...version === 1 ? { visible: true } : {
                        targets: Array.from({ length: count }, (_, index) => ({
                            viewId: 'fd_' + index, viewInstanceId: 'vi:' + index, bindingVersion: 1,
                        })),
                    },
                },
            };
            const draft = {
                schemaVersion: version,
                appId: 'bench', instanceId: 'instance_' + count + '_' + version,
                producerSeq: seq, sourceEpoch: seq, capturedAt: seq,
                views, refs, tools,
            };
            const start = performance.now();
            const result = core.committer.accept(draft);
            if (result.status !== 'published') {
                throw Error('Unexpected rejection ' + JSON.stringify(result));
            }
            const elapsed = performance.now() - start;
            if (seq > 5) samples.push(elapsed);
        }
        console.log('M4_SNAPSHOT_VERSION_BENCH=' + JSON.stringify({
            schemaVersion: version, views: count, refs: count,
            targets: version === 2 ? count : 0, samples: samples.length,
            commit_p50_ms: percentile(samples, 0.50), commit_p95_ms: percentile(samples, 0.95),
            note: 'Synthetic identical View/Ref data; V2 adds Tool targets and validates via V1 proxy; no Worker/DOM/SDK/IDE I/O',
        }));
    }
}
