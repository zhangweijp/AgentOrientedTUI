import { expect, expectTypeOf, it } from 'vitest';
import * as core from './index.js';
import * as producer from './producer.js';
import * as host from './host.js';
// @ts-expect-error AppSnapshot is the only supported committed snapshot name.
import type { AppSnapshotV4 } from './index.js';
// @ts-expect-error The V2 DTOs are also retired.
import type { AppSnapshotV2, ToolDescriptorV2, PreparedAppSnapshotDraftV2 } from './index.js';
// @ts-expect-error Failure envelope details are internal to snapshot validation.
import type { SnapshotDraftEnvelope } from './index.js';
// @ts-expect-error Snapshot health is represented by SnapshotRead.status.
import type { SnapshotHealth } from './index.js';
// @ts-expect-error Factory return types are inferred rather than exported as aliases.
import type { ViewOwnedTools } from './index.js';
// @ts-expect-error Ref is a parameter source, not a separate callable category.
import type { SafeRefInvoker } from './index.js';
// @ts-expect-error Console-specific input DTOs are removed from Core.
import type { ConsoleInputs, ConsoleInputPath } from './index.js';
// @ts-expect-error forwardRequestSource is removed from Core host entry.
import type { forwardRequestSource } from './host.js';

it('exports the portable thin root and two specialized sub-entries', () => {
    expect(Object.keys(core).sort()).toEqual([
        'AOTUIError', 'APP_LIFECYCLE_PROTOCOL', 'DEFAULT_PROJECTION_LIMITS', 'DEFAULT_SNAPSHOT_LIMITS',
        'MARKDOWN_VIEW_FORMAT', 'SNAPSHOT_SCHEMA_VERSION', 'SnapshotDataError',
        'VIEW_TYPE_TOOL_PROTOCOL', 'ViewMultiplicity', 'ViewRegion', 'canonicalJson', 'captureAppMetadata',
        'compileToolParameters', 'compileValueSchema', 'checkWireJson', 'copyWireJson', 'copyJson', 'createRefCapture',
        'hasViewTypeToolAuthoringProtocol', 'isInstanceName', 'isRefId', 'isTUIAppFactory',
        'isToolResultData', 'isViewTypeName', 'normalizeProjectionLimits', 'readAppFactory', 'refKey', 'utf8Size',
    ].sort());
    expect(Object.keys(producer).sort()).toEqual([
        'SemanticProjectionCoordinator', 'ViewToolContractError', 'captureSnapshotDraftEnvelope',
        'captureSnapshotPrepareIssue', 'commitAppFrame', 'createViewOwnedTools', 'viewToolReceiver', 'hostedObservationCapacityIssue',
        'checkRefViews', 'refPath', 'scopeAllows', 'TOOL_REQUEST_LIMITS', 'validatePreparedSnapshot',
    ].sort());
    expect(Object.keys(host).sort()).toEqual([
        'RAW_TOOL_ARGUMENT_LIMITS', 'REF_VALUE_LIMITS',
        'RESOLVED_TOOL_ARGUMENT_LIMITS', 'TOOL_REQUEST_LIMITS',
        'captureSnapshotDraftEnvelope', 'captureSnapshotPrepareIssue',
        'createAppInteraction', 'createSnapshotCore', 'createTurnCoordinator', 'encodeRefLiteral', 'formatRefPath',
        'hostedObservationCapacityIssue', 'hostedObservationNamespace',
        'normalizeProjectionLimits', 'parseRefAddress', 'prepareViewTypeParameters', 'previewCommittedApp',
        'projectCompleteViews', 'REF_ADDRESS_PREFIX', 'refPath', 'refConsumerAllowed', 'scopeAllows',
        'snapshotId', 'viewToolReceiver',
    ].sort());
});

it('keeps the mutable terminal result contract', () => {
    const failure = { success: false as const, error: { code: 'TOOL_UNAVAILABLE', message: 'Unavailable' } };
    const result: core.ViewToolInvocationTerminal = { phase: 'not-entered', result: failure };
    const entered: core.ViewToolInvocationTerminal = { phase: 'entered-returned', result: { success: true } };
    entered.result = failure;
    expect(result).toEqual({ phase: 'not-entered', result: failure });
    expect(entered).toEqual({ phase: 'entered-returned', result: failure });
});

