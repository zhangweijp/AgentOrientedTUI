import { describe, expect, it, vi } from 'vitest';
import { createViewOwnedTools } from './view-owned-tools.js';
const spec = { name: 'read', description: 'Read', isMutating: false, inputSchema: { type: 'object', properties: {
    file: { type: 'string', 'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target' } },
}, required: ['file'] } } as const;
const safe = { safeRefInvocationMode: 'snapshot-value-v1' } as const;
const callable = async () => ({ phase: 'entered-returned' as const, result: { success: true } });
describe('Ref v1 registration qualification', () => {
    it('mode flags in Schema, Snapshot observation or args cannot qualify an ordinary/old Wrapper', async () => {
        const registry = createViewOwnedTools('app', 'i'); const view = registry.mount('v', 'File');
        const handler = vi.fn(() => ({ success: true }));
        expect(() => registry.registerTool(view.viewInstanceId, { ...spec, inputSchema: { ...spec.inputSchema,
            safeRefInvocationMode: 'snapshot-value-v1' } }, handler, true, safe)).toThrow('REF_DECLARATION_INVALID');
        registry.registerTool(view.viewInstanceId, spec, handler, true, safe);
        const tool = { ...registry.listTools()[0]!, safeRefInvocationMode: 'snapshot-value-v1' };
        expect(registry.validateRefBinding(tool, tool.targets[0]!)).toMatchObject({ error: { code: 'REF_EXECUTION_UNAVAILABLE' } });
        expect(await registry.invokeRef(tool, tool.targets[0]!, { file: {}, safeRefInvocationMode: 'snapshot-value-v1', __safeMode: true }))
            .toMatchObject({ phase: 'not-entered', result: { error: { code: 'REF_EXECUTION_UNAVAILABLE' } } });
        expect(handler).not.toHaveBeenCalled();
    });
    it('revalidates and calls the registered safe function synchronously, without using the ordinary Wrapper', async () => {
        const registry = createViewOwnedTools('app', 'i'); const view = registry.mount('v', 'File');
        const ordinary = vi.fn(() => ({ success: true })); const safeCall = vi.fn(callable);
        registry.registerTool(view.viewInstanceId, spec, ordinary, true, safe, safeCall);
        const tool = registry.listTools()[0]!; const result = registry.invokeRef(tool, tool.targets[0]!, { file: {} });
        expect(safeCall).toHaveBeenCalledOnce(); expect(ordinary).not.toHaveBeenCalled();
        registry.setEnabled(view.viewInstanceId, 'read', false);
        expect(await result).toEqual({ phase: 'entered-returned', result: { success: true } });
        expect(await registry.invokeRef(tool, tool.targets[0]!, { file: {} })).toMatchObject({ phase: 'not-entered' });
        expect(safeCall).toHaveBeenCalledOnce();
    });
    it('scopes metadata to the actual function, View instance and binding version', async () => {
        const registry = createViewOwnedTools('app', 'i');
        const a = registry.mount('a', 'File'), b = registry.mount('b', 'File');
        const first = vi.fn(() => ({ success: true })), old = vi.fn(() => ({ success: true }));
        registry.registerTool(a.viewInstanceId, spec, first, true, safe, callable);
        registry.registerTool(b.viewInstanceId, spec, old);
        const tool = registry.listTools()[0]!; const [at, bt] = tool.targets;
        expect(registry.validateRefBinding(tool, at!).success).toBe(true);
        expect(registry.validateRefBinding(tool, bt!)).toMatchObject({ error: { code: 'REF_EXECUTION_UNAVAILABLE' } });
        expect(JSON.stringify(tool)).not.toContain('safeRef');
        expect((await registry.invoke(tool, at!, { file: {} }))).toMatchObject({ error: { code: 'REF_CONTRACT_UNSUPPORTED' } });
        expect(first).not.toHaveBeenCalled(); expect(old).not.toHaveBeenCalled();
        registry.setEnabled(a.viewInstanceId, 'read', false);
        expect(registry.validateRefBinding(tool, at!).success).toBe(false);
        registry.setEnabled(a.viewInstanceId, 'read', true);
        const newer = registry.listTools()[0]!;
        expect(registry.validateRefBinding(newer, newer.targets[0]!).success).toBe(false);
    });
    it('never inherits qualification after unregister, replacement or remount', () => {
        const registry = createViewOwnedTools('app', 'i'); let view = registry.mount('v', 'File');
        const handler = vi.fn(() => ({ success: true }));
        const release = registry.registerTool(view.viewInstanceId, spec, handler, true, safe, callable);
        const old = registry.listTools()[0]!; release(); release();
        registry.registerTool(view.viewInstanceId, spec, handler);
        expect(registry.validateRefBinding(old, old.targets[0]!).success).toBe(false);
        let now = registry.listTools()[0]!;
        expect(registry.validateRefBinding(now, now.targets[0]!).success).toBe(false);
        registry.unmount(view.viewInstanceId); view = registry.mount('v', 'File');
        registry.registerTool(view.viewInstanceId, spec, handler);
        now = registry.listTools()[0]!;
        expect(registry.validateRefBinding(old, old.targets[0]!).success).toBe(false);
        expect(registry.validateRefBinding(now, now.targets[0]!).success).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });
    it.each([{ safeRefInvocationMode: 'other' }, { safeRefInvocationMode: 'snapshot-value-v1', extra: true }, null])('rejects invalid metadata %#', options => {
        const registry = createViewOwnedTools('app', 'i'); const view = registry.mount('v', 'File');
        expect(() => registry.registerTool(view.viewInstanceId, spec, () => ({ success: true }), true, options as any)).toThrow();
    });
    it('captures metadata without reading getters or retaining mutable options', () => {
        const registry = createViewOwnedTools('app', 'i'); const view = registry.mount('v', 'File');
        let reads = 0; const options = { get safeRefInvocationMode() { reads++; return 'snapshot-value-v1'; } };
        expect(() => registry.registerTool(view.viewInstanceId, spec, () => ({ success: true }), true, options as any)).toThrow();
        expect(reads).toBe(0);
        const mutable: any = { ...safe }; registry.registerTool(view.viewInstanceId, spec, () => ({ success: true }), true, mutable, callable);
        mutable.safeRefInvocationMode = 'other';
        const tool = registry.listTools()[0]!;
        expect(registry.validateRefBinding(tool, tool.targets[0]!).success).toBe(true);
    });
});
