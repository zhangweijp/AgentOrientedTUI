import { createTurnCoordinator, projectCompleteViews } from '@aotui/core/host';
import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { SemanticSnapshotReceiver } from '../../runtime/src/adapters/snapshot/receiver.js';
import { createCandidateScope } from '../../runtime/src/engine/core/candidate-scope.js';
import { createRuntime, type AppExecutionBackend, type AppExecutionProjection, type RunningApp } from '../../runtime/src/index.js';
import { commitAppFrame, createViewOwnedTools, SemanticProjectionCoordinator } from '@aotui/core/producer';
import { compileToolParameters } from '@aotui/core';
import type { AppDiscoveryInfo, IDesktop } from '../../runtime/src/spi/runtime/kernel.interface.js';
import type { ExecutionBinding, InvocationContext } from '@aotui/core';
import type { ViewToolInvocationTerminal } from '@aotui/core';
import type { SnapshotCore } from '@aotui/core';
import { fixtureProvider, watchUntil } from '../fixtures/batch-two-support.mjs';

type ReceiverCoreInspection = { core: SnapshotCore };

function inspectCore(receiver: SemanticSnapshotReceiver) {
    return (receiver as unknown as ReceiverCoreInspection).core.store.inspect();
}

function createApp(appId: string, name: string, instanceId: string, viewType: string, body: string, viewName = 'Workspace') {
    const registry = createViewOwnedTools(appId, instanceId);
    const input = compileToolParameters({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false });
    if (!input.ok) throw new Error('The real registry fixture requires a valid ordinary Tool contract.');

    const invoked: string[] = [];
    let type = viewType;
    let owner = {};
    const toolName = () => type === 'InvalidAlias' ? 'run-file' : 'run';
    registry.defineViewTypes([...new Set([viewType, 'Workspace'])].map(name => ({
        name, multiplicity: 'multiple', tools: [{ name: name === 'InvalidAlias' ? 'run-file' : 'run',
            description: 'Run the current App Tool.', inputSchema: input.contract.schema }],
    })));
    const execute = async (args: Readonly<Record<string, unknown>>) => {
        const value = String(args.value);
        invoked.push(value);
        return { success: true, data: { appId, value } };
    };

    const receiver = new SemanticSnapshotReceiver(appId, instanceId, () => 100);
    const binding: ExecutionBinding = {
        identity: {},
        isLive: source => registry.validateTypeToolBinding(source.tool, source.receiver).success,
        execute: async (context: InvocationContext) => {
            const terminal: ViewToolInvocationTerminal = await registry.invokeTypeTool(
                context.source.tool, context.source.receiver, context.effectiveInput);
            return { kind: 'tool-result', phase: terminal.phase, result: terminal.result };
        },
    };
    const execution = {
        resolve: () => binding,
    };

    const projection = new SemanticProjectionCoordinator({ identity: () => ({ appId, instanceId }) });
    const publish = (nextBody = body, visible = true) => {
        commitAppFrame(projection, registry, () => ({ views: visible ? [{
            idPrefix: 'workspace', type, name: viewName, region: 'dynamic', owner,
            content: { format: 'markdown-v1', value: nextBody }, refs: [],
            bindings: [{ name: toolName(), enabled: true, execute }],
        }] : [] }));
        const publication = projection.nextPublication();
        const accepted = 'draft' in publication
            ? receiver.acceptPrepared(publication.draft)
            : receiver.acceptPrepareFailure(publication.failure);
        if (accepted.status !== 'published' && accepted.status !== 'unchanged') {
            throw new Error(`The real Snapshot Receiver rejected ${appId}: ${accepted.issue.code}`);
        }
    };
    publish();

    return {
        app: { installationId: appId + ':install', appId: appId as AppDiscoveryInfo['appId'], appInstanceId: instanceId, name, status: 'running' as const },
        registry, receiver, projection, execution, invoked, publish,
        repairViewType(next: string) {
            type = next;
            owner = {};
            publish(`${appId} repaired View content.`);
        },
    };
}

