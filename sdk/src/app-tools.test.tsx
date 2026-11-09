import { Component, h, type ComponentChildren } from 'preact';
import { act, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Type from 'typebox';
import { createViewOwnedTools } from '@aotui/runtime/core';
import { createAppId, createDesktopId, type AppTypeToolDefinition, type AppTypeToolRegistrationOptions } from '@aotui/runtime/spi';
import { SemanticProjectionCoordinator } from '../../runtime/src/core/projection/coordinator.js';
import { AppRuntimeContext } from './context/AppRuntimeContext.js';
import { AppTools, ToolRef, ToolCatalog } from './components/AppTools.js';
import { View } from './components/View.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import * as bindingModule from './tools/view-type-tool.js';
import type { ToolMap, ToolSet, ToolBindingController } from './tools/view-type-tool.js';
import type { IAppTypeToolPort } from '@aotui/runtime/spi';
import { createToolBindings, defineToolSet, defineViewTypeTool, getToolCatalog } from './tools/view-type-tool.js';

const tools = defineToolSet({
    read: defineViewTypeTool({ viewType: 'Card', name: 'read', description: 'Read a card.',  inputSchema: Type.Object({ path: Type.String() }) }),
    other: defineViewTypeTool({ viewType: 'Card', name: 'other', description: 'Another card action.', inputSchema: Type.Object({}) }),
});
const bindings = (label: string, enabled = true) => ({
    read: { enabled, execute: (args: Readonly<{ path: string }>) => ({ success: true, data: { label, path: args.path } }) },
    other: { execute: () => ({ success: true }) },
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

function environment(name: string) {
    const registry = createViewOwnedTools(name, name + '_run');
    const projection = new SemanticProjectionCoordinator();
    const begin = vi.spyOn(projection, 'beginCommit'), end = vi.spyOn(projection, 'endCommit');
    let registers = 0, releases = 0;
    const context = {
        appId: createAppId(name), desktopId: createDesktopId('cards'),
        markDirty() {}, projection, toolCleanup: new Set<() => void>(),
        refExporter: { registerRef() { throw new Error('This fixture has no Refs'); } },
        appTypeTools: {
            protocol: 'view-type-tools-v4' as const,
            registerTypeTool(definition: AppTypeToolDefinition, options: AppTypeToolRegistrationOptions) {
                registers++; const release = registry.registerTypeTool(definition, options);
                projection.recordMutation('tool');
                return () => { releases++; release(); projection.recordMutation('tool'); };
            },
        },
        viewTools: {
            mount(id: string, type: string) { const view = registry.mount(id, type); projection.recordMutation('view'); return view.viewInstanceId; },
            unmount(id: string) { registry.unmount(id); projection.recordMutation('view'); },
        },
        appLifecycle: { protocol: 'app-lifecycle-v2' as const, register() { return () => {}; } },
    };
    cleanups.push(() => registry.dispose());
    return { registry, context, projection, begin, end, counts: () => ({ registers, releases }) };
}
type Environment = ReturnType<typeof environment>;
function call(x: Environment, observed = x.registry.listTools().find(tool => tool.name === 'read')!) {
    if (observed.execution.kind !== 'view-type') throw new Error('Expected type activation');
    return x.registry.invokeTypeTool(observed, observed.execution, { path: 'file' });
}
class Boundary extends Component<{ children?: ComponentChildren; onError?(error: unknown): void }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error: unknown) { this.props.onError?.(error); }
    render() { return this.state.failed ? h('p', {}, 'Fallback') : this.props.children; }
}
const card = (id = 'card') => h(View, {kind: 'state', id, type: 'Card', key: id }, h(ToolRef, { tool: tools.read }));
function mount(x: Environment, children: ComponentChildren) {
    const view = render(h(AppRuntimeContext.Provider, { value: x.context }, children));
    cleanups.push(view.unmount); return view;
}

describe('M3 AppTools Preact adapter', () => {
    it('presents the first candidate without an extra render and omission never disables a binding', async () => {
        const x = environment('first'); let renders = 0;
        function Content() { renders++; return h(View, {kind: 'state', id: 'card', type: 'Card' }, h(ToolRef, { tool: tools.read })); }
        const view = mount(x, h(AppTools, { definition: tools, bindings: bindings('first') }, h(Content, {})));
        expect(renders).toBe(1); expect(view.container.querySelectorAll('tool-ref')).toHaveLength(1);
        expect(x.registry.listTools()).toHaveLength(2);
        expect((await call(x)).result).toMatchObject({ success: true, data: { label: 'first' } });
        view.unmount(); expect(x.registry.inspect().bindings).toBe(0); expect(x.registry.inspect().views).toBe(0);
        expect(x.begin).toHaveBeenCalledTimes(x.end.mock.calls.length);
    });

    it('rejects missing context, foreign definitions and mismatched View types before registering', () => {
        expect(() => render(h(ToolRef, { tool: tools.read }))).toThrow('TOOL_REF_CONTEXT_REQUIRED');
        const foreign = defineViewTypeTool({ viewType: 'Card', name: 'foreign', description: 'Foreign.', inputSchema: Type.Object({}) });
        for (const [tool, type, code] of [[foreign, 'Card', 'TOOL_REF_OUTSIDE_SET'], [tools.read, 'Wrong', 'TOOL_REF_VIEW_TYPE_MISMATCH']] as const) {
            const x = environment(code); let failure: unknown;
            mount(x, h(Boundary, { onError: error => { failure = error; } }, h(AppTools, { definition: tools, bindings: bindings('bad') },
                h(View, {kind: 'state', type: 'card', id: 'card', type }, h(ToolRef, { tool })))));
            expect(failure).toMatchObject({ code }); expect(x.registry.inspect().bindings).toBe(0);
        }
    });

    it('captures a detached candidate without getters and ignores mutation after render capture', async () => {
        const x = environment('captured'), candidate = bindings('captured');
        function Mutate() { candidate.read.execute = () => ({ success: true, data: { label: 'mutated', path: 'wrong' } }); candidate.read.enabled = false; return card(); }
        const view = mount(x, h(AppTools, { definition: tools, bindings: candidate }, h(Mutate, {})));
        expect(view.container.querySelector('tool-ref')).not.toBeNull(); expect((await call(x)).result).toMatchObject({ data: { label: 'captured' } });
        view.unmount();
        let reads = 0; const bad = bindings('getter'); Object.defineProperty(bad.read, 'execute', { enumerable: true, get() { reads++; return () => ({ success: true }); } });
        let failure: unknown;
        mount(x, h(Boundary, { onError: error => { failure = error; } }, h(AppTools, { definition: tools, bindings: bad }, card())));
        expect(failure).toMatchObject({ code: 'TOOL_BINDING_INVALID' }); expect(reads).toBe(0); expect(x.registry.inspect().bindings).toBe(0);
    });

    it.each([true, false])('does not execute or publish a failed candidate render from initial enabled=%s', async enabled => {
        const x = environment('failed_' + enabled); let update!: () => void; let before: ReturnType<typeof call> | undefined;
        const candidate = vi.fn(() => ({ success: true })); let observed: ReturnType<typeof x.registry.listTools>[number];
        const { useState } = await import('preact/hooks');
        function Child({ fail }: { fail: boolean }) {
            if (fail) { if (observed) before = call(x, observed); expect(x.registry.listTools().some(tool => tool.name === 'read')).toBe(enabled); throw new Error('child render failed'); }
            return card();
        }
        function App() { const [fail, set] = useState(false); update = () => set(true);
            return h(AppTools, { definition: tools, bindings: fail ? { ...bindings('candidate', !enabled), read: { enabled: !enabled, execute: candidate } } : bindings('committed', enabled) }, h(Child, { fail })); }
        mount(x, h(Boundary, {}, h(App, {}))); observed = x.registry.listTools().find(tool => tool.name === 'read')!;
        await act(async () => update());
        if (before) expect((await before).result).toMatchObject({ data: { label: 'committed' } });
        expect(candidate).not.toHaveBeenCalled(); expect(x.registry.inspect().bindings).toBe(0); expect(x.registry.inspect().views).toBe(0);
    });

    it.each([true, false])('preserves the previous frame in parent layout after a descendant throws (initial enabled=%s)', async enabled => {
        const x = environment('layout_' + enabled);
        const { useLayoutEffect, useState } = await import('preact/hooks');
        const candidate = vi.fn(() => ({ success: true }));
        const error = new Error('descendant render failed');
        let update!: () => void, caught: unknown, observedAtLayout = false;
        let invocation: ReturnType<typeof call> | undefined;
        const Child = ({ fail }: { fail: boolean }) => {
            if (fail) throw error;
            return card();
        };
        function App() {
            const [fail, setFail] = useState(false);
            update = () => setFail(true);
            useLayoutEffect(() => {
                if (!fail) return;
                expect(caught).toBe(error);
                observedAtLayout = true;
                const read = x.registry.listTools().find(tool => tool.name === 'read');
                if (read) invocation = call(x, read);
            }, [fail]);
            return h(Boundary, { onError: value => { caught = value; } }, h(AppTools, {
                definition: tools,
                bindings: fail ? { ...bindings('new'), read: { execute: candidate } } : bindings('committed', enabled),
            }, h(Child, { fail })));
        }
        mount(x, h(App, {}));
        await act(async () => update());
        expect(observedAtLayout).toBe(true);
        expect(candidate).not.toHaveBeenCalled();
        if (enabled) expect((await invocation)?.result).toMatchObject({ data: { label: 'committed' } });
        else expect(invocation).toBeUndefined();
        expect(x.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        expect(x.begin).toHaveBeenCalledTimes(x.end.mock.calls.length);
    });

    it('rejects a second disabled owner and keeps the first owner and another App intact', async () => {
        const a = environment('owner_a'), b = environment('owner_b');
        const first = mount(a, h(AppTools, { definition: tools, bindings: bindings('A') }, card()));
        mount(b, h(AppTools, { definition: tools, bindings: bindings('B') }, card()));
        let failure: unknown;
        const disabled = bindings('other', false); const secondBindings = { ...disabled, other: { ...disabled.other, enabled: false } };
        const second = mount(a, h(Boundary, { onError: error => { failure = error; } }, h(AppTools, { definition: tools, bindings: secondBindings })));
        expect(failure).toMatchObject({ code: 'TOOL_BINDING_OWNER_CONFLICT' });
        expect((await call(a)).result).toMatchObject({ data: { label: 'A' } }); expect((await call(b)).result).toMatchObject({ data: { label: 'B' } });
        second.unmount(); first.unmount(); expect(a.registry.inspect().bindings).toBe(0); expect((await call(b)).result.success).toBe(true);
    });

    it('rejects direct definition and port replacement before mutation and permits explicit remount', async () => {
        const a = environment('identity_a'), b = environment('identity_b');
        const other = defineToolSet({ read: tools.read, other: tools.other }); let failure: unknown;
        const child = (definition: typeof tools, key: string) => h(Boundary, { key, onError: error => { failure = error; } }, h(AppTools, { definition, bindings: bindings('identity') }, card()));
        const view = mount(a, child(tools, 'first'));
        await act(async () => view.rerender(h(AppRuntimeContext.Provider, { value: a.context }, child(other, 'first'))));
        expect(failure).toMatchObject({ code: 'APP_TOOLS_IDENTITY_CHANGED' }); expect(a.registry.inspect().bindings).toBe(0);
        await act(async () => view.rerender(h(AppRuntimeContext.Provider, { value: a.context }, child(other, 'second'))));
        expect(a.registry.inspect().bindings).toBe(2);
        await act(async () => view.rerender(h(AppRuntimeContext.Provider, { value: { ...a.context, appTypeTools: b.context.appTypeTools } }, child(other, 'second'))));
        expect(failure).toMatchObject({ code: 'APP_TOOLS_IDENTITY_CHANGED' }); expect(b.registry.inspect().bindings).toBe(0);
        await act(async () => view.rerender(h(AppRuntimeContext.Provider, { value: b.context }, child(other, 'third'))));
        expect(b.registry.inspect().bindings).toBe(2); view.unmount(); expect(b.registry.inspect().bindings).toBe(0);
    });

    it('closes one owner on register failure with balanced projection and preserves a healthy App', async () => {
        const a = environment('register_fail'), b = environment('healthy'); mount(b, h(AppTools, { definition: tools, bindings: bindings('healthy') }, card()));
        const register = a.context.appTypeTools.registerTypeTool; let calls = 0, failure: unknown;
        a.context.appTypeTools.registerTypeTool = (definition, options) => { if (++calls === 2) throw Object.assign(new Error('second registration failed'), { code: 'INJECTED' }); return register(definition, options); };
        mount(a, h(Boundary, { onError: error => { failure = error; } }, h(AppTools, { definition: tools, bindings: bindings('bad') }, card())));
        expect(failure).toMatchObject({ code: 'TOOL_BINDING_COMMIT_FAILED', diagnostics: { original: { code: 'INJECTED' } } });
        expect(a.registry.inspect().bindings).toBe(0); expect(a.begin).toHaveBeenCalledTimes(a.end.mock.calls.length); expect(a.projection.token().ready).toBe(true);
        expect((await call(b)).result).toMatchObject({ data: { label: 'healthy' } });
    });

    it.each(['initialize', 'unmount', 'reentrant-unmount'] as const)('revokes Tools before a parent cleanup can interrupt %s', async phase => {
        const { useLayoutEffect } = await import('preact/hooks');
        const x = environment('interrupted_' + phase);
        const mountError = new Error('application layout failed'), cleanupError = new Error('application cleanup failed');
        const execute = vi.fn(() => ({ success: true }));
        let old!: ReturnType<typeof x.registry.listTools>[number];
        let duringCleanup: ReturnType<typeof call> | undefined;
        let nestedClose: (() => void) | undefined;
        const readyTools: string[][] = [];
        const unsubscribe = x.projection.subscribe(() => readyTools.push(x.registry.listTools().map(tool => tool.name)));
        function App() {
            useLayoutEffect(() => {
                old = x.registry.listTools().find(tool => tool.name === 'read')!;
                return () => {
                    if (duringCleanup) return;
                    duringCleanup = call(x, old);
                    nestedClose?.();
                    throw cleanupError;
                };
            }, []);
            useLayoutEffect(() => { if (phase === 'initialize') throw mountError; }, []);
            return h(AppTools, { definition: tools, bindings: { ...bindings('closed'), read: { execute } } }, card());
        }
        const container = document.createElement('div');
        const initialized = createTUIApp({ app_name: 'interrupted', component: App }).initializeComponent(container, x.context);
        const renderer = phase === 'initialize' ? undefined : await initialized;
        if (renderer) {
            if (phase === 'reentrant-unmount') nestedClose = () => renderer.unmount();
            readyTools.length = 0;
            expect(() => renderer.unmount()).toThrow(cleanupError);
        } else {
            await expect(initialized).rejects.toBe(mountError);
        }
        expect((await duringCleanup)?.phase).toBe('not-entered');
        expect((await call(x, old)).phase).toBe('not-entered');
        expect(execute).not.toHaveBeenCalled();
        expect(x.registry.inspect().bindings).toBe(0);
        expect(readyTools.flat()).toEqual([]);
        unsubscribe();
        const successor = await createTUIApp({ app_name: 'successor',
            component: () => h(AppTools, { definition: tools, bindings: bindings('successor') }, card()),
        }).initializeComponent(document.createElement('div'), x.context);
        renderer?.unmount();
        expect((await call(x)).result).toMatchObject({ data: { label: 'successor' } });
        successor.unmount();
        expect(x.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        expect(x.begin).toHaveBeenCalledTimes(x.end.mock.calls.length);
    });

    it('retains failed unmount cleanup for renderer retry without taking the business lifecycle owner', async () => {
        const x = environment('cleanup'), normal = x.context.appTypeTools.registerTypeTool; let fail = true;
        x.context.appTypeTools.registerTypeTool = (definition, options) => { const release = normal(definition, options); return () => { if (fail && definition.name === 'read') throw new Error('release refused'); release(); }; };
        let lifecycleRegistrations = 0;
        x.context.appLifecycle.register = () => { lifecycleRegistrations++; return () => {}; };
        function App() { return h(AppTools, { definition: tools, bindings: bindings('cleanup') }, card()); }
        const factory = createTUIApp({ app_name: 'cleanup', component: App }); const container = document.createElement('div');
        const renderer = await factory.initializeComponent(container, x.context);
        expect(lifecycleRegistrations).toBe(0);
        expect(() => renderer.unmount()).toThrow('TOOL_BINDING_CLEANUP_FAILED'); expect(x.registry.inspect().bindings).toBe(1);
        const successor = createToolBindings({ definition: tools, appTypeTools: x.context.appTypeTools });
        expect(() => successor.commit(bindings('early'))).toThrow('TOOL_BINDING_OWNER_CONFLICT');
        fail = false; renderer.unmount(); expect(x.registry.inspect().bindings).toBe(0);
        const next = await factory.initializeComponent(container, x.context); expect(x.registry.inspect().bindings).toBe(2);
        renderer.unmount(); expect(x.registry.inspect().bindings).toBe(2); next.unmount(); expect(x.registry.inspect().bindings).toBe(0);
        expect(x.begin).toHaveBeenCalledTimes(x.end.mock.calls.length); expect(x.projection.token().ready).toBe(true);
    });

    it('retries the failed initial tree and its Tool handles before reusing the App port', async () => {
        const x = environment('initial_cleanup');
        const healthy = environment('healthy_initial');
        const register = x.context.appTypeTools.registerTypeTool;
        let broken = true;
        x.context.appTypeTools.registerTypeTool = (definition, options) => {
            if (broken && definition.name === 'other') throw new Error('second registration failed');
            const release = register(definition, options);
            return () => {
                if (broken) throw new Error('release refused');
                release();
            };
        };
        function App() { return h(AppTools, { definition: tools, bindings: bindings('live') }, card()); }
        const factory = createTUIApp({ app_name: 'initial_cleanup', component: App });
        const first = document.createElement('div');
        await expect(factory.initializeComponent(first, x.context)).rejects.toMatchObject({
            code: 'TOOL_BINDING_CLEANUP_FAILED', diagnostics: { original: { message: 'second registration failed' } },
        });
        expect(x.registry.inspect().bindings).toBe(1);
        const other = await factory.initializeComponent(document.createElement('div'), healthy.context);
        await expect(factory.initializeComponent(document.createElement('div'), x.context)).rejects.toMatchObject({
            code: 'TOOL_BINDING_CLEANUP_FAILED',
        });
        expect(x.counts().registers).toBe(1);
        broken = false;
        const next = await factory.initializeComponent(document.createElement('div'), x.context);
        expect(first.childNodes).toHaveLength(0);
        expect(x.registry.inspect()).toMatchObject({ views: 1, bindings: 2 });
        expect((await call(x)).result.success).toBe(true);
        await next.unmount();
        expect(x.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        x.registry.dispose();
        expect(x.registry.inspect().retainedBytes).toBe(0);
        expect((await call(healthy)).result.success).toBe(true);
        await other.unmount();
        expect(x.begin).toHaveBeenCalledTimes(x.end.mock.calls.length);
    });

    it('finishes a partial unmount before another App reuses the same container', async () => {
        const a = environment('former'), b = environment('successor');
        const register = a.context.appTypeTools.registerTypeTool;
        let broken = true;
        a.context.appTypeTools.registerTypeTool = (definition, options) => {
            const release = register(definition, options);
            return () => {
                if (broken) throw new Error('release refused');
                release();
            };
        };
        function App() { return h(AppTools, { definition: tools, bindings: bindings('live') }, card()); }
        const container = document.createElement('div');
        const factory = createTUIApp({ app_name: 'reuse', component: App });
        const old = await factory.initializeComponent(container, a.context);
        expect(() => old.unmount()).toThrow('TOOL_BINDING_CLEANUP_FAILED');
        await expect(factory.initializeComponent(container, b.context)).rejects.toMatchObject({ code: 'TOOL_BINDING_CLEANUP_FAILED' });
        expect(b.counts().registers).toBe(0);
        broken = false;
        const next = await factory.initializeComponent(container, b.context);
        expect(a.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        await old.unmount();
        expect((await call(b)).result.success).toBe(true);
        await next.unmount();
        expect(b.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
    });

    it('does not unmount a successor after the former DOM detached and projection end failed', async () => {
        const x = environment('detached');
        function App() { return h(AppTools, { definition: tools, bindings: bindings('live') }, card()); }
        const factory = createTUIApp({ app_name: 'detached', component: App });
        const container = document.createElement('div');
        const old = await factory.initializeComponent(container, x.context);
        const projectionError = new Error('injected projection end failure');
        const failEnd = vi.spyOn(x.context.projection, 'endCommit');
        failEnd.mockImplementation(() => {
            SemanticProjectionCoordinator.prototype.endCommit.call(x.projection);
            if (x.projection.token().ready) throw projectionError;
        });
        expect(() => old.unmount()).toThrow(projectionError);
        expect(container.childNodes).toHaveLength(0);
        expect(x.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        failEnd.mockRestore();
        const next = await factory.initializeComponent(container, x.context);
        const observed = x.registry.listTools().find(tool => tool.name === 'read')!;
        expect((await call(x, observed)).result.success).toBe(true);
        await old.unmount();
        expect(container.querySelector('tool-ref')).not.toBeNull();
        expect((await call(x, observed)).result.success).toBe(true);
        await next.unmount();
        expect(x.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        x.registry.dispose();
        expect(x.registry.inspect().retainedBytes).toBe(0);
    });

    it('retains an unconfirmed late handle after register-time dispose and isolates its successor', async () => {
        const x = environment('late_handle');
        const original = bindingModule.createToolBindings;
        let disposeDuringRegister: () => void = () => {};
        let isDisposed: () => boolean = () => false;
        vi.spyOn(bindingModule, 'createToolBindings').mockImplementation(function<const Map extends ToolMap>(options: {
            definition: ToolSet<Map>; appTypeTools: IAppTypeToolPort;
        }): ToolBindingController<Map> {
            const controller = original(options);
            disposeDuringRegister = () => controller.dispose();
            isDisposed = () => bindingModule.isToolBindingDisposed(controller);
            return controller;
        });
        const normal = x.context.appTypeTools.registerTypeTool; let closeInside = true, failRelease = true;
        x.context.appTypeTools.registerTypeTool = (definition, options) => {
            const release = normal(definition, options);
            if (closeInside) { closeInside = false; disposeDuringRegister(); expect(isDisposed()).toBe(false); }
            return () => { if (failRelease) throw new Error('late release refused'); release(); };
        };
        let failure: unknown;
        expect(() => mount(x, h(Boundary, { onError: error => { failure = error; } },
            h(AppTools, { definition: tools, bindings: bindings('late') }, h(ToolRef, { tool: tools.read }))))).toThrow('TOOL_BINDING_CLEANUP_FAILED');
        failure ??= (() => { try { [...x.context.toolCleanup][0]!(); } catch (error) { return error; } })();
        expect(failure).toMatchObject({ code: 'TOOL_BINDING_CLEANUP_FAILED', diagnostics: { original: { code: 'TOOL_BINDING_CLOSED' } } });
        expect(x.context.toolCleanup.size).toBe(1); expect(x.registry.inspect().bindings).toBe(1);
        const oldCleanup = [...x.context.toolCleanup][0]!; const oldDisposed = isDisposed;
        failRelease = false;
        const successor = mount(x, h(AppTools, { definition: tools, bindings: bindings('successor') }, card()));
        expect(oldDisposed()).toBe(true); expect(x.context.toolCleanup.size).toBe(0); expect(x.registry.inspect().bindings).toBe(2);
        oldCleanup(); expect(x.registry.inspect().bindings).toBe(2); expect((await call(x)).result).toMatchObject({ data: { label: 'successor' } });
        successor.unmount(); expect(x.begin).toHaveBeenCalledTimes(x.end.mock.calls.length);
    });

    it('matches pure TS descriptors, calls, invalidation, cleanup and stable catalog across one event sequence', async () => {
        const react = environment('react_sequence'), pure = environment('ts_sequence');
        const controller = createToolBindings({ definition: tools, appTypeTools: pure.context.appTypeTools });
        const view = render(h('div', {})); cleanups.push(view.unmount);
        const pureViews: string[] = []; let previousReact: ReturnType<typeof react.registry.listTools>[number] | undefined, previousPure: typeof previousReact;
        const catalog = JSON.stringify(getToolCatalog(tools)); let catalogMarkup: string | undefined;
        for (const [index, [count, enabled]] of [[0, true], [1, true], [3, true], [3, false], [1, true], [0, true], [1, true]].entries()) {
            const label = 'event_' + index;
            await act(async () => view.rerender(h(AppRuntimeContext.Provider, { value: react.context }, h(AppTools, { definition: tools, bindings: bindings(label, Boolean(enabled)) }, [
                h(ToolCatalog, { definition: tools }), ...Array.from({ length: Number(count) }, (_, i) => card('card_' + i)),
            ]))));
            controller.commit(bindings(label, Boolean(enabled)));
            while (pureViews.length > Number(count)) pure.context.viewTools.unmount(pureViews.pop()!);
            while (pureViews.length < Number(count)) pureViews.push(pure.context.viewTools.mount('card_' + pureViews.length, 'Card'));
            const a = react.registry.listTools(), b = pure.registry.listTools();
            const descriptors = (list: typeof a) => list.map(({ viewType, name, description, inputSchema }) => ({ viewType, name, description, inputSchema }));
            expect(descriptors(a)).toEqual(descriptors(b));
            const currentA = a.find(tool => tool.name === 'read'), currentB = b.find(tool => tool.name === 'read');
            if (currentA && currentB) expect(await call(react, currentA)).toEqual(await call(pure, currentB));
            if (previousReact && previousPure) expect(await call(react, previousReact)).toEqual(await call(pure, previousPure));
            previousReact = currentA ?? previousReact; previousPure = currentB ?? previousPure;
            const markup = view.container.querySelector('[data-role="tool-catalog"]')!.outerHTML;
            catalogMarkup ??= markup; expect(markup).toBe(catalogMarkup); expect(JSON.stringify(getToolCatalog(tools))).toBe(catalog);
        }
        view.unmount(); controller.dispose(); for (const id of pureViews) pure.context.viewTools.unmount(id);
        expect(react.registry.inspect().bindings).toBe(0); expect(pure.registry.inspect().bindings).toBe(0);
        react.registry.dispose(); pure.registry.dispose(); expect(react.registry.inspect().retainedBytes).toBe(0); expect(pure.registry.inspect().retainedBytes).toBe(0);
    });
});

describe('Tool catalog presentation', () => {
    it('lists names once by ViewType without duplicating descriptions or schemas', () => {
        const definition = defineToolSet({
            first: defineViewTypeTool({ viewType: 'Files', name: 'inspect', description: 'DESCRIPTION_SENTINEL',
                inputSchema: Type.Object({ SCHEMA_SENTINEL: Type.String() }) }),
            second: defineViewTypeTool({ viewType: 'Files', name: 'edit', description: 'SECOND_DESCRIPTION_SENTINEL',
                inputSchema: Type.Object({ body: Type.String() }) }),
            third: defineViewTypeTool({ viewType: 'Plans', name: 'open', description: 'THIRD_DESCRIPTION_SENTINEL',
                inputSchema: Type.Object({ plan: Type.String() }) }),
        });
        const view = render(h(ToolCatalog, { definition }));
        try {
            expect([...view.container.querySelectorAll('h3')].map(node => node.textContent)).toEqual(['Files', 'Plans']);
            expect([...view.container.querySelectorAll('li')].map(node => node.textContent)).toEqual(['edit', 'inspect', 'open']);
            expect(view.container.querySelector('pre')).toBeNull();
            expect(view.container.textContent).not.toContain('DESCRIPTION_SENTINEL');
            expect(view.container.textContent).not.toContain('SCHEMA_SENTINEL');
            expect(view.container.textContent).not.toContain('Mutating');
            expect(getToolCatalog(definition)[0]!.description).toBe('SECOND_DESCRIPTION_SENTINEL');
        } finally { view.unmount(); }
    });
});
