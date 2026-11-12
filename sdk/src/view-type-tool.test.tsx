import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act, render } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import Type from 'typebox';
import { compileOrdinarySchema } from '@aotui/runtime/core';
import { AppRuntimeContext } from './context/AppRuntimeContext.js';
import { defineViewTypeTool } from './tools/view-type-tool.js';
import { AppTools } from './components/AppTools.js';
import { defineToolSet } from './tools/view-type-tool.js';

const mounted: Array<() => void> = [];
afterEach(() => { for (const unmount of mounted.splice(0)) unmount(); vi.restoreAllMocks(); });

function mount(component: () => unknown, port: unknown) {
    const view = render(h(AppRuntimeContext.Provider, {
        value: contextFor(port),
    }, h(component, {})));
    mounted.push(view.unmount);
    return view;
}

function contextFor(port: unknown) {
    return { appId: 'app', desktopId: 'desktop', refExporter: {}, markDirty() {}, appTypeTools: port,
        projection: { beginCommit() {}, endCommit() {} },
        appLifecycle: { protocol: 'app-lifecycle-v2', register() { return () => {}; } },
    } as any;
}

function appTypePort(register = vi.fn(() => vi.fn())) {
    return { protocol: 'view-type-tools-v4' as const, registerTypeTool: register };
}

