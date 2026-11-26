import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createAppInteraction, createSnapshotCore, createTurnCoordinator } from '@aotui/core/host';
import { commitAppFrame, createViewOwnedTools, SemanticProjectionCoordinator } from '@aotui/core/producer';
import { APP_LIFECYCLE_PROTOCOL, hasViewTypeToolAuthoringProtocol, isTUIAppFactory } from '@aotui/core';
import { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from '@aotui/runtime/adapters';
import { createCandidateScope } from '@aotui/runtime';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';

// One known serial App, using only package exports. Keep the wiring visible so it can be measured.
async function openLocalWorkItems(factory, desktopId, projectionLimits, appId) {
    const identity = { appId, instanceId: appId + '-work-items-1' };
    const core = createSnapshotCore(identity);
    const registry = createViewOwnedTools(identity.appId, identity.instanceId);
    const projection = new SemanticProjectionCoordinator({ identity: () => identity });
    const controller = new AbortController();
    let cleanup;
    const context = {
        appId: identity.appId, desktopId, signal: controller.signal, projectionLimits,
        appLifecycle: { protocol: APP_LIFECYCLE_PROTOCOL, register(owner) {
            assert.equal(cleanup, undefined);
            cleanup = owner;
            return () => assert.ok(controller.signal.aborted, 'This fixture unmounts its owner only on shutdown');
        } },
        defineViewTypes: definitions => { projection.assertWritable(); registry.defineViewTypes(definitions); },
        readViewId: owner => projection.readViewId(owner, registry),
        requestAttention() {},
        publishFrame(build, options) {
            assert.equal(options, undefined, 'Work Items only uses ordinary commits in this scenario');
            const result = commitAppFrame(projection, registry, build);
            const publication = projection.publishTo(core.committer);
            if (result.status === 'prepared') assert.ok(['published', 'unchanged'].includes(publication.status));
            return result;
        },
    };
    const instance = await factory.initialize(context);
    const binding = {
        identity: {},
        isLive: ({ tool, receiver }) => !controller.signal.aborted && !projection.failed &&
            registry.validateTypeToolBinding(tool, receiver).success,
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
        app: { installationId: appId + '_installation', appId: identity.appId, appInstanceId: identity.instanceId, name: appId, status: 'running' },
        readReceipt: authority.readReceipt,
        observe(turns) {
            return turns.prepareObservation(authority, () => !controller.signal.aborted);
        },
        async close() {
            controller.abort();
            core.lifecycle.stop();
            authority.close();
            cleanup.stop();
            try { await authority.whenClosed(); await instance.close(); await cleanup.close(); }
            finally { projection.close(); registry.dispose(); core.lifecycle.dispose(); }
            const { activeInvocations, activeReads, borrowedSnapshots, observations } = authority.inspect();
            const released = { activeInvocations, activeReads, borrowedSnapshots, observationSlots: observations.observationSlots,
                activeHolds: core.store.inspect().activeHolds, bindings: registry.inspect().bindings };
            assert.deepEqual(released, { activeInvocations: 0, activeReads: 0, borrowedSnapshots: 0, observationSlots: 0,
                activeHolds: 0, bindings: 0 });
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
    adapter: fileURLToPath(adapter), driver: await installed('@aotui/agent-driver-v2'),
};
assert.equal(await installed('@aotui/sdk'), resolutions.sdk);
assert.equal(await installed('@aotui/runtime', adapter), resolutions.runtime);
assert.equal(await installed('@aotui/agent-driver-v2', adapter), resolutions.driver);
const modules = await realpath('node_modules');
for (const path of Object.values(resolutions)) assert.ok(path.startsWith(modules + sep), path);
const factory = (await import(entry)).default;
assert.ok(isTUIAppFactory(factory) && hasViewTypeToolAuthoringProtocol(factory));
assert.equal(factory.app_name, manifest.app_name);
const jsonLimits = Object.freeze({ maxDepth: 12, maxNodes: 8192, maxApproxBytes: 65536, maxCanonicalBytes: 65536 });
const limits = Object.freeze({ maxViews: 8, maxRefs: 64, maxTools: 16,
    observation: Object.freeze({ ...jsonLimits, maxDepth: 20 }), metadata: jsonLimits });
const originalFetch = globalThis.fetch;
const requests = [];
const turns = createTurnCoordinator();
const receipts = [];
const release = {};
const owners = [];
let source, driver, turn;
try {
    const desktopId = 'assembly';
    const left = await openLocalWorkItems(factory, desktopId, limits, 'work_items');
    owners.push(left);
    const local = await openLocalWorkItems(factory, desktopId, limits, 'local');
    owners.push(local);
    const managed = left.app;
    const clients = new Map(owners.map(owner => [owner.app.appId, owner]));
    const activeApps = new Set(owners);
    const candidates = new Map();
    // This portable Host owns both instances and delegates the entire turn to Core.
    delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
    const desktop = {
        id: desktopId, listApps: () => [...activeApps].map(owner => owner.app), getSystemLogs: () => [],
        createCandidateScope,
        getAppWindows: () => undefined,
        getRunningApp(appId, instanceId) {
            const owner = clients.get(appId);
            assert.equal(instanceId, owner.app.appInstanceId);
            return { status: 'ready', app: { async observe() {
                const prepared = await owner.observe(turns);
                assert.equal(prepared.status, 'prepared', JSON.stringify(prepared.issue));
                const { observation } = prepared.candidate;
                candidates.set(appId, prepared.candidate);
                turn.observations[appId] = observation.observationId;
                return prepared;
            } } };
        },
        adoptTurn(selection) {
            if (turn.partial) candidates.get(local.app.appId).discard();
            const result = turns.adoptTurn(selection);
            for (const { candidate } of selection.apps) turn.adoptions.push([candidate.observation.source.appId, result.status]);
            if (result.status !== 'adopted') return result;
            const active = result.turn;
            return { ...result, turn: { ...active, get isCurrent() { return active.isCurrent; }, async invoke(appId, request, ...options) {
                const observed = candidates.get(appId).observation;
                assert.equal(request.observationId, observed.observationId);
                const captured = turn.calls.find(([id]) => id === request.invocationId);
                const tool = observed.tools.find(tool => appId + '-' + tool.name === captured[1]);
                assert.equal(request.toolId, tool.id);
                const { view_id, ...input } = captured[2];
                assert.equal(request.viewId, view_id);
                assert.deepEqual({ ...request.input }, input);
                const invoked = await active.invoke(appId, request, ...options);
                receipts.push({ appId, request, result: invoked });
                return invoked;
            } } };
        },
    };
    source = new SemanticAOTUIDrivenSource(desktop);

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
            assert.match(DEFAULT_AOTUI_SYSTEM_INSTRUCTION, /installation_id/);
            assert.ok(texts.includes('Compare the two workspaces. Turn ' + label));
            assert.deepEqual(request.tools.map(tool => tool.function.name).sort(), Object.keys(turn.context.tools).sort());
            for (const { function: wireTool } of request.tools) {
                assert.deepEqual(wireTool.parameters, JSON.parse(JSON.stringify(turn.context.tools[wireTool.name].inputSchema.jsonSchema)));
            }
            assert.equal(request.max_tokens, 256);
        }
        requests.push({ label, sent: turn.requests.length, observations: turn.observations, adoptions: turn.adoptions, error: turn.error?.code,
            budget: turn.error?.details, tools: request?.tools.map(tool => tool.function.name),
            wireBytes: turn.wireBytes, request });
        return turn;
    }
    const previous = new Map();
    for (const [id, client] of clients) {
        const captured = await client.observe(turns);
        assert.equal(captured.status, 'prepared');
        previous.set(id, captured.candidate);
    }
    const prior = turns.adoptTurn({ apps: [...previous.values()].map(candidate => ({ candidate })) });
    assert.equal(prior.status, 'adopted');
    const denied = await run('budget', [], { window: 1024 });
    assert.equal(denied.error?.code, 'MODEL_INPUT_BUDGET_EXCEEDED');
    assert.equal(denied.error.details.inputLimit, 768);
    assert.deepEqual(denied.adoptions, []);
    assert.equal(denied.requests.length, 0);

    const list = 'billing_export_2026_11_1';
    const reopenedList = 'billing_export_2026_11_2';
    for (const [id, { observation: observed }] of previous) {
        const result = await prior.turn.invoke(id, { invocationId: 'prior-count', observationId: observed.observationId,
            toolId: observed.tools.find(tool => tool.name === 'count').id, viewId: 'b_1', input: {  selected: '$ref.' + id + '.' + list + '.items[0]' } });
        assert.equal(result.receipt?.outcome.status, 'succeeded', 'Budget refusal preserved the previously adopted source');
    }
    prior.turn.release();
    const scripts = name => [
        [name + '-reverse', name + '-update', { view_id: 'workspace_1', operation: 'reverse' }],
        [name + '-remember', name + '-inspect', { view_id: 'b_1', selected: '$ref.' + name + '.' + list + '.items[0]' }],
        [name + '-close', name + '-update', { view_id: 'workspace_1', operation: 'close' }],
        [name + '-open', name + '-update', { view_id: 'workspace_1', operation: 'open' }],
        [name + '-stale', name + '-inspect', { view_id: list, selected: '$ref.' + name + '.b_1.selected' }],
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
    const after = await run('observe', [[managed.name + '-close-list', managed.name + '-update', { view_id: 'workspace_1', operation: 'close' }]]);
    assert.ifError(after.error);
    for (const { appId, name } of [managed, local.app]) {
        const view = (step, viewId) => step.requests[0].messages.filter(m => m.role === 'user' &&
            typeof m.content === 'string' && m.content.startsWith('<view view_id="' + viewId + '"') && m.content.includes('app_id="' + appId + '"'));
        assert.equal(view(before, list).length, 1);
        assert.match(view(before, list)[0].content, /items\[4\]/);
        assert.equal(view(after, reopenedList).length, 1);
        assert.doesNotMatch(view(after, reopenedList)[0].content, /items\[4\]/);
        assert.match(view(before, 'workspace_1')[0].content, /Inspections: 0/);
        assert.match(view(after, 'workspace_1')[0].content, /Inspections: 1[\s\S]*"selected":0/);
        const tools = after.requests[0].tools.filter(tool => tool.function.name === name + '-inspect');
        assert.equal(tools.length, 1);
        assert.ok(tools[0].function.parameters.required.includes('view_id'));
    }
    assert.equal(receipts.length, 11);
    assert.equal(receipts.at(-1).result.receipt.outcome.status, 'succeeded');
    const broken = await run('partial', [], { partial: true });
    assert.equal(broken.error?.code, 'SEMANTIC_ADOPTION_FAILED');
    assert.deepEqual(broken.adoptions, [[managed.appId, 'rejected'], [local.app.appId, 'rejected']]);
    assert.equal(broken.requests.length, 0);
    for (const candidate of candidates.values()) assert.equal(turns.adoptTurn({ apps: [{ candidate }] }).status, 'rejected');
    const recovered = await run('recovered');
    assert.ifError(recovered.error);
    assert.equal(recovered.requests.length, 1);
    for (const { appId, request: { observationId, invocationId }, result } of receipts) {
        assert.notEqual(observationId, candidates.get(appId).observation.observationId);
        assert.deepEqual(await clients.get(appId).readReceipt({ observationId, invocationId }), result);
    }
    const recovery = recovered.requests[0];
    const listMessages = recovery.messages.filter(m => typeof m.content === 'string' && m.content.startsWith('<view view_id="' + reopenedList + '"'));
    assert.equal(listMessages.length, 1);
    assert.ok(listMessages[0].content.includes('app_id="local"'));
    assert.ok(recovery.tools.some(tool => tool.function.name === managed.name + '-inspect'), 'Second Item still receives the shared Tool');
    release[managed.appId] = await left.close();
    activeApps.delete(left);
    owners.splice(owners.indexOf(left), 1);
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
    turns.close();
    for (const owner of owners) release[owner.app.appId] = await owner.close();
}
console.log(JSON.stringify({ turns: requests, resolutions, appEntrySHA256: createHash('sha256').update(await readFile(fileURLToPath(entry))).digest('hex'),
    checkedReceipts: receipts.length, receipts: receipts.map(({ appId, request, result }) => ({
        appId, ...request, outcome: result.receipt.outcome, executionPhase: result.receipt.executionPhase,
    })), release }));
