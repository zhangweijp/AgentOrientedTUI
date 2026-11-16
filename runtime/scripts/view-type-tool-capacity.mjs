#!/usr/bin/env node
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const core = await import(process.argv[2]
    ? pathToFileURL(resolve(process.argv[2])).href
    : new URL('../dist/core/index.js', import.meta.url).href);
const appId = 'capacity-app';
const instanceId = 'capacity-instance';
const names = ['read_file', 'edit_file'];
const inputSchema = { type: 'object', properties: { content: { type: 'string' } }, additionalProperties: false };
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const elapsed = start => Number((performance.now() - start).toFixed(3));

async function runCase(viewCount) {
    const snapshotCore = core.createSnapshotCore({ appId, instanceId });
    const registry = core.createViewOwnedTools(appId, instanceId);
    let client;
    let handlerEntries = 0;
    try {
        const start = performance.now();
        registry.defineTools(names.map(name => ({ name, viewType: 'File', description: name, inputSchema })));
        const declarationMs = elapsed(start);
        const begin = performance.now();
        const frame = registry.prepareFrame(Array.from({ length: viewCount }, (_, index) => {
            const id = 'file_' + index;
            return { id, type: 'File', owner: {}, bindings: names.map(name => ({ name, enabled: true, execute() {
                handlerEntries++;
                return { success: true, data: { receiver: id } };
            } })) };
        }));
        const views = frame.instances.map(({ viewId: id, viewType: type, viewInstanceId, toolBindings }) => ({
            id, type, viewInstanceId, toolBindings, kind: 'state', name: id,
            content: { format: 'markdown-v1', value: 'Open file ' + id },
        }));
        const committed = snapshotCore.committer.accept({
            schemaVersion: core.SNAPSHOT_SCHEMA_VERSION, appId, instanceId, producerSeq: 1, sourceEpoch: 1, capturedAt: Date.now(),
            views, refs: {}, tools: Object.fromEntries(frame.tools.map(tool => [tool.id, tool])),
        });
        assert.equal(committed.status, 'published', JSON.stringify(committed));
        frame.accept();
        const commitMs = elapsed(begin);
        const binding = {
            identity: {},
            validateInput: (_source, value) => ({ ok: true, value }),
            isLive: source => ({ ok: registry.validateTypeToolBinding(source.tool, source.receiver).success }),
            execute: async context => ({ kind: 'tool-result', ...await registry.invokeTypeTool(
                context.source.tool, context.source.receiver, context.effectiveInput) }),
        };
        client = core.createAppInteraction(snapshotCore.store, { namespace: 'capacity-' + viewCount, now: Date.now, appId, instanceId,
            policy: { project: ({ source }) => ({ refs: [], toolIds: Object.keys(source.tools) }),
                authorize: () => true, canReadReceipt: () => true },
            execution: { resolve: () => binding },
        });
        const observing = performance.now();
        const result = await client.observe({ all: true });
        const observeMs = elapsed(observing);
        const report = {
            views: viewCount, snapshotToolDescriptors: frame.tools.length, snapshotToolBindings: registry.inspect().bindings,
            snapshotBytes: bytes(committed.snapshot), declarationMs, commitMs, observeMs, observation: result.status,
        };

        if (viewCount > 256) {
            assert.equal(result.status === 'rejected' && result.issue.code, 'OBSERVATION_CAPACITY', JSON.stringify(result));
            return { ...report, issue: result.issue.code };
        }
        assert.equal(result.status, 'observed', JSON.stringify(result));
        const { observation } = result;
        assert.equal(observation.views.length, viewCount);
        assert.equal(observation.tools.length, names.length);
        assert.equal(client.adoptObservation(observation.observationId).status, 'adopted');
        const dispatching = performance.now();
        for (const tool of observation.tools) {
            const result = await client.invoke({ invocationId: tool.name, observationId: observation.observationId,
                toolId: tool.id, input: { view_id: 'file_0' } });
            assert.equal(result.kind === 'receipt' && result.receipt.outcome.status, 'succeeded', JSON.stringify(result));
            assert.equal(result.receipt.outcome.value.data.receiver, 'file_0');
        }
        assert.equal(handlerEntries, names.length);
        return { ...report, observationBytes: bytes(observation), handlerEntries, invokeMs: elapsed(dispatching) };
    } finally {
        client?.close();
        await client?.whenClosed();
        registry.dispose();
        snapshotCore.lifecycle.dispose();
        assert.equal(snapshotCore.store.inspect().activeLeases, 0);
        assert.equal(registry.inspect().bindings, 0);
        if (client) assert.equal(client.inspect().combinedBytes, 0);
    }
}

const cases = [];
for (const count of [1, 10, 100, 1000]) cases.push(await runCase(count));
console.log(JSON.stringify({ benchmark: 'View Tool capacity', version: core.SNAPSHOT_SCHEMA_VERSION, node: process.version, cases }, null, 2));
