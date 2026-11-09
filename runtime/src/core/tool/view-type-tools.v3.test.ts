import { describe, expect, it, vi } from 'vitest';
import { compileOrdinaryParams } from './ordinary-parameter-contract.js';
import { createViewOwnedTools } from './view-owned-tools.js';
import type { SafeOrdinaryInvoker } from './invocation-terminal.js';
import type { ToolResult } from '../../spi/core/tool-result.js';

const schema = (() => {
    const result = compileOrdinaryParams({
        filePath: { type: 'string', required: true, desc: 'Business path interpreted by the App.' },
        content: { type: 'string', required: true },
    }, { additionalProperties: false });
    if (!result.ok) throw new Error('Test schema must compile');
    return result.contract.schema;
})();
const definition = {
    viewType: 'FileDetail', name: 'write_file', description: 'Write an already opened file.',
    inputSchema: schema, 
} as const;

function registry() { return createViewOwnedTools('ide', 'app-instance-1'); }
function safe(handler: (args: Readonly<Record<string, unknown>>) => ToolResult): SafeOrdinaryInvoker {
    return async args => ({ phase: 'entered-returned', result: await handler(args) });
}
function register(registry: ReturnType<typeof createViewOwnedTools>, handler: (args: Readonly<Record<string, unknown>>) => ToolResult,
    createInvoker: (fallback: SafeOrdinaryInvoker) => SafeOrdinaryInvoker = fallback => fallback) {
    return registry.registerTypeTool(definition, {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2',
        createSafeOrdinaryParametersInvoker: () => createInvoker(safe(handler)),
    });
}

