#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const coreEntry = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2])).href
    : new URL('../dist/core/index.js', import.meta.url).href;
const core = await import(coreEntry);
const counts = new Map();
const definitions = [
    { name: 'read_file', description: 'Read one open file.' },
    { name: 'edit_file', description: 'Edit one open file.' },
];
const inputSchema = {
    type: 'object',
    properties: {
        file_id: { type: 'string' },
        content: { type: 'string' },
    },
    required: ['file_id', 'content'],
    additionalProperties: false,
};
const appId = 'capacity-app';
const instanceId = 'capacity-instance';
const compiled = core.compileOrdinarySchema(inputSchema, 'view-type-parameters-v1');
if (!compiled.ok) throw new Error('Capacity parameter schema did not compile');

function elapsed(start) { return Number((performance.now() - start).toFixed(3)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function invocationFor(name) {
    return async args => {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        return { phase: 'entered-returned', result: { success: true, data: { tool: name, file_id: args.file_id } } };
    };
}
function grant(snapshot, selectedIds) {
    const selected = new Set(selectedIds);
    const views = snapshot.views.filter(view => selected.has(view.id));
    return {
        views: views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId })),
        refs: [],
        toolBindings: Object.values(snapshot.tools).flatMap(tool =>
            views.some(view => view.type === tool.viewType)
                ? [{ toolId: tool.id, execution: tool.execution }] : []),
        content: [],
    };
}

