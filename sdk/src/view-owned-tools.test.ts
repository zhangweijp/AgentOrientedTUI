import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useViewTypeTool } from './hooks/useViewTypeTool.js';
import { useDataRef } from './hooks/useRef.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const OPTS = { description: 'Hover in this file', params: {
    line: { type: 'number' as const, required: true },
} };

function setup(component: () => any, options?: { instanceId?: string; container?: HTMLElement }) {
    const factory = createTUIApp({ app_name: 'owner_fixture', component });
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
    kernel.setId('app_owned' as any);
    kernel.setAppExecutionInstanceId(options?.instanceId ?? 'runtime-issued-execution-1');
    const container = options?.container ?? document.createElement('div');
    document.body.appendChild(container);
    const changed: number[] = [];
    return {
        kernel, container, changed,
        async open() {
            await kernel.onOpen({
                appId: 'app_owned' as any, desktopId: 'desktop_test' as any,
                markDirty: () => changed.push(1), onRender: () => {},
            }, container);
        },
        async close() {
            await kernel.onClose();
            container.remove();
        },
        async invoke(tool: any, target: any, args: Record<string, unknown>) {
            return (await kernel.invokeBoundOrdinaryParametersViewTool(tool, target, args)).result;
        },
    };
}
const refMap = (kernel: AppKernel) => Object.fromEntries(kernel.getViewRefs().map(ref => [`${ref.viewId}:${ref.refId}`, ref.value]));