describe('ViewType Tools V3 Core registry', () => {
    it('keeps a registration hidden until a matching View is mounted', () => {
        const tools = registry();
        register(tools, () => ({ success: true }));
        expect(tools.listTools()).toEqual([]);
        tools.mount('file-a', 'FileDetail');
        expect(tools.listTools()).toHaveLength(1);
        expect(tools.listTools()[0]).toMatchObject({
            name: 'write_file', viewType: 'FileDetail',  execution: { kind: 'view-type' },
        });
        expect(tools.listTools()[0]).not.toHaveProperty('targets');
        expect(tools.listTools()[0]!.execution.kind).toBe('view-type');
        tools.dispose();
    });

    it('publishes one Tool and keeps its activation identity while ten same-type Views change', () => {
        const tools = registry();
        const release = register(tools, () => ({ success: true }));
        const first = tools.mount('file-0', 'FileDetail');
        const initial = tools.listTools()[0]!;
        const activationId = initial.execution.kind === 'view-type' ? initial.execution.activationId : '';
        const others = Array.from({ length: 9 }, (_, n) => tools.mount('file-' + (n + 1), 'FileDetail'));
        expect(tools.listTools()).toHaveLength(1);
        expect(tools.listTools()[0]!.execution).toEqual({ kind: 'view-type', activationId });
        for (const view of others) tools.unmount(view.viewInstanceId);
        expect(tools.listTools()).toHaveLength(1);
        expect(tools.listTools()[0]!.execution).toEqual({ kind: 'view-type', activationId });
        tools.unmount(first.viewInstanceId);
        expect(tools.listTools()).toEqual([]);
        release();
        tools.dispose();
    });

    it('retires identity after the last View closes and rejects the old activation after reopen', () => {
        const tools = registry();
        const release = register(tools, () => ({ success: true }));
        const first = tools.mount('file-a', 'FileDetail');
        const observed = tools.listTools()[0]!;
        expect(observed.execution.kind).toBe('view-type');
        const oldExecution = observed.execution;
        tools.unmount(first.viewInstanceId);
        expect(tools.validateTypeToolBinding(observed, oldExecution)).toMatchObject({ success: false,
            error: { code: 'TOOL_UNAVAILABLE' } });
        tools.mount('file-a', 'FileDetail');
        const current = tools.listTools()[0]!;
        expect(current.execution.kind).toBe('view-type');
        expect((current.execution as { activationId: string }).activationId).not.toBe((oldExecution as { activationId: string }).activationId);
        expect(tools.validateTypeToolBinding(observed, oldExecution)).toMatchObject({ success: false });
        release();
        tools.dispose();
    });

    it('passes the full business input to one type handler without interpreting a path target', async () => {
        const tools = registry();
        const handler = vi.fn((args: Readonly<Record<string, unknown>>) => ({ success: true, data: { path: args.filePath } }));
        const release = register(tools, handler);
        const view = tools.mount('file-a', 'FileDetail');
        const tool = tools.listTools()[0]!;
        expect(tool.execution.kind).toBe('view-type');
        const result = await tools.invokeTypeTool(tool, tool.execution, { filePath: 'b.txt', content: 'x' });
        expect(result).toEqual({ phase: 'entered-returned', result: { success: true, data: { path: 'b.txt' } } });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(tools.listViews().map(item => item.viewId)).toContain(view.viewId);
        release();
        tools.dispose();
    });

    it('rejects a same-key second owner and keeps the original callable active', async () => {
        const tools = registry();
        const first = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { owner: 'first' } } }));
        const secondFactory = vi.fn(() => safe(() => ({ success: true, data: { owner: 'second' } })));
        const release = register(tools, () => ({ success: true }), () => first);
        tools.mount('file-a', 'FileDetail');
        const observed = tools.listTools()[0]!;
        expect(() => tools.registerTypeTool(definition, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: secondFactory,
        }))
            .toThrow(expect.objectContaining({ code: 'TOOL_DUPLICATE' }));
        expect(await tools.invokeTypeTool(observed, observed.execution, { filePath: 'a.txt', content: 'x' }))
            .toEqual({ phase: 'entered-returned', result: { success: true, data: { owner: 'first' } } });
        expect(first).toHaveBeenCalledOnce();
        expect(secondFactory).not.toHaveBeenCalled();
        release();
        tools.dispose();
    });

    it('replacing a released registration gets a new activation and stale release cannot remove it', async () => {
        const tools = registry();
        tools.mount('file-a', 'FileDetail');
        const first = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { owner: 'old' } } }));
        const oldRelease = register(tools, () => ({ success: true }), () => first);
        const oldTool = tools.listTools()[0]!;
        const oldExecution = oldTool.execution;
        oldRelease();

        const next = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { owner: 'new' } } }));
        const newRelease = register(tools, () => ({ success: true }), () => next);
        const current = tools.listTools()[0]!;
        expect(current.execution.kind).toBe('view-type');
        expect(current.execution).not.toEqual(oldExecution);
        oldRelease();
        expect(await tools.invokeTypeTool(oldTool, oldExecution, { filePath: 'a.txt', content: 'x' })).toMatchObject({
            phase: 'not-entered', result: { error: { code: 'TOOL_UNAVAILABLE' } },
        });
        expect(await tools.invokeTypeTool(current, current.execution, { filePath: 'a.txt', content: 'x' })).toMatchObject({
            phase: 'entered-returned', result: { data: { owner: 'new' } },
        });
        expect(first).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledOnce();
        newRelease();
        tools.dispose();
    });

    it('does not accept a raw handler field or registration without the trusted safe invoker factory', () => {
        const tools = registry();
        const createInvoker = vi.fn(() => safe(() => ({ success: true })));
        expect(() => tools.registerTypeTool({ ...definition, handler: () => ({ success: true }) } as never, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: createInvoker,
        })).toThrow();
        expect(() => tools.registerTypeTool({ ...definition, inputSchema: { type: 'object', properties: {
            file: { type: 'reference' },
        } } }, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: createInvoker,
        })).toThrow();
        expect(createInvoker).not.toHaveBeenCalled();
        expect(() => tools.registerTypeTool(definition, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
        } as never)).toThrow(expect.objectContaining({ code: 'TOOL_INVALID' }));
        expect(tools.inspect()).toMatchObject({ bindings: 0 });
        tools.dispose();
    });

    it('keeps input validation in the trusted invoker before handler entry', async () => {
        const tools = registry();
        const handler = vi.fn(() => ({ success: true }));
        const compiled = compileOrdinaryParams({ filePath: { type: 'string', required: true }, content: { type: 'string', required: true } },
            { additionalProperties: false });
        if (!compiled.ok) throw new Error('Test schema must compile');
        const invoke: SafeOrdinaryInvoker = async input => {
            const checked = compiled.contract.validate(input);
            return checked.ok ? { phase: 'entered-returned', result: await handler() }
                : { phase: 'not-entered', result: { success: false, error: { code: 'E_INVALID_ARGS', message: 'bad arguments' } } };
        };
        const release = register(tools, handler, () => invoke);
        tools.mount('file-a', 'FileDetail');
        const tool = tools.listTools()[0]!;
        const invalid = await tools.invokeTypeTool(tool, tool.execution, { filePath: 'a.txt', content: 3 });
        expect(invalid).toMatchObject({ phase: 'not-entered', result: { error: { code: 'E_INVALID_ARGS' } } });
        expect(handler).not.toHaveBeenCalled();
        release();
        tools.dispose();
    });

    it('rejects getters, hidden option fields and custom prototypes without executing getters', () => {
        const tools = registry(); let getterCalls = 0;
        const accessor = {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            get createSafeOrdinaryParametersInvoker() { getterCalls++; return () => safe(() => ({ success: true })); },
        };
        expect(() => tools.registerTypeTool(definition, accessor as never)).toThrow(expect.objectContaining({ code: 'TOOL_INVALID' }));
        const hidden = {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: () => safe(() => ({ success: true })),
        };
        Object.defineProperty(hidden, 'internal', { value: true, enumerable: false });
        expect(() => tools.registerTypeTool(definition, hidden as never)).toThrow(expect.objectContaining({ code: 'TOOL_INVALID' }));
        const customPrototype = Object.assign(Object.create({ inherited: true }), {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: () => safe(() => ({ success: true })),
        });
        expect(() => tools.registerTypeTool(definition, customPrototype)).toThrow(expect.objectContaining({ code: 'TOOL_INVALID' }));
        expect(getterCalls).toBe(0);
        expect(tools.inspect().bindings).toBe(0);
    });

    it('rechecks registration ownership after factory reentry and refuses ghosts after dispose', () => {
        const tools = registry();
        tools.mount('file-a', 'FileDetail');
        const innerRelease = { value: undefined as (() => void) | undefined };
        expect(() => tools.registerTypeTool(definition, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: () => {
                innerRelease.value = register(tools, () => ({ success: true }));
                return safe(() => ({ success: true }));
            },
        })).toThrow(expect.objectContaining({ code: 'TOOL_DUPLICATE' }));
        expect(tools.inspect().bindings).toBe(1);
        expect(tools.listTools()).toHaveLength(1);
        innerRelease.value?.();
        expect(tools.inspect().bindings).toBe(0);
        expect(() => tools.registerTypeTool(definition, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2',
            createSafeOrdinaryParametersInvoker: () => {
                tools.dispose();
                return safe(() => ({ success: true }));
            },
        })).toThrow(expect.objectContaining({ code: 'VIEW_REGISTRY_CLOSED' }));
        expect(tools.inspect()).toEqual({ state: 'disposed', views: 0, bindings: 0, retainedBytes: 0 });
    });
});
