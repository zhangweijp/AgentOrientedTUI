import { describe, expect, it, vi } from 'vitest';
import { createViewOwnedTools } from '../core/tool/view-owned-tools.js';
import { invokeRefInvocationV1 } from './ref-invocation-v1.js';

function fixture(safe = true) {
    const registry = createViewOwnedTools('app', 'i'); const view = registry.mount('v', 'File');
    const handler = vi.fn(() => ({ success: true }));
    registry.registerTool(view.viewInstanceId, { name: 'read', description: 'Read', isMutating: false,
        inputSchema: { type: 'object', properties: { file: { type: 'string', 'x-aotui-ref': {
            version: 1, kind: 'snapshot-value', owner: 'tool-target' } } }, required: ['file'] } },
    handler, true, safe ? { safeRefInvocationMode: 'snapshot-value-v1' } : undefined,
    safe ? async args => ({ phase: 'entered-returned', result: await handler(args) }) : undefined);
    const { appId, appInstanceId, ...tool } = registry.listTools()[0]!;
    const message: any = { type: 'VIEW_TOOL_INVOKE_REF_V1', requestId: 'r', appId, instanceId: appInstanceId, snapshotId: 's',
        argumentMode: 'snapshot-value-v1', tool, target: tool.targets[0], rawArgs: { file: 'ref', other: { k: 1 } },
        effectiveArgs: { file: { value: 'old' }, other: { k: 1 } }, refSources: [{ param: 'file', refId: 'ref',
            kind: 'snapshot-value', refType: 'unknown', snapshotId: 's', viewId: 'v', viewInstanceId: view.viewInstanceId }] };
    const context = { appId, instanceId: appInstanceId, negotiated: true,
        validateBinding: vi.fn((t, target) => registry.validate({ ...t, appId, appInstanceId }, target)),
        validateWrapper: vi.fn((t, target) => registry.validateRefBinding({ ...t, appId, appInstanceId }, target)),
        invokeBinding: vi.fn((t, target, args) => registry.invokeRef({ ...t, appId, appInstanceId }, target, args)),
    };
    return { registry, view, handler, message, context };
}
describe('Worker Ref checks and current safe callable', () => {
    it('does not use a cached callable when the binding is revoked immediately after the adapter checks', async () => {
        const f = fixture(); f.context.validateWrapper.mockImplementation(() => {
            f.registry.setEnabled(f.view.viewInstanceId, 'read', false); return { success: true };
        });
        expect(await invokeRefInvocationV1(f.message, f.context)).toMatchObject({ terminal: { phase: 'not-entered', result: { error: { code: 'TOOL_UNAVAILABLE' } } } });
        expect(f.handler).not.toHaveBeenCalled();
    });
    it('keeps response identity from the captured request across an asynchronous business result', async () => {
        const f = fixture(); let release!: (value: any) => void;
        f.context.invokeBinding.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const pending = invokeRefInvocationV1(f.message, f.context);
        f.context.instanceId = 'replacement'; f.message.requestId = 'changed'; f.message.instanceId = 'replacement';
        release({ phase: 'entered-returned', result: { success: true } });
        expect(await pending).toMatchObject({ requestId: 'r', instanceId: 'i', terminal: { phase: 'entered-returned' } });
    });
    it.each(['throw', 'reject', 'undefined', 'non-json', 'bad-result', 'oversize'])('returns no manufactured terminal after entering an untrustworthy callable: %s', async kind => {
        const f = fixture(); let reads = 0;
        const cause = { get message() { reads++; throw 'PRIVATE'; }, toString() { reads++; throw 'PRIVATE'; } };
        f.context.invokeBinding.mockImplementation((): any => {
            if (kind === 'throw') throw cause;
            if (kind === 'reject') return Promise.reject(cause);
            if (kind === 'undefined') return undefined;
            const result: any = { success: true, data: {} };
            if (kind === 'non-json') result.data.value = undefined;
            if (kind === 'bad-result') result.success = 'yes';
            if (kind === 'oversize') result.data.value = 'x'.repeat(525000);
            return { phase: 'entered-returned', result };
        });
        expect(await invokeRefInvocationV1(f.message, f.context)).toBeNull();
        expect(f.context.invokeBinding).toHaveBeenCalledOnce(); expect(reads).toBe(0);
    });
    it.each([true, false])('requires a real callable as well as metadata: %s', async safe => {
        const f = fixture(safe); const response = await invokeRefInvocationV1(f.message, f.context);
        expect(response).toMatchObject({ success: true, terminal: safe
            ? { phase: 'entered-returned', result: { success: true } }
            : { phase: 'not-entered', result: { success: false, error: { code: 'REF_EXECUTION_UNAVAILABLE' } } } });
        expect(f.context.validateBinding).toHaveBeenCalledOnce(); expect(f.context.validateWrapper).toHaveBeenCalledOnce();
        expect(f.handler).toHaveBeenCalledTimes(safe ? 1 : 0);
    });
    it.each([
        ['mode', 'REF_EXECUTION_UNAVAILABLE'], ['capability', 'REF_EXECUTION_UNAVAILABLE'], ['instance', 'APP_INSTANCE_MISMATCH'],
        ['app', 'APP_INSTANCE_MISMATCH'], ['binding', 'TOOL_SOURCE_CONFLICT'], ['schema', 'TOOL_SOURCE_STALE'],
        ['target', 'TOOL_SOURCE_CONFLICT'], ['readonly', 'TOOL_PERMISSION_DENIED'], ['extra', 'OPERATION_INVALID_ARGS'],
        ['ordinary', 'OPERATION_INVALID_ARGS'], ['provenance', 'OPERATION_INVALID_ARGS'], ['unmount', 'VIEW_INSTANCE_REVOKED'],
        ['disabled', 'TOOL_UNAVAILABLE'],
    ])('rejects %s before Handler with %s', async (kind, code) => {
        const f = fixture();
        if (kind === 'mode') f.message.argumentMode = 'other';
        if (kind === 'capability') f.context.negotiated = false;
        if (kind === 'instance') f.message.instanceId = 'wrong';
        if (kind === 'app') f.message.appId = 'wrong';
        if (kind === 'binding') f.message.target = { ...f.message.target, bindingVersion: 99 };
        if (kind === 'schema') f.message.tool.description = 'changed';
        if (kind === 'target') f.message.target = { ...f.message.target, viewId: 'wrong' };
        if (kind === 'readonly') f.message.tool.isMutating = true;
        if (kind === 'extra') f.message.rootOwner = 'fake';
        if (kind === 'ordinary') f.message.effectiveArgs.other.k = 2;
        if (kind === 'provenance') f.message.refSources[0].refId = 'wrong';
        if (kind === 'unmount') f.registry.unmount(f.view.viewInstanceId);
        if (kind === 'disabled') f.registry.setEnabled(f.view.viewInstanceId, 'read', false);
        expect(await invokeRefInvocationV1(f.message, f.context)).toMatchObject({ terminal: { phase: 'not-entered', result: { error: { code } } } });
        expect(f.handler).not.toHaveBeenCalled();
    });
    it('returns fixed safe catch text even for arbitrary user exceptions', async () => {
        const f = fixture(); f.context.validateBinding.mockImplementation(() => { throw { toString() { throw 'SENTINEL'; }, message: 'SENTINEL' }; });
        const response = await invokeRefInvocationV1(f.message, f.context);
        expect(response?.terminal.result.error?.code).toBe('OPERATION_INVALID_ARGS');
        expect(JSON.stringify(response)).not.toContain('SENTINEL'); expect(f.handler).not.toHaveBeenCalled();
    });
    it('captures complete messages before even checking negotiation and uses safe routing only on failure', async () => {
        const f = fixture(); let getters = 0;
        Object.defineProperty(f.message.rawArgs, 'secret', { enumerable: true, get() { getters++; return 'SENTINEL'; } });
        f.context.negotiated = false;
        expect((await invokeRefInvocationV1(f.message, f.context))?.terminal.result.error?.code).toBe('OPERATION_INVALID_ARGS');
        expect(getters).toBe(0); expect(f.context.validateBinding).not.toHaveBeenCalled();
        Object.defineProperty(f.message, 'requestId', { get() { getters++; return 'SENTINEL'; } });
        expect(await invokeRefInvocationV1(f.message, f.context)).toBeNull(); expect(getters).toBe(0);
    });
});
