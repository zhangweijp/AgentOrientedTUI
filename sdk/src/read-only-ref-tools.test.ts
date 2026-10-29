import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useContext } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { createTUIApp, View, useDataRef, useState, experimental_useReadOnlyTool as useRead } from './index.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { ViewRuntimeContext } from './contexts/view-runtime-context.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close();vi.restoreAllMocks(); });
const ref = { type: 'reference' as const, required: true as const, refSource: 'snapshot-value-v1' as const };
async function setup(Content: () => any, options: { patch?: (port: any) => void; beforeRegister?: (definition: any) => void } = {}, witness: any = {}) {
    witness.register = 0;witness.factories = [];witness.release = 0;
    const factory = createTUIApp({ app_name: 'readonly_ref_test', component: () => h(View, { id: 'aa', type: 'File' }, h(Content, {})) });
    const initialize = factory.initializeComponent;
    factory.initializeComponent = async (container, context) => {
        const base = context.viewTools!;
        const port: any = { ...base, fingerprintReadOnlyParams: vi.fn(base.fingerprintReadOnlyParams!), fingerprintOrdinaryParams: vi.fn(base.fingerprintOrdinaryParams!),
            registerTool(id: string, name: string, definition: any, metadata: any) {
                witness.register++;options.beforeRegister?.(definition);
                const key = metadata.safeSnapshotValueParametersInvocationMode ? 'createSafeSnapshotValueParametersInvoker' : 'createSafeOrdinaryParametersInvoker';
                const release = base.registerTool(id, name, definition, { ...metadata, [key]: (contract: any) => {
                    witness.factories.push(contract);return metadata[key](contract);
                } });return () => { witness.release++;release(); };
            } };
        witness.port = port;options.patch?.(port);return initialize(container, { ...context, viewTools: port });
    };
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);kernel.setId('app' as any);kernel.setAppExecutionInstanceId('run');
    const container = document.createElement('div');document.body.appendChild(container);cleanups.push(async () => { await kernel.onClose();container.remove(); });
    await kernel.onOpen({ appId: 'app' as any, desktopId: 'd' as any, markDirty() {}, onRender() {} }, container);
    const tool = () => kernel.getViewOwnedToolDefinitions()[0]!;
    return { kernel, container, witness, tool, invoke: (args: any, source = tool()) => kernel.invokeBoundSnapshotValueParametersViewTool(source, source.targets[0]!, args) };
}
describe('R05/Q01 unified classification and preserved ordinary capability contract', () => {
    it('uses only the new render classifier while counting actual ordinary commit capture separately', async () => {
        let renders = 0;function Content() { renders++;useRead('plain', { description: 'Plain', params: { q: { type: 'string' } } }, () => ({ success: true }));return null; }
        const x = await setup(Content);expect(x.witness.port.fingerprintReadOnlyParams).toHaveBeenCalledTimes(renders);expect(x.witness.port.fingerprintOrdinaryParams).not.toHaveBeenCalled();
        expect(x.witness.factories).toHaveLength(1);expect(x.witness.factories[0].revision).toBe('ordinary-params-v1');
    });
    it.each(['support', 'fingerprint'])('rejects missing ordinary %s even disabled before register/factory/handler', async missing => {
        const w: any = {}, handler = vi.fn(() => ({ success: true }));function Content() { useRead('plain', { description: 'Plain', params: {}, enabled: false }, handler);return null; }
        await expect(setup(Content, { patch(port) { if (missing === 'support') port.safeOrdinaryParametersInvocationSupport = undefined;else port.fingerprintOrdinaryParams = undefined; } }, w)).rejects.toThrow('ORDINARY_PARAMETERS_UNSUPPORTED');
        expect(w.register).toBe(0);expect(w.factories).toHaveLength(0);expect(handler).not.toHaveBeenCalled();
    });
    it('falls back only for the complete old ordinary port, with no new classifier', async () => {
        function Content() { useRead('plain', { description: 'Plain', params: {} }, () => ({ success: true }));return null; }
        const x = await setup(Content, { patch(port) { port.fingerprintReadOnlyParams = undefined; } });expect(x.witness.port.fingerprintOrdinaryParams).toHaveBeenCalled();expect(x.witness.factories).toHaveLength(1);
    });
    it('uses independent new Ref capability after removing both old ordinary requirements', async () => {
        const handler = vi.fn(() => ({ success: true }));function Content() { useRead('read', { description: 'Read', params: { file: ref } }, handler);return null; }
        const x = await setup(Content, { patch(port) { port.safeOrdinaryParametersInvocationSupport = undefined;port.fingerprintOrdinaryParams = undefined; } });
        expect((await x.invoke({ file: {} })).phase).toBe('entered-returned');expect(handler).toHaveBeenCalledOnce();expect(x.witness.factories[0].revision).toBe('snapshot-value-params-v1');
    });
    it.each(['unknown', 'null', 'throw', 'nonfunction'])('does not fall back after invalid new classification %s', async kind => {
        const w: any = {};function Content() { useRead('read', { description: 'Read', params: { file: ref } }, () => ({ success: true }));return null; }
        await expect(setup(Content, { patch(port) {
            if (kind === 'nonfunction') port.fingerprintReadOnlyParams = true;
            else port.fingerprintReadOnlyParams = vi.fn(() => { if (kind === 'throw') throw Error('CONTROLLED_CLASSIFIER_FAILURE');return kind === 'null' ? null : { kind: 'other', fingerprint: 'key' }; });
        } }, w)).rejects.toThrow();
        expect(w.port.fingerprintOrdinaryParams).not.toHaveBeenCalled();expect(w.register).toBe(0);expect(w.factories).toHaveLength(0);
    });
    it('rejects Ref on an actual old ordinary-only classification port', async () => {
        const w: any = {};function Content() { useRead('read', { description: 'Read', params: { file: ref } }, () => ({ success: true }));return null; }
        await expect(setup(Content, { patch(port) { port.fingerprintReadOnlyParams = undefined; } }, w)).rejects.toThrow('PARAMETER_DECLARATION_UNSUPPORTED');expect(w.register).toBe(0);
    });
    it('rejects two Refs at runtime and missing new support before any registration', async () => {
        const w: any = {};function Multiple() { useRead('read', { description: 'Read', params: { a: ref, b: ref } }, () => ({ success: true }));return null; }
        await expect(setup(Multiple, {}, w)).rejects.toThrow('PARAMETER_DECLARATION_UNSUPPORTED');expect(w.register).toBe(0);expect(w.factories).toHaveLength(0);
        const missing: any = {};function Single() { useRead('read', { description: 'Read', params: { file: ref }, enabled: false }, () => ({ success: true }));return null; }
        await expect(setup(Single, { patch(port) { port.safeSnapshotValueParametersInvocationSupport = undefined; } }, missing)).rejects.toThrow('READONLY_PARAMETERS_UNSUPPORTED');expect(missing.register).toBe(0);expect(missing.factories).toHaveLength(0);
    });
});
describe('R13/R14/R15/R21 real SDK commit capture and safe entry', () => {
    it.each(['port', 'generation'])('releases the old Ref wrapper on controlled context %s change', async kind => {
        let update!: () => void;
        function Child() { useRead('read', { description: 'Read', params: { file: ref } }, () => ({ success: true }));return null; }
        function Content() {
            const context = useContext(ViewRuntimeContext)!;const [revision, set] = useState(0);update = () => set(revision + 1);
            const value = { ...context, meta: { ...context.meta, viewGeneration: context.meta.viewGeneration + (kind === 'generation' ? revision : 0) },
                viewTools: kind === 'port' && revision ? { ...context.viewTools! } : context.viewTools };
            return h(ViewRuntimeContext.Provider, { value }, h(Child, {}));
        }
        const x = await setup(Content), old = x.tool();await act(update);
        expect(x.witness.release).toBe(1);expect(x.witness.factories).toHaveLength(2);
        expect(x.tool().targets[0]!.bindingVersion).not.toBe(old.targets[0]!.bindingVersion);
        expect((await x.invoke({ file: {} }, old)).phase).toBe('not-entered');expect((await x.invoke({ file: {} })).phase).toBe('entered-returned');
    });
    it('validates the same full contract, preserves literals and defaults, and freezes the full Ref payload', async () => {
        const handler = vi.fn((args: any) => { expect(Object.isFrozen(args.file.list)).toBe(true);expect(Object.hasOwn(args, 'n')).toBe(false);return { success: true, data: { value: args.file } }; });
        function Content() { const r = useDataRef('id', { list: [1] });const [Tool] = useRead('read', { description: 'Read', params: { file: ref, choice: { type: 'enum', options: ['ok'] }, n: { type: 'number', default: 2 } } }, handler);return h('p', {}, [r('Original'), h(Tool, {})]); }
        const x = await setup(Content);expect(x.tool().inputSchema).toEqual(x.witness.factories[0].schema);expect(x.witness.factories).toHaveLength(1);
        expect(await x.invoke({ file: { list: [1] }, choice: 7 })).toMatchObject({ phase: 'not-entered' });expect(await x.invoke({ file: 'id' })).toMatchObject({ phase: 'not-entered' });expect(handler).not.toHaveBeenCalled();
        expect(await x.invoke({ file: { list: [1] }, choice: 'ok' })).toMatchObject({ phase: 'entered-returned', result: { success: true } });expect(handler).toHaveBeenCalledOnce();
    });
    it('uses actual commit fingerprint, then updates only the committed handler without rebinding', async () => {
        const p = { file: ref, text: { type: 'string' as const, constraints: { maxLength: 2 } } };let update!: () => void, once = true;
        function Content() { const [revision, set] = useState(1);update = () => set(revision + 1);useRead('read', { description: 'Read', params: p }, () => ({ success: true, data: { revision } }));return null; }
        const x = await setup(Content, { beforeRegister() { if (once) { once = false;p.text.constraints.maxLength = 1; } } });const old = x.tool();
        expect((old.inputSchema as any).properties.text.maxLength).toBe(1);expect((await x.invoke({ file: {}, text: 'xx' })).phase).toBe('not-entered');
        await act(update);expect(x.tool().targets[0]!.bindingVersion).toBe(old.targets[0]!.bindingVersion);expect(x.witness.factories).toHaveLength(1);
        expect(await x.invoke({ file: {}, text: 'x' })).toMatchObject({ result: { data: { revision: 2 } } });
        p.text.constraints.maxLength = 3;await act(update);expect(x.tool().targets[0]!.bindingVersion).not.toBe(old.targets[0]!.bindingVersion);expect((await x.invoke({ file: {} }, old)).phase).toBe('not-entered');
    });
    it('releases disabled registrations and assigns new identity on re-enable', async () => {
        let toggle!: () => void;function Content() { const [enabled, set] = useState(true);toggle = () => set(!enabled);useRead('read', { description: 'Read', params: { file: ref }, enabled }, () => ({ success: true }));return null; }
        const x = await setup(Content), old = x.tool();await act(toggle);expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);expect(x.witness.release).toBe(1);
        expect((await x.invoke({ file: {} }, old)).phase).toBe('not-entered');await act(toggle);expect(x.tool().targets[0]!.bindingVersion).not.toBe(old.targets[0]!.bindingVersion);
    });
});
