import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act, render } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import Type from 'typebox';
import { compileOrdinarySchema } from '@aotui/runtime/core';
import { AppRuntimeContext } from './context/AppRuntimeContext.js';
import { AppTools } from './components/AppTools.js';
import { defineViewTypeTool, defineToolSet, refParam } from './tools/view-type-tool.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
const tools = defineToolSet({ inspect: defineViewTypeTool({ viewType: 'File', name: 'inspect',
    description: 'Inspect the captured file.', 
    inputSchema: Type.Object({ file: refParam('File', Type.Object({ path: Type.String() })) }),
}) });
function fixture(component: () => unknown, port: unknown) {
    const view = render(h(AppRuntimeContext.Provider, { value: { appId: 'app', desktopId: 'desktop',
        appTypeTools: port, projection: { beginCommit() {}, endCommit() {} },
        appLifecycle: { protocol: 'app-lifecycle-v2', register: () => () => {} },
    } as any }, h(component, {})));
    cleanups.push(view.unmount); return view;
}
function port() {
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const invokers: Array<(args: any) => Promise<any>> = [];
    const registerTypeTool = vi.fn((definition, options) => {
        const contract = compileOrdinarySchema(definition.inputSchema, 'view-type-parameters-v1');
        if (!contract.ok) throw Error('Invalid fixture contract');
        invokers.push(options.createSafeOrdinaryParametersInvoker(contract.contract));
        const release = vi.fn(); releases.push(release); return release;
    });
    return { protocol: 'view-type-tools-v4', registerTypeTool, releases, invokers };
}
describe('Ref parameters through AppTools', () => {
    it('registers at App scope and releases the trusted callable on unmount', async () => {
        const mock = port(), execute = vi.fn(async () => ({ success: true }));
        const view = fixture(() => h(AppTools, { definition: tools, bindings: { inspect: { execute } } }), mock);
        expect(mock.registerTypeTool).toHaveBeenCalledOnce();
        expect(mock.registerTypeTool.mock.calls[0]![0]).not.toHaveProperty('handler');

        await expect(mock.invokers[0]!({ file: { path: 'a.txt' } })).resolves.toMatchObject({ phase: 'entered-returned' });
        expect(execute).toHaveBeenCalledWith({ file: { path: 'a.txt' } });
        view.unmount(); expect(mock.releases[0]).toHaveBeenCalledOnce();
        expect((await mock.invokers[0]!({ file: { path: 'a.txt' } })).phase).toBe('not-entered');
    });
    it('uses committed handler updates without replacing the registration', async () => {
        const mock = port(); let update!: (n: number) => void; const received: number[] = [];
        function App() { const [revision, setRevision] = useState(1); update = setRevision;
            return h(AppTools, { definition: tools, bindings: { inspect: { execute: () => {
                received.push(revision); return { success: true }; } } } }); }
        fixture(App, mock); await act(async () => update(2));
        expect(mock.registerTypeTool).toHaveBeenCalledOnce();
        await mock.invokers[0]!({ file: { path: 'a.txt' } }); expect(received).toEqual([2]);
    });
    it('refuses an unsupported App port before registering', () => {
        const registerTypeTool = vi.fn();
        expect(() => fixture(() => h(AppTools, { definition: tools, bindings: { inspect: { execute: () => ({ success: true }) } } }),
            { registerTypeTool })).toThrow();
        expect(registerTypeTool).not.toHaveBeenCalled();
    });
    it('registers only while enabled and releases before re-enabling', async () => {
        const mock = port(); let update!: (enabled: boolean) => void;
        function App() { const [enabled, setEnabled] = useState(false); update = setEnabled;
            return h(AppTools, { definition: tools, bindings: { inspect: { enabled, execute: () => ({ success: true }) } } }); }
        const view = fixture(App, mock); expect(mock.registerTypeTool).not.toHaveBeenCalled();
        await act(async () => update(true)); expect(mock.registerTypeTool).toHaveBeenCalledOnce();
        await act(async () => update(false)); expect(mock.releases[0]).toHaveBeenCalledOnce();

        await act(async () => update(true)); expect(mock.registerTypeTool).toHaveBeenCalledTimes(2);
    });
});