it('uses real Registries and Receivers to isolate, recover and release Semantic App projections', async () => {
    const bad = createApp('bad_app', 'bad_app', 'bad-instance', 'InvalidAlias', 'BAD_APP_BODY');
    const collidingB = createApp('collision_b', 'shared_app', 'collision-b-instance', 'Workspace', 'COLLISION_B_BODY');
    const collidingA = createApp('collision_a', 'shared_app', 'collision-a-instance', 'Workspace', 'COLLISION_A_BODY');
    const healthyBody = '<view id="literal">HEALTHY_APP_BODY</view>';
    const healthy = createApp('healthy_app', 'healthy_app', 'healthy-instance', 'Workspace', healthyBody, 'foo>bar');
    const assemblies = [bad, collidingB, collidingA, healthy];
    const subscriptions = new Set<() => void>();
    const turns = createTurnCoordinator();
    const policy = { project: projectCompleteViews, authorize: () => true, canReadReceipt: () => true };
    const desktop = {
        id: 'real-core-test-desktop',
        createCandidateScope,
        adoptTurn: turns.adoptTurn,
        getRunningApp: (appId: string, instanceId: string) => {
            const assembly = assemblies.find(item => item.app.appId === appId && item.app.appInstanceId === instanceId);
            if (!assembly) return { status: 'rejected', issue: { code: 'APP_INTERACTION_UNAVAILABLE', message: 'App not found.' } };
            const interaction = assembly.receiver.interaction(policy, assembly.execution);
            return { status: 'ready', app: { observe: () =>
                turns.prepareObservation(interaction, () => assemblies.includes(assembly)) } };
        },
        listApps: () => assemblies.map(assembly => assembly.app),
        getAppWindows: () => undefined,
        getSystemLogs: () => [],
        openApp: async () => {}, collapseApp: async () => {}, expandApp: async () => {},
        output: { subscribe: (listener: () => void) => subscriptions.add(listener),
            unsubscribe: (listener: () => void) => subscriptions.delete(listener) },
    } as unknown as IDesktop;
    const source = new SemanticAOTUIDrivenSource(desktop, { includeInstruction: false });
    const contexts: Awaited<ReturnType<typeof source.getContext>>[] = [];

    try {
        // The Core accepts this Tool name. The stricter native alias rule belongs
        // to Semantic Source, which must isolate only this App at projection time.
        const initial = bad.receiver['core'].store.readLatest('bad_app');
        expect(initial).toMatchObject({ status: 'ready', snapshot: { revision: 1 } });
        expect(bad.registry.getView('workspace_1')?.viewType).toBe('InvalidAlias');

        const first = await source.getContext();
        contexts.push(first);
        await first.adopt!();
        expect(first.tools['bad_app-run-file']).toBeUndefined();
        expect(first.tools['collision_a-run']).toBeDefined();
        expect(first.tools['healthy_app-run']).toBeDefined();
        const firstText = JSON.stringify(first.messages);
        expect(firstText).not.toContain('BAD_APP_BODY');
        expect(firstText).toContain('COLLISION_B_BODY');
        expect(firstText).toContain('COLLISION_A_BODY');
        expect(firstText).toContain('HEALTHY_APP_BODY');
        const healthyMessage = String(first.messages.find(message => String(message.content).includes('HEALTHY_APP_BODY'))?.content);
        expect(healthyMessage).toContain('view_id="workspace_1" view_type="Workspace" app_id="healthy_app" app_name="healthy_app"');
        expect(healthyMessage).toContain('\n&lt;view id="literal"&gt;HEALTHY_APP_BODY&lt;/view&gt;\n</view>');
        expect(firstText).toContain('AOTUI_TOOL_NAME_INVALID: toolName');
        expect(first.tools['collision_b-run']).toBeDefined();

        expect(await first.executeTool!('collision_a-run', { view_id: 'workspace_1', value: 'winner' }, 'collision-winner'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { appId: 'collision_a', value: 'winner' } });
        expect(await first.executeTool!('healthy_app-run', { view_id: 'workspace_1', value: 'usable' }, 'healthy-call'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { appId: 'healthy_app', value: 'usable' } });
        expect(collidingA.invoked).toEqual(['winner']);
        expect(collidingB.invoked).toEqual([]);
        expect(healthy.invoked).toEqual(['usable']);
        expect(bad.invoked).toEqual([]);
        expect(bad.receiver.getInteractionStats()).toMatchObject({ observations: { observations: 0, reservations: 0, } });

        await first.release!();
        for (const assembly of assemblies) {
            expect(assembly.receiver.getInteractionStats()).toMatchObject({ observations: { observations: 0, reservations: 0, } });
            expect(inspectCore(assembly.receiver).activeHolds).toBe(0);
        }

        // Repair the declaration in the same live Registry and publish a new
        // accepted Snapshot. The next context must expose its current Tool.
        bad.repairViewType('Workspace');
        expect(bad.receiver['core'].store.readLatest('bad_app')).toMatchObject({ status: 'ready', snapshot: { revision: 2 } });
        const recovered = await source.getContext();
        contexts.push(recovered);
        await recovered.adopt!();
        expect(recovered.tools['bad_app-run']).toBeDefined();
        expect(JSON.stringify(recovered.messages)).toContain('bad_app repaired View content.');
        expect(await recovered.executeTool!('bad_app-run', { view_id: 'workspace_2', value: 'recovered' }, 'bad-recovered'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { appId: 'bad_app', value: 'recovered' } });
        expect(bad.invoked).toEqual(['recovered']);

        await recovered.release!();
        source.dispose();
        for (const assembly of assemblies) {
            await assembly.receiver.close();
            assembly.projection.close();
            assembly.registry.dispose();
            expect(assembly.receiver.getInteractionStats()).toMatchObject({ closed: true, observations: { observations: 0, reservations: 0, } });
            expect(inspectCore(assembly.receiver)).toMatchObject({
                state: 'disposed', activeHolds: 0, currentBytes: 0,
            });
            expect(assembly.registry.inspect()).toMatchObject({ state: 'disposed', views: 0, bindings: 0 });
        }
    } finally {
        for (const context of contexts) await context.release?.();
        source.dispose();
        for (const assembly of assemblies) {
            await assembly.receiver.close();
            assembly.projection.close();
            assembly.registry.dispose();
        }
    }
});

