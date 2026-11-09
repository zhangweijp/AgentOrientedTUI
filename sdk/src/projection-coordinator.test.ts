/**
 * M3 real SDK + Preact + AppKernel contract probes (NOT hand-authored HTML).
 * Assertions compare mounted View identities, Ref/Tool projections and the Core epoch.
 */
import { describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useDataRef } from './hooks/useRef.js';
import { useArrayRef } from './hooks/useArrayRef.js';
import { AppTools, ToolRef } from './components/AppTools.js';
import { defineViewTypeTool, defineToolSet } from './tools/view-type-tool.js';
import Type from 'typebox';
import { ViewRuntimeContext } from './contexts/view-runtime-context.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const refsOf = (kernel: AppKernel) => Object.fromEntries(
    kernel.getViewRefs().map(ref => [`${ref.viewId}:${ref.refId}`, ref.value]),
);

function setup(component: () => any) {
    const factory = createTUIApp({ app_name: 'm3_app', component });
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
    kernel.setId('m3_app_0' as any);
    const container = document.createElement('div');
    document.body.appendChild(container);
    return {
        kernel, container,
        async open() {
            await kernel.onOpen({
                appId: 'm3_app_0' as any, desktopId: 'desktop_0' as any,
            }, container);
        },
        async close() {
            await kernel.onClose();
            container.remove();
        },
    };
}

