import { expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { AppKernel } from './AppKernel.js';

function defer() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
it.each(['normal', 'sync-throw', 'async-reject', 'async-held'] as const)('A17 actual AppKernel disposes owned Registry after renderer %s and preserves entered business results', async mode => {
    const { document } = parseHTML('<html><body><div id="app"></div></body></html>');
    const unmountStarted = defer(), unmountGate = defer(), handlerStarted = defer(), handlerGate = defer(); let runtime: any, calls = 0;
    const kernel = new AppKernel({ name: 'test', appName: 'test', component: { async initializeComponent(_container: any, context: any) {
        runtime = context; const view = context.viewTools.mount('v', 'Detail');
        context.viewTools.registerTool(view, 'held', { description: 'Held', params: {}, isMutating: false, handler: async () => { calls++; handlerStarted.resolve(); await handlerGate.promise; return { success: true, data: 19 }; } });
        context.refExporter.registerRef('v', 'r', { value: 19 }); context.allocateViewId('key');
        return { unmount() { unmountStarted.resolve(); if (mode === 'sync-throw') throw Error('renderer sync'); if (mode === 'async-reject') return Promise.reject(Error('renderer async')); if (mode === 'async-held') return unmountGate.promise; } };
    } } } as any); kernel.setId('a' as any);
    const container = document.getElementById('app')!, remove = vi.spyOn(container, 'removeEventListener');
    await kernel.onOpen({ appId: 'a', desktopId: 'd', onRender() {}, markDirty() {} } as any, container as any);
    const owned = (kernel as any).viewOwnedTools, source = kernel.getViewOwnedToolDefinitions()[0], target = source.targets[0];
    expect(owned.inspect().bindings).toBe(1); const running = kernel.invokeBoundReadOnlyTool(source as any, target, {}); await handlerStarted.promise;
    const closing = kernel.onClose(); expect(kernel.onClose()).toBe(closing); void closing.catch(() => {}); await unmountStarted.promise;
    if (mode === 'async-held') { expect(owned.inspect()).toMatchObject({ state: 'active', views: 0, bindings: 0 }); expect(remove).not.toHaveBeenCalled(); }
    expect(await kernel.invokeBoundReadOnlyTool(source as any, target, {})).toMatchObject({ success: false, error: { code: 'TOOL_UNAVAILABLE' } });
    expect(calls).toBe(1); handlerGate.resolve(); expect(await running).toEqual({ success: true, data: 19 });
    unmountGate.resolve();
    if (mode === 'sync-throw' || mode === 'async-reject') await expect(closing).rejects.toHaveProperty('code', 'APP_UNMOUNT_FAILED'); else await closing;
    expect(owned.inspect()).toEqual({ state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
    expect(() => owned.mount('new', 'Detail')).toThrow(expect.objectContaining({ code: 'VIEW_REGISTRY_CLOSED' }));
    expect(() => runtime.viewTools.mount('new', 'Detail')).toThrow(expect.objectContaining({ code: 'APP_KERNEL_CLOSED' }));
    expect(remove).toHaveBeenCalledTimes(5); expect(kernel.exportRefsToIndexMap()).toEqual({}); expect((kernel as any).viewRegistry.getAll()).toEqual([]); expect((kernel as any).viewKeyToId.size).toBe(0);
});