describe('View-local useViewTypeTool with real Preact and AppKernel', () => {
    it('uses mounted Semantic View bindings without the retired View/type registries or tree', async () => {
        function Root() { return h(View, { id: 'root', type: 'Root' }, h('p', {}, 'Ready')); }
        const x = setup(Root);
        try {
            await x.open();
            expect(x.kernel.getViewOwnedViewInstances()).toMatchObject([
                { viewId: 'root', viewType: 'Root' },
            ]);
            expect((x.kernel as any).getAllTypeTools).toBeUndefined();
            expect((x.kernel as any).callTypeTool).toBeUndefined();
            expect((x.kernel as any).viewRegistry).toBeUndefined();
            expect(x.container.querySelector('[data-view-tree]')).toBeNull();
            expect(x.container.querySelector('[data-view-id="root"]')).not.toBeNull();
        } finally {
            await x.close();
        }
        expect(x.kernel.getViewOwnedViewInstances()).toEqual([]);
    });

    it('aggregates two FileDetails into one Tool while their independently bound handlers target the correct file', async () => {
        const appHover = vi.fn(async () => ({ success: true, data: { file: 'App.tsx' } }));
        const pkgHover = vi.fn(async () => ({ success: true, data: { file: 'package.json' } }));
        function Detail({ file }: { file: string }) {
            const [HoverUI] = useViewTypeTool('lsp_hover', OPTS, file === 'App.tsx' ? appHover : pkgHover);
            return h('section', {}, [h('p', { key: 'label' }, file), h(HoverUI, { key: 'tool' }, 'Hover')]);
        }
        function Root() {
            return h('main', {}, [
                h(View, { id: 'fd_0', type: 'FileDetail', key: 'app' },
                    h(Detail, { file: 'App.tsx' })),
                h(View, { id: 'fd_1', type: 'FileDetail', key: 'pkg' },
                    h(Detail, { file: 'package.json' })),
            ]);
        }
        const x = setup(Root);
        try {
            await x.open();
            const listed = x.kernel.getViewOwnedToolDefinitions();
            expect(listed).toHaveLength(1);
            expect(listed[0]).toMatchObject({
                appId: 'app_owned', appInstanceId: 'runtime-issued-execution-1',
                viewType: 'FileDetail', name: 'lsp_hover',
            });
            expect(listed[0].targets.map(t => t.viewId)).toEqual(['fd_0', 'fd_1']);
            expect(listed[0].targets[0].viewInstanceId).not.toBe(listed[0].targets[1].viewInstanceId);
            expect(x.container.querySelectorAll('tool-ref')).toHaveLength(2); // One affordance for each bound View.
            const first = await x.invoke(listed[0], listed[0].targets[0], { line: 1 });
            const second = await x.invoke(listed[0], listed[0].targets[1], { line: 2 });
            expect(first).toMatchObject({ success: true, data: { file: 'App.tsx' } });
            expect(second).toMatchObject({ success: true, data: { file: 'package.json' } });
            expect(appHover).toHaveBeenCalledTimes(1);
            expect(pkgHover).toHaveBeenCalledTimes(1);
            const instanceIds = Array.from(x.container.querySelectorAll('[data-view-instance-id]'))
                .map(node => node.getAttribute('data-view-instance-id'));
            expect(new Set(instanceIds).size).toBe(2);
        } finally {
            await x.close();
        }
        expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
    });

    it('closing A never unregisters B; reopening fd_0 gives a new ViewInstanceId', async () => {
        let setOpen!: (open: boolean) => void;
        const handlerA = vi.fn(async () => ({ success: true, data: { value: 'old' } }));
        const handlerB = vi.fn(async () => ({ success: true, data: { value: 'B' } }));
        const handlerNew = vi.fn(async () => ({ success: true, data: { value: 'new' } }));
        let reincarnated = false;
        function Detail({ handler }: { handler: () => Promise<any> }) {
            useViewTypeTool('inspect', { description: 'Inspect', params: {} }, handler);
            return h('p', {}, 'Stable');
        }
        function Root() {
            const [open, update] = useState(true);
            setOpen = update;
            return h('main', {}, [
                open ? h(View, { id: 'fd_0', key: 'a', type: 'FileDetail' },
                    h(Detail, { handler: reincarnated ? handlerNew : handlerA })) : null,
                h(View, { id: 'fd_1', key: 'b', type: 'FileDetail' },
                    h(Detail, { handler: handlerB })),
            ]);
        }
        const x = setup(Root);
        try {
            await x.open();
            const first = x.kernel.getViewOwnedToolDefinitions()[0];
            expect(first.targets).toHaveLength(2);
            const oldA = first.targets.find(t => t.viewId === 'fd_0')!;
            const beforeB = first.targets.find(t => t.viewId === 'fd_1')!;
            setOpen(false);
            await sleep(35);
            const remaining = x.kernel.getViewOwnedToolDefinitions()[0];
            expect(remaining.targets).toHaveLength(1);
            expect(remaining.targets[0]).toEqual(beforeB);
            const noA = await x.invoke(first, oldA, {});
            expect(noA).toMatchObject({ success: false, error: { code: 'VIEW_INSTANCE_REVOKED' } });
            expect((await x.invoke(first, beforeB, {})).success).toBe(true);
            reincarnated = true;
            setOpen(true);
            await sleep(35);
            const reopened = x.kernel.getViewOwnedToolDefinitions()[0];
            const nextA = reopened.targets.find(t => t.viewId === 'fd_0')!;
            expect(nextA.viewInstanceId).not.toBe(oldA.viewInstanceId);
            expect((await x.invoke(first, oldA, {})).success).toBe(false);
            expect((await x.invoke(reopened, nextA, {})).data).toEqual({ value: 'new' });
            expect(handlerA).not.toHaveBeenCalled();
            expect(handlerNew).toHaveBeenCalledTimes(1);
            expect(handlerB).toHaveBeenCalledTimes(1);
        } finally {
            await x.close();
        }
    });

    it('per-View enabled flags operate independently even during rapid re-render', async () => {
        let setFlags!: (flags: { a: boolean; b: boolean }) => void;
        const handlerA = vi.fn(async () => ({ success: true, data: { owner: 'A' } }));
        const handlerB = vi.fn(async () => ({ success: true, data: { owner: 'B' } }));
        function Detail({ enabled, handler }: { enabled: boolean; handler: () => Promise<any> }) {
            useViewTypeTool('inspect', { description: 'Inspect', params: {} },
                handler, { enabled });
            return h('p', {}, 'Unchanging');
        }
        function Root() {
            const [flags, update] = useState({ a: true, b: false });
            setFlags = update;
            return h('main', {}, [
                h(View, { id: 'fd_0', type: 'FileDetail', key: 'a' }, h(Detail, { enabled: flags.a, handler: handlerA })),
                h(View, { id: 'fd_1', type: 'FileDetail', key: 'b' }, h(Detail, { enabled: flags.b, handler: handlerB })),
            ]);
        }
        const x = setup(Root);
        try {
            await x.open();
            const initial = x.kernel.getViewOwnedToolDefinitions()[0];
            expect(initial.targets.map(t => t.viewId)).toEqual(['fd_0']);
            const oldA = initial.targets[0]!;
            expect(await x.invoke(initial, oldA, {})).toMatchObject({ success: true, data: { owner: 'A' } });
            setFlags({ a: false, b: true });
            await sleep(35);
            const later = x.kernel.getViewOwnedToolDefinitions()[0];
            expect(later.targets.map(t => t.viewId)).toEqual(['fd_1']);
            expect((await x.invoke(initial, oldA, {})).success).toBe(false);
            expect(handlerA).toHaveBeenCalledOnce(); expect(handlerB).not.toHaveBeenCalled();
            setFlags({ a: true, b: true });
            await sleep(35);
            const restored = x.kernel.getViewOwnedToolDefinitions()[0];
            expect(restored.targets).toHaveLength(2);
            const freshA = restored.targets.find(t => t.viewId === 'fd_0')!;
            expect(freshA.viewInstanceId).toBe(oldA.viewInstanceId);
            expect(freshA.bindingVersion).not.toBe(oldA.bindingVersion);
            expect(await x.invoke(restored, freshA, {})).toMatchObject({ success: true, data: { owner: 'A' } });
            expect(await x.invoke(initial, oldA, {})).toMatchObject({ success: false, error: { code: 'TOOL_SOURCE_STALE' } });
            expect(handlerA).toHaveBeenCalledTimes(2); expect(handlerB).not.toHaveBeenCalled();
        } finally {
            await x.close();
        }
    });

    it('unmounting a View releases its Ref and View-local Tool', async () => {
        let setOpen!: (open: boolean) => void;
        function Content() {
            const record = useDataRef('record', { id: 'A' });
            useViewTypeTool('inspect', { description: 'Inspect', params: {} },
                async () => ({ success: true }));
            return h('p', {}, record('Record'));
        }
        function Root() {
            const [open, update] = useState(true);
            setOpen = update;
            return open
                ? h(View, { id: 'fd_0', type: 'FileDetail' }, h(Content, {}))
                : null;
        }
        const x = setup(Root);
        try {
            await x.open();
            expect(refMap(x.kernel)['fd_0:record']).toEqual({ id: 'A' });
            expect(x.kernel.getViewOwnedToolDefinitions()[0]?.targets).toHaveLength(1);

            setOpen(false);
            await sleep(35);
            expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(0);
            expect(refMap(x.kernel)).toEqual({});
            expect(x.kernel.getViewOwnedToolDefinitions()).toEqual([]);
        } finally {
            await x.close();
        }
    });

});

