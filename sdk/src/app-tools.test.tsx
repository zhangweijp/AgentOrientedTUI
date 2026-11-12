import { Component, h, type ComponentChildren } from 'preact';
import { act, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Type from 'typebox';
import { createViewOwnedTools } from '@aotui/runtime/core';
import { createAppId, createDesktopId, type AppTypeToolDefinition, type AppTypeToolRegistrationOptions } from '@aotui/runtime/spi';
import { SemanticProjectionCoordinator } from '../../runtime/src/core/projection/coordinator.js';
import { AppRuntimeContext } from './context/AppRuntimeContext.js';
import { AppTools, ToolCatalog } from './components/AppTools.js';
import { View } from './components/View.js';
import { mountPreactApp } from './app-factory/createTUIApp.js';
import * as bindingModule from './tools/view-type-tool.js';
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
    const projection = new SemanticProjectionCoordinator({
        identity: () => ({ appId: name, instanceId: name + '_run' }),
        readFrame: () => ({
            views: registry.listViews().map(view => ({ id: view.viewId, name: view.viewId,
                type: view.viewType, viewInstanceId: view.viewInstanceId, kind: 'state', content: { format: 'markdown-v1', value: '' } })),
            tools: registry.listTools(),
        }),
    });
    const begin = vi.spyOn(projection, 'beginCommit'), end = vi.spyOn(projection, 'endCommit');
    let registers = 0, releases = 0;
    const context = {
        appId: createAppId(name), desktopId: createDesktopId('cards'),
        projection, toolCleanup: new Set<() => void>(),
        refExporter: { registerRef() { throw new Error('This fixture has no Refs'); } },
        appTypeTools: {
            protocol: 'view-type-tools-v4' as const,
            registerTypeTool(definition: AppTypeToolDefinition, options: AppTypeToolRegistrationOptions) {
                registers++; const release = registry.registerTypeTool(definition, options);
                return () => { releases++; release(); };
            },
        },
        viewTools: {
            mount(id: string, type: string) { return registry.mount(id, type).viewInstanceId; },
            unmount(id: string) { registry.unmount(id); },
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
const card = (id = 'card') => h(View, {kind: 'state', id, type: 'Card', key: id });
function mount(x: Environment, children: ComponentChildren) {
    const view = render(h(AppRuntimeContext.Provider, { value: x.context }, children));
    cleanups.push(view.unmount); return view;
}

describe('M3 AppTools Preact adapter', () => {
    it('registers the first committed bindings without an extra render', async () => {
        const x = environment('first'); let renders = 0;
        function Content() { renders++; return h(View, {kind: 'state', id: 'card', type: 'Card' }); }
        const view = mount(x, h(AppTools, { definition: tools, bindings: bindings('first') }, h(Content, {})));
        expect(renders).toBe(1); expect(view.container.querySelector('[data-view-id=card]')).not.toBeNull();
        expect(x.registry.listTools()).toHaveLength(2);
        expect((await call(x)).result).toMatchObject({ success: true, data: { label: 'first' } });
        view.unmount(); expect(x.registry.inspect().bindings).toBe(0); expect(x.registry.inspect().views).toBe(0);
        expect(x.begin).toHaveBeenCalledTimes(x.end.mock.calls.length);
    });

    it('captures a detached candidate without getters and ignores mutation after render capture', async () => {
        const x = environment('captured'), candidate = bindings('captured');
        function Mutate() { candidate.read.execute = () => ({ success: true, data: { label: 'mutated', path: 'wrong' } }); candidate.read.enabled = false; return card(); }
        const view = mount(x, h(AppTools, { definition: tools, bindings: candidate }, h(Mutate, {})));
        expect((await call(x)).result).toMatchObject({ data: { label: 'captured' } });
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
        const initialized = mountPreactApp(App, container, x.context);
        const renderer = phase === 'initialize' ? undefined : await initialized;
        if (renderer) {
            if (phase === 'reentrant-unmount') nestedClose = () => renderer.close();
            readyTools.length = 0;
            expect(() => renderer.close()).toThrow(cleanupError);
        } else {
            await expect(initialized).rejects.toBe(mountError);
        }
        expect((await duringCleanup)?.phase).toBe('not-entered');
        expect((await call(x, old)).phase).toBe('not-entered');
        expect(execute).not.toHaveBeenCalled();
        expect(x.registry.inspect().bindings).toBe(0);
        expect(readyTools.flat()).toEqual([]);
        unsubscribe();
        const successor = await mountPreactApp(
            () => h(AppTools, { definition: tools, bindings: bindings('successor') }, card()),
            document.createElement('div'), x.context,
        );
        renderer?.close();
        expect((await call(x)).result).toMatchObject({ data: { label: 'successor' } });
        successor.close();
        expect(x.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        expect(x.begin).toHaveBeenCalledTimes(x.end.mock.calls.length);
    });

    it('retains failed unmount cleanup for renderer retry without taking the business lifecycle owner', async () => {
        const x = environment('cleanup'), normal = x.context.appTypeTools.registerTypeTool; let fail = true;
        x.context.appTypeTools.registerTypeTool = (definition, options) => { const release = normal(definition, options); return () => { if (fail && definition.name === 'read') throw new Error('release refused'); release(); }; };
        let lifecycleRegistrations = 0;
        x.context.appLifecycle.register = () => { lifecycleRegistrations++; return () => {}; };
        function App() { return h(AppTools, { definition: tools, bindings: bindings('cleanup') }, card()); }
        const factory = { initialize: mountPreactApp.bind(null, App) }; const container = document.createElement('div');
        const renderer = await factory.initialize(container, x.context);
        expect(lifecycleRegistrations).toBe(0);
        expect(() => renderer.close()).toThrow('TOOL_BINDING_CLEANUP_FAILED'); expect(x.registry.inspect().bindings).toBe(1);
        const successor = createToolBindings(tools, x.context.appTypeTools);
        expect(() => successor.prepare(bindings('early'))()).toThrow('TOOL_BINDING_OWNER_CONFLICT');
        fail = false; renderer.close(); expect(x.registry.inspect().bindings).toBe(0);
        const next = await factory.initialize(container, x.context); expect(x.registry.inspect().bindings).toBe(2);
        renderer.close(); expect(x.registry.inspect().bindings).toBe(2); next.close(); expect(x.registry.inspect().bindings).toBe(0);
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
        const factory = { initialize: mountPreactApp.bind(null, App) };
        const first = document.createElement('div');
        await expect(factory.initialize(first, x.context)).rejects.toMatchObject({
            code: 'TOOL_BINDING_CLEANUP_FAILED', diagnostics: { original: { message: 'second registration failed' } },
        });
        expect(x.registry.inspect().bindings).toBe(1);
        const other = await factory.initialize(document.createElement('div'), healthy.context);
        await expect(factory.initialize(document.createElement('div'), x.context)).rejects.toMatchObject({
            code: 'TOOL_BINDING_CLEANUP_FAILED',
        });
        expect(x.counts().registers).toBe(1);
        broken = false;
        const next = await factory.initialize(document.createElement('div'), x.context);
        expect(first.childNodes).toHaveLength(0);
        expect(x.registry.inspect()).toMatchObject({ views: 1, bindings: 2 });
        expect((await call(x)).result.success).toBe(true);
        await next.close();
        expect(x.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        x.registry.dispose();
        expect(x.registry.inspect().retainedBytes).toBe(0);
        expect((await call(healthy)).result.success).toBe(true);
        await other.close();
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
        const factory = { initialize: mountPreactApp.bind(null, App) };
        const old = await factory.initialize(container, a.context);
        expect(() => old.close()).toThrow('TOOL_BINDING_CLEANUP_FAILED');
        await expect(factory.initialize(container, b.context)).rejects.toMatchObject({ code: 'TOOL_BINDING_CLEANUP_FAILED' });
        expect(b.counts().registers).toBe(0);
        broken = false;
        const next = await factory.initialize(container, b.context);
        expect(a.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        await old.close();
        expect((await call(b)).result.success).toBe(true);
        await next.close();
        expect(b.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
    });

    it('does not unmount a successor after the former DOM detached and projection end failed', async () => {
        const x = environment('detached');
        function App() { return h(AppTools, { definition: tools, bindings: bindings('live') }, card()); }
        const factory = { initialize: mountPreactApp.bind(null, App) };
        const container = document.createElement('div');
        const old = await factory.initialize(container, x.context);
        const projectionError = new Error('injected projection end failure');
        const failEnd = vi.spyOn(x.context.projection, 'endCommit');
        failEnd.mockImplementation(() => {
            const result = SemanticProjectionCoordinator.prototype.endCommit.call(x.projection);
            if (x.projection.token().ready) throw projectionError;
            return result;
        });
        expect(() => old.close()).toThrow(projectionError);
        expect(container.childNodes).toHaveLength(0);
        expect(x.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        failEnd.mockRestore();
        const next = await factory.initialize(container, x.context);
        const observed = x.registry.listTools().find(tool => tool.name === 'read')!;
        expect((await call(x, observed)).result.success).toBe(true);
        await old.close();
        expect(container.querySelector('[data-view-id=card]')).not.toBeNull();
        expect((await call(x, observed)).result.success).toBe(true);
        await next.close();
        expect(x.registry.inspect()).toMatchObject({ views: 0, bindings: 0 });
        x.registry.dispose();
        expect(x.registry.inspect().retainedBytes).toBe(0);
    });

    it('retains an unconfirmed late handle after register-time dispose and isolates its successor', async () => {
        const x = environment('late_handle');
        const original = bindingModule.createToolBindings;
        let disposeDuringRegister: () => void = () => {};
        let isDisposed: () => boolean = () => false;
        vi.spyOn(bindingModule, 'createToolBindings').mockImplementation((definition, port) => {
            const controller = original(definition, port);
            disposeDuringRegister = () => controller.dispose();
            isDisposed = () => controller.disposed;
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
            h(AppTools, { definition: tools, bindings: bindings('late') })))).toThrow('TOOL_BINDING_CLEANUP_FAILED');
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

    it('bounds cleanup diagnostics and attempts every handle before releasing its owner', () => {
        const registry = createViewOwnedTools('cards', 'bounded_cleanup');
        cleanups.push(() => registry.dispose());
        const keys = ['local_' + 'k'.repeat(200), ...Array.from({ length: 11 }, (_, i) => 'local_' + i)];
        const definition = defineToolSet(Object.fromEntries(keys.map((key, i) => [key, defineViewTypeTool({
            viewType: 'Card', name: 'tool_' + i, description: 'Test cleanup.', inputSchema: Type.Object({}),
        })])));
        const candidate = Object.fromEntries(keys.map(key => [key, { execute: () => ({ success: true }) }]));
        let failing = true, attempts = 0;
        const getter = vi.fn(() => 'must not be read');
        const port: IAppTypeToolPort = { protocol: 'view-type-tools-v4', registerTypeTool(tool, options) {
            const release = registry.registerTypeTool(tool, options);
            return () => {
                attempts++;
                if (!failing) return release();
                if (tool.name === 'tool_0') throw Object.defineProperty({}, 'message', { get: getter });
                throw Object.assign(new Error('e'.repeat(1000)), { name: 'n'.repeat(200), code: 'c'.repeat(200) });
            };
        } };
        const controller = createToolBindings(definition, port);
        const next = createToolBindings(definition, port);
        controller.prepare(candidate)();
        let failure: any;
        try { controller.dispose(); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: 'TOOL_BINDING_CLEANUP_FAILED',
            diagnostics: { cleanupFailureCount: 12, omittedCleanupFailures: 4 } });
        const diagnostics = failure.diagnostics;
        expect(diagnostics.cleanupErrors).toHaveLength(8);
        expect(diagnostics.cleanupErrors[0]).toMatchObject({ toolKeyTruncated: true });
        expect(Object.isFrozen(diagnostics.cleanupErrors)).toBe(true);
        for (const { toolKey, error } of diagnostics.cleanupErrors) {
            expect(toolKey.length).toBeLessThanOrEqual(64);
            expect(error.message.length).toBeLessThanOrEqual(256);
            expect(error.name.length).toBeLessThanOrEqual(64);
            expect(error.code?.length ?? 0).toBeLessThanOrEqual(64);
        }
        expect(getter).not.toHaveBeenCalled();
        expect(attempts).toBe(12);
        expect(() => next.prepare(candidate)()).toThrow('TOOL_BINDING_OWNER_CONFLICT');
        failing = false;
        controller.dispose();
        expect(attempts).toBe(24);
        expect(registry.inspect().bindings).toBe(0);
        next.prepare(candidate)();
        controller.dispose();
        expect(registry.inspect().bindings).toBe(12);
        next.dispose();
    });

    it('keeps the Root catalog stable as Views and current Tools change', async () => {
        const x = environment('catalog');
        const app = (open: boolean) => h(AppRuntimeContext.Provider, { value: x.context },
            h(AppTools, { definition: tools, bindings: bindings('catalog') }, [
                h(ToolCatalog, { definition: tools }), open ? card() : null,
            ]));
        const view = render(app(false));
        cleanups.push(view.unmount);
        const catalog = () => view.container.querySelector('[data-role="tool-catalog"]')!.outerHTML;
        const initial = catalog();
        expect(x.registry.listTools()).toHaveLength(0);
        await act(async () => view.rerender(app(true)));
        expect(x.registry.listTools()).toHaveLength(2);
        expect(catalog()).toBe(initial);
        await act(async () => view.rerender(app(false)));
        expect(x.registry.listTools()).toHaveLength(0);
        expect(catalog()).toBe(initial);
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
