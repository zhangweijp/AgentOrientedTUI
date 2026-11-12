import { projectCompleteViews } from '../../runtime/src/core/invocation/observation-registry.js';
import { expect, it } from 'vitest';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { SemanticSnapshotReceiver } from '../../runtime/src/adapters/snapshot/receiver.js';
import { createViewOwnedTools } from '../../runtime/src/core/tool/view-owned-tools.js';
import { compileOrdinaryParams } from '../../runtime/src/core/tool/ordinary-parameter-contract.js';
import type { AppDiscoveryInfo, IDesktop, IKernel } from '../../runtime/src/spi/runtime/kernel.interface.js';
import type { ExecutionBinding, InvocationContext, InvocationSource, AppInteractionPolicy } from '@aotui/runtime/core';
import type { ViewToolInvocationTerminal } from '../../runtime/src/core/tool/invocation-terminal.js';
import type { AppTypeToolDefinition } from '../../runtime/src/spi/runtime/app-type-tools.interface.js';
import type { SnapshotCore } from '../../runtime/src/core/snapshot/types.js';

type ReceiverCoreInspection = { core: SnapshotCore };

function inspectCore(receiver: SemanticSnapshotReceiver) {
    return (receiver as unknown as ReceiverCoreInspection).core.store.inspect();
}

function createApp(appId: string, name: string, instanceId: string, viewType: string, body: string, viewName = 'Workspace') {
    const registry = createViewOwnedTools(appId, instanceId);
    const input = compileOrdinaryParams({ value: { type: 'string', required: true } }, { additionalProperties: false });
    if (!input.ok) throw new Error('The real registry fixture requires a valid ordinary Tool contract.');

    const invoked: string[] = [];
    let view = registry.mount('workspace', viewType);
    let releaseTypeTool: () => void;
    const register = (type: string) => {
        const definition: AppTypeToolDefinition = { viewType: type, name: 'run', description: 'Run the current App Tool.',
            inputSchema: input.contract.schema };
        return registry.registerTypeTool(definition, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: contract => async args => {
                const checked = contract.validate(args);
                if (!checked.ok) return { phase: 'not-entered', result: { success: false,
                    error: { code: checked.code, message: 'Input did not match the registered Tool contract.' } } };
                const value = String(checked.value.value);
                invoked.push(value);
                return { phase: 'entered-returned', result: { success: true, data: { appId, value } } };
            },
        });
    };
    releaseTypeTool = register(viewType);

    const receiver = new SemanticSnapshotReceiver(appId, instanceId, () => 100);
    const binding: ExecutionBinding = {
        identity: {},
        mode: 'ordinary-v2',
        validateInput: (_source: InvocationSource, value: Readonly<Record<string, unknown>>) => {
            const checked = input.contract.validate(value);
            return checked.ok ? { ok: true, value: checked.value } : { ok: false };
        },
        isLive: source => registry.validateTypeToolBinding(source.tool, source.execution).success
            ? { ok: true } : { ok: false },
        execute: async (context: InvocationContext) => {
            const terminal: ViewToolInvocationTerminal = await registry.invokeTypeTool(
                context.source.tool, context.source.execution, context.effectiveInput);
            return { kind: 'tool-result', phase: terminal.phase, result: terminal.result };
        },
    };
    const execution = {
        resolve: (source: InvocationSource) => registry.listTools().some(tool => tool.id === source.tool.id) ? binding : null,
    };

    let sequence = 0;
    const publish = (nextBody = body) => {
        sequence++;
        const views = registry.listViews().map(item => ({ id: item.viewId, viewInstanceId: item.viewInstanceId,
            type: item.viewType, name: viewName, kind: 'state' as const,
            content: { format: 'markdown-v1' as const, value: nextBody } }));
        const tools = Object.fromEntries(registry.listTools().map(tool => [tool.id, tool]));
        const accepted = receiver.acceptPrepared({ schemaVersion: 3, appId, instanceId, producerSeq: sequence,
            sourceEpoch: sequence, capturedAt: sequence, views, refs: {}, tools });
        if (accepted.status !== 'published' && accepted.status !== 'unchanged') {
            throw new Error(`The real Snapshot Receiver rejected ${appId}: ${accepted.issue.code}`);
        }
    };
    publish();

    return {
        app: { appId: appId as AppDiscoveryInfo['appId'], appInstanceId: instanceId, name, status: 'running' as const },
        registry, receiver, execution, invoked, view: () => view,
        repairViewType(type: string) {
            releaseTypeTool();
            registry.unmount(view.viewInstanceId);
            view = registry.mount('workspace', type);
            releaseTypeTool = register(type);
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
        // Core V3 accepts this identity. The stricter native alias rule belongs
        // to Semantic Source, which must isolate only this App at projection time.
        expect(bad.receiver.report()).toMatchObject({ health: 'ready', published: 1 });
        expect(bad.registry.listViews()[0]?.viewType).toBe('A-B');
        expect(bad.registry.listTools()[0]?.viewType).toBe('A-B');
        expect(JSON.stringify(bad.receiver.report())).not.toContain('AOTUI_TOOL_NAME_INVALID');

        const first = await source.getContext();
        contexts.push(first);
        await first.adopt!();
        expect(first.tools['bad_app-A-B-run']).toBeUndefined();
        expect(first.tools['shared_app-Workspace-run']).toBeDefined();
        expect(first.tools['healthy_app-Workspace-run']).toBeDefined();
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

        expect(await first.executeTool!('shared_app-Workspace-run', { value: 'winner' }, 'collision-winner'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { appId: 'collision_a', value: 'winner' } });
        expect(await first.executeTool!('healthy_app-Workspace-run', { value: 'usable' }, 'healthy-call'))
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
            expect(inspectCore(assembly.receiver).activeLeases).toBe(0);
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
        expect(await recovered.executeTool!('bad_app-Workspace-run', { value: 'recovered' }, 'bad-recovered'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { appId: 'bad_app', value: 'recovered' } });
        expect(bad.invoked).toEqual(['recovered']);

        await recovered.release!();
        source.dispose();
        for (const assembly of assemblies) {
            await assembly.receiver.close();
            assembly.registry.dispose();
            expect(assembly.receiver.getInteractionStats()).toMatchObject({ closed: true, combinedBytes: 0,
                observations: { observations: 0, reservations: 0, totalBytes: 0 } });
            expect(inspectCore(assembly.receiver)).toMatchObject({
                state: 'disposed', appRecords: 0, activeLeases: 0, currentBytes: 0,
            });
            expect(assembly.registry.inspect()).toMatchObject({ state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
        }
    } finally {
        for (const context of contexts) await context.release?.();
        source.dispose();
        for (const assembly of assemblies) {
            await assembly.receiver.close();
            assembly.registry.dispose();
        }
    }
});