describe('Committed lifecycle and Tool metadata updates', () => {
    it('APP_CLOSE fully unmounts Tool-owning Views, and APP_OPEN gets fresh IDs', async () => {
        const handler = vi.fn(async () => ({ success: true }));
        function Content() {
            useViewTypeTool('inspect', { description: 'Inspect', params: {} },
                handler);
            return h('p', {}, 'A');
        }
        const Root = () => h(View, { id: 'fd_0', type: 'FileDetail' }, h(Content, {}));
        const x = setup(Root);
        let next: ReturnType<typeof setup> | undefined;
        try {
            await x.open();
            const old = x.kernel.getViewOwnedToolDefinitions()[0];
            expect(old.targets).toHaveLength(1);
            await x.kernel.onClose();
            expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
            expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(0);
            await expect(x.open()).rejects.toHaveProperty('code', 'APP_KERNEL_CLOSED');
            next = setup(Root, { instanceId: 'runtime-issued-execution-2', container: x.container });
            await next.open();
            const again = next.kernel.getViewOwnedToolDefinitions()[0];
            expect(again.targets).toHaveLength(1);
            expect(again.appId).toBe(old.appId);
            expect(again.appInstanceId).not.toBe(old.appInstanceId);
            expect(again.targets[0].viewInstanceId).not.toBe(old.targets[0].viewInstanceId);
            expect((await x.invoke(old, old.targets[0], {})).error?.code)
                .toBe('TOOL_UNAVAILABLE');
            expect((await next.invoke(old, old.targets[0], {})).error?.code).toBe('VIEW_INSTANCE_REVOKED');
            expect(handler).not.toHaveBeenCalled();
            expect((await next.invoke(again, again.targets[0], {})).success).toBe(true);
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await next?.close();
            await x.close();
        }
    });

    it('a real parameter schema change invalidates only its own Tool registration', async () => {
        let change!: (value: boolean) => void;
        function Content() {
            const [asString, update] = useState(false);
            change = update;
            useViewTypeTool('inspect', {
                description: 'Inspect',
                params: { value: { type: asString ? 'string' as const : 'number' as const } },
            }, async () => ({ success: true }));
            return h('p', {}, 'Same text');
        }
        const x = setup(() => h(View, { id: 'fd_0', type: 'FileDetail' }, h(Content, {})));
        try {
            await x.open();
            const before = x.kernel.getViewOwnedToolDefinitions()[0];
            expect(before.inputSchema).toMatchObject({ properties: { value: { type: 'number' } } });
            change(true);
            await sleep(35);
            const after = x.kernel.getViewOwnedToolDefinitions()[0];
            expect(after.inputSchema).toMatchObject({ properties: { value: { type: 'string' } } });
            expect(after.targets[0].viewInstanceId).toBe(before.targets[0].viewInstanceId);
            expect(after.targets[0].bindingVersion).not.toBe(before.targets[0].bindingVersion);
            expect((await x.invoke(before, before.targets[0], {})).error?.code)
                .toBe('TOOL_SOURCE_STALE');
        } finally {
            await x.close();
        }
    });

    it('View-local Tool preserves a failed business outcome in a real SDK/AppKernel environment', async () => {
        const failure = { success: false, error: { code: 'E_LSP_DOWN', message: 'LSP unavailable' } };
        function Content() {
            useViewTypeTool('inspect', { description: 'Inspect', params: {} }, async () => failure);
            return h('p', {}, 'Inspect');
        }
        const x = setup(() => h(View, { id: 'fd_0', type: 'FileDetail' }, h(Content, {})));
        try {
            await x.open();
            const listed = x.kernel.getViewOwnedToolDefinitions()[0];
            const terminal = await x.kernel.invokeBoundOrdinaryParametersViewTool(listed, listed.targets[0], {});
            expect(terminal).toEqual({ phase: 'entered-returned', result: failure });
            expect(terminal).not.toHaveProperty('failureEffects'); // An undeclared business failure stays unknown to Core.
        } finally {
            await x.close();
        }
    });
});

