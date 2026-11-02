import { describe, expect, it, vi } from 'vitest';
import { compileSnapshotValueParams } from '../core/tool/snapshot-value-parameter-contract.js';
import { invokeRefInvocationV2 } from './ref-invocation-v2.js';
function fixture() {
    const c = compileSnapshotValueParams({ file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } });if (!c.ok) throw Error('fixture');
    const target = { viewId: 'v', viewInstanceId: 'mount', bindingVersion: 1 };
    const input = { type: 'VIEW_TOOL_INVOKE_REF_V2', requestId: 'r', appId: 'app', instanceId: 'run', snapshotId: 'source', argumentMode: 'snapshot-value-v2',
        tool: { id: JSON.stringify(['app', 'File', 'read']), name: 'read', description: 'Read', viewType: 'File', inputSchema: c.contract.schema, isMutating: false, targets: [target] }, target,
        rawArgs: { file: 'id' }, effectiveArgs: { file: {} }, refSources: [{ param: 'file', refId: 'id', kind: 'snapshot-value', refType: 'unknown', snapshotId: 'source', viewId: 'v', viewInstanceId: 'mount' }] };
    const events: string[] = [], context = { appId: 'app', instanceId: 'run', negotiated: true,
        validateBinding: vi.fn((tool: any) => { expect(tool.inputSchema).toHaveProperty('x-aotui-parameter-contract', 'snapshot-value-params-v1');events.push('live');return { success: true }; }),
        validateWrapper: vi.fn((tool: any) => { expect(tool.inputSchema).toHaveProperty('x-aotui-parameter-contract', 'snapshot-value-params-v1');events.push('private');return { success: true }; }),
        invokeBinding: vi.fn(() => { events.push('entry');return { phase: 'entered-returned' as const, result: { success: true } }; }) };
    return { input, context, events };
}
describe('R03/R04/R15 Ref V2 Worker final qualification', () => {
    it('checks original full identity, both argument stages and private qualification before synchronous entry', async () => {
        const f = fixture();f.context.validateWrapper.mockImplementation(tool => { expect(tool.inputSchema['x-aotui-parameter-contract']).toBe('snapshot-value-params-v1');f.events.push('private');queueMicrotask(() => f.events.push('microtask'));return { success: true }; });
        const promise = invokeRefInvocationV2(f.input, f.context);expect(f.events).toEqual(['live', 'private', 'entry']);
        expect((await promise)?.terminal.phase).toBe('entered-returned');expect(f.events).toEqual(['live', 'private', 'entry', 'microtask']);
    });
    it.each(['capability', 'instance', 'source', 'private', 'mutating'])('rejects %s before callable entry', async kind => {
        const f = fixture();if (kind === 'capability') f.context.negotiated = false;if (kind === 'instance') f.context.instanceId = 'other';
        if (kind === 'source') f.input.refSources[0]!.snapshotId = 'other';if (kind === 'mutating') f.input.tool.isMutating = true;
        if (kind === 'private') f.context.validateWrapper.mockReturnValue({ success: false });
        const r = await invokeRefInvocationV2(f.input, f.context);expect(r?.terminal.phase).toBe('not-entered');expect(f.context.invokeBinding).not.toHaveBeenCalled();
    });
    it('cannot prove non-entry after a callable throws', async () => {
        const f = fixture();f.context.invokeBinding.mockImplementation(() => { throw Error('PRIVATE'); });
        expect(await invokeRefInvocationV2(f.input, f.context)).toBe(null);expect(f.context.invokeBinding).toHaveBeenCalledOnce();
    });
});
