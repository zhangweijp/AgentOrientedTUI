import { describe, expect, it, vi } from 'vitest';
import { AppKernel } from './AppKernel.js';

const make = () => {
    const kernel = new AppKernel({
        appName: 'type_tool_contract', name: 'Test',
        component: { initializeComponent: vi.fn() },
    });
    kernel.setId('app_0' as any);
    (kernel as any).renderAllViews = vi.fn();
    (kernel as any).componentRenderer = { render: vi.fn() };
    return kernel;
};

const view = (id: string, type = 'FileDetail') => ({
    id, name: type, type,
    onMount: async () => {}, onDismount: async () => {},
    onOperation: async () => ({ success: true }),
    render: () => 'View',
});

describe('P0: real AppKernel TypeTool result and Ref scope', () => {
    it('preserves a business failure instead of reporting outer success', async () => {
        const kernel = make();
        const failure = { success: false, error: { code: 'LSP_ERROR', message: 'Server unavailable' } };
        const handler = vi.fn(async () => failure);
        kernel.registerTypeTool('FileDetail', 'lsp_hover', {
            description: 'Hover', params: {}, handler,
        });
        const result = await kernel.callTypeTool('FileDetail', 'lsp_hover', {});
        expect(result).toEqual(failure);
        expect(result.success).toBe(false);
        expect(handler).toHaveBeenCalledTimes(1);
        expect((kernel as any).componentRenderer.render).not.toHaveBeenCalled();
    });

    it('keeps structured success status/data and supports legacy raw-value handlers', async () => {
        const kernel = make();
        kernel.registerTypeTool('FileDetail', 'modern', {
            description: 'Inspect', params: {},
            handler: async () => ({ success: true, data: { kind: 'modern' } }),
        });
        expect(await kernel.callTypeTool('FileDetail', 'modern', {}))
            .toEqual({ success: true, data: { kind: 'modern' } });
        kernel.registerTypeTool('FileDetail', 'old', {
            description: 'Inspect', params: {}, handler: async () => ({ kind: 'legacy' }),
        });
        expect(await kernel.callTypeTool('FileDetail', 'old', {}))
            .toEqual({ success: true, data: { kind: 'legacy' } });
    });

    it('rejects a malformed business status rather than wrapping it as success', async () => {
        const kernel = make();
        const malformed = vi.fn(async () => ({ success: 'false', error: {
            code: 'BUSINESS_FAILED', message: 'Not a boolean status',
        } }));
        kernel.registerTypeTool('FileDetail', 'invalid_status', {
            description: 'Invalid handler status', params: {}, handler: malformed,
        });
        expect(await kernel.callTypeTool('FileDetail', 'invalid_status', {}))
            .toMatchObject({ success: false, error: { code: 'TOOL_RESULT_INVALID' } });
        expect((kernel as any).componentRenderer.render).not.toHaveBeenCalled();
    });

    it('fails closed on ambiguous Ref names within the SAME ViewType', async () => {
        const kernel = make();
        (kernel as any).viewRegistry.register(view('fd_0'));
        (kernel as any).viewRegistry.register(view('fd_1'));
        const first = { id: 'A' };
        const second = { id: 'B' };
        kernel.exportRef('fd_0' as any, 'selected', first);
        kernel.exportRef('fd_1' as any, 'selected', second);
        const handler = vi.fn(async () => ({ success: true }));
        kernel.registerTypeTool('FileDetail', 'inspect', {
            description: 'Inspect', params: { target: { type: 'reference' } }, handler,
        });
        const response = await kernel.callTypeTool('FileDetail', 'inspect', { target: 'selected' });
        expect(response).toMatchObject({ success: false, error: {
            code: 'OPERATION_INVALID_ARGS',
        } });
        expect(handler).not.toHaveBeenCalled();
    });

    it('never resolves a matching Ref from a different ViewType', async () => {
        const kernel = make();
        (kernel as any).viewRegistry.register(view('fd_0', 'FileDetail'));
        (kernel as any).viewRegistry.register(view('workspace', 'Workspace'));
        kernel.exportRef('workspace' as any, 'selected', { id: 'wrong type' });
        const handler = vi.fn(async () => ({ success: true }));
        kernel.registerTypeTool('FileDetail', 'inspect', {
            description: 'Inspect', params: { target: { type: 'reference' } }, handler,
        });
        expect(await kernel.callTypeTool('FileDetail', 'inspect', { target: 'selected' }))
            .toMatchObject({ success: false, error: { code: 'OPERATION_INVALID_ARGS' } });
        expect(handler).not.toHaveBeenCalled();
    });

    it('resolves a unique typed Ref within its ViewType, without scanning global suffixes', async () => {
        const kernel = make();
        (kernel as any).viewRegistry.register(view('fd_0', 'FileDetail'));
        (kernel as any).viewRegistry.register(view('workspace', 'Workspace'));
        const right = { id: 'App.tsx' };
        kernel.exportRef('fd_0' as any, 'Task:selected', right);
        kernel.exportRef('workspace' as any, 'Task:selected', { id: 'not FileDetail' });
        const handler = vi.fn(async (args: any) => ({
            success: true, data: { result: args.target.id },
        }));
        kernel.registerTypeTool('FileDetail', 'inspect', {
            description: 'Inspect', params: { target: { type: 'reference' } }, handler,
        });
        expect(await kernel.callTypeTool('FileDetail', 'inspect', { target: 'Task:selected' }))
            .toMatchObject({ success: true, data: { result: 'App.tsx' } });
        expect(handler).toHaveBeenCalledWith({ target: right });
    });

    it('rejects any ambiguous reference array without executing the handler', async () => {
        const kernel = make();
        (kernel as any).viewRegistry.register(view('fd_0'));
        (kernel as any).viewRegistry.register(view('fd_1'));
        kernel.exportRef('fd_0' as any, 'selected', { id: 'A' });
        kernel.exportRef('fd_1' as any, 'selected', { id: 'B' });
        const handler = vi.fn(async () => ({ success: true }));
        kernel.registerTypeTool('FileDetail', 'inspect', {
            description: 'Inspect',
            params: { targets: { type: 'array', itemType: 'reference' } },
            handler,
        });
        expect(await kernel.callTypeTool('FileDetail', 'inspect', { targets: ['selected'] }))
            .toMatchObject({ success: false, error: { code: 'OPERATION_INVALID_ARGS' } });
        expect(handler).not.toHaveBeenCalled();
    });
});