describe('M3 SDK semantic projection commit', () => {
    it('exposes View, Ref, ArrayRef and one V3 type activation on the initial committed frame', async () => {
        function Content() {
            const [task] = useState({ id: 'A' });
            const ref = useDataRef('selected', task);
            const [listLabel, itemLabel] = useArrayRef('pending', [task], { itemType: 'Task' });
            return h('section', {}, [
                h('p', { key: 'selected' }, ref('Stable')),
                h('p', { key: 'item' }, itemLabel(0, 'Stable')),
                h('p', { key: 'list' }, listLabel('List')),
            ]);
        }
        const boundTools = defineToolSet({ tool: defineViewTypeTool({
                viewType: 'Workspace', name: 'complete', description: 'Complete the current task.',
                inputSchema: Type.Object({}),
            }) });

        function App() {
            return h(AppTools, { definition: boundTools, bindings: { tool: { execute: async () => ({ success: true }) } } }, h('main', {}, [
                h(View, {kind: 'state', id: 'workspace', type: 'Workspace' }, h(Content, {})),
                h(ToolRef, { tool: boundTools.tool }, 'Complete'),
            ]));
        }
        const x = setup(App);
        try {
            await x.open();
            const view = x.container.querySelector('[data-view-id="workspace"]');
            expect(view).not.toBeNull();
            expect(view?.getAttribute('data-view-instance-id')).toBeTruthy();
            expect(Object.keys(refsOf(x.kernel)).sort()).toEqual([
                'workspace:pending[0]',
                'workspace:pending',
                'workspace:selected',
            ].sort());
            const allRefs = refsOf(x.kernel) as Record<string, any>;
            expect(allRefs['workspace:pending[0]']).toMatchObject({ id: 'A' });
            expect(allRefs['workspace:pending']).toHaveLength(1);
            expect(x.container.innerHTML).toContain('(Task:pending[0])');
            expect(x.container.innerHTML).toContain('(Task[]:pending)');
            const tools = x.kernel.getToolDefinitions();
            expect(tools).toHaveLength(1);
            expect(tools[0]!.execution).toMatchObject({ kind: 'view-type', activationId: expect.any(String) });
            expect(tools[0]!.execution).not.toHaveProperty('targets');
            expect(x.container.querySelector('tool-ref')?.textContent).toBe('Complete');
            const token = x.kernel.getProjectionCoordinator().token();
            expect(token.ready).toBe(true);
            expect(token.epoch).toBeGreaterThan(0);
        } finally {
            await x.close();
        }
    });

    it('publishes View, Ref and disabled type Tool together from one state commit', async () => {
        let update!: (state: { id: string; enabled: boolean }) => void;
        function Content({ id }: { id: string }) {
            const left = useDataRef('left', { id });
            const right = useDataRef('right', { id });
            return h('section', {}, [h('p', { key: 'left' }, left('Stable')), h('p', { key: 'right' }, right('Stable'))]);
        }
        const boundTools = defineToolSet({ tool: defineViewTypeTool({
                viewType: 'Workspace', name: 'inspect', description: 'Inspect the Workspace.',
                inputSchema: Type.Object({}),
            }) });

        function App() {
            const [state, setState] = useState({ id: 'A', enabled: true }); update = setState;
            return h(AppTools, { definition: boundTools, bindings: { tool: { execute: async () => ({ success: true }), ...({ enabled: state.enabled }) } } }, h('main', {}, [
                h(View, {kind: 'state', id: 'workspace', type: 'Workspace' }, h(Content, { id: state.id })),
                h(ToolRef, { tool: boundTools.tool }, 'Inspect'),
            ]));
        }
        const x = setup(App);
        const seen: Array<{ left?: string; right?: string; toolCount: number; visible: boolean; ready: boolean }> = [];
        const unsubscribe = x.kernel.getProjectionCoordinator().subscribe(token => {
            seen.push({
                left: (refsOf(x.kernel)['workspace:left'] as any)?.id,
                right: (refsOf(x.kernel)['workspace:right'] as any)?.id,
                toolCount: x.kernel.getToolDefinitions().length,
                visible: x.container.querySelector('tool-ref') !== null,
                ready: token.ready,
            });
        });
        try {
            await x.open();
            expect(x.kernel.getToolDefinitions()).toHaveLength(1);
            seen.length = 0;
            await act(async () => update({ id: 'B', enabled: false }));
            expect((refsOf(x.kernel)['workspace:left'] as any)?.id).toBe('B');
            expect((refsOf(x.kernel)['workspace:right'] as any)?.id).toBe('B');
            expect(x.kernel.getToolDefinitions()).toEqual([]);
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every(item => item.left === 'B' && item.right === 'B' && item.toolCount === 0 && !item.visible && item.ready)).toBe(true);

            seen.length = 0;
            await act(async () => update({ id: 'C', enabled: true }));
            expect((refsOf(x.kernel)['workspace:left'] as any)?.id).toBe('C');
            expect((refsOf(x.kernel)['workspace:right'] as any)?.id).toBe('C');
            expect(x.kernel.getToolDefinitions()).toHaveLength(1);
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every(item => item.left === 'C' && item.right === 'C' && item.toolCount === 1 && item.visible && item.ready)).toBe(true);
        } finally {
            unsubscribe();
            await x.close();
        }
    });

    it('publishes Ref-only epoch changes even when the DOM and Tool descriptor remain unchanged', async () => {
        let update!: (value: { id: string }) => void;
        function Content() {
            const [value, setValue] = useState({ id: 'A' });
            update = setValue;
            const ref = useDataRef('selected', value);
            return h('p', {}, ref('Stable label'));
        }
        function App() { return h(View, {kind: 'state', id: 'workspace', type: 'Workspace' }, h(Content, {})); }
        const x = setup(App);
        const epochs: number[] = [];
        const unsub = x.kernel.getProjectionCoordinator().subscribe(token => epochs.push(token.epoch));
        try {
            await x.open();
            await sleep(30);
            const html = x.container.innerHTML;
            const beforeEpoch = x.kernel.getProjectionCoordinator().token().epoch;
            let domChanges = 0;
            const observer = new MutationObserver(records => { domChanges += records.length; });
            observer.observe(x.container, { childList: true, subtree: true, characterData: true, attributes: true });
            update({ id: 'B' });
            await sleep(45);
            observer.disconnect();
            const afterEpoch = x.kernel.getProjectionCoordinator().token().epoch;
            expect(x.container.innerHTML).toBe(html);
            expect(domChanges).toBe(0);
            expect((refsOf(x.kernel)['workspace:selected'] as any)?.id).toBe('B');
            expect(afterEpoch).toBeGreaterThan(beforeEpoch);
            expect(epochs.some(epoch => epoch > beforeEpoch)).toBe(true);
        } finally {
            unsub();
            await x.close();
        }
    });

    it('changes Runtime View identity after unmount/remount with identical View ID', async () => {
        let setVisible!: (value: boolean) => void;
        function App() {
            const [visible, update] = useState(true);
            setVisible = update;
            return visible ? h(View, {kind: 'state', id: 'workspace', type: 'Workspace' }, h('p', {}, 'Visible')) : null;
        }
        const x = setup(App);
        try {
            await x.open();
            const original = x.container.querySelector('[data-view-id="workspace"]')?.getAttribute('data-view-instance-id');
            expect(original).toBeTruthy();
            setVisible(false);
            await sleep(35);
            expect(x.container.querySelector('[data-view-id="workspace"]')).toBeNull();
            setVisible(true);
            await sleep(35);
            const fresh = x.container.querySelector('[data-view-id="workspace"]')?.getAttribute('data-view-instance-id');
            expect(fresh).toBeTruthy();
            expect(fresh).not.toBe(original);
            expect(x.kernel.getProjectionCoordinator().token().ready).toBe(true);
        } finally {
            await x.close();
        }
    });
});

