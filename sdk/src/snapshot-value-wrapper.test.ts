import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useViewTypeTool } from './hooks/useViewTypeTool.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const params = () => ({ file: { type: 'reference' as const, required: true, refSource: 'snapshot-value-v1' as const },
    value: { type: 'string' as const, required: true } });
const close: Array<() => Promise<void>> = [];
async function setup(Content: any, support: any = 'snapshot-value-v1', root?: any) {
    const captures: any[] = [], registrations: any[] = []; let port: any;
    const factory = createTUIApp({ app_name: 'safe_fixture', component: root ?? (() => h(View, { id: 'file_view', type: 'File' }, h(Content, {}))) });
    const initialize = factory.initializeComponent;
    factory.initializeComponent = async (container, context) => {
        port = context.viewTools;
        const forwarded: any = { ...port, safeRefInvocationSupport: support, registerTool: (...args: any[]) => {
            const options = args[3]; registrations.push(options);
            if (options?.createSafeRefInvoker) args[3] = { ...options, createSafeRefInvoker: (p: any) => {
                captures.push(p); return options.createSafeRefInvoker(p);
            } };
            return port.registerTool(...args);
        } };
        if (support === 'missing') delete forwarded.safeRefInvocationSupport;
        return initialize(container, { ...context, viewTools: forwarded });
    };
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
    kernel.setId('safe_app' as any); kernel.setAppExecutionInstanceId('safe_instance');
    const container = document.createElement('div'); document.body.appendChild(container);
    close.push(async () => { await kernel.onClose(); container.remove(); });
    await kernel.onOpen({ appId: 'safe_app' as any, desktopId: 'd' as any, markDirty() {}, onRender() {} }, container);
    const tool = () => kernel.getViewOwnedToolDefinitions()[0];
    return { kernel, captures, registrations, get port() { return port; }, tool,
        invoke: (args: any, source = tool(), target = source.targets[0]) => kernel.invokeBoundRefViewTool(source, target, args) };
}
afterEach(async () => { for (const cleanup of close.splice(0)) await cleanup(); vi.restoreAllMocks(); });

