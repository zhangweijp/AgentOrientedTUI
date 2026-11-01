import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useContext } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { createTUIApp, View, useDataRef, useState, useViewTypeTool } from './index.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { ViewRuntimeContext } from './contexts/view-runtime-context.js';

const cleanups: Array<() => Promise<void>> = [];
const ref = { type: 'reference' as const, required: true as const, refSource: 'snapshot-value-v1' as const };

async function setup(Content: () => any, options: {
    patch?: (port: any) => void;
    beforeRegister?: (definition: any) => void;
} = {}, witness: any = {}, root?: any) {
    witness.register = 0;
    witness.factories = [];
    witness.release = 0;
    witness.modes = [];
    const factory = createTUIApp({ app_name: 'readonly_ref_test', component: root ?? (() => h(View, { id: 'aa', type: 'File' }, h(Content, {}))) });
    const initialize = factory.initializeComponent;
    factory.initializeComponent = async (container, context) => {
        const base = context.viewTools!;
        const port: any = {
            ...base,
            fingerprintReadOnlyParams: vi.fn(base.fingerprintReadOnlyParams!),
            fingerprintOrdinaryParams: vi.fn(base.fingerprintOrdinaryParams!),
            registerTool(instanceId: string, name: string, definition: any, metadata: any) {
                witness.register++;
                witness.modes.push(metadata?.safeSnapshotValueParametersInvocationMode ?? metadata?.safeOrdinaryParametersInvocationMode);
                options.beforeRegister?.(definition);
                if (!metadata) return base.registerTool(instanceId, name, definition, metadata);
                const key = metadata.safeSnapshotValueParametersInvocationMode
                    ? 'createSafeSnapshotValueParametersInvoker'
                    : 'createSafeOrdinaryParametersInvoker';
                const release = base.registerTool(instanceId, name, definition, {
                    ...metadata,
                    [key]: (contract: any) => {
                        witness.factories.push(contract);
                        return metadata[key](contract);
                    },
                });
                return () => { witness.release++; release(); };
            },
        };
        witness.port = port;
        options.patch?.(port);
        return initialize(container, { ...context, viewTools: port });
    };
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
    kernel.setId('app' as any);
    kernel.setAppExecutionInstanceId('run');
    const container = document.createElement('div');
    document.body.appendChild(container);
    cleanups.push(async () => { await kernel.onClose(); container.remove(); });
    await kernel.onOpen({ appId: 'app' as any, desktopId: 'd' as any, markDirty() {}, onRender() {} }, container);
    const tool = () => kernel.getViewOwnedToolDefinitions()[0]!;
    return {
        kernel, container, witness, tool,
        invoke: (args: any, source = tool(), target = source.targets[0]) =>
            kernel.invokeBoundSnapshotValueParametersViewTool(source, target, args),
    };
}

afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); });