describe('Deterministic multi-View lifecycle stress', () => {
    it('60 rapid commits preserve exclusive owners and never resurrect removed Tools', async () => {
        type Flags = Record<string, boolean>;
        let update!: (state: { mounted: Flags; enabled: Flags }) => void;
        const viewIds = ['fd_0', 'fd_1', 'fd_2', 'fd_3'];
        function Detail({ enabled }: { enabled: boolean }) {
            useViewTypeTool('inspect', {
                description: 'Inspect file', params: {},
            }, async () => ({ success: true }), { enabled });
            return h('span', {}, 'Stable');
        }
        function Root() {
            const [state, setter] = useState({
                mounted: Object.fromEntries(viewIds.map(id => [id, true])),
                enabled: Object.fromEntries(viewIds.map(id => [id, true])),
            });
            update = setter;
            return h('main', {}, viewIds.filter(id => state.mounted[id]).map(id =>
                h(View, { id, key: id, type: 'FileDetail' },
                    h(Detail, { enabled: state.enabled[id] })),
            ));
        }
        const x = setup(Root);
        const history = new Map<string, string>();
        let seed = 12345;
        try {
            await x.open();
            for (let step = 0; step < 60; step++) {
                const mounted: Flags = {};
                const enabled: Flags = {};
                for (const id of viewIds) {
                    seed = (seed * 48271) % 2147483647;
                    mounted[id] = seed % 5 !== 0;
                    enabled[id] = seed % 3 !== 0;
                }
                update({ mounted, enabled });
                await sleep(8);
                const targets = x.kernel.getViewOwnedToolDefinitions()[0]?.targets ?? [];
                const expected = viewIds.filter(id => mounted[id] && enabled[id]);
                expect(targets.map(t => t.viewId)).toEqual(expected);
                expect(new Set(targets.map(t => t.viewInstanceId)).size).toBe(targets.length);
                for (const id of expected) {
                    const token = targets.find(t => t.viewId === id)!.viewInstanceId;
                    const old = history.get(id);
                    if (old && !mounted[id]) throw new Error('Unexpected removed owner');
                    history.set(id, token);
                }
                if (targets.length) {
                    const selected = x.kernel.getViewOwnedToolDefinitions()[0];
                    expect(selected.targets.every(t => t.viewInstanceId.includes('runtime-issued-execution-1')))
                        .toBe(true);
                }
            }
        } finally {
            await x.close();
        }
        expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
    });
});

