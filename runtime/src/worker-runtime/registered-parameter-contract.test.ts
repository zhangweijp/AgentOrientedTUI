import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { expect, it, vi } from 'vitest';
import { AppKernel } from './app-kernel/AppKernel.js';
import { detailFrame, publishedTool } from '../../tests/fixtures/app-frame.js';
import type { AppContext, RuntimeContext } from '@aotui/core';

it.each([false, true])('reuses the shared contract across View reactivation and replacement (Ref=%s)', async typed => {
    let runtime!: RuntimeContext;
    const property = typed
        ? { 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } }
        : { type: 'string' };
    const inputSchema = { type: 'object', properties: { file: property }, additionalProperties: false };
    const execute = vi.fn(() => ({ success: true }));
    let owner = {};
    const publish = (enabled = true) => runtime.publishFrame(() => ({ views: [detailFrame({
        owner, bindings: [{ name: 'read', enabled, execute }],
    })] }));
    const identity = { appId: 'example', desktopId: 'desktop' } as AppContext;
    const kernel = new AppKernel({ ...identity, instanceId: 'registered-parameters', projectionLimits: DEFAULT_PROJECTION_LIMITS, factory: { initialize(context) {
        runtime = context;
        context.defineViewTypes([{ name: "Detail", multiplicity: 'multiple', tools: [{ name: 'read', description: 'Read', inputSchema }] }]);
        publish();
        return;
    } } } as any);

    try {
        await kernel.onOpen();
        const first = publishedTool(kernel, 'read');
        const schema = first.tool.inputSchema;
        expect(schema.properties).toMatchObject({ file: property });
        const input = { file: typed ? { path: 'a.txt' } : 'a.txt' };
        expect(await kernel.invokeBoundTypeTool(first.tool, first.receiver, input, terminal => terminal)).toMatchObject({ phase: 'entered-returned' });
        expect(execute).toHaveBeenCalledOnce();

        publish(false);
        expect(kernel.validateBoundTypeTool(first.tool, first.receiver).success).toBe(false);
        publish();
        const again = publishedTool(kernel, 'read');
        expect(again.receiver.viewInstanceId).toBe(first.receiver.viewInstanceId);
        expect(again.receiver.activationId).not.toBe(first.receiver.activationId);
        expect(again.tool.inputSchema).toEqual(schema);

        owner = {};
        publish();
        const replacement = publishedTool(kernel, 'read');
        expect(replacement.receiver.viewInstanceId).not.toBe(first.receiver.viewInstanceId);
        expect(replacement.tool.inputSchema).toEqual(schema);
        expect(await kernel.invokeBoundTypeTool(first.tool, first.receiver, input, terminal => terminal)).toMatchObject({ phase: 'not-entered' });
        expect(execute).toHaveBeenCalledOnce();
    } finally {
        await kernel.onClose();
    }
});