it('exports the execution port and MOD-01/MOD-02 contracts used by the current observation', () => {
    expectTypeOf<keyof core.ExecutionBinding>().toEqualTypeOf<'identity' | 'isLive' | 'execute'>();
    expectTypeOf<core.ObservationWindowSelection>().toEqualTypeOf<{ readonly activeViews: readonly core.ViewIdentity[] }>();
    expectTypeOf<core.PublicRefValue>().toEqualTypeOf<{
        readonly appId: string;
        readonly viewId: string;
        readonly refId: string;
        readonly path: core.RefPath;
        readonly value: core.JsonValue;
    }>();
    expectTypeOf<core.ReadPublicRefsResult>().toEqualTypeOf<
        Readonly<{ status: 'ready'; refs: readonly core.PublicRefValue[] }> |
        Readonly<{ status: 'rejected'; issue: core.InteractionIssue }>
    >();
});

it('C18 runs actual Core, Registry and instance dispatch through the explicit entries', async () => {
    const registry = producer.createViewOwnedTools('app', 'instance');
    const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
    let calls = 0;
    const execute = async () => { calls++; return { success: true, data: { value: 19 } }; };
    registry.defineViewTypes([{ name: "Detail", multiplicity: 'multiple', tools: [{ name: 'read', description: 'Read', inputSchema }] }]);
    const frame = registry.prepareFrame([{ idPrefix: 'v', type: 'Detail', owner: {}, bindings: [{ name: 'read', enabled: true, execute }] }]);
    frame.accept();
    const tool = frame.tools[0]!, view = frame.instances[0]!;
    const snapshots = host.createSnapshotCore({ appId: 'app', instanceId: 'instance', now: () => 0 });
    expect(snapshots.committer.accept({ schemaVersion: 8, appId: 'app', instanceId: 'instance', producerSeq: 1, sourceEpoch: 1, capturedAt: 0,
        views: [{ toolBindings: view.toolBindings, id: view.viewId, viewInstanceId: view.viewInstanceId, type: 'Detail', name: 'Detail', region: 'dynamic', content: { format: 'markdown-v1', value: 'state' } }],
        refs: {}, tools: { [tool.id]: tool } }).status).toBe('published');
    const binding: core.ExecutionBinding = { identity: {},
        isLive: source => registry.validateTypeToolBinding(tool, source.receiver).success, execute: async context => {
            const terminal = await registry.invokeTypeTool(tool, context.source.receiver, context.effectiveInput);
            if (terminal.phase !== 'entered-returned' || !terminal.result.success || terminal.result.data?.value !== 19) throw Error('Unexpected business result');
            return { kind: 'tool-result', phase: 'entered-returned', result: { success: true, data: { value: 19 } } };
        } };
    const interaction = host.createAppInteraction(snapshots.store, { namespace: 'public:instance', now: () => 0, appId: 'app', instanceId: 'instance', policy: {
        project: () => ({ refs: [], toolIds: [tool.id] }),
        authorize: () => true, canReadReceipt: () => true }, execution: { resolve: () => binding } });
    const observed = await interaction.observe(); expect(observed.status).toBe('observed'); if (observed.status !== 'observed') throw Error();
    expect(interaction.adoptObservation(observed.observation.observationId)).toEqual({ status: 'adopted' });
    const request = { invocationId: 'call', observationId: observed.observation.observationId,
        toolId: observed.observation.tools[0]!.id, viewId: view.viewId, input: {  } };
    const result = await interaction.invoke(request);
    expect(result).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: { success: true, data: { value: 19 } } } } });
    interaction.releaseObservation(observed.observation.observationId);
    const query: core.ReceiptQuery = { observationId: request.observationId, invocationId: request.invocationId };
    expect(await interaction.readReceipt(query)).toEqual(result);
    expect(await interaction.readReceipt('call' as unknown as core.ReceiptQuery)).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_INVALID' });
    expect(interaction).not.toHaveProperty('sweepExpired');
    expect(calls).toBe(1); interaction.close(); registry.dispose(); snapshots.lifecycle.dispose();
});