describe('Stable canonical Tool schema', () => {
    it('a merely reordered parameter object does not recreate the Tool binding', async () => {
        let reorder!: (state: boolean) => void;
        function Content() {
            const [reversed, set] = useState(false);
            reorder = set;
            const params = reversed
                ? { second: { type: 'string' as const }, first: { type: 'number' as const } }
                : { first: { type: 'number' as const }, second: { type: 'string' as const } };
            useViewTypeTool('inspect', { description: 'Inspect', params },
                async () => ({ success: true }));
            return h('p', {}, 'Same output');
        }
        const x = setup(() => h(View, { id: 'fd_0', type: 'FileDetail' }, h(Content, {})));
        try {
            await x.open();
            const before = x.kernel.getViewOwnedToolDefinitions()[0];
            reorder(true);
            await sleep(35);
            const after = x.kernel.getViewOwnedToolDefinitions()[0];
            expect(after.id).toBe(before.id);
            expect(after.targets[0]).toEqual(before.targets[0]);
            expect(after.inputSchema).toEqual(before.inputSchema);
        } finally {
            await x.close();
        }
    });

    it('a malicious accessor in parameter metadata is rejected without executing its getter', async () => {
        let calls = 0;
        const params = Object.defineProperty({}, 'value', {
            enumerable: true,
            get() { calls++; return { type: 'string' }; },
        });
        function Content() {
            useViewTypeTool('inspect', { description: 'Inspect', params: params as any },
                async () => ({ success: true }));
            return h('p', {}, 'Never published');
        }
        const x = setup(() => h(View, { id: 'fd_0', type: 'FileDetail' }, h(Content, {})));
        try {
            await expect(x.open()).rejects.toThrow(/Accessors|hidden properties/);
            expect(calls).toBe(0);
            expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
        } finally {
            await x.close();
        }
    });
});

describe('Failed mount is not a partially published Tool', () => {
    it('rejects incompatible same-type definitions without exposing a conflicting group', async () => {
        let conflict = true;
        function Content({ description }: { description: string }) {
            useViewTypeTool('inspect', { description, params: {} },
                async () => ({ success: true }));
            return h('p', {}, 'Stable');
        }
        const x = setup(() => h('main', {}, [
            h(View, { id: 'fd_0', type: 'FileDetail', key: 'a' },
                h(Content, { description: 'Public Schema A' })),
            h(View, { id: 'fd_1', type: 'FileDetail', key: 'b' },
                h(Content, { description: conflict ? 'Conflicting Schema B' : 'Public Schema A' })),
        ]));
        try {
            await expect(x.open()).rejects.toThrow(/TOOL_SCHEMA_CONFLICT/);
            expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
        } finally {
            await x.close();
        }
    });
});
