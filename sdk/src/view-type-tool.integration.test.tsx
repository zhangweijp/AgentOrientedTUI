import { Component, h, type ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Type from 'typebox';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useDataRef } from './hooks/useRef.js';
import { useArrayRef } from './hooks/useArrayRef.js';
import { AppTools, ToolRef } from './components/AppTools.js';
import { defineViewTypeTool, defineToolSet, refParam } from './tools/view-type-tool.js';

type Tool = ReturnType<AppKernel['getToolDefinitions']>[number];

const environments: Array<ReturnType<typeof createEnvironment>> = [];

function createEnvironment(component: () => unknown, options: {
    readonly appName?: string;
    readonly instanceId?: string;
    readonly wrapContext?: (context: any) => any;
} = {}) {
    const factory = createTUIApp({ app_name: options.appName ?? 'type_tool_integration', component });
    const initialize = factory.initializeComponent;
    if (options.wrapContext) {
        factory.initializeComponent = async (container, context) =>
            initialize(container, options.wrapContext!(context));
    }
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
    kernel.setId('type_tool_integration' as any);
    kernel.setAppExecutionInstanceId(options.instanceId ?? 'type_tool_integration_run_1');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const environment = {
        kernel,
        container,
        async open() {
            await act(async () => kernel.onOpen({
                appId: 'type_tool_integration' as any,
                desktopId: 'integration_desktop' as any,
            }, container));
        },
        async close() {
            await act(async () => kernel.onClose());
            container.remove();
        },
        tools() { return kernel.getToolDefinitions(); },
        typeTool(name: string) {
            const tool = kernel.getToolDefinitions().find(candidate => candidate.name === name && candidate.execution.kind === 'view-type');
            if (!tool) throw new Error(`ViewType Tool ${name} is not active`);
            return tool;
        },
        invokeType(tool: Tool, args: Readonly<Record<string, unknown>>) {
            if (tool.execution.kind !== 'view-type') throw new Error('Expected a ViewType Tool descriptor');
            return kernel.invokeBoundTypeTool(tool, { kind: 'view-type', activationId: tool.execution.activationId }, args);
        },

    };
    environments.push(environment);
    return environment;
}

afterEach(async () => {
    for (const environment of environments.splice(0)) {
        await environment.close();
    }
    vi.restoreAllMocks();
});

class ErrorBoundary extends Component<{
    children?: ComponentChildren;
    onError?: (error: unknown) => void;
}, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() { return { failed: true }; }

    componentDidCatch(error: unknown) { this.props.onError?.(error); }

    render() {
        return this.state.failed ? h('p', {}, 'Committed fallback') : this.props.children;
    }
}

