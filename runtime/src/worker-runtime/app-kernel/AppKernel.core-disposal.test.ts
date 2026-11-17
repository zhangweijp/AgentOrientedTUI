import { DEFAULT_PROJECTION_LIMITS } from '../../core/invocation/observation-registry.js';
import { detailFrame, publishedTool } from '../../../tests/fixtures/app-frame.js';
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
    const kernel = new AppKernel({ appName: 'test_app', appId: 'a', desktopId: 'd', instanceId: 'run', projectionLimits: DEFAULT_PROJECTION_LIMITS, factory: { async initialize(context: any) {
        runtime = context;
        const execute = async () => {
            calls++; handlerStarted.resolve(); await handlerGate.promise; return { success: true, data: 19 };
        };
        context.defineTools([{ viewType: 'Detail', name: 'held', description: 'Held',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]);
        context.publishFrame(() => ({ views: [detailFrame({
            bindings: [{ name: 'held', enabled: true, execute }],
            refs: [{ id: 'r', refType: 'Value', value: { value: 19 } }],
        })] }));
        return { close: unmount };
    } } } as any);
    await kernel.onOpen();
    const owned = (kernel as any).viewOwnedTools, { tool, receiver } = publishedTool(kernel, 'held');
    expect(owned.inspect().bindings).toBe(1);
    const running = kernel.invokeBoundTypeTool(tool, receiver, {});
    await handlerStarted.promise;
    const closing = kernel.onClose(); expect(kernel.onClose()).toBe(closing); void closing.catch(() => {}); await unmountStarted.promise;
    if (mode === 'async-held') { expect(owned.inspect()).toMatchObject({ state: 'disposed', views: 0, bindings: 0 }); expect(unmount).toHaveBeenCalledTimes(1); }
    expect(await kernel.invokeBoundTypeTool(tool, receiver, {})).toMatchObject({ phase: 'not-entered', result: { success: false, error: { code: 'TOOL_UNAVAILABLE' } } });
    expect(calls).toBe(1); handlerGate.resolve(); expect(await running).toEqual({ phase: 'entered-returned', result: { success: true, data: 19 } });
    unmountGate.resolve();
    if (mode === 'sync-throw' || mode === 'async-reject') await expect(closing).rejects.toHaveProperty('code', 'APP_UNMOUNT_FAILED'); else await closing;
    expect(owned.inspect()).toEqual({ state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
    expect(() => owned.prepareFrame([])).toThrow(expect.objectContaining({ code: 'VIEW_REGISTRY_CLOSED' }));
    expect(() => runtime.publishFrame(() => ({ views: [] }))).toThrow(expect.objectContaining({ code: 'APP_KERNEL_CLOSED' }));
    expect(unmount).toHaveBeenCalledTimes(1); expect(kernel.getViewRefs()).toEqual([]);
    expect((kernel as any).viewRegistry).toBeUndefined(); expect((kernel as any).typeTools).toBeUndefined();
});