it('sends no candidate HTTP when A closes or remounts inside B verification', async () => {
    const facts = [];
    for (const change of ['close', 'remount', 'text']) {
        const a = createApp('first_app', 'first_app', 'first-instance', 'Workspace', 'original A body');
        const b = createApp('second_app', 'second_app', 'second-instance', 'Workspace', 'original B body');
        const receivers = [a, b], turns = createTurnCoordinator();
        const receiver = b.receiver as unknown as ReceiverCoreInspection;
        const original = receiver.core;
        let atRead: (() => void) | undefined;
        receiver.core = { ...original, store: { ...original.store, readLatest(appId) {
            const changeNow = atRead;
            atRead = undefined;
            changeNow?.();
            return original.store.readLatest(appId);
        } } };
        let duringNextAdoption = false;
        let failures = 0;
        const policy = { project: projectCompleteViews, authorize: () => true, canReadReceipt: () => true };
        const desktop = {
            createCandidateScope,
            adoptTurn: (input: Parameters<typeof turns.adoptTurn>[0]) => {
                if (duringNextAdoption) atRead = () => {
                    failures++;
                    if (change === 'close') a.publish('', false);
                    else if (change === 'remount') a.repairViewType('Workspace');
                    else a.publish('new A body');
                };
                return turns.adoptTurn(input);
            },
            listApps: () => receivers.map(item => item.app),
            getAppWindows: () => undefined,
            getRunningApp(appId: string) {
                const found = receivers.find(item => item.app.appId === appId)!;
                return { status: 'ready', app: { observe: () =>
                    turns.prepareObservation(found.receiver.interaction(policy, found.execution), () => true) } };
            },
            output: { subscribe() {}, unsubscribe() {} },
        } as unknown as IDesktop;
        const provider = await fixtureProvider();
        const source = new SemanticAOTUIDrivenSource(desktop);
        const errors: Array<Error & { code?: string; cause?: { code?: string } }> = [];
        const driver = new AgentDriverV2({ sources: [source], llm: {
            model: 'atomic-fixture', provider: { id: 'atomic-fixture', baseURL: provider.url }, apiKey: 'test-only',
        }, onRunError: error => errors.push(error) });
        try {
            const prior = await source.getContext();
            await prior.adopt!();
            duringNextAdoption = true;
            await driver.trigger();
            await (driver as unknown as { runInFlight?: Promise<void> }).runInFlight;
            expect(failures).toBe(1);
            expect(provider.failures).toEqual([]);
            if (change === 'text') {
                expect(errors).toEqual([]);
                expect(provider.requests).toHaveLength(1);
                expect(JSON.stringify(provider.requests[0].body.messages)).toContain('original A body');
            } else {
                expect(provider.requests).toHaveLength(0);
                expect(errors).toMatchObject([{ code: 'SEMANTIC_ADOPTION_FAILED', cause: { code: 'OBSERVATION_WINDOW_CHANGED' } }]);
                expect(await prior.executeTool!('first_app-run', { view_id: 'workspace_1', value: 'rejected' }, 'old-a'))
                    .toMatchObject({ outcomeStatus: 'rejected', error: { code: 'VIEW_INSTANCE_REVOKED' } });
                expect(await prior.executeTool!('second_app-run', { view_id: 'workspace_1', value: 'retained' }, 'old-b'))
                    .toMatchObject({ outcomeStatus: 'succeeded' });
                expect(a.invoked).toEqual([]);
                expect(b.invoked).toEqual(['retained']);
            }
            facts.push({ change, requests: provider.requests, errors: errors.map(error => [error.code, error.cause?.code]),
                firstCalls: a.invoked, secondCalls: b.invoked });
        } finally {
            driver.dispose(); await source.dispose(); await provider.close();
            for (const { receiver, projection, registry } of receivers) {
                await receiver.close();
                projection.close();
                registry.dispose();
            }
        }
    }
    const evidence = process.env.AOTUI_BATCH_TWO_EVIDENCE;
    if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(join(evidence, 'atomic-driver.json'), JSON.stringify(facts, null, 2));
    }
});

