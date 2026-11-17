import { DEFAULT_PROJECTION_LIMITS } from '../core/invocation/observation-registry.js';
import { expect, it, vi } from 'vitest';
import { AppKernel } from './app-kernel/AppKernel.js';
import { detailFrame, publishedTool } from '../../tests/fixtures/app-frame.js';
import type { AppContext, RuntimeContext } from '../spi/index.js';

it.each([false, true])('reuses the shared contract across View reactivation and replacement (Ref=%s)', async typed => {
    let runtime!: RuntimeContext;
    const property = typed
        ? { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } }
        : { type: 'string' };
    const inputSchema = { type: 'object', properties: { file: property }, additionalProperties: false };
    const execute = vi.fn(() => ({ success: true }));
    let owner = {};
    const publish = (enabled = true) => runtime.publishFrame(() => ({ views: [detailFrame({
        owner, bindings: [{ name: 'read', enabled, execute }],
    })] }));
    const identity = { appId: 'example', desktopId: 'desktop' } as AppContext;
    const kernel = new AppKernel({ ...identity, instanceId: 'registered-parameters', projectionLimits: DEFAULT_PROJECTION_LIMITS, appName: 'example', factory: { initialize(context) {
        runtime = context;
        context.defineTools([{ viewType: 'Detail', name: 'read', description: 'Read', inputSchema }]);
        publish();
        return { close() {} };
    } } } as any);

    try {
        await kernel.onOpen();
        const first = publishedTool(kernel, 'read');
        const contract = kernel.getBoundTypeToolContract(first.tool, first.receiver);
        expect(contract?.hasRefs).toBe(typed);
        const input = { file: typed ? { path: 'a.txt' } : 'a.txt' };
        expect(await kernel.invokeBoundTypeTool(first.tool, first.receiver, input)).toMatchObject({ phase: 'entered-returned' });
        expect(execute).toHaveBeenCalledOnce();

        publish(false);
        expect(kernel.getBoundTypeToolContract(first.tool, first.receiver)).toBeUndefined();
        publish();
        const again = publishedTool(kernel, 'read');
        expect(again.receiver.viewInstanceId).toBe(first.receiver.viewInstanceId);
        expect(again.receiver.activationId).not.toBe(first.receiver.activationId);
        expect(kernel.getBoundTypeToolContract(again.tool, again.receiver)).toBe(contract);

        owner = {};
        publish();
        const replacement = publishedTool(kernel, 'read');
        expect(replacement.receiver.viewInstanceId).not.toBe(first.receiver.viewInstanceId);
        expect(kernel.getBoundTypeToolContract(replacement.tool, replacement.receiver)).toBe(contract);
        expect(await kernel.invokeBoundTypeTool(first.tool, first.receiver, input)).toMatchObject({ phase: 'not-entered' });
        expect(execute).toHaveBeenCalledOnce();
    } finally {
        await kernel.onClose();
    }
});
