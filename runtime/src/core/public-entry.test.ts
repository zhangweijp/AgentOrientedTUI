import { expect, expectTypeOf, it } from 'vitest';
import * as core from './index.js';
import * as memory from '../adapters/storage/memory-state-storage.js';
import type { ViewToolInvocationTerminal as OldTerminal, RefV1Terminal as OldRef } from '../spi/worker-protocol/messages.js';
import type { SafeRefInvoker as OldSafeRef, SafeOrdinaryInvoker as OldSafeOrdinary,
    SafeCreateIfAbsentInvoker as OldSafeCreate } from '../spi/runtime/view-owned-tools.interface.js';

it('C12 exports precisely the frozen Core values and separate Memory constructor', () => {
    expect(Object.keys(core).sort()).toEqual(['createSnapshotCore', 'refKey', 'createViewOwnedTools',
        'ViewToolContractError', 'createScopedInteraction', 'createStateSession', 'compileOrdinaryParams',
        'compileOrdinarySchema', 'ordinaryParameterProfile', 'compileOrdinaryProfile', 'compileSnapshotValueParams',
        'compileSnapshotValueProfile', 'createIfAbsentSchema', 'isCreateIfAbsentSchema', 'matchesCreateIfAbsentInput'].sort());
    expect(Object.keys(memory)).toEqual(['createMemoryStateStorage']);
});

it('C13 preserves all five old type identities, mutable terminal branches and Promise-only callables', () => {
    expectTypeOf<OldTerminal>().toEqualTypeOf<core.ViewToolInvocationTerminal>();
    expectTypeOf<OldRef>().toEqualTypeOf<core.RefV1Terminal>();
    expectTypeOf<OldSafeRef>().toEqualTypeOf<core.SafeRefInvoker>();
    expectTypeOf<OldSafeOrdinary>().toEqualTypeOf<core.SafeOrdinaryInvoker>();
    expectTypeOf<OldSafeCreate>().toEqualTypeOf<core.SafeCreateIfAbsentInvoker>();
    expectTypeOf<ReturnType<core.SafeRefInvoker>>().toEqualTypeOf<Promise<core.RefV1Terminal>>();
    expectTypeOf<ReturnType<core.SafeCreateIfAbsentInvoker>>().toEqualTypeOf<Promise<core.CreateIfAbsentTerminal>>();
    expectTypeOf<core.ViewOwnedTools>().toEqualTypeOf<ReturnType<typeof core.createViewOwnedTools>>();
    expectTypeOf<core.StateSession>().toEqualTypeOf<ReturnType<typeof core.createStateSession>>();
    const result: core.ViewToolInvocationTerminal = { phase: 'not-entered', result: { success: true } };
    result.phase = 'entered-returned'; result.result = { success: false };
    expect(result).toEqual({ phase: 'entered-returned', result: { success: false } });
});

it('C18 runs actual Core, Registry and Scoped dispatch through the explicit entry', async () => {
    const registry = core.createViewOwnedTools('app', 'instance'), view = registry.mount('v', 'Detail');
    let calls = 0;
    registry.registerTool(view.viewInstanceId, { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} }, isMutating: false },
        () => { calls++; return { success: true, data: { value: 19 } }; });
    const tool = registry.listTools()[0], snapshots = core.createSnapshotCore({ now: () => 0 });
    snapshots.lifecycle.startApp('app', 'instance');
    expect(snapshots.committer.accept({ schemaVersion: 2, appId: 'app', instanceId: 'instance', producerSeq: 1, sourceEpoch: 1, capturedAt: 0,
        views: [{ id: 'v', viewInstanceId: view.viewInstanceId, type: 'Detail', name: 'Detail', kind: 'state', content: { format: 'markdown-v1', value: 'state' } }],
        refs: {}, tools: { [tool.id]: { id: tool.id, name: tool.name, description: tool.description, viewType: tool.viewType,
            inputSchema: tool.inputSchema, isMutating: tool.isMutating, targets: tool.targets } } }).status).toBe('published');
    const binding: core.ExecutionBinding = { identity: {}, mode: 'ordinary', validateInput: (_source, input) => ({ ok: true, value: input }),
        isLive: source => ({ ok: registry.validate(tool, source.target).success }), execute: async context => {
            const result = await registry.invoke(tool, context.source.target, context.effectiveInput);
            if (!result.success || result.data?.value !== 19) throw Error('Unexpected business result');
            return { kind: 'action', phase: 'entered-returned', outcome: { status: 'succeeded', value: 19 } };
        } };
    const authority = core.createScopedInteraction(snapshots.store, { namespace: 'public:instance', now: () => 0 });
    const opened = authority.createScope({ appId: 'app', instanceId: 'instance', policy: {
        project: () => ({ views: [{ viewId: 'v', viewInstanceId: view.viewInstanceId }], refs: [], targets: [{ toolId: tool.id, target: tool.targets[0] }], content: [] }),
        authorize: () => true, canReadReceipt: () => true }, execution: { resolve: () => binding } });
    expect(opened.status).toBe('opened'); if (opened.status !== 'opened') throw Error();
    const observed = await opened.client.observe({ viewIds: ['v'] }); expect(observed.status).toBe('observed'); if (observed.status !== 'observed') throw Error();
    expect(await opened.client.invoke({ invocationId: 'call', observationId: observed.observation.observationId,
        bindingId: observed.observation.bindings[0].bindingId, input: {} })).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded', value: 19 } } });
    expect(calls).toBe(1); authority.close(); registry.dispose(); snapshots.lifecycle.dispose();
});