describe('M3 observable commit-phase consistency', () => {
    it('never notifies a mixed pair of Ref bindings after one SDK state commit', async () => {
        let update!: (value: { id: string }) => void;
        function Content() {
            const [state, setState] = useState({ id: 'A' });
            update = setState;
            const left = useDataRef('left', state);
            const right = useDataRef('right', state);
            return h('section', {}, [
                h('p', {key:'left'}, left('Fixed label')),
                h('p', {key:'right'}, right('Fixed label')),
            ]);
        }
        function App() { return h(View, {kind: 'state', id: 'workspace', type: 'Workspace' }, h(Content, {})); }
        const x = setup(App);
        const seen: Array<{ left?: string; right?: string; ready: boolean }> = [];
        const unsubscribe = x.kernel.getProjectionCoordinator().subscribe(token => {
            const refs = refsOf(x.kernel) as Record<string, { id?: string }>;
            seen.push({
                left: refs['workspace:left']?.id,
                right: refs['workspace:right']?.id,
                ready: token.ready,
            });
        });
        try {
            await x.open();
            await sleep(20);
            seen.length = 0;
            update({ id: 'B' });
            await sleep(45);
            expect(seen.length).toBeGreaterThan(0);
            expect(seen).toEqual(seen.map(() => ({
                left: 'B', right: 'B', ready: true,
            })));
            expect(x.kernel.getProjectionCoordinator().token().ready).toBe(true);
        } finally {
            unsubscribe();
            await x.close();
        }
    });
});

describe('M3 ArrayRef marker and registry parity', () => {
    it('registers only emitted typed Ref IDs and cleans up stale items', async () => {
        type Task = { id: string };
        let setItems!: (next: { items: Task[]; itemType: string }) => void;
        function Content() {
            const [state, update] = useState({
                items: [{ id: 'A' }, { id: 'B' }],
                itemType: 'Task',
            });
            setItems = update;
            const [list, item] = useArrayRef('pending', state.items, { itemType: state.itemType });
            return h('section', {}, [
                h('p', { key: 'list' }, list('List')),
                h('p', { key: 'first' }, state.items.length ? item(0, 'Stable') : 'None'),
            ]);
        }
        function App() { return h(View, {kind: 'state', id: 'workspace', type: 'Workspace' }, h(Content, {})); }
        const x = setup(App);
        const key = (ref: string) => 'workspace:' + ref;
        try {
            await x.open();
            const refs = () => refsOf(x.kernel) as Record<string, any>;
            expect(refs()[key('pending')]).toEqual([{ id: 'A' }, { id: 'B' }]);
            expect(refs()[key('pending[0]')]).toEqual({ id: 'A' });
            expect(refs()[key('Task:pending[0]')]).toBeUndefined();
            expect(refs()[key('Task[]:pending')]).toBeUndefined();

            let domMutations = 0;
            const beforeHtml = x.container.innerHTML;
            const beforeEpoch = x.kernel.getProjectionCoordinator().token().epoch;
            const observer = new MutationObserver(records => { domMutations += records.length; });
            observer.observe(x.container, { childList: true, subtree: true, attributes: true, characterData: true });
            setItems({ items: [{ id: 'B' }, { id: 'A' }], itemType: 'Task' });
            await sleep(40);
            observer.disconnect();
            expect(domMutations).toBe(0);
            expect(x.container.innerHTML).toBe(beforeHtml);
            expect(refs()[key('pending[0]')]).toEqual({ id: 'B' });
            expect(refs()[key('pending')]).toEqual([{ id: 'B' }, { id: 'A' }]);
            expect(x.kernel.getProjectionCoordinator().token().epoch).toBeGreaterThan(beforeEpoch);

            setItems({ items: [{ id: 'B' }], itemType: 'Job' });
            await sleep(40);
            expect(x.kernel.getViewRefs().filter(r => r.viewId === 'workspace').every(r => r.refType === 'Job')).toBe(true);
            expect(refs()[key('pending')]).toEqual([{ id: 'B' }]);
            expect(refs()[key('pending[0]')]).toEqual({ id: 'B' });
            expect(refs()[key('Task:pending[0]')]).toBeUndefined();
            expect(refs()[key('Task[]:pending')]).toBeUndefined();

            setItems({ items: [], itemType: 'Job' });
            await sleep(40);
            expect(refs()[key('pending')]).toEqual([]);
            expect(refs()[key('pending[0]')]).toBeUndefined();
        } finally {
            await x.close();
        }
    });
});