describe('useViewTypeTool snapshot-value-v2 parameters', () => {
    it('captures the original immutable Ref value and validates mixed ordinary fields without defaults', async () => {
        const handler = vi.fn((args: any) => {
            expect(Object.isFrozen(args.file.list)).toBe(true);
            expect(Object.hasOwn(args, 'limit')).toBe(false);
            return { success: true, data: { value: args.file } };
        });
        function Content() {
            const file = useDataRef('file-ref', { list: [1] });
            const [Tool] = useViewTypeTool('inspect', { description: 'Inspect file', isMutating: false,
                params: { file: ref, choice: { type: 'enum', options: ['text', 'json'] as const }, limit: { type: 'number', default: 2 } } }, handler);
            return h('section', {}, [file('Current file'), h(Tool, {}, 'Inspect')]);
        }
        const x = await setup(Content);
        const source = x.tool();
        expect(x.witness.modes).toEqual(['snapshot-value-v2']);
        expect(x.witness.factories).toHaveLength(1);
        expect(source.isMutating).toBe(false);
        expect(source.inputSchema).toEqual({ ...x.witness.factories[0].schema, 'x-aotui-parameter-contract': 'snapshot-value-params-v1' });
        expect(source.inputSchema).toMatchObject({ properties: { file: { type: 'string', 'x-aotui-ref': { version: 1 } } } });
        expect(x.container.querySelector('tool-ref')?.textContent).toBe('Inspect');
        expect(await x.invoke({ file: { list: [1] }, choice: 7 })).toMatchObject({ phase: 'not-entered' });
        expect(await x.invoke({ file: { list: [1] }, choice: 'text' })).toMatchObject({ phase: 'entered-returned', result: { success: true } });
        expect(handler).toHaveBeenCalledOnce();
    });

    it('rejects missing Ref V2 support or invalid classifier output before registration, even while disabled', async () => {
        const handler = vi.fn(() => ({ success: true }));
        function Content() {
            useViewTypeTool('inspect', { description: 'Inspect', isMutating: false, params: { file: ref } }, handler, { enabled: false });
            return null;
        }
        for (const missing of ['support', 'classifier']) {
            const witness: any = {};
            await expect(setup(Content, { patch(port) {
                if (missing === 'support') port.safeSnapshotValueParametersInvocationSupport = undefined;
                else port.fingerprintReadOnlyParams = undefined;
            } }, witness)).rejects.toThrow('READONLY_PARAMETERS_UNSUPPORTED');
            expect(witness.register).toBe(0);
            expect(witness.factories).toHaveLength(0);
        }
        function InvalidClassifier() {
            useViewTypeTool('inspect', { description: 'Inspect', isMutating: false, params: { file: ref } }, handler);
            return null;
        }
        await expect(setup(InvalidClassifier, { patch(port) {
            port.fingerprintReadOnlyParams = () => ({ kind: 'ordinary', fingerprint: 'wrong' });
        } })).rejects.toThrow('READONLY_PARAMETERS_UNSUPPORTED');
        expect(handler).not.toHaveBeenCalled();
    });

    it('requires explicitly read-only Ref declarations and exactly one supported Ref', async () => {
        const witness: any = {};
        function Mutating() { useViewTypeTool('inspect', { description: 'Inspect', params: { file: ref } } as any, async () => ({ success: true })); return null; }
        await expect(setup(Mutating, {}, witness)).rejects.toThrow('REF_DECLARATION_INVALID');
        expect(witness.register).toBe(0);
        function Multiple() { useViewTypeTool('inspect', { description: 'Inspect', isMutating: false, params: { a: ref, b: ref } } as any, async () => ({ success: true })); return null; }
        await expect(setup(Multiple)).rejects.toThrow('PARAMETER_DECLARATION_UNSUPPORTED');
    });

    it('keeps same-type Views and their captured values isolated', async () => {
        const seen: any[] = [];
        function Detail({ id }: { id: string }) {
            useViewTypeTool('read', { description: 'Read', isMutating: false, params: { file: ref } },
                async args => { seen.push([id, args.file]); return { success: true, data: { id } }; });
            return h('p', {}, id);
        }
        const x = await setup(Detail, {}, {}, () => h('main', {}, ['aa', 'bb'].map(id => h(View, { id, key: id, type: 'File' }, h(Detail, { id })))));
        const source = x.kernel.getViewOwnedToolDefinitions()[0]!;
        expect(source.targets).toHaveLength(2);
        for (const target of source.targets) {
            const original = { owner: target.viewId };
            expect((await x.invoke({ file: original }, source, target)).result.data).toEqual({ id: target.viewId });
            expect(seen.at(-1)).toEqual([target.viewId, original]);
        }
        expect(seen[0]![1]).not.toBe(seen[1]![1]);
    });

    it('updates only the committed handler and revokes bindings when Ref parameters change', async () => {
        let update!: (revision: number) => void;
        const calls: number[] = [];
        const params = { file: ref, text: { type: 'string' as const, constraints: { maxLength: 2 } } };
        function Content() {
            const [revision, set] = useState(1); update = set;
            useViewTypeTool('read', { description: 'Read', isMutating: false, params }, async () => {
                calls.push(revision); return { success: true, data: { revision } };
            });
            return null;
        }
        let firstRegistration = true;
        const x = await setup(Content, { beforeRegister() { if (firstRegistration) { firstRegistration = false; params.text.constraints.maxLength = 1; } } });
        const old = x.tool();
        expect(await x.invoke({ file: {}, text: 'xx' })).toMatchObject({ phase: 'not-entered' });
        await act(() => update(2));
        expect(x.tool().targets[0].bindingVersion).toBe(old.targets[0].bindingVersion);
        expect(x.witness.factories).toHaveLength(1);
        expect((await x.invoke({ file: {}, text: 'x' })).result.data).toEqual({ revision: 2 });
        await act(() => { params.text.constraints.maxLength = 3; update(3); });
        expect(x.tool().targets[0].bindingVersion).not.toBe(old.targets[0].bindingVersion);
        expect((await x.invoke({ file: {}, text: 'xx' }, old)).phase).toBe('not-entered');
        expect(calls).toEqual([2]);
    });

    it('does not publish a handler from a failed Preact render', async () => {
        let update!: (failed: boolean) => void;
        const calls: string[] = [];
        function Content() {
            const [failed, set] = useState(false); update = set;
            useViewTypeTool('read', { description: 'Read', isMutating: false, params: { file: ref } }, async () => {
                calls.push(failed ? 'uncommitted' : 'committed'); return { success: true };
            });
            if (failed) throw new Error('controlled failed Ref render');
            return null;
        }
        const x = await setup(Content), original = x.tool();
        await expect(Promise.resolve().then(() => act(() => update(true)))).rejects.toThrow('controlled failed Ref render');
        const result = await x.invoke({ file: {} }, original);
        expect(calls).not.toContain('uncommitted');
        if (result.phase === 'entered-returned') expect(calls).toEqual(['committed']);
        else expect(calls).toEqual([]);
    });

    it('releases a disabled registration and assigns a new binding when re-enabled', async () => {
        let toggle!: () => void;
        function Content() {
            const [enabled, set] = useState(true); toggle = () => set(!enabled);
            useViewTypeTool('read', { description: 'Read', isMutating: false, params: { file: ref } }, async () => ({ success: true }), { enabled });
            return null;
        }
        const x = await setup(Content), old = x.tool();
        await act(toggle);
        expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
        expect(x.witness.release).toBe(1);
        expect((await x.invoke({ file: {} }, old)).phase).toBe('not-entered');
        await act(toggle);
        expect(x.tool().targets[0].bindingVersion).not.toBe(old.targets[0].bindingVersion);
        expect((await x.invoke({ file: {} })).phase).toBe('entered-returned');
    });
});
