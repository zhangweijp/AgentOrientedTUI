import { describe, expect, it, vi } from 'vitest';
import { compileToolParameters } from '@aotui/core';
import { invokeViewTool } from './tool-invocation.js';
import { snapshotId } from '@aotui/core/internal';
function fixture() {
    const c = compileToolParameters({ type: 'object', properties: { file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: true });if (!c.ok) throw Error('fixture');
    
    const receiver = { viewId: 'v', viewInstanceId: 'mount', activationId: 'active-1' };
    const input = { type: 'VIEW_TOOL_INVOKE', requestId: 'r', appId: 'app', instanceId: 'run', snapshotId: 'source', observationId: 'obs', receiver,
        tool: { multiplicity: 'multiple', id: JSON.stringify(['app', 'File', 'read']), name: 'read', description: 'Read', viewType: 'File', inputSchema: c.contract.schema },
        rawArgs: { file: '$app.v.id' }, refSources: [{ param: 'file', address: '$app.v.id', refId: 'id', path: [] as (number | string)[], kind: 'snapshot-value',
            scope: 'private', refType: 'unknown', appId: 'app', instanceId: 'run', snapshotId: 'source', observationId: 'obs',
            viewId: 'v', viewInstanceId: 'mount', consumerInstanceId: 'run', consumerObservationId: 'obs',
            consumerViewInstanceId: 'mount', consumerActivationId: 'active-1', value: {} }] };
    const events: string[] = [], context = { appId: 'app', instanceId: 'run', toolsEnabled: true,
        validateBinding: vi.fn((tool: any) => { expect(tool.inputSchema).toEqual(input.tool.inputSchema);events.push('live');return { success: true }; }),
        getParameterContract: () => c.contract,
        isRefViewLive: () => true,
        refScope: () => 'private' as const,
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

describe('Worker qualification for an external origin', () => {
    function external(revision = 9) {
        const f = fixture();
        const address = '$contacts.list.emails[1]';
        f.input.rawArgs.file = address;
        const record = { ...f.input.refSources[0]!, address, refId: 'emails', path: [1] as (number | string)[], arrayElement: true, scope: 'public',
            viewId: 'list', viewInstanceId: 'vi:v1:["contacts-run",1]', appId: 'contacts', instanceId: 'contacts-run',
            snapshotId: snapshotId('contacts', 'contacts-run', revision), observationId: 'host:contacts-run:observation:13' };
        f.input.refSources = [record];
        return { ...f, record };
    }

    it('reconstructs an external Ref using its own snapshot and never consults the local View registry for it', async () => {
        const f = external();
        const local = vi.fn(() => false);
        const response = await invokeViewTool(f.input, { ...f.context, isRefViewLive: local });
        expect(response?.terminal.phase).toBe('entered-returned');
        expect(f.context.invokeBinding).toHaveBeenCalledExactlyOnceWith(f.input.tool, f.input.receiver, { file: {} });
        expect(local).not.toHaveBeenCalled();
    });

    it.each([
        ['omitted', (_, records) => records.pop()],
        ['extra', (record, records) => records.push(record)],
        ['wrong array slot', record => Object.assign(record, { index: 0 })],
        ['wrong named slot', record => { record.param = 'other'; }],
        ['wrong selected element', record => { record.path = [0]; }],
        ['wrong segment kind', record => { record.path = ['1']; }],
        ['extra path segment', record => { record.path.push('email'); }],
        ['omitted path segment', record => { record.path.pop(); }],
        ['mixed snapshot owner', record => { record.snapshotId = snapshotId('another', 'contacts-run', 2); }],
        ['mixed observation owner', record => { record.observationId = 'host:another-run:observation:13'; }],
        ['mixed View owner', record => { record.viewInstanceId = 'vi:v1:["another-run",1]'; }],
        ['target observation mismatch', record => { record.consumerObservationId = 'obs-new'; }],
        ['target instance mismatch', record => { record.consumerInstanceId = 'run-new'; }],
        ['scope mismatch', record => { record.scope = 'protected'; }],
    ] satisfies [string, (record: ReturnType<typeof external>['record'], records: ReturnType<typeof external>['input']['refSources']) => unknown][])(
        'rejects %s before handler entry', async (_, modify) => {
            const f = external();
            modify(f.record, f.input.refSources);
            const response = await invokeViewTool(f.input, f.context);
            expect(response?.terminal).toMatchObject({ phase: 'not-entered', result: { success: false, error: { code: 'E_INVALID_ARGS' } } });
            expect(f.context.invokeBinding).not.toHaveBeenCalled();
        });

    it('rejects mixing separately plausible original observations from the same App across two slots', async () => {
        const f = external();
        const c = compileToolParameters({ type: 'object', properties: { file: { type: 'array', items: { type: 'string' } } },
            required: ['file'], additionalProperties: false });
        if (!c.ok) throw Error('fixture');
        const input = { ...f.input, tool: { ...f.input.tool, inputSchema: c.contract.schema },
            rawArgs: { file: [f.record.address, 'literal', f.record.address] },
            refSources: [{ ...f.record, index: 0, value: 'email' }, { ...f.record, index: 2, value: 'email',
                snapshotId: snapshotId('contacts', 'contacts-run', 10), observationId: 'host:contacts-run:observation:14' }] };
        const context = { ...f.context, validateBinding: () => ({ success: true }), getParameterContract: () => c.contract };
        const response = await invokeViewTool(input, context);
        expect(response?.terminal).toMatchObject({ phase: 'not-entered', result: { success: false, error: { code: 'E_INVALID_ARGS' } } });
        expect(f.context.invokeBinding).not.toHaveBeenCalled();
        input.refSources[1] = { ...input.refSources[0]!, index: 2 };
        expect((await invokeViewTool(input, context))?.terminal.phase).toBe('entered-returned');
        expect(f.context.invokeBinding.mock.calls[0]?.[2]).toEqual({ file: ['email', 'literal', 'email'] });
    });
});