describe('M3 rapid lifecycle and asynchronous projection resilience', () => {
    it('never exposes dangling Refs at notification boundaries through repeated mount/reorder/unmount', async () => {
        type Task = { id: string };
        type State = { show: boolean; data: Task[]; enabled: boolean };
        let mutate!: (next: State) => void;
        let expected: State = { show: true, data: [{ id: 'A' }], enabled: true };
        function Details({ data }: { data: Task[] }) {
            const [list, item] = useArrayRef('tasks', data, { itemType: 'Task' });
            return h('section', {}, [
                h('p', { key: 'list' }, list('List')),
                data.length ? h('p', { key: 'first' }, item(0, 'Stable')) : null,
            ]);
        }
        const boundTools = defineToolSet({ tool: defineViewTypeTool({
                viewType: 'Workspace', name: 'inspect', description: 'Inspect the current Workspace.',
                inputSchema: Type.Object({}),
            }) });

        function App() {
            const [state, set] = useState<State>(expected);
            mutate = next => { expected = next; set(next); };
            return h(AppTools, { definition: boundTools, bindings: { tool: { execute: async () => ({ success: true }), ...({ enabled: state.enabled }) } } }, state.show
                ? h(View, {kind: 'state', id: 'workspace', type: 'Workspace' },
                    h('section', {}, [h(Details, { key: 'refs', data: state.data }), h(ToolRef, { tool: boundTools.tool, ...({ key: 'tool' }) }, 'Inspect')]))
                : null);
        }
        const x = setup(App);
        const observed: string[] = [];
        let torn = 0;
        const unlisten = x.kernel.getProjectionCoordinator().subscribe(token => {
            const views = x.kernel.getViewOwnedViewInstances();
            const refs = refsOf(x.kernel) as Record<string, any>;
            const ids = Object.keys(refs);
            const tools = x.kernel.getToolDefinitions();
            if (!token.ready) torn++;
            if (views.length === 0) {
                if (ids.length || tools.length || x.container.querySelector('tool-ref')) torn++;
            } else {
                const domNode = x.container.querySelector('[data-view-id="workspace"]');
                if (!domNode || !domNode.getAttribute('data-view-instance-id')) torn++;
                // An emitted Ref must be registered under the same exact key.
                if (!Object.hasOwn(refs, 'workspace:tasks')) torn++;
                if (Object.hasOwn(refs, 'workspace:tasks[0]') &&
                    !domNode?.textContent?.includes('(Task:tasks[0])')) torn++;
                if (tools.length !== (expected.enabled ? 1 : 0)) torn++;
                if ((x.container.querySelector('tool-ref') !== null) !== expected.enabled) torn++;
                if (tools.length && (tools[0]!.execution.kind !== 'view-type' || Object.hasOwn(tools[0]!.execution, 'targets'))) torn++;
            }
            observed.push(views.length + '/' + ids.length + '/' + tools.length);
        });
        try {
            await x.open();
            // Deterministic pseudo-random changes; include a full close/reopen and
            // zero-item arrays, and vary ViewType Tool visibility in the same state update.
            let seed = 9001;
            for (let step = 0; step < 40; step++) {
                seed = (seed * 48271) % 2147483647;
                const show = step % 6 !== 0;
                const count = seed % 4;
                const enabled = seed % 3 !== 0;
                const data: Task[] = Array.from({ length: count }, (_, i) => ({
                    id: 'task_' + step + '_' + i,
                }));
                mutate({ show, data, enabled });
                await sleep(8);
                const currentViews = x.kernel.getViewOwnedViewInstances();
                const refs = refsOf(x.kernel);
                const tools = x.kernel.getToolDefinitions();
                if (!show) {
                    expect(currentViews).toHaveLength(0);
                    expect(Object.keys(refs)).toHaveLength(0);
                    expect(tools).toHaveLength(0);
                } else {
                    expect(currentViews).toHaveLength(1);
                    expect(Object.keys(refs).length).toBe(1 + data.length);
                    expect(tools).toHaveLength(enabled ? 1 : 0);
                }
            }
            expect(observed.length).toBeGreaterThan(10);
            expect(torn).toBe(0);
        } finally {
            unlisten();
            await x.close();
        }
    });
});

