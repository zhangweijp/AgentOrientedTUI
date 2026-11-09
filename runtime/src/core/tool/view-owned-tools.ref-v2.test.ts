import { describe, expect, it, vi } from 'vitest';
import { createViewOwnedTools } from './view-owned-tools.js';
import type { SafeOrdinaryInvoker, ViewToolInvocationTerminal } from './invocation-terminal.js';
const definition = { viewType: 'File', name: 'read', description: 'Read original object', 
    inputSchema: { type: 'object', properties: { file: { type: 'string', minLength: 1,
        'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: false },
} as const;
function setup() { const r = createViewOwnedTools('app', 'run'), owner = r.mount('aa', 'File'); return { r, owner }; }
function register(r: ReturnType<typeof createViewOwnedTools>, invoke: SafeOrdinaryInvoker, name = 'read') {
    return r.registerTypeTool({ ...definition, name }, { safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: () => invoke });
}
function terminal(data: any = undefined): ViewToolInvocationTerminal {
    return { phase: 'entered-returned', result: { success: true, ...(data === undefined ? {} : { data }) } };
}
describe('Ref parameters in the ViewType registry', () => {
    it('requires an exact contract and a private safe invoker', () => {
        const { r } = setup();
        for (const factory of [() => undefined, async () => terminal()]) expect(() => r.registerTypeTool(definition, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: factory,
        } as any)).toThrow(expect.objectContaining({ code: 'TOOL_INVALID' }));
        expect(r.listTools()).toEqual([]); r.dispose();
    });
    it('keeps one shared handler active until the last matching View closes', async () => {
        const { r, owner } = setup(), other = r.mount('bb', 'File');
        const invoke = vi.fn(async (args: any) => terminal({ owner: args.file.owner })); const release = register(r, invoke);
        const observed = r.listTools()[0]!; expect(r.listTools()).toHaveLength(1);
        expect(observed.execution.kind).toBe('view-type'); expect(observed.execution).not.toHaveProperty('targets');
        for (const owner of ['A', 'B']) expect(await r.invokeTypeTool(observed, observed.execution, { file: { owner } })).toEqual(terminal({ owner }));
        expect(invoke).toHaveBeenCalledTimes(2); r.unmount(owner.viewInstanceId);
        expect(r.validateTypeToolBinding(observed, observed.execution)).toEqual({ success: true });
        r.unmount(other.viewInstanceId); expect(await r.invokeTypeTool(observed, observed.execution, { file: { owner: 'A' } })).toMatchObject({ phase: 'not-entered' });
        release(); r.dispose();
    });
    it('rejects changed public contract, App identity and retired activation', () => {
        const { r, owner } = setup(), invoke = vi.fn(async () => terminal()); register(r, invoke);
        const observed = r.listTools()[0]!;
        for (const patch of [{ description: 'changed' }, { id: 'other' }]) expect(r.validateTypeToolBinding({ ...observed, ...patch }, observed.execution).success).toBe(false);
        expect(r.validateTypeToolBinding(observed, { kind: 'view-type', activationId: 'forged' }).success).toBe(false);
        r.unmount(owner.viewInstanceId); expect(r.validateTypeToolBinding(observed, observed.execution).success).toBe(false);
        const reopened = r.mount('aa', 'File'); expect(reopened.viewInstanceId).not.toBe(owner.viewInstanceId);
        expect(r.listTools()[0]!.execution).not.toEqual(observed.execution);
        expect(r.validateTypeToolBinding(observed, observed.execution).success).toBe(false); expect(invoke).not.toHaveBeenCalled(); r.dispose();
    });
    it('refuses duplicate ownership without replacing the original callable', async () => {
        const { r } = setup(), original = vi.fn(async () => terminal({ owner: 'original' })), duplicate = vi.fn(async () => terminal());
        register(r, original); expect(() => register(r, duplicate)).toThrow(expect.objectContaining({ code: 'TOOL_DUPLICATE' }));
        const tool = r.listTools()[0]!; expect(await r.invokeTypeTool(tool, tool.execution, { file: {} })).toEqual(terminal({ owner: 'original' }));
        expect(original).toHaveBeenCalledOnce(); expect(duplicate).not.toHaveBeenCalled(); r.dispose();
    });
    it('rejects retired annotations and leaves a current shared registration unchanged', () => {
        const { r } = setup(); register(r, async () => terminal()); const original = r.listTools();
        expect(() => r.registerTypeTool({ ...definition, name: 'legacy', inputSchema: { ...definition.inputSchema,
            properties: { file: { type: 'string', 'x-aotui-ref': { version: 1 } } } } }, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: () => async () => terminal(),
        })).toThrow(); expect(r.listTools()).toEqual(original); r.dispose();
    });
    it.each(['success', 'throw'] as const)('preserves an already-entered Ref %s after disposal', async outcome => {
        const { r } = setup(); let resolve!: () => void; const gate = new Promise<void>(yes => { resolve = yes; });
        register(r, async () => { await gate; if (outcome === 'throw') throw Error('ref failure'); return terminal({ retained: true }); });
        const tool = r.listTools()[0]!, pending = r.invokeTypeTool(tool, tool.execution, { file: {} }); r.dispose();
        expect(await r.invokeTypeTool(tool, tool.execution, { file: {} })).toMatchObject({ phase: 'not-entered' }); resolve();
        if (outcome === 'throw') await expect(pending).rejects.toThrow('ref failure'); else expect(await pending).toEqual(terminal({ retained: true }));
    });
    it('keeps an App registration hidden when its factory unmounts the last View', () => {
        const { r, owner } = setup(); const release = r.registerTypeTool(definition, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: () => {
                r.unmount(owner.viewInstanceId); return async () => terminal();
            },
        });
        expect(r.listViews()).toEqual([]); expect(r.listTools()).toEqual([]); expect(r.inspect()).toMatchObject({ views: 0, bindings: 1 });
        r.mount('aa', 'File'); expect(r.listTools()).toHaveLength(1); release(); expect(r.inspect().bindings).toBe(0); r.dispose();
    });
    it('rechecks duplicate ownership after invoker factory reentry', () => {
        const { r } = setup(); expect(() => r.registerTypeTool(definition, {
            safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: () => {
                register(r, async () => terminal()); return async () => terminal();
            },
        })).toThrow(expect.objectContaining({ code: 'TOOL_DUPLICATE' }));
        expect(r.inspect()).toMatchObject({ views: 1, bindings: 1 }); expect(r.listTools()).toHaveLength(1); r.dispose();
    });
});