describe('committed SDK safe Wrapper and Runtime registration', () => {
    it('shares one detached frozen capture with the safe factory and preserves it after external mutation', async () => {
        const external: any = params(); const business = vi.fn(async args => ({ success: true, data: { args } }));
        function Content() { useViewTypeTool('read', { description: 'Read', isMutating: false, params: external }, business); return h('p', {}, 'File'); }
        const x = await setup(Content); const original = x.tool(); const capture = x.captures[0];
        expect(x.captures).toHaveLength(1); expect(capture).not.toBe(external);
        expect(Object.isFrozen(capture)).toBe(true); expect(Object.isFrozen(capture.file)).toBe(true);
        expect(capture.value.type).toBe((original.inputSchema as any).properties.value.type);
        external.value.type = 'number'; external.file.required = false;
        expect((await x.invoke({ file: { text: 'A' }, value: 'old', extra: [1] })).phase).toBe('entered-returned');
        expect(await x.invoke({ file: {}, value: 2 })).toMatchObject({ phase: 'not-entered', result: { error: { code: 'E_INVALID_ARGS' } } });
        expect(business).toHaveBeenCalledOnce(); expect(x.tool()).toEqual(original); expect(capture.value.type).toBe('string');
    });

    it('updates only the committed business handler and revokes the old binding when Schema changes', async () => {
        let update!: (state: { revision: number; numeric: boolean; description: string; enabled: boolean }) => void;
        const calls: number[] = [];
        function Content() {
            const [state, set] = useState({ revision: 1, numeric: false, description: 'Read', enabled: true }); update = set;
            useViewTypeTool('read', { description: state.description, isMutating: false,
                params: { ...params(), value: { type: state.numeric ? 'number' : 'string', required: true } } },
            async () => { calls.push(state.revision); return { success: true, data: { revision: state.revision } }; }, { enabled: state.enabled });
            return h('p', {}, 'Unchanged');
        }
        const x = await setup(Content); const first = x.tool();
        const next = { revision: 2, numeric: false, description: 'Read', enabled: true };
        update(next); // scheduled but not yet rendered/committed
        expect((await x.invoke({ file: {}, value: 'x' }, first)).result.data).toEqual({ revision: 1 });
        await act(() => {});
        expect(x.tool().targets).toEqual(first.targets); expect(x.captures).toHaveLength(1);
        expect((await x.invoke({ file: {}, value: 'x' }, first)).result.data).toEqual({ revision: 2 });
        await act(() => update({ ...next, revision: 3, numeric: true }));
        expect(x.tool().targets[0].bindingVersion).not.toBe(first.targets[0].bindingVersion);
        expect(await x.invoke({ file: {}, value: 'x' }, first)).toMatchObject({ phase: 'not-entered', result: { error: { code: 'TOOL_SOURCE_STALE' } } });
        expect((await x.invoke({ file: {}, value: 3 })).result.data).toEqual({ revision: 3 });
        const beforeDescription = x.tool();
        await act(() => update({ ...next, revision: 4, numeric: true, description: 'Read updated' }));
        expect((await x.invoke({ file: {}, value: 3 }, beforeDescription)).phase).toBe('not-entered');
        const beforeDisable = x.tool();
        await act(() => update({ ...next, enabled: false })); expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
        expect((await x.invoke({ file: {}, value: 'x' }, beforeDisable)).phase).toBe('not-entered');
        await act(() => update(next)); expect(x.tool().targets[0].bindingVersion).not.toBe(beforeDisable.targets[0].bindingVersion);
        expect(calls).toEqual([1, 2, 3]);
    });

    it('a failed real Preact render cannot publish its handler or params into an existing safe binding', async () => {
        let update!: (bad: boolean) => void; const calls: string[] = [];
        function Content() {
            const [bad, set] = useState(false); update = set;
            useViewTypeTool('read', { description: 'Read', isMutating: false, params: params() }, async () => {
                calls.push(bad ? 'uncommitted' : 'committed'); return { success: true };
            });
            if (bad) throw new Error('controlled failed render');
            return h('p', {}, 'Ready');
        }
        const x = await setup(Content); const first = x.tool();
        await expect(Promise.resolve().then(() => act(() => update(true)))).rejects.toThrow('controlled failed render');
        const result = await x.invoke({ file: {}, value: 'x' }, first);
        expect(calls).not.toContain('uncommitted');
        if (result.phase === 'entered-returned') expect(calls).toEqual(['committed']);
        else expect(calls).toEqual([]); // Preact may revoke the failed subtree.
        expect(x.captures).toHaveLength(1);
    });

    it.each(['missing', 'future', false])('keeps declarations without safe qualification when support=%s', async support => {
        const handler = vi.fn(async () => ({ success: true }));
        function Content() { useViewTypeTool('read', { description: 'Read', isMutating: false, params: params() }, handler); return h('p', {}, 'A'); }
        const x = await setup(Content, support);
        expect(x.tool().inputSchema).toMatchObject({ properties: { file: { 'x-aotui-ref': { version: 1 } } } });
        expect(x.registrations).toEqual([undefined]);
        expect(await x.invoke({ file: {}, value: 'x' })).toMatchObject({ phase: 'not-entered', result: { error: { code: 'REF_EXECUTION_UNAVAILABLE' } } });
        expect(handler).not.toHaveBeenCalled();
    });

    it('same-type Views keep independent captured params and business closures', async () => {
        const a = params(), b = params(); const seen: any[] = [];
        function Detail({ id }: { id: string }) { useViewTypeTool('read', { description: 'Read', isMutating: false, params: id === 'aa' ? a : b },
            async args => { seen.push([id, args]); return { success: true, data: { id } }; }); return h('p', {}, id); }
        const x = await setup(Detail, 'snapshot-value-v1', () => h('main', {}, ['aa', 'bb'].map(id => h(View, { id, key: id, type: 'File' }, h(Detail, { id })))));
        expect(x.captures).toHaveLength(2); expect(x.captures[0]).not.toBe(x.captures[1]);
        const tool = x.tool(); for (const target of tool.targets) {
            const args = { file: { owner: target.viewId }, value: target.viewId };
            expect((await x.invoke(args, tool, target)).result.data).toEqual({ id: target.viewId });
            expect(seen.at(-1)).toEqual([target.viewId, args]);
        }
    });

    it.each(['mode-getter', 'factory-getter', 'factory-not-callable', 'bad-return', 'factory-throws', 'unknown-mode'])('rejects unsafe factory metadata: %s', async kind => {
        function Content() { return h('p', {}, 'Mounted'); }
        const x = await setup(Content); let reads = 0;
        const options: any = { safeRefInvocationMode: 'snapshot-value-v1', createSafeRefInvoker: () => async () => ({ phase: 'entered-returned', result: { success: true } }) };
        if (kind === 'mode-getter') Object.defineProperty(options, 'safeRefInvocationMode', { enumerable: true, get() { reads++; return 'snapshot-value-v1'; } });
        if (kind === 'factory-getter') Object.defineProperty(options, 'createSafeRefInvoker', { enumerable: true, get() { reads++; return () => {}; } });
        if (kind === 'factory-not-callable') options.createSafeRefInvoker = true;
        if (kind === 'bad-return') options.createSafeRefInvoker = () => undefined;
        if (kind === 'factory-throws') options.createSafeRefInvoker = () => { throw { message: 'private' }; };
        if (kind === 'unknown-mode') options.safeRefInvocationMode = 'future';
        const instance = x.port.mount('manual', 'Manual');
        expect(() => x.port.registerTool(instance, 'read', { description: 'Read', isMutating: false, params: params(), handler: async () => ({ success: true }) }, options)).toThrow();
        expect(reads).toBe(0); expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0); x.port.unmount(instance);
    });
});
