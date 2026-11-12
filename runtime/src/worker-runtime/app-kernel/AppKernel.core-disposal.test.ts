import { expect, it, vi } from 'vitest';
import { AppKernel } from './AppKernel.js';

function defer() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
it.each(['normal', 'sync-throw', 'async-reject', 'async-held'] as const)('A17 actual AppKernel disposes owned Registry after renderer %s and preserves entered business results', async mode => {
    const unmountStarted = defer(), unmountGate = defer(), handlerStarted = defer(), handlerGate = defer(); let runtime: any, calls = 0;
    const unmount = vi.fn(() => {
        unmountStarted.resolve();
        if (mode === 'sync-throw') throw Error('renderer sync');
        if (mode === 'async-reject') return Promise.reject(Error('renderer async'));
        if (mode === 'async-held') return unmountGate.promise;
    });
    const kernel = new AppKernel({ name: 'test', appName: 'test', factory: { async initialize(context: any) {
        runtime = context;
        context.projection.beginCommit();
        const view = context.viewTools.mount('v', 'Detail');
        context.setViewReader(() => [{ id: 'v', viewInstanceId: view, type: 'Detail', name: 'v',
            kind: 'state', content: { format: 'markdown-v1', value: '' } }]);
        const handler = async (_args: any) => { calls++; handlerStarted.resolve(); await handlerGate.promise; return { success: true, data: 19 }; };
        context.appTypeTools.registerTypeTool({ viewType: 'Detail', name: 'held', description: 'Held',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: () => async args => ({ phase: 'entered-returned', result: await handler(args) }),
        });
        context.refExporter.registerRef('v', 'r', { value: 19 });
        expect(context.projection.endCommit()).toBe('prepared');
        return { close: unmount };
    } } } as any); kernel.setId('a' as any);
    await kernel.onOpen({ appId: 'a', desktopId: 'd' } as any);
    const owned = (kernel as any).viewOwnedTools, source = kernel.getToolDefinitions()[0];
    if (!source || source.execution.kind !== 'view-type') throw Error('Expected a ViewType Tool');
    const execution = source.execution;
    expect(owned.inspect().bindings).toBe(1); const running = kernel.invokeBoundTypeTool(source, execution, {}); await handlerStarted.promise;
    const closing = kernel.onClose(); expect(kernel.onClose()).toBe(closing); void closing.catch(() => {}); await unmountStarted.promise;
    if (mode === 'async-held') { expect(owned.inspect()).toMatchObject({ state: 'active', views: 0, bindings: 1 }); expect(unmount).toHaveBeenCalledTimes(1); }
    expect(await kernel.invokeBoundTypeTool(source, execution, {})).toMatchObject({ phase: 'not-entered', result: { success: false, error: { code: 'TOOL_UNAVAILABLE' } } });
    expect(calls).toBe(1); handlerGate.resolve(); expect(await running).toEqual({ phase: 'entered-returned', result: { success: true, data: 19 } });
    unmountGate.resolve();
    if (mode === 'sync-throw' || mode === 'async-reject') await expect(closing).rejects.toHaveProperty('code', 'APP_UNMOUNT_FAILED'); else await closing;
    expect(owned.inspect()).toEqual({ state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
    expect(() => owned.mount('new', 'Detail')).toThrow(expect.objectContaining({ code: 'VIEW_REGISTRY_CLOSED' }));
    expect(() => runtime.viewTools.mount('new', 'Detail')).toThrow(expect.objectContaining({ code: 'APP_KERNEL_CLOSED' }));
    expect(unmount).toHaveBeenCalledTimes(1); expect(kernel.getViewRefs()).toEqual([]);
    expect((kernel as any).viewRegistry).toBeUndefined(); expect((kernel as any).typeTools).toBeUndefined();
});
