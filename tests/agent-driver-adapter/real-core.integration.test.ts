import { projectCompleteViews } from '@aotui/core/internal';
import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { SemanticSnapshotReceiver } from '../../runtime/src/adapters/snapshot/receiver.js';
import { Desktop } from '../../runtime/src/engine/core/desktop.js';
import type { AppManager } from '../../runtime/src/engine/app/manager.js';
import { commitAppFrame, SemanticProjectionCoordinator } from '@aotui/core/internal';
import { createViewOwnedTools } from '@aotui/core';
import { compileToolParameters } from '@aotui/core';
import type { AppDiscoveryInfo, IDesktop, IKernel } from '../../runtime/src/spi/runtime/kernel.interface.js';
import type { ExecutionBinding, InvocationContext, AppInteractionPolicy } from '@aotui/core';
import type { ViewToolInvocationTerminal } from '@aotui/core';
import type { SnapshotCore } from '@aotui/core';
import { fixtureProvider } from '../fixtures/batch-two-support.mjs';

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
        isLive: source => registry.validateTypeToolBinding(source.tool, source.receiver).success
            ? { ok: true } : { ok: false },
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
    const publish = (nextBody = body) => {
        commitAppFrame(projection, registry, () => ({ views: [{
            createId: () => 'workspace', type, name: viewName, region: 'dynamic', owner,
            content: { format: 'markdown-v1', value: nextBody }, refs: [],
            bindings: [{ name: toolName(), enabled: true, execute }],
        }] }));
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
        registry, receiver, projection, execution, invoked,
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
    const desktop = {
        id: 'real-core-test-desktop',
        bindRequestSources: () => undefined,
        getInstalledApps: () => assemblies.map(assembly => assembly.app),
        getAppWindows: () => undefined,
        getSystemLogs: () => [],
        openApp: async () => {}, closeApp: async () => {}, collapseApp: async () => {}, expandApp: async () => {},
        output: { subscribe: (listener: () => void) => subscriptions.add(listener),
            unsubscribe: (listener: () => void) => subscriptions.delete(listener) },
    } as unknown as IDesktop;
    const kernel = {
        getAppInteraction: (_desktopId: string, appId: string, instanceId: string, policy?: AppInteractionPolicy) => {
            const assembly = assemblies.find(item => item.app.appId === appId);
            return assembly && assembly.app.appInstanceId === instanceId
                ? { status: 'ready' as const, interaction: assembly.receiver.interaction(policy ?? {
                    project: projectCompleteViews, authorize: () => true, canReadReceipt: () => true,
                }, assembly.execution) }
                : { status: 'rejected' as const, issue: { code: 'APP_INTERACTION_UNAVAILABLE', message: 'App not found.' } };
        },
    } as unknown as IKernel;
    const source = new SemanticAOTUIDrivenSource(desktop, kernel, { includeInstruction: false });
    const contexts: Awaited<ReturnType<typeof source.getContext>>[] = [];

    try {
        // The Core accepts this Tool name. The stricter native alias rule belongs
        // to Semantic Source, which must isolate only this App at projection time.
        expect(bad.receiver.report()).toMatchObject({ health: 'ready', published: 1 });
        expect(bad.registry.getView('workspace')?.viewType).toBe('InvalidAlias');
        expect(JSON.stringify(bad.receiver.report())).not.toContain('AOTUI_TOOL_NAME_INVALID');

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
        expect(healthyMessage).toContain('view_id="workspace" view_type="Workspace" app_id="healthy_app" app_name="healthy_app"');
        expect(healthyMessage).toContain('\n&lt;view id="literal"&gt;HEALTHY_APP_BODY&lt;/view&gt;\n</view>');
        expect(firstText).toContain('AOTUI_TOOL_NAME_INVALID: toolName');
        expect(first.tools['collision_b-run']).toBeDefined();

        expect(await first.executeTool!('collision_a-run', { view_id: 'workspace', value: 'winner' }, 'collision-winner'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { appId: 'collision_a', value: 'winner' } });
        expect(await first.executeTool!('healthy_app-run', { view_id: 'workspace', value: 'usable' }, 'healthy-call'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { appId: 'healthy_app', value: 'usable' } });
        expect(collidingA.invoked).toEqual(['winner']);
        expect(collidingB.invoked).toEqual([]);
        expect(healthy.invoked).toEqual(['usable']);
        expect(bad.invoked).toEqual([]);
        expect(bad.receiver.getInteractionStats()).toMatchObject({ combinedBytes: 0,
            observations: { observations: 0, reservations: 0, totalBytes: 0 } });

        await first.release!();
        for (const assembly of assemblies) {
            expect(assembly.receiver.getInteractionStats()).toMatchObject({ sourceBytes: 0, workBytes: 0,
                observations: { observations: 0, reservations: 0, totalBytes: 0 } });
            expect(inspectCore(assembly.receiver).activeHolds).toBe(0);
        }

        // Repair the declaration in the same live Registry and publish a new
        // accepted Snapshot. The next context must expose its current Tool.
        bad.repairViewType('Workspace');
        expect(bad.receiver.report()).toMatchObject({ health: 'ready', published: 2 });
        const recovered = await source.getContext();
        contexts.push(recovered);
        await recovered.adopt!();
        expect(recovered.tools['bad_app-run']).toBeDefined();
        expect(JSON.stringify(recovered.messages)).toContain('bad_app repaired View content.');
        expect(await recovered.executeTool!('bad_app-run', { view_id: 'workspace', value: 'recovered' }, 'bad-recovered'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { appId: 'bad_app', value: 'recovered' } });
        expect(bad.invoked).toEqual(['recovered']);

        await recovered.release!();
        source.dispose();
        for (const assembly of assemblies) {
            await assembly.receiver.close();
            assembly.projection.close();
            assembly.registry.dispose();
            expect(assembly.receiver.getInteractionStats()).toMatchObject({ closed: true, combinedBytes: 0,
                observations: { observations: 0, reservations: 0, totalBytes: 0 } });
            expect(inspectCore(assembly.receiver)).toMatchObject({
                state: 'disposed', activeHolds: 0, currentBytes: 0,
            });
            expect(assembly.registry.inspect()).toMatchObject({ state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
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

it('uses the Host App limit even when an adopted request contains more than 128 sources', async () => {
    const maxApps = 150;
    const assemblies = Array.from({ length: maxApps + 1 }, (_, index) => {
        const id = 'capacity_' + index;
        return createApp(id, id, id + '_run', 'Workspace', 'Short page.');
    });
    const byId = new Map(assemblies.map(assembly => [assembly.app.appId, assembly]));
    const desktop = new Desktop();
    const manager = (desktop as unknown as { appManager: AppManager }).appManager;
    let directorySize = 0;
    const policy: AppInteractionPolicy = {
        project: () => ({ refs: [], toolIds: [] }), authorize: () => true, canReadReceipt: () => true,
    };
    vi.spyOn(manager, 'getInstalledApps').mockImplementation(() => assemblies.slice(0, directorySize).map(item => item.app));
    vi.spyOn(manager, 'isRunningApp').mockImplementation((id, instance) => byId.get(id)?.app.appInstanceId === instance);
    const issueClient = vi.spyOn(manager, 'getAppInteraction').mockImplementation((id, instance) => {
        const assembly = byId.get(id);
        if (!assembly || assembly.app.appInstanceId !== instance) throw new Error('Unexpected capacity fixture identity');
        return { status: 'ready', interaction: assembly.receiver.interaction(policy, assembly.execution) };
    });
    const bind = vi.spyOn(desktop, 'bindRequestSources');
    const kernel = { getAppInteraction: (_desktopId: string, id: string, instanceId: string) =>
        desktop.getAppInteraction(id, instanceId) } as IKernel;
    const provider = await fixtureProvider();
    const facts = [];
    try {
        for (directorySize of [128, 129, 151]) {
            const errors: Error[] = [];
            const source = new SemanticAOTUIDrivenSource(desktop, kernel, { maxApps, includeInstruction: false });
            const driver = new AgentDriverV2({ sources: [source], llm: {
                model: 'capacity-fixture', provider: { id: 'capacity-fixture', baseURL: provider.url }, apiKey: 'test-only',
                inputBudget: () => ({ contextWindow: 100_000, maxOutputTokens: 2048 }),
            }, onRunError: error => errors.push(error) });
            bind.mockClear();
            issueClient.mockClear();
            const sent = provider.requests.length;
            try {
                await driver.trigger();
                await (driver as unknown as { runInFlight?: Promise<void> }).runInFlight;
                const newRequests = provider.requests.slice(sent);
                const pages = newRequests.flatMap(request => request.body.messages.filter(({ role, content }) =>
                    role === 'user' && typeof content === 'string' && content.startsWith('<view ')));
                facts.push({ directorySize, maxApps, issuedClients: issueClient.mock.calls.length,
                    bindAttempts: bind.mock.calls.map(([request]) => request.apps.length),
                    bound: bind.mock.results.filter(result => result.type === 'return').length,
                    requests: newRequests.length, pages: pages.length, errors: errors.map(error => error.message) });
                if (directorySize > maxApps) {
                    expect(errors.map(error => error.message)).toEqual(['SEMANTIC_APP_CAPACITY']);
                    expect(issueClient).not.toHaveBeenCalled();
                    expect(bind).not.toHaveBeenCalled();
                    expect(newRequests).toHaveLength(0);
                } else {
                    expect(errors).toEqual([]);
                    expect(bind).toHaveBeenCalledTimes(1);
                    expect(bind.mock.calls[0]![0].apps).toHaveLength(directorySize);
                    expect(pages).toHaveLength(directorySize);
                    expect(newRequests).toHaveLength(1);
                }
                expect(provider.failures).toEqual([]);
                for (const { receiver } of assemblies)
                    expect(receiver.getInteractionStats()?.observations.observations ?? 0).toBe(0);
            } finally {
                driver.stop();
                driver.dispose();
                source.dispose();
            }
        }
    } finally {
        for (const assembly of assemblies) {
            await assembly.receiver.close();
            assembly.projection.close();
            assembly.registry.dispose();
        }
        await desktop.dispose();
        await provider.close();
        const evidence = process.env.AOTUI_BATCH_TWO_EVIDENCE;
        if (evidence) {
            await mkdir(evidence, { recursive: true });
            await writeFile(join(evidence, 'source-capacity.json'), JSON.stringify(facts, null, 2));
        }
    }
});