describe('M3 ArrayRef cleanup on registration failure', () => {
    it('removes every Ref registered before a later item registration throws', () => {
        const refs = new Map<string, object>();
        const registry = {
            registerRef(id: string, value: object) {
                if (id === 'pending[1]') throw new Error('controlled Ref registration failure');
                refs.set(id, value);
                return {
                    update(next: object) { refs.set(id, next); },
                    release() { refs.delete(id); },
                };
            },
        };
        function Content() {
            useArrayRef('pending', [{ id: 'A' }, { id: 'B' }], { itemType: 'Task' });
            return null;
        }
        const container = document.createElement('div');
        expect(() => render(
            h(ViewRuntimeContext.Provider, {
                value: { meta: {}, refs: registry } as any,
            }, h(Content, {})),
            container,
        )).toThrow('controlled Ref registration failure');
        expect([...refs.keys()]).toEqual([]);
        render(null, container);
    });
});

describe('M3 untyped ArrayRef marker and registry parity', () => {
    it('registers only bare IDs when itemType is omitted', async () => {
        function Content() {
            const [, item] = useArrayRef('pending', [{ id: 'A' }]);
            return h('p', {}, item(0, 'Stable'));
        }
        function App() { return h(View, {kind: 'state', id: 'workspace', type: 'Workspace' }, h(Content, {})); }
        const x = setup(App);
        try {
            await x.open();
            expect(Object.keys(refsOf(x.kernel)).sort()).toEqual([
                'workspace:pending',
                'workspace:pending[0]',
            ]);
            expect(x.container.textContent).toContain('(pending[0])');
        } finally {
            await x.close();
        }
    });
});

describe('M3 batched semantic updates', () => {
    it('coalesces rapid component state changes and observes only the final coherent Ref state', async () => {
        let setState!: (s: { id: string }) => void;
        function Content() {
            const [state, setter] = useState({ id: 'first' });
            setState = setter;
            const selected = useDataRef('selected', state);
            return h('section', {}, [
                h('p', {}, selected('Unchanging')),
            ]);
        }
        function App() {
            return h(View, {kind: 'state', id: 'workspace', type: 'Workspace' }, h(Content, {}));
        }
        const x = setup(App);
        const events: Array<{ epoch: number; id: string }> = [];
        const unsub = x.kernel.getProjectionCoordinator().subscribe(token => {
            events.push({
                epoch: token.epoch,
                id: (refsOf(x.kernel)['workspace:selected'] as any)?.id,
            });
        });
        try {
            await x.open();
            await sleep(20);
            events.length = 0;
            const oldContent = x.container.querySelector('p')?.textContent;
            for (let i = 0; i < 20; i++) {
                setState({ id: 'batch-' + i });
            }
            await sleep(50);
            expect(x.container.querySelector('p')?.textContent).toBe(oldContent);
            expect((refsOf(x.kernel)['workspace:selected'] as any).id).toBe('batch-19');
            expect(events.length).toBeGreaterThan(0);
            // No observer should ever receive the intermediate A/B mixed state.
            expect(events.every(x => x.id === 'batch-19')).toBe(true);
            expect(events.every((x,i) => i === 0 || x.epoch >= events[i-1].epoch)).toBe(true);
        } finally {
            unsub();
            await x.close();
        }
    });
});