async function runCase(viewCount) {
    const snapshotCore = core.createSnapshotCore();
    snapshotCore.lifecycle.startApp(appId, instanceId);
    const tools = core.createViewOwnedTools(appId, instanceId);
    const releases = [];
    const owners = [];
    counts.clear();
    const mountStart = performance.now();
    for (let index = 0; index < viewCount; index++) owners.push(tools.mount(`file-${index}`, 'File'));
    const viewMountMs = elapsed(mountStart);

    let toolRegistrationCalls = 0;
    let toolRegistrationMs = 0;
    const start = performance.now();
    for (const definition of definitions) {
        releases.push(tools.registerTypeTool({
            viewType: 'File', ...definition, inputSchema,
        }, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: () => invocationFor(definition.name),
        }));
        toolRegistrationCalls++;
    }
    toolRegistrationMs = elapsed(start);

    const snapshotTools = tools.listTools();
    const draft = {
        schemaVersion: 3,
        appId,
        instanceId,
        producerSeq: 1,
        sourceEpoch: 1,
        capturedAt: Date.now(),
        views: owners.map(owner => ({ id: owner.viewId, viewInstanceId: owner.viewInstanceId, type: owner.viewType,
            name: owner.viewId, kind: 'state', content: { format: 'markdown-v1', value: `Open file ${owner.viewId}` } })),
        refs: {},
        tools: Object.fromEntries(snapshotTools.map(tool => [tool.id, tool])),
    };
    const commitStart = performance.now();
    const committed = snapshotCore.committer.accept(draft);
    const commitMs = elapsed(commitStart);
    assert(committed.status === 'published', `Snapshot commit failed at ${viewCount} Views: ${JSON.stringify(committed)}`);
    const snapshot = committed.snapshot;
    const snapshotJsonBytes = Buffer.byteLength(JSON.stringify(snapshot));
    const snapshotViewsJsonBytes = Buffer.byteLength(JSON.stringify(snapshot.views));
    const viewDescriptorsJsonBytes = Buffer.byteLength(JSON.stringify(snapshot.views.map(({ content: _content, ...view }) => view)));
    const viewContentJsonBytes = Buffer.byteLength(JSON.stringify(snapshot.views.map(view => view.content)));
    const viewContentUtf8Bytes = snapshot.views.reduce((sum, view) => sum + Buffer.byteLength(view.content.value, 'utf8'), 0);

    const authority = core.createScopedInteraction(snapshotCore.store, { namespace: `capacity-${viewCount}`, now: Date.now });
    const bindings = new Map();
    const scopeResult = authority.createScope({ appId, instanceId,
        policy: { project: ({ source, selection }) => grant(source, selection.viewIds), authorize: () => true, canReadReceipt: () => true },
        execution: { resolve(source) {
            if (!bindings.has(source.tool.id)) bindings.set(source.tool.id, {
                identity: {}, mode: 'view-type-parameters-v1',
                isLive(current) { return { ok: tools.validateTypeToolBinding(current.tool, current.execution).success }; },
                validateInput(_source, input) { const result = compiled.contract.validate(input);
                    return result.ok ? { ok: true, value: result.value } : { ok: false }; },
                async execute(context) { return { kind: 'tool-result', ...await tools.invokeTypeTool(context.source.tool,
                    context.source.execution, context.effectiveInput) }; },
            });
            return bindings.get(source.tool.id);
        } },
    });
    assert(scopeResult.status === 'opened', `Scope open failed: ${JSON.stringify(scopeResult)}`);
    const client = scopeResult.client;
    let allViewsObservation;
    if (viewCount > 256) {
        const start = performance.now();
        const attempted = await client.observe({ all: true });
        allViewsObservation = { status: attempted.status, issue: attempted.status === 'rejected' ? attempted.issue.code : undefined,
            elapsedMs: elapsed(start) };
        assert(attempted.status === 'rejected' && attempted.issue.code === 'OBSERVATION_CAPACITY',
            `Expected the observation View limit to reject ${viewCount} Views`);
    }

    const selectedOwners = viewCount > 256 ? owners.slice(0, 100) : owners;
    const selectedIds = selectedOwners.map(owner => owner.viewId);
    const observeStart = performance.now();
    const completed = await client.observe({ viewIds: selectedIds });
    const observeMs = elapsed(observeStart);
    assert(completed.status === 'observed', `Observation failed: ${JSON.stringify(completed)}`);
    const observation = completed.observation;
    const callsBefore = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const invokeStart = performance.now();
    for (const tool of observation.tools) {
        const binding = observation.bindings.find(candidate => candidate.toolId === tool.id);
        assert(binding, `No observed binding for ${tool.name}`);
        const args = { file_id: selectedIds[0], content: 'updated' };
        const result = await client.invoke({ invocationId: tool.name, observationId: observation.observationId,
            bindingId: binding.bindingId, input: args });
        assert(result.kind === 'receipt' && result.receipt.executionPhase === 'entered-returned' && result.receipt.outcome.status === 'succeeded',
            `Tool invocation failed for ${tool.name}: ${JSON.stringify(result)}`);
    }
    const invocationMs = elapsed(invokeStart);
    const callsAfter = [...counts.values()].reduce((sum, count) => sum + count, 0);

    const cleanupStart = performance.now();
    client.close(); client.close();
    authority.close(); authority.close();
    await authority.whenClosed();
    for (const release of releases) { release(); release(); }
    for (const owner of owners) { tools.unmount(owner.viewInstanceId); tools.unmount(owner.viewInstanceId); }
    const emptyRegistry = tools.inspect();
    tools.dispose();
    tools.dispose();
    snapshotCore.lifecycle.stopApp(appId, instanceId);
    snapshotCore.lifecycle.dispose();
    const cleanupMs = elapsed(cleanupStart);
    const interactionStats = authority.inspect();
    const observationStats = interactionStats.observations;
    const disposedToolStats = tools.inspect();
    const snapshotStats = snapshotCore.store.inspect();
    assert(emptyRegistry.views === 0 && emptyRegistry.bindings === 0, 'Repeated releases/unmounts left live Tool state');
    assert(disposedToolStats.state === 'disposed' && disposedToolStats.views === 0 && disposedToolStats.bindings === 0,
        'Repeated registry disposal did not leave an empty registry');
    assert(observationStats.scopes === 0 && observationStats.observations === 0 && observationStats.reservations === 0,
        'Repeated observation close left live observation state');
    assert(snapshotStats.activeLeases === 0, 'Cleanup left a pinned Snapshot lease');
    assert(interactionStats.scopes === 0 && interactionStats.combinedBytes === 0, 'Cleanup left interaction ownership');

    return {
        views: viewCount,
        selectedViews: selectedOwners.length,
        schemaVersion: snapshot.schemaVersion,
        registryToolRegistrationCalls: toolRegistrationCalls,
        registryViewCount: owners.length,
        snapshotToolDescriptors: Object.keys(snapshot.tools).length,
        snapshotExecutionBindings: Object.values(snapshot.tools).length,
        allViewsObservation,
        selectedObservation: {
            status: 'observed',
            views: observation.views.length,
            tools: observation.tools.length,
            bindings: observation.bindings.length,
            toolsJsonBytes: Buffer.byteLength(JSON.stringify(observation.tools)),
            schemasJsonBytes: Buffer.byteLength(JSON.stringify(observation.tools.map(tool => tool.inputSchema))),
            bindingsJsonBytes: Buffer.byteLength(JSON.stringify(observation.bindings)),
        },
        payloadBytes: {
            snapshotJsonBytes,
            snapshotViewsJsonBytes,
            viewDescriptorsJsonBytes,
            viewContentJsonBytes,
            viewContentUtf8Bytes,
        },
        codeDerivedSchemaWork: {
            registryOrdinarySchemaCompiles: definitions.length,
            legacySnapshotValueProfileChecks: 0,
            basis: 'Per ViewType registration, source calls compileOrdinarySchema once.',
            outsideBenchmark: 'SDK definition-time compilation, Host resolution, Worker wire validation and their repeated per-call schema work are excluded.',
        },
        invocationCount: callsAfter - callsBefore,
        handlerEntries: Object.fromEntries(counts),
        cleanupCalls: {
            scopeClientClose: 2,
            interactionAuthorityClose: 2,
            registrationRelease: releases.length * 2,
            viewUnmount: owners.length * 2,
            toolRegistryDispose: 2,
        },
        finalState: {
            toolRegistry: disposedToolStats,
            observations: observationStats,
            interactions: interactionStats,
            snapshotStore: { activeLeases: snapshotStats.activeLeases },
        },
        timingsMs: { viewMount: viewMountMs, toolRegistration: toolRegistrationMs, commit: commitMs,
            observe: observeMs, invoke: invocationMs, cleanup: cleanupMs },
    };
}

const cases = [];
for (const count of [1, 10, 100, 1000]) cases.push(await runCase(count));
console.log(JSON.stringify({
    benchmark: 'AOTUI Core View/Tool capacity and lifecycle',
    version: 'view-type-v3',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ordinaryToolKinds: definitions.map(definition => definition.name),
    notes: {
        scope: 'Current Core Registry + Snapshot + ScopedInteraction; observe/invoke include the real policy, preparation and receipt path. No Worker, DOM renderer or Host wire cost. Invocation timings are not directly comparable to the retired registry-only benchmark.',
        schemaCompilation: 'V3 registry compiles the input schema during each type registration. Host resolve and Worker wire validation also compile ordinary profiles; this script does not measure those stages.',
        payloadBytes: 'JSON byte counts use JSON.stringify on Core snapshot/observation structures. View content UTF-8 bytes are reported separately. These are not XML/Markdown-rendered User Message bytes or model token counts; component byte fields overlap and should not be summed.',
        comparison: 'This entry measures current ViewType registration only. Historical baseline outputs remain separate immutable evidence.',
        capacity: 'The 1000-View full observation must be rejected by the hard 256-View observation cap; the 100-View selection is measured separately.',
    },
    cases,
}, null, 2));
