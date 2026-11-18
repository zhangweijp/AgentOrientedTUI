import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { AppRegistry, createRuntime } from '@aotui/runtime';
import { createAppInteraction, createSnapshotCore, createViewOwnedTools, SemanticProjectionCoordinator } from '@aotui/runtime/core';
import { APP_LIFECYCLE_PROTOCOL, hasViewTypeToolAuthoringProtocol, isTUIAppFactory } from '@aotui/runtime/spi';
import { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from '@aotui/runtime/adapters';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';

// One known serial App, using only package exports. Keep the wiring visible so it can be measured.
async function openLocalWorkItems(factory, desktopId, projectionLimits) {
    const identity = { appId: 'local', instanceId: 'local-work-items-1' };
    const core = createSnapshotCore(identity);
    const registry = createViewOwnedTools(identity.appId, identity.instanceId);
    const projection = new SemanticProjectionCoordinator({ identity: () => identity });
    const controller = new AbortController();
    let cleanup;
    const instance = await factory.initialize({
        appId: identity.appId, desktopId, signal: controller.signal, projectionLimits,
        appLifecycle: { protocol: APP_LIFECYCLE_PROTOCOL, register(owner) {
            assert.equal(cleanup, undefined);
            cleanup = owner;
            return () => assert.ok(controller.signal.aborted, 'This fixture unmounts its owner only on shutdown');
        } },
        defineTools: definitions => { projection.assertWritable(); registry.defineTools(definitions); },
        publishFrame(build, options) {
            assert.equal(options, undefined, 'Work Items only uses ordinary commits in this scenario');
            const result = projection.commit(() => {
                const { views } = build();
                const plan = registry.prepareFrame(views);
                return {
                    views: views.map(({ id, type, name, kind, content }, i) => ({
                        id, type, name, kind, content, viewInstanceId: plan.instances[i].viewInstanceId,
                        toolBindings: plan.instances[i].toolBindings,
                    })),
                    refs: views.flatMap((view, i) => view.refs.map(ref => ({
                        ...ref, viewId: view.id, viewInstanceId: plan.instances[i].viewInstanceId,
                    }))),
                    tools: plan.tools, accept: plan.accept,
                };
            });
            const publication = projection.publishTo(core.committer);
            if (result.status === 'prepared') assert.ok(['published', 'unchanged'].includes(publication.status));
            return result;
        },
    });
    const binding = {
        identity: {},
        isLive: ({ tool, receiver }) => ({ ok: !controller.signal.aborted && !projection.failed &&
            registry.validateTypeToolBinding(tool, receiver).success }),
        execute: async ({ source, effectiveInput }) => ({
            kind: 'tool-result', ...await registry.invokeTypeTool(source.tool, source.receiver, effectiveInput),
        }),
    };
    const authority = createAppInteraction(core.store, { ...identity, namespace: identity.instanceId, now: Date.now,
        observationLimits: projectionLimits,
        policy: { project: ({ source }) => ({
            refs: Object.values(source.refs).map(ref => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
            toolIds: Object.keys(source.tools),
        }), authorize: () => true, canReadReceipt: () => true },
        execution: { resolve: source => source.appId === identity.appId && source.instanceId === identity.instanceId ? binding : null },
    });
    return {
        app: { appId: identity.appId, appInstanceId: identity.instanceId, name: 'local', status: 'running' },
        client: { ...authority,
            async observe(selection) { await instance.whenCommitted(controller.signal); return authority.observe(selection); },
            async invoke(request) { await instance.whenCommitted(controller.signal); return authority.invoke(request); },
        },
        async close() {
            controller.abort();
            core.lifecycle.stop();
            authority.close();
            cleanup.stop();
            try { await authority.whenClosed(); await instance.close(); await cleanup.close(); }
            finally { projection.close(); registry.dispose(); core.lifecycle.dispose(); }
            const released = { combinedBytes: authority.inspect().combinedBytes,
                activeHolds: core.store.inspect().activeHolds, bindings: registry.inspect().bindings };
            assert.deepEqual(released, { combinedBytes: 0, activeHolds: 0, bindings: 0 });
            return released;
        },
    };
}

function modelReply(calls) {
    const delta = calls.length ? { tool_calls: calls.map(([id, name, args], index) => ({
        id, index, type: 'function', function: { name, arguments: JSON.stringify(args) },
    })) } : { content: 'Done' };
    const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'fixture', model: 'fixture', created: 1,
        choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    return new Response(chunk(delta, null) + chunk({}, calls.length ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
}

const appDirectory = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(resolve(appDirectory, 'aoapp.json')));
const entry = pathToFileURL(resolve(appDirectory, manifest.entry.main)).href;
// Resolve ESM from the actual importing module. All shared dependencies must be the installed copies.
const installed = async (name, parent) => realpath(fileURLToPath(import.meta.resolve(name, parent)));
const sdk = import.meta.resolve('@aotui/sdk', entry);
const adapter = import.meta.resolve('@aotui/agent-driver-adapter');
const resolutions = {
    sdk: await installed('@aotui/sdk', entry), runtime: await installed('@aotui/runtime'),
    adapter: fileURLToPath(adapter), driver: await installed('@aotui/agent-driver-v2'), preact: await installed('preact', entry),
};
assert.equal(await installed('@aotui/sdk'), resolutions.sdk);
assert.equal(await installed('@aotui/runtime', sdk), resolutions.runtime);
assert.equal(await installed('@aotui/runtime', adapter), resolutions.runtime);
assert.equal(await installed('@aotui/agent-driver-v2', adapter), resolutions.driver);
assert.equal(await installed('preact', sdk), resolutions.preact);
const modules = await realpath('node_modules');
for (const path of Object.values(resolutions)) assert.ok(path.startsWith(modules + sep), path);
const factory = (await import(entry)).default;
assert.ok(isTUIAppFactory(factory) && hasViewTypeToolAuthoringProtocol(factory));
assert.equal(factory.kernelConfig.appName, manifest.app_name);
const jsonLimits = Object.freeze({ maxDepth: 12, maxNodes: 8192, maxApproxBytes: 65536, maxCanonicalBytes: 65536 });
const limits = Object.freeze({ maxViews: 8, maxRefs: 64, maxTools: 16, observation: jsonLimits, metadata: jsonLimits });
const runtime = createRuntime();
const originalFetch = globalThis.fetch;
const turns = [];
const receipts = [];
const release = {};
let source, local, driver, turn;
try {
    const desktopId = await runtime.createDesktop('assembly');
    const desktop = runtime.getDesktop(desktopId);
    const apps = new AppRegistry();
    await apps.registerTransient('local:' + appDirectory);
    const [installed] = await apps.installAll(desktop, { projectionLimits: limits, dynamicConfig: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR } });
    assert.equal(installed.status, 'installed', JSON.stringify(installed));
    const [managed] = desktop.getInstalledApps();
    const access = runtime.getAppInteraction(desktopId, installed.appId, managed.appInstanceId);
    assert.equal(access.status, 'ready');
    local = await openLocalWorkItems(factory, desktopId, limits);
    const clients = new Map([[managed.appId, access.interaction], [local.app.appId, local.client]]);
    const candidates = new Map();
    // Real observations, adoption results and receipts on both paths. The only injected fault
    // releases the second candidate immediately before its actual Core adoption attempt.
    delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
    source = new SemanticAOTUIDrivenSource({
        id: desktopId, getInstalledApps: () => [...desktop.getInstalledApps(), local.app], getSystemLogs: () => [],
    }, { getAppInteraction(id, appId, instanceId) {
        const client = clients.get(appId);
        assert.equal(id, desktopId);
        assert.equal(instanceId, appId === managed.appId ? managed.appInstanceId : local.app.appInstanceId);
        return { status: 'ready', interaction: { ...client,
            async observe(selection) {
                const result = await client.observe(selection);
                assert.equal(result.status, 'observed', JSON.stringify(result.issue));
                candidates.set(appId, result.observation);
                turn.observations[appId] = result.observation.observationId;
                return result;
            },
            adoptObservation(oid) {
                assert.equal(oid, candidates.get(appId).observationId);
                if (turn.partial && appId === local.app.appId) client.releaseObservation(oid);
                const result = client.adoptObservation(oid);
                turn.adoptions.push([appId, result.status]);
                return result;
            },
            async invoke(request) {
                const observed = candidates.get(appId);
                assert.equal(request.observationId, observed.observationId);
                const captured = turn.calls.find(([id]) => id === request.invocationId);
                const appName = appId === managed.appId ? managed.name : local.app.name;
                const tool = observed.tools.find(tool => appName + '-' + tool.name === captured[1]);
                assert.equal(request.toolId, tool.id);
                assert.deepEqual({ ...request.input }, captured[2]);
                const result = await client.invoke(request);
                receipts.push({ appId, request, result });
                return result;
            },
        } };
    } });

    // Control each turn explicitly. Production Source, Driver, AI SDK and provider serializer
    // all run. Only the provider's HTTP transport returns a scripted SSE response.
    globalThis.fetch = async (url, init) => {
        assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions');
        assert.deepEqual(turn.adoptions, source.listApps().filter(app => app.status === 'running').map(app => [app.appId, 'adopted']));
        turn.wireBytes = Buffer.byteLength(init.body, 'utf8');
        turn.requests.push(JSON.parse(init.body));
        return modelReply(turn.calls);
    };
    const history = { name: 'history', onUpdate: () => () => {}, getContext: () => ({
        messages: [{ role: 'user', content: 'Compare the two workspaces. Turn ' + turn.label, timestamp: 2 }], tools: {},
    }) };
    driver = new AgentDriverV2({ sources: [history, { name: source.name, onUpdate: () => () => {},
        async getContext() {
            const context = await source.getContext();
            turn.context = context;
            return { ...context, async release() { await context.release(); turn.finished.resolve(); } };
        } }],
        llm: { model: 'fixture', provider: { id: 'assembly', baseURL: 'https://fixture.invalid/v1' }, apiKey: 'fixture',
            inputBudget: () => ({ contextWindow: turn.window, maxOutputTokens: 256 }) },
        onRunError: error => { turn.error = error; },
    });
    async function run(label, calls = [], { window = 100000, partial = false } = {}) {
        turn = { label, calls, window, partial, requests: [], observations: {}, adoptions: [], finished: Promise.withResolvers() };
        const timer = setTimeout(() => turn.finished.reject(turn.error ?? new Error('Context was not released for ' + label)), 15000);
        try { await Promise.all([driver.trigger(), turn.finished.promise]); }
        finally { clearTimeout(timer); }
        const request = turn.requests[0];
        if (request) {
            assert.equal(turn.requests.length, 1);
            const texts = request.messages.map(message => message.content);
            for (const message of turn.context.messages) assert.ok(texts.includes(message.content), 'Candidate message missing from actual request');
            assert.ok(texts.includes(DEFAULT_AOTUI_SYSTEM_INSTRUCTION));
            assert.match(DEFAULT_AOTUI_SYSTEM_INSTRUCTION, /trusted App in a Worker thread/);
            assert.ok(texts.includes('Compare the two workspaces. Turn ' + label));
            assert.deepEqual(request.tools.map(tool => tool.function.name).sort(), Object.keys(turn.context.tools).sort());
            for (const { function: wireTool } of request.tools) {
                assert.deepEqual(wireTool.parameters, JSON.parse(JSON.stringify(turn.context.tools[wireTool.name].inputSchema.jsonSchema)));
            }
            assert.equal(request.max_tokens, 256);
        }
        turns.push({ label, sent: turn.requests.length, observations: turn.observations, adoptions: turn.adoptions, error: turn.error?.code,
            budget: turn.error?.details, tools: request?.tools.map(tool => tool.function.name),
            wireBytes: turn.wireBytes, request });
        return turn;
    }
    const previous = new Map();
    for (const [id, client] of clients) {
        const captured = await client.observe({ all: true });
        assert.equal(captured.status, 'observed');
        assert.equal(client.adoptObservation(captured.observation.observationId).status, 'adopted');
        previous.set(id, captured.observation);
    }
    const denied = await run('budget', [], { window: 1024 });
    assert.equal(denied.error?.code, 'MODEL_INPUT_BUDGET_EXCEEDED');
    assert.equal(denied.error.details.inputLimit, 768);
    assert.deepEqual(denied.adoptions, []);
    assert.equal(denied.requests.length, 0);

    const list = 'billing_export_2026_11';
    for (const [id, observed] of previous) {
        const result = await clients.get(id).invoke({ invocationId: 'prior-count', observationId: observed.observationId,
            toolId: observed.tools.find(tool => tool.name === 'count').id, input: { view_id: 'b', selected: list + '.items[0]' } });
        assert.equal(result.receipt?.outcome.status, 'succeeded', 'Budget refusal preserved the previously adopted source');
    }
    const scripts = name => [
        [name + '-reverse', name + '-update', { view_id: 'workspace', operation: 'reverse' }],
        [name + '-remember', name + '-inspect', { view_id: 'b', selected: list + '.items[0]' }],
        [name + '-close', name + '-update', { view_id: 'workspace', operation: 'close' }],
        [name + '-open', name + '-update', { view_id: 'workspace', operation: 'open' }],
        [name + '-stale', name + '-inspect', { view_id: list, selected: 'b.selected' }],
    ];
    const calls = [...scripts(managed.name), ...scripts(local.app.name)];
    const before = await run('operate', calls);
    assert.ifError(before.error);
    assert.equal(receipts.length, calls.length);
    for (const [i, { request, result }] of receipts.entries()) {
        assert.equal(request.invocationId, calls[i][0]);
        assert.equal(result.kind, 'receipt');
        const { outcome, executionPhase } = result.receipt;
        if (request.invocationId.endsWith('-stale')) {
            assert.equal(outcome.status, 'rejected');
            assert.equal(outcome.code, 'VIEW_INSTANCE_REVOKED');
            assert.equal(executionPhase, 'not-dispatched');
        } else {
            assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome));
            assert.deepEqual(Object.keys(outcome.value), ['success']);
            assert.equal(outcome.value.success, true);
        }
    }
    const after = await run('observe', [[managed.name + '-close-list', managed.name + '-update', { view_id: 'workspace', operation: 'close' }]]);
    assert.ifError(after.error);
    for (const { appId, name } of [managed, local.app]) {
        const view = (step, viewId) => step.requests[0].messages.filter(m => m.role === 'user' &&
            typeof m.content === 'string' && m.content.startsWith('<view id="' + viewId + '"') && m.content.includes('app_id="' + appId + '"'));
        assert.equal(view(before, list).length, 1);
        assert.match(view(before, list)[0].content, /Data:items\[4\]/);
        assert.equal(view(after, list).length, 1);
        assert.doesNotMatch(view(after, list)[0].content, /Data:items\[4\]/);
        assert.match(view(before, 'workspace')[0].content, /Inspections: 0/);
        assert.match(view(after, 'workspace')[0].content, /Inspections: 1[\s\S]*"selected":0/);
        const tools = after.requests[0].tools.filter(tool => tool.function.name === name + '-inspect');
        assert.equal(tools.length, 1);
        assert.ok(tools[0].function.parameters.required.includes('view_id'));
    }
    assert.equal(receipts.length, 11);
    assert.equal(receipts.at(-1).result.receipt.outcome.status, 'succeeded');
    const broken = await run('partial', [], { partial: true });
    assert.equal(broken.error?.code, 'SEMANTIC_ADOPTION_PARTIAL');
    assert.deepEqual(broken.adoptions, [[managed.appId, 'adopted'], [local.app.appId, 'rejected']]);
    assert.equal(broken.requests.length, 0);
    for (const [id, observation] of candidates) assert.equal(clients.get(id).adoptObservation(observation.observationId).status, 'rejected');
    const recovered = await run('recovered');
    assert.ifError(recovered.error);
    assert.equal(recovered.requests.length, 1);
    for (const { appId, request: { observationId, invocationId }, result } of receipts) {
        assert.notEqual(observationId, candidates.get(appId).observationId);
        assert.deepEqual(await clients.get(appId).readReceipt({ observationId, invocationId }), result);
    }
    const recovery = recovered.requests[0];
    const listMessages = recovery.messages.filter(m => typeof m.content === 'string' && m.content.startsWith('<view id="' + list + '"'));
    assert.equal(listMessages.length, 1);
    assert.ok(listMessages[0].content.includes('app_id="local"'));
    assert.ok(recovery.tools.some(tool => tool.function.name === managed.name + '-inspect'), 'Second Item still receives the shared Tool');
    await desktop.closeApp(managed.appId, managed.appInstanceId);
    const remaining = await run('closed');
    assert.ifError(remaining.error);
    const last = remaining.requests[0];
    assert.ok(last.tools.every(tool => !tool.function.name.startsWith(managed.name + '-')));
    assert.ok(last.tools.some(tool => tool.function.name === 'local-inspect'));
    assert.ok(last.messages.every(m => typeof m.content !== 'string' || !m.content.startsWith('<view ') ||
        !m.content.includes('app_id="' + managed.appId + '"')));
} finally {
    globalThis.fetch = originalFetch;
    driver?.stop();
    driver?.dispose();
    source?.dispose();
    try { release.local = await local?.close(); }
    finally {
        const report = await runtime.beginShutdown().completion;
        assert.ok(report.ok && report.resourcesReleased, JSON.stringify(report));
        assert.equal(report.interactions.retainedOperations, 0);
        assert.equal(report.interactions.retainedBytes, 0);
        release.managed = { resourcesReleased: report.resourcesReleased, retainedOperations: report.interactions.retainedOperations,
            retainedBytes: report.interactions.retainedBytes };
    }
}
console.log(JSON.stringify({ turns, resolutions, appEntrySHA256: createHash('sha256').update(await readFile(fileURLToPath(entry))).digest('hex'),
    checkedReceipts: receipts.length, receipts: receipts.map(({ appId, request, result }) => ({
        appId, ...request, outcome: result.receipt.outcome, executionPhase: result.receipt.executionPhase,
    })), release }));
