import { describe, expect, it, vi } from 'vitest';
import { compileToolParameters } from '../core/tool/tool-parameters.js';
import { invokeViewTool } from './tool-invocation.js';
function fixture() {
    const c = compileToolParameters({ type: 'object', properties: { file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: true });if (!c.ok) throw Error('fixture');
    
    const receiver = { viewId: 'v', viewInstanceId: 'mount', activationId: 'active-1' };
    const input = { type: 'VIEW_TOOL_INVOKE', requestId: 'r', appId: 'app', instanceId: 'run', snapshotId: 'source', receiver,
        tool: { id: JSON.stringify(['app', 'File', 'read']), name: 'read', description: 'Read', viewType: 'File', inputSchema: c.contract.schema },
        rawArgs: { file: 'v.id' }, effectiveArgs: { file: {} }, refSources: [{ param: 'file', refId: 'id', kind: 'snapshot-value', refType: 'unknown', snapshotId: 'source', viewId: 'v', viewInstanceId: 'mount' }] };
    const events: string[] = [], context = { appId: 'app', instanceId: 'run', toolsEnabled: true,
        validateBinding: vi.fn((tool: any) => { expect(tool.inputSchema).toEqual(input.tool.inputSchema);events.push('live');return { success: true }; }),
        getParameterContract: () => c.contract,
            isRefViewLive: () => true,
        invokeBinding: vi.fn(() => { events.push('entry');return { phase: 'entered-returned' as const, result: { success: true } }; }) };
    return { input, context, events };
}
describe('Worker qualification for Ref Tools', () => {
    it('checks original full identity, both argument stages and private qualification before synchronous entry', async () => {
        const f = fixture();f.context.validateBinding.mockImplementation(tool => { expect(tool.inputSchema).toEqual(f.input.tool.inputSchema);f.events.push('private');queueMicrotask(() => f.events.push('microtask'));return { success: true }; });
        const promise = invokeViewTool(f.input, f.context);expect(f.events).toEqual(['private', 'entry']);
        expect((await promise)?.terminal.phase).toBe('entered-returned');expect(f.events).toEqual(['private', 'entry', 'microtask']);
    });
    it.each(['read-only', 'instance', 'source', 'private', 'legacy-wire'])('rejects %s before callable entry', async kind => {
        const f = fixture();if (kind === 'read-only') f.context.toolsEnabled = false;if (kind === 'instance') f.context.instanceId = 'other';
        if (kind === 'source') f.input.refSources[0]!.snapshotId = 'other';if (kind === 'legacy-wire') f.input.type = 'VIEW_TOOL_INVOKE_V3';
        if (kind === 'private') f.context.validateBinding.mockReturnValue({ success: false, error: { code: 'BINDING_PRIVATE', message: 'Binding is not public' } });
        const r = await invokeViewTool(f.input, f.context);expect(r?.terminal.phase).toBe('not-entered');expect(f.context.invokeBinding).not.toHaveBeenCalled();
    });
    it('cannot prove non-entry after a callable throws', async () => {
        const f = fixture();f.context.invokeBinding.mockImplementation(() => { throw Error('PRIVATE'); });
        const response = await invokeViewTool(f.input, f.context);
        expect(response).toEqual({
            type: 'VIEW_TOOL_INVOKE_RESPONSE', requestId: f.input.requestId,
            appId: f.input.appId, instanceId: f.input.instanceId,
            success: true,
            terminal: { phase: 'finished-unknown' },
        });
        expect(f.context.invokeBinding).toHaveBeenCalledOnce();
    });
});
