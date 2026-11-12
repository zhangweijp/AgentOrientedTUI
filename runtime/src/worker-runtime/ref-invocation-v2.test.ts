import { describe, expect, it, vi } from 'vitest';
import { compileOrdinarySchema } from '../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../core/tool/ordinary-parameter-profile.js';
import { invokeTypeParameters } from './ordinary-invocation-v2.js';
function fixture() {
    const c = compileOrdinarySchema({ type: 'object', properties: { file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: true }, 'view-type-parameters-v1');if (!c.ok) throw Error('fixture');
    
    const execution = { kind: 'view-type' as const, activationId: 'active-1' };
    const input = { type: 'VIEW_TOOL_INVOKE_V4', requestId: 'r', appId: 'app', instanceId: 'run', snapshotId: 'source', argumentMode: 'view-type-parameters-v1', execution,
        tool: { id: JSON.stringify(['app', 'File', 'read']), name: 'read', description: 'Read', viewType: 'File', inputSchema: ordinaryParameterProfile(c.contract), 
            execution },
        rawArgs: { file: 'v.id' }, effectiveArgs: { file: {} }, refSources: [{ param: 'file', refId: 'id', kind: 'snapshot-value', refType: 'unknown', snapshotId: 'source', viewId: 'v', viewInstanceId: 'mount' }] };
    const events: string[] = [], context = { appId: 'app', instanceId: 'run', negotiated: true,
        validateBinding: vi.fn((tool: any) => { expect(tool.inputSchema).toHaveProperty('x-aotui-parameter-contract', 'view-type-parameters-v1');events.push('live');return { success: true }; }),
        getParameterContract: () => c.contract,
            isRefViewLive: () => true,
        invokeBinding: vi.fn(() => { events.push('entry');return { phase: 'entered-returned' as const, result: { success: true } }; }) };
    return { input, context, events };
}
describe('R03/R04/R15 Ref V4 Worker final qualification', () => {
    it('checks original full identity, both argument stages and private qualification before synchronous entry', async () => {
        const f = fixture();f.context.validateBinding.mockImplementation(tool => { expect(tool.inputSchema['x-aotui-parameter-contract']).toBe('view-type-parameters-v1');f.events.push('private');queueMicrotask(() => f.events.push('microtask'));return { success: true }; });
        const promise = invokeTypeParameters(f.input, f.context);expect(f.events).toEqual(['private', 'entry']);
        expect((await promise)?.terminal.phase).toBe('entered-returned');expect(f.events).toEqual(['private', 'entry', 'microtask']);
    });
    it.each(['capability', 'instance', 'source', 'private', 'legacy-wire'])('rejects %s before callable entry', async kind => {
        const f = fixture();if (kind === 'capability') f.context.negotiated = false;if (kind === 'instance') f.context.instanceId = 'other';
        if (kind === 'source') f.input.refSources[0]!.snapshotId = 'other';if (kind === 'legacy-wire') f.input.type = 'VIEW_TOOL_INVOKE_V3';
        if (kind === 'private') f.context.validateBinding.mockReturnValue({ success: false, error: { code: 'BINDING_PRIVATE', message: 'Binding is not public' } });
        const r = await invokeTypeParameters(f.input, f.context);expect(r?.terminal.phase).toBe('not-entered');expect(f.context.invokeBinding).not.toHaveBeenCalled();
    });
    it('cannot prove non-entry after a callable throws', async () => {
        const f = fixture();f.context.invokeBinding.mockImplementation(() => { throw Error('PRIVATE'); });
        const response = await invokeTypeParameters(f.input, f.context);
        expect(response).toEqual({
            type: 'VIEW_TOOL_INVOKE_V4_RESPONSE', requestId: f.input.requestId,
            appId: f.input.appId, instanceId: f.input.instanceId,
            argumentMode: f.input.argumentMode, success: true,
            terminal: { phase: 'finished-unknown' },
        });
        expect(f.context.invokeBinding).toHaveBeenCalledOnce();
    });
});