function editDefinition(description = 'Edit an opened file.') {
    return defineViewTypeTool({
        viewType: 'FileDetail',
        name: 'edit_file',
        description,
        inputSchema: Type.Object({ filePath: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    });
}

describe('ViewTypeTool through real Preact and AppKernel', () => {
    it('registers once for a ViewType, emits a V3 type activation without instance targets, and renders one affordance per View', async () => {
        const execute = vi.fn(async (args: Readonly<{ filePath: string }>) => ({ success: true, data: { path: args.filePath } }));
        const boundTools = defineToolSet({ tool: editDefinition() });

        function App() {
            return h(AppTools, { definition: boundTools, bindings: { tool: { execute: execute } } }, h('main', {}, [
                h(View, {kind: 'state', id: 'file_a', type: 'FileDetail', key: 'a' }, h(ToolRef, { tool: boundTools.tool }, 'Edit A')),
                h(View, {kind: 'state', id: 'file_b', type: 'FileDetail', key: 'b' }, h(ToolRef, { tool: boundTools.tool }, 'Edit B')),
            ]));
        }
        const environment = createEnvironment(App);
        await environment.open();

        const tool = environment.typeTool('edit_file');
        expect(environment.tools()).toHaveLength(1);
        expect(tool.execution.kind).toBe('view-type');
        expect(tool.execution).toMatchObject({ kind: 'view-type', activationId: expect.any(String) });
        expect(tool.execution).not.toHaveProperty('targets');
        expect(tool).not.toHaveProperty('handler');
        expect(environment.kernel.getViewOwnedViewInstances().map(view => view.viewId)).toEqual(['file_a', 'file_b']);
        expect(environment.container.querySelectorAll('tool-ref')).toHaveLength(2);
        expect(await environment.invokeType(tool, { filePath: '/workspace/a.txt' })).toMatchObject({
            phase: 'entered-returned', result: { success: true, data: { path: '/workspace/a.txt' } },
        });
        expect(execute).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledWith({ filePath: '/workspace/a.txt' });
    });

    it('keeps the prior handler through a failed render, then revokes it when the owner commits a fallback', async () => {
        let update!: (fail: boolean) => void;
        const committed = vi.fn(async () => ({ success: true, data: { version: 'committed' } }));
        const candidate = vi.fn(async () => ({ success: true, data: { version: 'candidate' } }));
        let boundaryError: unknown;
        const boundTools = defineToolSet({ tool: editDefinition() });

        function ToolOwner({ fail }: { fail: boolean }) {
            if (fail) throw new Error('candidate render failed');
            return h(AppTools, { definition: boundTools, bindings: { tool: { execute: fail ? candidate : committed } } }, h(ToolRef, { tool: boundTools.tool }, 'Edit'));
        }
        function App() {
            const [fail, setFail] = useState(false);
            update = setFail;
            return h('main', {}, [
                h(View, {kind: 'state', id: 'file', type: 'FileDetail' }, h('p', {}, 'File content')),
                h(ErrorBoundary, { onError: error => { boundaryError = error; } }, h(ToolOwner, { fail })),
            ]);
        }
        const environment = createEnvironment(App);
        await environment.open();
        const old = environment.typeTool('edit_file');

        await act(async () => update(true));
        expect(boundaryError).toMatchObject({ message: 'candidate render failed' });
        expect(environment.container.textContent).toContain('Committed fallback');
        expect(candidate).not.toHaveBeenCalled();
        const result = await environment.invokeType(old, { filePath: '/workspace/a.txt' });
        expect(result.phase).toBe('not-entered');
        expect(committed).not.toHaveBeenCalled();
        expect(environment.tools()).toEqual([]);
    });

    it('publishes returned and unknown failure facts without inventing application effects', async () => {
        const unknown = { success: false, error: { code: 'OUTCOME_UNKNOWN', message: 'Read the current View.' } };
        const partial = { success: false, effects: 'partial' as const, error: { code: 'PARTIAL_WRITE', message: 'One file changed.' } };
        let setPartial!: (next: boolean) => void;
        const boundTools = defineToolSet({ tool: defineViewTypeTool({
                viewType: 'FileDetail', name: 'edit_file', description: 'Edit the file.',
                inputSchema: Type.Object({ filePath: Type.String() }),
            }) });

        function App() {
            const [isPartial, update] = useState(false); setPartial = update;
            return h(AppTools, { definition: boundTools, bindings: { tool: { execute: async () => isPartial ? partial : unknown } } }, h(View, {kind: 'state', id: 'file', type: 'FileDetail' }, h(ToolRef, { tool: boundTools.tool }, 'Edit')));
        }
        const environment = createEnvironment(App);
        await environment.open();
        const first = environment.typeTool('edit_file');
        expect(await environment.invokeType(first, { filePath: '/workspace/a.txt' })).toEqual({ phase: 'entered-returned', result: unknown });
        await act(async () => setPartial(true));
        const afterHandlerUpdate = environment.typeTool('edit_file');
        expect(afterHandlerUpdate.execution).toEqual(first.execution);
        expect(await environment.invokeType(first, { filePath: '/workspace/a.txt' })).toEqual({
            phase: 'entered-returned', failureEffects: 'partial',
            result: { success: false, error: partial.error },
        });
    });

    it('passes only supplied JSON arguments and recursively freezes handler input', async () => {
        const execute = vi.fn(async (args: Readonly<{ path: string; labels: readonly string[]; optional?: string }>) => {
            expect(Object.isFrozen(args)).toBe(true);
            expect(Object.isFrozen(args.labels)).toBe(true);
            expect(Object.hasOwn(args, 'optional')).toBe(false);
            return { success: true, data: { labels: args.labels } };
        });
        const boundTools = defineToolSet({ tool: defineViewTypeTool({
                viewType: 'FileDetail', name: 'inspect', description: 'Inspect the file.',
                inputSchema: Type.Object({
                    path: Type.String(),
                    labels: Type.Array(Type.String()),
                    optional: Type.Optional(Type.String({ default: 'not supplied' })),
                }, { additionalProperties: false }),
            }) });

        function App() {
            return h(AppTools, { definition: boundTools, bindings: { tool: { execute: execute } } }, h(View, {kind: 'state', id: 'file', type: 'FileDetail' }, h(ToolRef, { tool: boundTools.tool }, 'Inspect')));
        }
        const environment = createEnvironment(App);
        await environment.open();
        const tool = environment.typeTool('inspect');
        expect(await environment.invokeType(tool, { path: '/workspace/a.txt', labels: ['source'] })).toMatchObject({
            phase: 'entered-returned', result: { success: true, data: { labels: ['source'] } },
        });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('supports an empty parameter contract and applies Runtime input validation before handler entry', async () => {
        const execute = vi.fn(async () => ({ success: true }));
        const boundTools = defineToolSet({ tool: defineViewTypeTool({
                viewType: 'Status', name: 'read_status', description: 'Read status.',
                inputSchema: Type.Object({}, { additionalProperties: false }), 
            }) });

        function App() {
            return h(AppTools, { definition: boundTools, bindings: { tool: { execute: execute } } }, h(View, {kind: 'state', id: 'status', type: 'Status' }, h(ToolRef, { tool: boundTools.tool }, 'Read status')));
        }
        const environment = createEnvironment(App);
        await environment.open();
        const tool = environment.typeTool('read_status');
        expect(tool).not.toHaveProperty('isMutating');
        expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
        expect((await environment.invokeType(tool, { extra: true })).phase).toBe('not-entered');
        expect(execute).not.toHaveBeenCalled();
        expect(await environment.invokeType(tool, {})).toMatchObject({ phase: 'entered-returned', result: { success: true } });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('invalidates old activation observations after a schema change or disable/enable transition', async () => {
        let update!: (state: { changed: boolean; enabled: boolean }) => void;
        const execute = vi.fn(async () => ({ success: true }));
        const contracts = [1, 2].map(minLength => defineToolSet({ tool: defineViewTypeTool({
            viewType: 'FileDetail', name: 'edit_file', description: 'Edit the file.',
            inputSchema: Type.Object({ filePath: Type.String({ minLength }) }),
        }) }));
        function App() {
            const [state, setState] = useState({ changed: false, enabled: true }); update = setState;
            const definition = contracts[state.changed ? 1 : 0]!;
            return h(AppTools, { key: String(state.changed), definition, bindings: { tool: { execute, enabled: state.enabled } } },
                h(View, {kind: 'state', id: 'file', type: 'FileDetail' }, h(ToolRef, { tool: definition.tool }, 'Edit')));
        }
        function Checked() { return h(ErrorBoundary, {}, h(App, {})); }
        const environment = createEnvironment(Checked);
        await environment.open();
        const original = environment.typeTool('edit_file');
        await act(async () => update({ changed: true, enabled: true }));
        const changed = environment.typeTool('edit_file');
        expect(changed.execution.kind).toBe('view-type');
        expect((changed.execution as any).activationId).not.toBe((original.execution as any).activationId);
        expect((await environment.invokeType(original, { filePath: 'x' })).phase).toBe('not-entered');
        expect(await environment.invokeType(changed, { filePath: 'xx' })).toMatchObject({ phase: 'entered-returned' });

        await act(async () => update({ changed: true, enabled: false }));
        expect(environment.tools()).toEqual([]);
        expect((await environment.invokeType(changed, { filePath: 'xx' })).phase).toBe('not-entered');
        await act(async () => update({ changed: true, enabled: true }));
        const restored = environment.typeTool('edit_file');
        expect((restored.execution as any).activationId).not.toBe((changed.execution as any).activationId);
    });

    it('expires type activations on APP_CLOSE and issues a fresh identity on APP_OPEN', async () => {
        const boundTools = defineToolSet({ tool: editDefinition() });

        function App() {
            return h(AppTools, { definition: boundTools, bindings: { tool: { execute: async () => ({ success: true }) } } }, h(View, {kind: 'state', id: 'file', type: 'FileDetail' }, h(ToolRef, { tool: boundTools.tool }, 'Edit')));
        }
        const first = createEnvironment(App, { instanceId: 'runtime_app_instance_1' });
        await first.open();
        const old = first.typeTool('edit_file');
        await first.close();
        expect(first.tools()).toEqual([]);

        const reopened = createEnvironment(App, { instanceId: 'runtime_app_instance_2' });
        await reopened.open();
        const current = reopened.typeTool('edit_file');
        expect(current.execution.kind).toBe('view-type');
        expect((current.execution as any).activationId).not.toBe((old.execution as any).activationId);
        const stale = await reopened.invokeType(old, { filePath: '/workspace/a.txt' });
        expect(stale.phase).toBe('not-entered');
        expect(await reopened.invokeType(current, { filePath: '/workspace/a.txt' })).toMatchObject({ phase: 'entered-returned' });
    });

    it('refuses a failed Runtime registration after releasing the former activation', async () => {
        let update!: (description: string) => void;
        let rejectNext = false;
        let rejectedRegistrations = 0;
        const declarations = ['First declaration', 'Second declaration'].map(description => defineToolSet({ tool: editDefinition(description) }));
        function App() {
            const [description, setDescription] = useState('First declaration'); update = setDescription;
            const definition = declarations[description === 'First declaration' ? 0 : 1]!;
            return h(AppTools, { key: description, definition, bindings: { tool: { execute: async () => ({ success: true }) } } },
                h(View, {kind: 'state', id: 'file', type: 'FileDetail' }, h(ToolRef, { tool: definition.tool }, 'Edit')));
        }
        function Checked() { return h(ErrorBoundary, {}, h(App, {})); }
        const environment = createEnvironment(Checked, {
            wrapContext(context) {
                const port = context.appTypeTools;
                return {
                    ...context,
                    appTypeTools: {
                        protocol: port.protocol,
                        registerTypeTool(definition: any, registration: any) {
                            if (rejectNext) {
                                rejectNext = false;
                                rejectedRegistrations++;
                                const schema = definition.inputSchema;
                                const invalid = {
                                    ...definition,
                                    inputSchema: {
                                        ...schema,
                                        properties: {
                                            ...schema.properties,
                                            filePath: { ...schema.properties.filePath, format: 'uri' },
                                        },
                                    },
                                };
                                return port.registerTypeTool(invalid, registration);
                            }
                            return port.registerTypeTool(definition, registration);
                        },
                    },
                };
            },
        });
        await environment.open();
        const former = environment.typeTool('edit_file');
        rejectNext = true;
        await act(async () => update('Second declaration'));
        expect(rejectedRegistrations).toBe(1);
        expect(environment.tools()).toEqual([]);
        expect((await environment.invokeType(former, { filePath: '/workspace/a.txt' })).phase).toBe('not-entered');
    });

    it('keeps one activation coherent through 60 rapid View mount and enabled commits', async () => {
        type State = { open: boolean[]; enabled: boolean };
        let update!: (next: State) => void;
        const boundTools = defineToolSet({ tool: editDefinition() });

        function App() {
            const [state, setState] = useState<State>({ open: [true, true, true, true], enabled: true }); update = setState;
            return h(AppTools, { definition: boundTools, bindings: { tool: { execute: async () => ({ success: true }), ...({ enabled: state.enabled }) } } }, h('main', {}, state.open.flatMap((open, index) => open ? [
                h(View, {kind: 'state', id: `file_${index}`, type: 'FileDetail', key: `file_${index}` }, h(ToolRef, { tool: boundTools.tool }, 'Edit')),
            ] : [])));
        }
        const environment = createEnvironment(App);
        await environment.open();
        let seed = 19;
        let lastActive: Tool | undefined;
        for (let step = 0; step < 60; step++) {
            const open = [0, 1, 2, 3].map(() => {
                seed = seed * 48271 % 2147483647;
                return seed % 4 !== 0;
            });
            const enabled = step % 5 !== 0;
            await act(async () => update({ open, enabled }));
            const active = environment.tools();
            const shouldBeActive = enabled && open.some(Boolean);
            expect(active.length).toBe(shouldBeActive ? 1 : 0);
            const current = active[0];
            if (lastActive) {
                const oldActivation = lastActive.execution.kind === 'view-type' ? lastActive.execution.activationId : undefined;
                const currentActivation = current?.execution.kind === 'view-type' ? current.execution.activationId : undefined;
                if (oldActivation !== currentActivation) {
                    expect((await environment.invokeType(lastActive, { filePath: '/workspace/stale.txt' })).phase)
                        .toBe('not-entered');
                }
            }
            if (active.length) {
                expect(active[0]!.execution.kind).toBe('view-type');
                expect(active[0]!.execution).not.toHaveProperty('targets');
                expect(new Set(environment.kernel.getViewOwnedViewInstances().map(view => view.viewInstanceId)).size)
                    .toBe(environment.kernel.getViewOwnedViewInstances().length);
                lastActive = active[0];
            }
        }
    });
});

describe('Ref parameters with real Preact and AppKernel', () => {
    function recordTools(maxLength = 2) {
        return defineToolSet({ inspect: defineViewTypeTool({ viewType: 'Record', name: 'inspect',
            description: 'Inspect the captured record.', 
            inputSchema: Type.Object({ record: refParam('Record', Type.Object({ owner: Type.String() })),
                text: Type.Optional(Type.String({ maxLength })) }),
        }) });
    }
    it('shares one type handler across Views and passes each resolved object without target selectors', async () => {
        const calls: string[] = [], tools = recordTools();
        function Detail({ id }: { id: string }) {
            const record = useDataRef('record', { owner: id }, { refType: 'Record' });
            return h('section', {}, [record('Record'), h(ToolRef, { tool: tools.inspect }, `Inspect ${id}`)]);
        }
        function App() { return h(AppTools, { definition: tools, bindings: { inspect: { execute: args => {
            calls.push(args.record.owner); return { success: true }; } } } },
            ['rec_a', 'rec_b'].map(id => h(View, {kind: 'state', id, type: 'Record', key: id }, h(Detail, { id })))); }
        const environment = createEnvironment(App); await environment.open();
        const tool = environment.typeTool('inspect'); expect(environment.tools()).toHaveLength(1);
        expect(tool.execution).not.toHaveProperty('targets');
        expect(tool.inputSchema).toMatchObject({ properties: { record: { type: 'string', 'x-aotui-ref-kind': 'Record' } } });
        expect(environment.container.querySelectorAll('tool-ref')).toHaveLength(2);
        for (const owner of ['rec_a', 'rec_b']) expect(await environment.invokeType(tool, { record: { owner } }))
            .toMatchObject({ phase: 'entered-returned', result: { success: true } });
        expect(calls).toEqual(['rec_a', 'rec_b']);
    });
    it('revokes the activation after its last View closes and gives reopening a new identity', async () => {
        const tools = recordTools(); let setOpen!: (open: boolean) => void;
        function App() { const [open, update] = useState(true); setOpen = update;
            return h(AppTools, { definition: tools, bindings: { inspect: { execute: () => ({ success: true }) } } },
                open ? h(View, {kind: 'state', id: 'record', type: 'Record' }, h(ToolRef, { tool: tools.inspect }, 'Inspect')) : null); }
        const environment = createEnvironment(App); await environment.open(); const old = environment.typeTool('inspect');
        const oldView = environment.kernel.getViewOwnedViewInstances()[0]!.viewInstanceId;
        await act(async () => setOpen(false)); expect(environment.tools()).toEqual([]);
        expect((await environment.invokeType(old, { record: { owner: 'A' } })).phase).toBe('not-entered');
        await act(async () => setOpen(true)); expect(environment.typeTool('inspect').execution).not.toEqual(old.execution);
        expect(environment.kernel.getViewOwnedViewInstances()[0]!.viewInstanceId).not.toBe(oldView);
    });
    it('does not expose a handler from a failed render and revokes it after the committed fallback', async () => {
        const tools = recordTools(); let update!: (fail: boolean) => void;
        const committed = vi.fn(async () => ({ success: true })), candidate = vi.fn(async () => ({ success: true }));
        function Owner({ fail }: { fail: boolean }) {
            return h(AppTools, { definition: tools, bindings: { inspect: { execute: fail ? candidate : committed } } }, h(Detail, { fail }));
        }
        function Detail({ fail }: { fail: boolean }) { if (fail) throw Error('failed Ref render');
            return h(View, {kind: 'state', id: 'record', type: 'Record' }, h(ToolRef, { tool: tools.inspect }, 'Inspect')); }
        function App() { const [fail, setFail] = useState(false); update = setFail;
            return h(ErrorBoundary, {}, h(Owner, { fail })); }
        const environment = createEnvironment(App); await environment.open(); const old = environment.typeTool('inspect');
        await act(async () => update(true)); expect(environment.container.textContent).toContain('Committed fallback');
        expect(candidate).not.toHaveBeenCalled(); expect(environment.tools()).toEqual([]);
        expect((await environment.invokeType(old, { record: { owner: 'A' } })).phase).toBe('not-entered');
        expect(committed).not.toHaveBeenCalled();
    });
    it('keeps committed handler changes and replaces the activation on an explicit Schema remount', async () => {
        let update!: (s: { revision: number; maxLength: number }) => void; const calls: number[] = [];
        const definitions = { 1: recordTools(1), 2: recordTools(2) };
        function App() { const [state, setState] = useState({ revision: 1, maxLength: 2 }); update = setState;
            const tools = definitions[state.maxLength as 1 | 2];
            return h(AppTools, { key: state.maxLength, definition: tools, bindings: { inspect: { execute: () => {
                calls.push(state.revision); return { success: true }; } } } },
                h(View, {kind: 'state', id: 'record', type: 'Record' }, h(ToolRef, { tool: tools.inspect }, 'Inspect'))); }
        const environment = createEnvironment(App); await environment.open(); const old = environment.typeTool('inspect');
        await act(async () => update({ revision: 2, maxLength: 2 }));
        expect(environment.typeTool('inspect').execution).toEqual(old.execution);
        expect((await environment.invokeType(old, { record: { owner: 'A' }, text: 'ok' })).phase).toBe('entered-returned');
        await act(async () => update({ revision: 3, maxLength: 1 })); const changed = environment.typeTool('inspect');
        expect(changed.execution).not.toEqual(old.execution);
        expect((await environment.invokeType(old, { record: { owner: 'A' }, text: 'ok' })).phase).toBe('not-entered');
        expect((await environment.invokeType(changed, { record: { owner: 'A' }, text: 'x' })).phase).toBe('entered-returned');
        expect(calls).toEqual([2, 3]);
    });
    it('releases disabled Ref Tools and issues a new type activation on re-enable', async () => {
        const tools = recordTools(); let update!: (enabled: boolean) => void;
        function App() { const [enabled, setEnabled] = useState(false); update = setEnabled;
            return h(AppTools, { definition: tools, bindings: { inspect: { enabled, execute: () => ({ success: true }) } } },
                h(View, {kind: 'state', id: 'record', type: 'Record' }, h(ToolRef, { tool: tools.inspect }, 'Inspect'))); }
        const environment = createEnvironment(App); await environment.open(); expect(environment.tools()).toEqual([]);
        await act(async () => update(true)); const old = environment.typeTool('inspect');
        await act(async () => update(false)); expect(environment.tools()).toEqual([]);
        expect((await environment.invokeType(old, { record: { owner: 'A' } })).phase).toBe('not-entered');
        await act(async () => update(true)); const current = environment.typeTool('inspect');
        expect(current.execution).not.toEqual(old.execution);
        expect((await environment.invokeType(current, { record: { owner: 'A' } })).phase).toBe('entered-returned');
    });
    it('rejects an unsupported App port even while the Ref Tool is disabled', async () => {
        const tools = recordTools(); const registerTypeTool = vi.fn();
        const environment = createEnvironment(() => h(AppTools, { definition: tools,
            bindings: { inspect: { enabled: false, execute: () => ({ success: true }) } } }), {
            wrapContext: context => ({ ...context, appTypeTools: { registerTypeTool } }),
        });
        await expect(environment.open()).rejects.toThrow();
        expect(registerTypeTool).not.toHaveBeenCalled(); expect(environment.tools()).toEqual([]);
    });
    it('accepts multiple object/list Ref parameters and ordinary fields', async () => {
        const ref = refParam('Record', Type.Object({ owner: Type.String() }));
        const left = { owner: 'A' }, right = { owner: 'B' }, records = [left, right];
        const tools = defineToolSet({ inspect: defineViewTypeTool({ viewType: 'Record', name: 'inspect', description: 'Inspect records.',
            inputSchema: Type.Object({ left: ref, right: ref,
                records: refParam('Record', Type.Array(Type.Object({ owner: Type.String() }))), label: Type.String() }, { additionalProperties: false }) }) });
        const execute = vi.fn((args: Readonly<{ left: Readonly<{ owner: string }>; right: Readonly<{ owner: string }>;
            records: readonly Readonly<{ owner: string }>[]; label: string }>) => ({ success: true, data: { count: args.records.length } }));
        function Detail() {
            const leftRef = useDataRef('left', left, { refType: 'Record' });
            const rightRef = useDataRef('right', right, { refType: 'Record' });
            const [listRef] = useArrayRef('records', records, { itemType: 'Record' });
            return h('section', {}, [leftRef('Left'), rightRef('Right'), listRef('Records'), h(ToolRef, { tool: tools.inspect }, 'Inspect')]);
        }
        const environment = createEnvironment(() => h(AppTools, { definition: tools, bindings: { inspect: { execute } } },
            h(View, {kind: 'state', id: 'record', type: 'Record' }, h(Detail, {}))));
        await environment.open(); const tool = environment.typeTool('inspect');
        expect(environment.tools()).toHaveLength(1); expect(tool).not.toHaveProperty('isMutating');
        expect(environment.kernel.getViewRefs().find(r => r.refId === 'records'))
            .toMatchObject({ refType: 'Record', value: records });
        expect(await environment.invokeType(tool, { left, right, records, label: 'mixed' }))
            .toMatchObject({ phase: 'entered-returned', result: { success: true, data: { count: 2 } } });
        expect(execute).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledWith({ left, right, records, label: 'mixed' });
        const args = execute.mock.calls[0]![0];
        expect(() => Object.defineProperty(args.left, 'owner', { value: 'changed' })).toThrow();
        expect(() => Object.defineProperty(args.records, '0', { value: right })).toThrow();
        expect(left.owner).toBe('A'); expect(Object.isFrozen(left)).toBe(false); expect(Object.isFrozen(records)).toBe(false);
        await environment.close(); expect(environment.tools()).toEqual([]); expect(environment.kernel.getViewRefs()).toEqual([]);
    });

    it('keeps absent optional object/list Ref fields absent and invokes supplied valid values', async () => {
        const record = refParam('Record', Type.Object({ owner: Type.String() }));
        const tools = defineToolSet({ inspect: defineViewTypeTool({ viewType: 'Record', name: 'inspect', description: 'Inspect optional records.',
            inputSchema: Type.Object({ label: Type.String(), record: Type.Optional(record),
                records: Type.Optional(refParam('Record', Type.Array(Type.Object({ owner: Type.String() })))) }, { additionalProperties: false }) }) });
        const execute = vi.fn((args: Readonly<{ label: string; record?: Readonly<{ owner: string }>;
            records?: readonly Readonly<{ owner: string }>[] }>) => ({ success: true }));
        const environment = createEnvironment(() => h(AppTools, { definition: tools, bindings: { inspect: { execute } } },
            h(View, {kind: 'state', id: 'record', type: 'Record' }, h(ToolRef, { tool: tools.inspect }, 'Inspect'))));
        await environment.open(); const tool = environment.typeTool('inspect');
        expect(environment.tools()).toHaveLength(1);
        expect((await environment.invokeType(tool, { label: 'absent' })).phase).toBe('entered-returned');
        expect(execute.mock.calls[0]![0]).toEqual({ label: 'absent' });
        expect(Object.hasOwn(execute.mock.calls[0]![0], 'record')).toBe(false);
        expect(Object.hasOwn(execute.mock.calls[0]![0], 'records')).toBe(false);
        expect((await environment.invokeType(tool, { label: 'provided', record: { owner: 'A' }, records: [{ owner: 'B' }] })).phase)
            .toBe('entered-returned');
        expect(execute.mock.calls[1]![0]).toEqual({ label: 'provided', record: { owner: 'A' }, records: [{ owner: 'B' }] });
        for (const input of [{ label: 'undefined', record: undefined }, { label: 'null', record: null },
            { label: 'bad object', record: { owner: 1 } }, { label: 'bad list', records: { owner: 'A' } },
            { label: 'bad item', records: [{ owner: 1 }] }]) {
            expect((await environment.invokeType(tool, input)).phase).toBe('not-entered');
        }
        expect(execute).toHaveBeenCalledTimes(2);
    });

    it('rejects missing required Ref payloads and invalid values before entering the multi-Ref handler', async () => {
        const ref = refParam('Record', Type.Object({ owner: Type.String() }));
        const tools = defineToolSet({ inspect: defineViewTypeTool({ viewType: 'Record', name: 'inspect', description: 'Inspect required records.',
            inputSchema: Type.Object({ left: ref, right: ref, label: Type.String() }, { additionalProperties: false }) }) });
        const execute = vi.fn(() => ({ success: true }));
        const environment = createEnvironment(() => h(AppTools, { definition: tools, bindings: { inspect: { execute } } },
            h(View, {kind: 'state', id: 'record', type: 'Record' }, h(ToolRef, { tool: tools.inspect }, 'Inspect'))));
        await environment.open(); const tool = environment.typeTool('inspect');
        for (const input of [{ label: 'missing', left: { owner: 'A' } },
            { label: 'wrong shape', left: 'Record:left', right: { owner: 'B' } },
            { label: 'wrong data', left: { owner: 'A' }, right: { owner: 1 } },
            { label: 1, left: { owner: 'A' }, right: { owner: 'B' } }]) {
            expect((await environment.invokeType(tool, input)).phase).toBe('not-entered');
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it('accepts resolved Ref selections and rejects raw names before handler entry', async () => {
        const tools = defineToolSet({ inspect: defineViewTypeTool({ viewType: 'Record', name: 'inspect', description: 'Inspect selections.',
            inputSchema: Type.Object({ records: Type.Array(refParam('Record', Type.Object({ owner: Type.String() }))) }) }) });
        const execute = vi.fn(() => ({ success: true }));
        const environment = createEnvironment(() => h(AppTools, { definition: tools, bindings: { inspect: { execute } } },
            h(View, { id: 'record', type: 'Record', kind: 'state' }, h(ToolRef, { tool: tools.inspect }))));
        await environment.open(); const tool = environment.typeTool('inspect');
        expect((await environment.invokeType(tool, { records: [{ owner: 'A' }, { owner: 'B' }] })).phase).toBe('entered-returned');
        expect(execute).toHaveBeenCalledWith({ records: [{ owner: 'A' }, { owner: 'B' }] });
        expect((await environment.invokeType(tool, { records: ['Record:a'] })).phase).toBe('not-entered');
        expect(execute).toHaveBeenCalledOnce();
    });
    it('still rejects unsupported nested Ref parameters without leaving registrations', async () => {
        const ref = refParam('Record', Type.Object({ owner: Type.String() }));
        for (const { schema, code } of [
            { schema: Type.Object({ nested: Type.Object({ record: ref }) }), code: 'TOOL_SCHEMA_UNSUPPORTED' },
            { schema: Type.Object({ records: Type.Array(Type.Array(ref)) }), code: 'TOOL_SCHEMA_UNSUPPORTED' },
        ]) {
            const environment = createEnvironment(() => {
                const tools = defineToolSet({ inspect: defineViewTypeTool({ viewType: 'Record', name: 'inspect', description: 'Inspect.', inputSchema: schema }) });
                return h(AppTools, { definition: tools, bindings: { inspect: { execute: () => ({ success: true }) } } });
            });
            await expect(environment.open()).rejects.toMatchObject({ code });
            expect(environment.tools()).toEqual([]); expect(environment.kernel.getViewOwnedViewInstances()).toEqual([]);
        }
    });
    it('rejects parameter getters before registration without reading their values', () => {
        const getter = vi.fn(() => refParam('Record', Type.Object({ owner: Type.String() })));
        const schema = Type.Object({ record: Type.String() });
        Object.defineProperty(schema.properties, 'record', { enumerable: true, get: getter });
        expect(() => defineViewTypeTool({ viewType: 'Record', name: 'inspect', description: 'Inspect.', inputSchema: schema })).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });
});
