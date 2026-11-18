import { projectCompleteViews } from '../../runtime/src/core/invocation/observation-registry.js';
import { expect, it } from 'vitest';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { SemanticSnapshotReceiver } from '../../runtime/src/adapters/snapshot/receiver.js';
import { commitAppFrame, SemanticProjectionCoordinator } from '../../runtime/src/core/projection/coordinator.js';
import { createViewOwnedTools } from '../../runtime/src/core/tool/view-owned-tools.js';
import { compileToolParameters } from '../../runtime/src/core/tool/tool-parameters.js';
import type { AppDiscoveryInfo, IDesktop, IKernel } from '../../runtime/src/spi/runtime/kernel.interface.js';
import type { ExecutionBinding, InvocationContext, AppInteractionPolicy } from '@aotui/runtime/core';
import type { ViewToolInvocationTerminal } from '../../runtime/src/core/tool/invocation-terminal.js';
import type { SnapshotCore } from '../../runtime/src/core/snapshot/types.js';

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
    registry.defineTools([...new Set([viewType, 'Workspace'])].map(viewType => ({
        viewType, name: 'run', description: 'Run the current App Tool.', inputSchema: input.contract.schema,
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
            id: 'workspace', type, name: viewName, kind: 'state', owner,
            content: { format: 'markdown-v1', value: nextBody }, refs: [],
            bindings: [{ name: 'run', enabled: true, execute }],
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
        app: { appId: appId as AppDiscoveryInfo['appId'], appInstanceId: instanceId, name, status: 'running' as const },
        registry, receiver, projection, execution, invoked,
        repairViewType(next: string) {
            type = next;
            owner = {};
            publish(`${appId} repaired View content.`);
        },
    };
}

it('uses real Registries and Receivers to isolate, recover and release Semantic App projections', async () => {
    const bad = createApp('bad_app', 'bad_app', 'bad-instance', 'A-B', 'BAD_APP_BODY');
    const collidingB = createApp('collision_b', 'shared_app', 'collision-b-instance', 'Workspace', 'COLLISION_B_BODY');
    const collidingA = createApp('collision_a', 'shared_app', 'collision-a-instance', 'Workspace', 'COLLISION_A_BODY');
    const healthyBody = '<view id="literal">HEALTHY_APP_BODY</view>';
    const healthy = createApp('healthy_app', 'healthy_app', 'healthy-instance', 'Workspace', healthyBody, 'foo>bar');
    const assemblies = [bad, collidingB, collidingA, healthy];
    const subscriptions = new Set<() => void>();
    const desktop = {
        id: 'real-core-test-desktop',
        getInstalledApps: () => assemblies.map(assembly => assembly.app),
        getSystemLogs: () => [],
        openApp: async () => {}, closeApp: async () => {}, collapseApp: async () => {}, showApp: async () => {},
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
        // Core V5 accepts this identity. The stricter native alias rule belongs
        // to Semantic Source, which must isolate only this App at projection time.
        expect(bad.receiver.report()).toMatchObject({ health: 'ready', published: 1 });
        expect(bad.registry.listViews()[0]?.viewType).toBe('A-B');
        expect(JSON.stringify(bad.receiver.report())).not.toContain('AOTUI_TOOL_NAME_INVALID');

        const first = await source.getContext();
        contexts.push(first);
        await first.adopt!();
        expect(first.tools['bad_app-A-B-run']).toBeUndefined();
        expect(first.tools['shared_app-run']).toBeDefined();
        expect(first.tools['healthy_app-run']).toBeDefined();
        const firstText = JSON.stringify(first.messages);
        expect(firstText).not.toContain('BAD_APP_BODY');
        expect(firstText).not.toContain('COLLISION_B_BODY');
        expect(firstText).toContain('COLLISION_A_BODY');
        expect(firstText).toContain('HEALTHY_APP_BODY');
        const healthyMessage = String(first.messages.find(message => String(message.content).includes('HEALTHY_APP_BODY'))?.content);
        expect(healthyMessage).toContain('name="foo&gt;bar"');
        expect(healthyMessage).toContain('\n&lt;view id="literal"&gt;HEALTHY_APP_BODY&lt;/view&gt;\n</view>');
        expect(firstText).toContain('AOTUI_TOOL_NAME_INVALID: viewType');
        expect(firstText).toContain('AOTUI_TOOL_NAME_COLLISION');

        expect(await first.executeTool!('shared_app-run', { view_id: 'workspace', value: 'winner' }, 'collision-winner'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { appId: 'collision_a', value: 'winner' } });
        expect(await first.executeTool!('healthy_app-run', { view_id: 'workspace', value: 'usable' }, 'healthy-call'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { appId: 'healthy_app', value: 'usable' } });
        expect(collidingA.invoked).toEqual(['winner']);
        expect(collidingB.invoked).toEqual([]);
        expect(healthy.invoked).toEqual(['usable']);
        expect(bad.invoked).toEqual([]);
        expect(bad.receiver.getInteractionStats()).toMatchObject({ combinedBytes: 0,
            observations: { observations: 0, reservations: 0, totalBytes: 0 } });
        expect(collidingB.receiver.getInteractionStats()).toMatchObject({ combinedBytes: 0,
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
        expect(recovered.tools['bad_app-Workspace-run']).toBeDefined();
        expect(JSON.stringify(recovered.messages)).toContain('bad_app repaired View content.');
        expect(await recovered.executeTool!('bad_app-Workspace-run', { view_id: 'workspace', value: 'recovered' }, 'bad-recovered'))
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