it('uses the Host App limit even when an adopted request contains more than 128 sources', async () => {
    const maxApps = 150;
    const frame: AppExecutionProjection = {
        revision: 1, refs: [], tools: [],
        views: [{ id: 'workspace', type: 'Workspace', name: 'Workspace', region: 'dynamic',
            body: 'Short page.', viewInstanceId: 'workspace-mount', tools: [] }],
    };
    // Use real Runtime registrations and observations with a lightweight execution backend for the 151 Apps.
    const observations: string[] = [];
    const backend: AppExecutionBackend = {
        start({ instanceId }, emit) {
            return {
                send({ kind, id }) {
                    switch (kind) {
                        case 'initialize': return emit({ kind: 'reply', id, status: 'ready' });
                        case 'open':
                            emit({ kind: 'projection', frame });
                            return emit({ kind: 'reply', id, status: 'done' });
                        case 'observe':
                            observations.push(instanceId);
                            return emit({ kind: 'projection', id, frame });
                        case 'stop':
                            return emit({ kind: 'reply', id, status: 'done', cleanup: { state: 'stopped', issues: [] } });
                        case 'close':
                            return emit({ kind: 'reply', id, status: 'done', cleanup: { state: 'completed', issues: [] } });
                        default: throw new Error('Unexpected execution request for the capacity fixture: ' + kind);
                    }
                },
                terminate: () => emit({ kind: 'exited' }),
            };
        },
    };
    const receivers = vi.spyOn(SemanticSnapshotReceiver.prototype, 'interaction');
    const runtime = createRuntime({ executionBackends: { capacity: backend } });
    const desktop = await runtime.createDesktop('capacity');
    const issueClient = vi.spyOn(desktop, 'getRunningApp');
    const bind = vi.spyOn(desktop, 'adoptTurn');
    const provider = await fixtureProvider();
    const facts = [];
    try {
        const apps: RunningApp[] = [];
        for (const directorySize of [128, 129, maxApps + 1]) {
            for (let index = apps.length; index < directorySize; index++) {
                const name = 'capacity_' + index;
                const installation = await desktop.registerPendingApp({ installationId: name, name, backend: 'capacity' });
                apps.push(await desktop.openApp(installation));
            }
            expect(desktop.listApps()).toHaveLength(directorySize);
            expect(receivers.mock.contexts).toHaveLength(directorySize);
            const errors: Error[] = [];
            const source = new SemanticAOTUIDrivenSource(desktop, { maxApps, includeInstruction: false });
            const driver = new AgentDriverV2({ sources: [source], llm: {
                model: 'capacity-fixture', provider: { id: 'capacity-fixture', baseURL: provider.url }, apiKey: 'test-only',
                inputBudget: () => ({ contextWindow: 100_000, maxOutputTokens: 2048 }),
            }, onRunError: error => errors.push(error) });
            bind.mockClear();
            issueClient.mockClear();
            observations.length = 0;
            const sent = provider.requests.length;
            try {
                await driver.trigger();
                await watchUntil(() => driver.getState() === 'idle');
                const newRequests = provider.requests.slice(sent);
                const pages = newRequests.flatMap(request => request.body.messages.filter(({ role, content }) =>
                    role === 'user' && typeof content === 'string' && content.startsWith('<view ')));
                const adopted = bind.mock.results.filter(result => result.type === 'return' && result.value.status === 'adopted');
                facts.push({ directorySize, maxApps, issuedClients: issueClient.mock.calls.length,
                    preparedObservations: observations.length,
                    bindAttempts: bind.mock.calls.map(([request]) => request.apps.length),
                    bound: adopted.length,
                    requests: newRequests.length, pages: pages.length, errors: errors.map(error => error.message) });
                if (directorySize > maxApps) {
                    expect(errors.map(error => error.message)).toEqual(['SEMANTIC_APP_CAPACITY']);
                    expect(issueClient).not.toHaveBeenCalled();
                    expect(observations).toEqual([]);
                    expect(bind).not.toHaveBeenCalled();
                    expect(newRequests).toHaveLength(0);
                } else {
                    expect(errors).toEqual([]);
                    expect(issueClient.mock.calls).toEqual(apps.map(app => [app.appId, app.instanceId]));
                    expect(observations).toEqual(apps.map(app => app.instanceId));
                    expect(bind).toHaveBeenCalledTimes(1);
                    expect(adopted).toHaveLength(1);
                    expect(bind.mock.calls[0]![0].apps).toHaveLength(directorySize);
                    expect(pages).toHaveLength(directorySize);
                    expect(newRequests).toHaveLength(1);
                }
                expect(provider.failures).toEqual([]);
                for (const receiver of receivers.mock.contexts)
                    expect(receiver.getInteractionStats()?.observations).toMatchObject({ observations: 0, reservations: 0 });
            } finally {
                driver.stop();
                driver.dispose();
                await source.dispose();
            }
        }
    } finally {
        const close = await runtime.beginClose().completion;
        receivers.mockRestore();
        await provider.close();
        expect(close).toMatchObject({ resourcesReleased: true, workers: { report: { total: 0 } } });
        const evidence = process.env.AOTUI_BATCH_TWO_EVIDENCE;
        if (evidence) {
            await mkdir(evidence, { recursive: true });
            await writeFile(join(evidence, 'source-capacity.json'), JSON.stringify(facts, null, 2));
        }
    }
});
