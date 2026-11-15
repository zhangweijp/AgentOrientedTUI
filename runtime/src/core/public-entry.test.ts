import { expect, expectTypeOf, it } from 'vitest';
import * as core from './index.js';
import * as memory from '../adapters/storage/memory-state-storage.js';
// @ts-expect-error AppSnapshotV3 is the only public AppSnapshot name.
import type { AppSnapshot } from './index.js';
// @ts-expect-error V3 is the only supported committed snapshot contract.
import type { AppSnapshotV2, ToolDescriptorV2, PreparedAppSnapshotDraftV2 } from './index.js';
// @ts-expect-error Failure envelope details are internal to snapshot validation.
import type { SnapshotDraftEnvelope } from './index.js';
// @ts-expect-error Snapshot health is represented by SnapshotRead.status.
import type { SnapshotHealth } from './index.js';
// @ts-expect-error Factory return types are inferred rather than exported as aliases.
import type { ViewOwnedTools } from './index.js';
// @ts-expect-error Factory return types are inferred rather than exported as aliases.
import type { StateSession } from './index.js';
import type { ViewToolInvocationTerminal as ProtocolTerminal } from '../spi/worker-protocol/messages.js';
import type { SafeOrdinaryInvoker as ProtocolSafeOrdinary } from './tool/invocation-terminal.js';
// @ts-expect-error Ref is a parameter source, not a separate callable category.
import type { SafeRefInvoker } from './index.js';

it('C12 exports precisely the frozen Core values and separate Memory constructor', () => {
    expect(Object.keys(core).sort()).toEqual(['ORDINARY_INVOKER_ABI_V4', 'MARKDOWN_VIEW_FORMAT', 'SNAPSHOT_SCHEMA_VERSION', 'VIEW_TYPE_PARAMETERS_MODE', 'createSnapshotCore', 'refKey', 'createViewOwnedTools',
        'ViewToolContractError', 'SnapshotDataError', 'SemanticProjectionCoordinator', 'createAppInteraction', 'createStateSession',
        'compileOrdinarySchema', 'compileValueSchema', 'modelToolSchema', 'ordinaryParameterProfile', 'compileOrdinaryProfile'].sort());
    expect(Object.keys(memory)).toEqual(['createMemoryStateStorage']);
});

it('C13 keeps the shared terminal identity, mutable terminal data and Promise-only invokers', () => {
    expectTypeOf<ProtocolTerminal>().toEqualTypeOf<core.ViewToolInvocationTerminal>();
    expectTypeOf<ProtocolSafeOrdinary>().toEqualTypeOf<core.SafeOrdinaryInvoker>();
    expectTypeOf<ReturnType<core.SafeOrdinaryInvoker>>().toEqualTypeOf<Promise<core.ViewToolInvocationTerminal>>();
    const failure = { success: false as const, error: { code: 'TOOL_UNAVAILABLE', message: 'Unavailable' } };
    const result: core.ViewToolInvocationTerminal = { phase: 'not-entered', result: failure };
    const entered: core.ViewToolInvocationTerminal = { phase: 'entered-returned', result: { success: true } };
    entered.result = failure;
    expect(result).toEqual({ phase: 'not-entered', result: failure });
    expect(entered).toEqual({ phase: 'entered-returned', result: failure });
});

it('C18 runs actual Core, Registry and instance dispatch through the explicit entry', async () => {
    const registry = core.createViewOwnedTools('app', 'instance'), view = registry.mount('v', 'Detail');
    const contract = core.compileOrdinarySchema({ type: 'object', properties: {}, additionalProperties: false });
    if (!contract.ok) throw Error('Fixture ViewType contract');
    let calls = 0;
    const handler = async (_args: Record<string, unknown>) => { calls++; return { success: true, data: { value: 19 } }; };
    registry.registerTypeTool({ viewType: 'Detail', name: 'read', description: 'Read', inputSchema: contract.contract.schema }, {
        safeOrdinaryParametersInvocationMode: 'ordinary-invoker/v4',
        createSafeOrdinaryParametersInvoker: () => async args => ({ phase: 'entered-returned', result: await handler(args) }),
    });
    const tool = registry.listTools()[0], snapshots = core.createSnapshotCore({ now: () => 0 });
    if (tool.execution.kind !== 'view-type') throw Error('Expected a type Tool');
    snapshots.lifecycle.startApp('app', 'instance');
    expect(snapshots.committer.accept({ schemaVersion: 3, appId: 'app', instanceId: 'instance', producerSeq: 1, sourceEpoch: 1, capturedAt: 0,
        views: [{ id: 'v', viewInstanceId: view.viewInstanceId, type: 'Detail', name: 'Detail', kind: 'state', content: { format: 'markdown-v1', value: 'state' } }],
        refs: {}, tools: { [tool.id]: tool } }).status).toBe('published');
    const binding: core.ExecutionBinding = { identity: {}, validateInput: (_source, input) => ({ ok: true, value: input }),
        isLive: source => ({ ok: registry.validateTypeToolBinding(tool, source.execution).success }), execute: async context => {
            const terminal = await registry.invokeTypeTool(tool, context.source.execution, context.effectiveInput);
            if (terminal.phase !== 'entered-returned' || !terminal.result.success || terminal.result.data?.value !== 19) throw Error('Unexpected business result');
            return { kind: 'tool-result', phase: 'entered-returned', result: { success: true, data: { value: 19 } } };
        } };
    const interaction = core.createAppInteraction(snapshots.store, { namespace: 'public:instance', now: () => 0, appId: 'app', instanceId: 'instance', policy: {
        project: () => ({ views: [{ viewId: 'v', viewInstanceId: view.viewInstanceId }], refs: [],
            toolBindings: [{ toolId: tool.id, execution: { kind: 'view-type', activationId: tool.execution.activationId } }], content: [] }),
        authorize: () => true, canReadReceipt: () => true }, execution: { resolve: () => binding } });
    const observed = await interaction.observe({ viewIds: ['v'] }); expect(observed.status).toBe('observed'); if (observed.status !== 'observed') throw Error();
    expect(interaction.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
    const request = { invocationId: 'call', observationId: observed.observation.observationId,
        bindingId: observed.observation.bindings[0].bindingId, input: {} };
    const result = await interaction.invoke(request);
    expect(result).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { success: true, data: { value: 19 } } } } });
    interaction.releaseObservation(observed.observation.observationId);
    const query: core.ReceiptQuery = { observationId: request.observationId, invocationId: request.invocationId };
    expect(await interaction.readReceipt(query)).toEqual(result);
    expect(await interaction.readReceipt('call' as unknown as core.ReceiptQuery)).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_INVALID' });
    expect(interaction).not.toHaveProperty('sweepExpired');
    expect(calls).toBe(1); interaction.close(); registry.dispose(); snapshots.lifecycle.dispose();
});