describe('defineViewTypeTool', () => {
    it('infers from one TypeBox Schema and returns a detached deeply frozen JSON copy', () => {
        const schema = Type.Object({
            filePath: Type.String({ description: 'Opened file path.' }),
            tags: Type.Array(Type.String()),
        });
        const definition = defineViewTypeTool({
            viewType: 'FileDetail', name: 'edit_file', description: 'Edit an open file.', inputSchema: schema,
        });
        expect(definition.inputSchema).toEqual({
            type: 'object', required: ['filePath', 'tags'], properties: {
                filePath: { type: 'string', description: 'Opened file path.' },
                tags: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: true,
        });
        expect(Object.isFrozen(definition)).toBe(true);
        expect(Object.isFrozen(definition.inputSchema)).toBe(true);
        expect(Object.isFrozen((definition.inputSchema.properties as any).filePath)).toBe(true);
        expect(Object.isFrozen(schema)).toBe(false);
        (schema.properties.filePath as any).description = 'Changed after definition.';
        expect((definition.inputSchema.properties as any).filePath.description).toBe('Opened file path.');
    });

    it('rejects unknown keys and declaration accessors without evaluating them', () => {
        let called = 0;
        const declaration = {
            viewType: 'File', name: 'edit', description: 'Edit.', inputSchema: Type.Object({}),
        };
        Object.defineProperty(declaration, 'extra', { value: true, enumerable: true });
        expect(() => defineViewTypeTool(declaration as any)).toThrow('TOOL_DEFINITION_INVALID');

        const getter: any = { viewType: 'File', name: 'edit', description: 'Edit.', inputSchema: Type.Object({}) };
        Object.defineProperty(getter, 'description', { get() { called++; return false; }, enumerable: true });
        expect(() => defineViewTypeTool(getter)).toThrow('TOOL_DEFINITION_INVALID');
        expect(called).toBe(0);
    });

    it('captures the Runtime normalized ordinary schema and reports unsupported constraints at definition time', () => {
        const definition = defineViewTypeTool({
            viewType: 'Record', name: 'inspect', description: 'Inspect.',
            inputSchema: Type.Object({ zeta: Type.String(), alpha: Type.String() }),
        });
        expect(definition.inputSchema).toEqual({
            type: 'object',
            properties: { alpha: { type: 'string' }, zeta: { type: 'string' } },
            required: ['alpha', 'zeta'],
            additionalProperties: true,
        });

        const unsupported = Type.Object({ path: Type.String() }) as any;
        unsupported.properties.path.format = 'uri';
        expect(() => defineViewTypeTool({
            viewType: 'Record', name: 'inspect', description: 'Inspect.',
            inputSchema: unsupported,
        })).toThrow('$.properties.path.format');
    });

    it('rejects a malformed TypeBox pattern at definition time with its field path', () => {
        const inputSchema = Type.Object({ slug: Type.String({ pattern: '[' }) });
        expect(() => defineViewTypeTool({
            viewType: 'Record', name: 'lookup', description: 'Find a record.', inputSchema,
        })).toThrowError(expect.objectContaining({
            name: 'TypeBoxSchemaExportError', code: 'TOOL_SCHEMA_INVALID', path: '$.properties.slug.pattern',
        }));
    });

    it('keeps a parameter named pattern as ordinary TypeBox string data', () => {
        const definition = defineViewTypeTool({
            viewType: 'Search', name: 'search_files', description: 'Search file names.',
            inputSchema: Type.Object({ pattern: Type.String() }),
        });
        expect(definition.inputSchema.properties).toHaveProperty('pattern', { type: 'string' });
    });
});

describe('AppTools ordinary binding migration', () => {
    it('registers one binding at App scope for multiple component children', async () => {
        const registrations: Array<{ definition: any; options: any; release: ReturnType<typeof vi.fn> }> = [];
        const port = appTypePort(vi.fn((definition, options) => {
            const release = vi.fn(); registrations.push({ definition, options, release }); return release;
        }));
        const execute = vi.fn(async (args: Readonly<{ filePath: string }>) => ({ success: args.filePath.length > 0 }));
        const definition = defineToolSet({ edit: defineViewTypeTool({ viewType: 'FileDetail', name: 'edit_file', description: 'Edit an opened file.',
            inputSchema: Type.Object({ filePath: Type.String({ description: 'Opened path.' }) }) }) });
        function App() { return h(AppTools, { definition, bindings: { edit: { execute } } }, h('main', {}, [
            h('section', { key: 'one' }),
            h('section', { key: 'two' }),
        ])); }
        mount(App, port);
        expect(registrations).toHaveLength(1);
        expect(registrations[0]!.definition).toEqual({ viewType: 'FileDetail', name: 'edit_file', description: 'Edit an opened file.',
            inputSchema: definition.edit.inputSchema });
        expect(Object.isFrozen(registrations[0]!.definition.inputSchema)).toBe(true);
        const invoker = registrations[0]!.options.createSafeOrdinaryParametersInvoker({ validate(input: unknown) { return { ok: true, value: Object.freeze(input as object) }; }, fingerprint: 'contract' });
        expect(await invoker({ filePath: '/workspace/a.txt' })).toMatchObject({ phase: 'entered-returned', result: { success: true } });
        expect(execute).toHaveBeenCalledWith({ filePath: '/workspace/a.txt' });
        expect(registrations[0]!.options.safeOrdinaryParametersInvocationMode).toBe('ordinary-v2');
    });

    it('keeps the registration while replacing the committed handler and releases only when disabled or unmounted', async () => {
        const registrations: Array<{ options: any; release: ReturnType<typeof vi.fn> }> = [];
        const port = appTypePort(vi.fn((_definition, options) => { const release = vi.fn(); registrations.push({ options, release }); return release; }));
        let update!: (next: number) => void; let enabled = true;
        const first = vi.fn(async () => ({ success: true, data: { revision: 'first' } }));
        const second = vi.fn(async () => ({ success: true, data: { revision: 'second' } }));
        const definition = defineToolSet({ save: defineViewTypeTool({ viewType: 'Document', name: 'save', description: 'Save.', inputSchema: Type.Object({ content: Type.String() }) }) });
        function App() { const [revision, set] = useState(0); update = set;
            return h(AppTools, { definition, bindings: { save: { execute: revision === 0 ? first : second, enabled } } }); }
        const view = mount(App, port); expect(registrations).toHaveLength(1);
        await act(async () => update(1)); expect(registrations).toHaveLength(1);
        const captured = { validate(input: unknown) { return { ok: true, value: Object.freeze(input as object) }; }, fingerprint: 'contract' };
        const invoke = registrations[0]!.options.createSafeOrdinaryParametersInvoker(captured);
        expect(await invoke({ content: 'new' })).toMatchObject({ result: { data: { revision: 'second' } } });
        expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledOnce();
        enabled = false; await act(async () => update(2));
        expect(registrations[0]!.release).toHaveBeenCalledOnce();
        expect(await invoke({ content: 'stale' })).toMatchObject({ phase: 'not-entered' });
        enabled = true; await act(async () => update(3)); expect(registrations).toHaveLength(2);
        expect(await registrations[1]!.options.createSafeOrdinaryParametersInvoker(captured)({ content: 'after enable' })).toMatchObject({ result: { data: { revision: 'second' } } });
        view.unmount(); expect(registrations[0]!.release).toHaveBeenCalledOnce(); expect(registrations[1]!.release).toHaveBeenCalledOnce();
    });

    it('keeps the static normalized contract while handler state changes', async () => {
        const register = vi.fn(() => vi.fn()); let update!: (next: boolean) => void;
        const a = defineViewTypeTool({ viewType: 'Record', name: 'inspect', description: 'Inspect.', inputSchema: Type.Object({ zeta: Type.String(), alpha: Type.String() }) });
        const b = defineViewTypeTool({ viewType: 'Record', name: 'inspect', description: 'Inspect.', inputSchema: Type.Object({ alpha: Type.String(), zeta: Type.String() }) });
        expect(a.inputSchema).toEqual(b.inputSchema);
        const definition = defineToolSet({ inspect: a });
        function App() { const [next, set] = useState(false); update = set; return h(AppTools, { definition, bindings: { inspect: { execute: () => ({ success: next }) } } }); }
        mount(App, appTypePort(register)); await act(async () => update(true)); expect(register).toHaveBeenCalledTimes(1);
    });

    it('releases the former port and registers the new port through explicit remount', async () => {
        const oldReleases: Array<ReturnType<typeof vi.fn>> = [], newReleases: Array<ReturnType<typeof vi.fn>> = [];
        const oldPort = appTypePort(vi.fn(() => { const release = vi.fn(); oldReleases.push(release); return release; }));
        const newPort = appTypePort(vi.fn(() => { const release = vi.fn(); newReleases.push(release); return release; }));
        const definition = defineToolSet({ save: defineViewTypeTool({ viewType: 'Document', name: 'save', description: 'Save.', inputSchema: Type.Object({ content: Type.String() }) }) });
        function App() { return h(AppTools, { definition, bindings: { save: { execute: () => ({ success: true }) } } }); }
        const view = render(h(AppRuntimeContext.Provider, { value: contextFor(oldPort) }, h(App, { key: 'old' }))); mounted.push(view.unmount);
        expect(oldReleases).toHaveLength(1);
        await act(async () => view.rerender(h(AppRuntimeContext.Provider, { value: contextFor(newPort) }, h(App, { key: 'new' }))));
        expect(oldReleases[0]).toHaveBeenCalledOnce(); expect(newReleases).toHaveLength(1);
        view.unmount(); expect(newReleases[0]).toHaveBeenCalledOnce();
    });

    it('passes the Runtime-captured validator to execute and rejects invalid input before handler entry', async () => {
        const registrations: Array<{ definition: any; options: any }> = [];
        const port = appTypePort(vi.fn((definition, options) => { registrations.push({ definition, options }); return vi.fn(); }));
        const execute = vi.fn(async (args: Readonly<{ count: number }>) => ({ success: true, data: { count: args.count } }));
        const definition = defineToolSet({ inspect: defineViewTypeTool({ viewType: 'Counter', name: 'inspect', description: 'Inspect.',  inputSchema: Type.Object({ count: Type.Number({ minimum: 1 }) }, { additionalProperties: false }) }) });
        function App() { return h(AppTools, { definition, bindings: { inspect: { execute } } }); }
        mount(App, port); const registration = registrations[0]!; expect(registration.definition).not.toHaveProperty('isMutating');
        const compiled = compileOrdinarySchema(registration.definition.inputSchema); expect(compiled.ok).toBe(true); if (!compiled.ok) throw new Error('Contract must compile');
        const invoke = registration.options.createSafeOrdinaryParametersInvoker(compiled.contract);
        await expect(invoke({ count: 0 })).resolves.toMatchObject({ phase: 'not-entered' }); expect(execute).not.toHaveBeenCalled();
        await expect(invoke({ count: 3 })).resolves.toMatchObject({ phase: 'entered-returned', result: { success: true, data: { count: 3 } } }); expect(execute).toHaveBeenCalledWith({ count: 3 });
    });

    it('releases only the prior Schema through explicit ToolSet remount', async () => {
        const registrations: Array<{ definition: any; release: ReturnType<typeof vi.fn> }> = [];
        const port = appTypePort(vi.fn((definition) => { const release = vi.fn(); registrations.push({ definition, release }); return release; }));
        let update!: (next: boolean) => void;
        const contracts = [1, 2].map(minimum => defineToolSet({ set: defineViewTypeTool({ viewType: 'Counter', name: 'set', description: 'Set.', inputSchema: Type.Object({ count: Type.Number({ minimum }) }) }) }));
        function App() { const [changed, set] = useState(false); update = set; const definition = contracts[changed ? 1 : 0]!;
            return h(AppTools, { key: String(changed), definition, bindings: { set: { execute: () => ({ success: true }) } } }); }
        mount(App, port); await act(async () => update(true)); expect(registrations).toHaveLength(2); expect(registrations[0]!.release).toHaveBeenCalledOnce();
        expect(registrations[1]!.definition.inputSchema.properties.count.minimum).toBe(2);
    });

    it('requires the versioned AppTypeTool Runtime port without fallback', () => {
        const definition = defineToolSet({ open: defineViewTypeTool({ viewType: 'File', name: 'open', description: 'Open.', inputSchema: Type.Object({}) }) });
        function App() { return h(AppTools, { definition, bindings: { open: { execute: () => ({ success: true }) } } }); }
        expect(() => mount(App, { protocol: 'old', registerTypeTool() {} })).toThrow('TOOL_BINDING_PORT_INVALID');
        expect(() => mount(App, undefined)).toThrow('TOOL_BINDING_PORT_INVALID');
    });

    it.each([null, 0, 'yes'])('rejects a non-boolean enabled value: %s', enabled => {
        const definition = defineToolSet({ open: defineViewTypeTool({ viewType: 'File', name: 'open', description: 'Open.', inputSchema: Type.Object({}) }) });
        function App() { return h(AppTools, { definition, bindings: { open: { execute: () => ({ success: true }), enabled } } } as any); }
        expect(() => mount(App, appTypePort())).toThrow('TOOL_BINDING_INVALID');
    });

    it('treats absent enabled as true and rejects explicit undefined', () => {
        const register = vi.fn(() => vi.fn()); const definition = defineToolSet({ open: defineViewTypeTool({ viewType: 'File', name: 'open', description: 'Open.', inputSchema: Type.Object({}) }) });
        function App() { return h(AppTools, { definition, bindings: { open: { execute: () => ({ success: true }) } } }); }
        mount(App, appTypePort(register)); expect(register).toHaveBeenCalledOnce();
        function Invalid() { return h(AppTools, { definition, bindings: { open: { execute: () => ({ success: true }), enabled: undefined } } } as any); }
        expect(() => mount(Invalid, appTypePort())).toThrow('TOOL_BINDING_INVALID');
    });
});
