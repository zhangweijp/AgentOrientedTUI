/**
 * M3 real SDK + Preact + AppKernel contract probes (NOT hand-authored HTML).
 * Assertions compare actual View/Ref/ViewTypeTool registries and the Core epoch.
 */
import { describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useDataRef } from './hooks/useRef.js';
import { useArrayRef } from './hooks/useArrayRef.js';
import { useViewTypeTool } from './hooks/useViewTypeTool.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const TOOL_PARAMS = {};

function setup(component: () => any) {
    const factory = createTUIApp({ app_name: 'm3_app', component });
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
    kernel.setId('m3_app_0' as any);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const markDirty: string[] = [];
    return {
        kernel, container, markDirty,
        async open() {
            await kernel.onOpen({
                appId: 'm3_app_0' as any, desktopId: 'desktop_0' as any,
                markDirty: () => markDirty.push('dirty'), onRender: () => {},
            }, container);
        },
        async close() {
            (kernel as any).componentRenderer?.unmount();
            await kernel.onClose();
            container.remove();
        },
    };
}

describe('M3 SDK semantic projection commit', () => {
    it('exposes View, single Ref, ArrayRef and ViewTypeTool on the initial committed frame', async () => {
        function Content() {
            const [task] = useState({ id: 'A' });
            const ref = useDataRef('selected', task);
            const [listLabel, itemLabel] = useArrayRef('pending', [task], { itemType: 'Task' });
            const [ToolUI] = useViewTypeTool('Workspace', 'complete', {
                description: 'Complete task', params: TOOL_PARAMS,
            }, async () => ({ success: true }));
            return h('section', {}, [
                h('p', { key: 'selected' }, ref('Stable')),
                h('p', { key: 'item' }, itemLabel(0, 'Stable')),
                h('p', { key: 'list' }, listLabel('List')),
                h(ToolUI, { key: 'tool' }, 'Complete'),
            ]);
        }
        function App() {
            return h(View, { id: 'workspace', type: 'Workspace' }, h(Content, {}));
        }
        const x = setup(App);
        try {
            await x.open();
            const view = x.container.querySelector('[data-view-id="workspace"]');
            expect(view).not.toBeNull();
            expect(view?.getAttribute('data-view-generation')).toMatch(/^sdk_mount_/);
            expect(Object.keys(x.kernel.exportRefsToIndexMap()).sort()).toEqual([
                'workspace:Task:pending[0]',
                'workspace:Task[]:pending',
                'workspace:pending',
                'workspace:pending[0]',
                'workspace:selected',
            ].sort());
            const allRefs = x.kernel.exportRefsToIndexMap() as Record<string, any>;
            expect(allRefs['workspace:Task:pending[0]']).toMatchObject({ id: 'A' });
            expect(allRefs['workspace:Task[]:pending']).toHaveLength(1);
            expect(x.container.innerHTML).toContain('(Task:pending[0])');
            expect(x.container.innerHTML).toContain('(Task[]:pending)');
            expect(x.kernel.getAllTypeTools().get('Workspace')).toHaveLength(1);
            const registeredTool = x.kernel.getAllTypeTools().get('Workspace')![0];
            expect(registeredTool.declaredByViewId).toBe('workspace');
            expect(registeredTool.declaredByViewGeneration).toBe(view?.getAttribute('data-view-generation'));
            const token = x.kernel.getProjectionCoordinator().token();
            expect(token.ready).toBe(true);
            expect(token.epoch).toBeGreaterThan(0);
        } finally {
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
        function App() { return h(View, { id: 'workspace', type: 'Workspace' }, h(Content, {})); }
        const x = setup(App);
        const epochs: number[] = [];
        const unsub = x.kernel.getProjectionCoordinator().subscribe(token => epochs.push(token.epoch));
        try {
            await x.open();
            await sleep(30);
            const html = x.container.innerHTML;
            const beforeEpoch = x.kernel.getProjectionCoordinator().token().epoch;
            const beforeDirty = x.markDirty.length;
            let domChanges = 0;
            const observer = new MutationObserver(records => { domChanges += records.length; });
            observer.observe(x.container, { childList: true, subtree: true, characterData: true, attributes: true });
            update({ id: 'B' });
            await sleep(45);
            observer.disconnect();
            const afterEpoch = x.kernel.getProjectionCoordinator().token().epoch;
            expect(x.container.innerHTML).toBe(html);
            expect(domChanges).toBe(0);
            expect((x.kernel.exportRefsToIndexMap()['workspace:selected'] as any)?.id).toBe('B');
            expect(afterEpoch).toBeGreaterThan(beforeEpoch);
            expect(epochs.some(epoch => epoch > beforeEpoch)).toBe(true);
            expect(x.markDirty.length).toBe(beforeDirty);
        } finally {
            unsub();
            await x.close();
        }
    });

    it('unregisters disabled ViewTypeTool in the same commit as availability changes', async () => {
        let enabled!: (value: boolean) => void;
        function Content() {
            const [on, setOn] = useState(true);
            enabled = setOn;
            const [ToolUI] = useViewTypeTool('Workspace', 'complete', {
                description: 'Complete', params: TOOL_PARAMS,
            }, async () => ({ success: true }), { enabled: on });
            return h(ToolUI, {}, 'Complete');
        }
        function App() { return h(View, { id: 'workspace', type: 'Workspace' }, h(Content, {})); }
        const x = setup(App);
        try {
            await x.open();
            expect(x.kernel.getAllTypeTools().get('Workspace')).toHaveLength(1);
            const before = x.kernel.getProjectionCoordinator().token().epoch;
            enabled(false);
            await sleep(35);
            expect(x.kernel.getAllTypeTools().get('Workspace')).toBeUndefined();
            expect(x.kernel.getProjectionCoordinator().token().epoch).toBeGreaterThan(before);
            enabled(true);
            await sleep(35);
            expect(x.kernel.getAllTypeTools().get('Workspace')).toHaveLength(1);
        } finally {
            await x.close();
        }
    });

    it('changes View generation after unmount/remount with identical View ID', async () => {
        let setVisible!: (value: boolean) => void;
        function App() {
            const [visible, update] = useState(true);
            setVisible = update;
            return visible ? h(View, { id: 'workspace', type: 'Workspace' }, h('p', {}, 'Visible')) : null;
        }
        const x = setup(App);
        try {
            await x.open();
            const original = x.container.querySelector('[data-view-id="workspace"]')?.getAttribute('data-view-generation');
            expect(original).toBeTruthy();
            setVisible(false);
            await sleep(35);
            expect(x.container.querySelector('[data-view-id="workspace"]')).toBeNull();
            setVisible(true);
            await sleep(35);
            const fresh = x.container.querySelector('[data-view-id="workspace"]')?.getAttribute('data-view-generation');
            expect(fresh).toBeTruthy();
            expect(fresh).not.toBe(original);
            expect(x.kernel.getProjectionCoordinator().token().ready).toBe(true);
        } finally {
            await x.close();
        }
    });
});

describe('M3 observable commit-phase consistency', () => {
    it('never notifies a mixed pair of Ref bindings or a stale Tool after one SDK state commit', async () => {
        let update!: (value: { id: string; enabled: boolean }) => void;
        const PARAMS = {};
        function Content() {
            const [state, setState] = useState({ id: 'A', enabled: true });
            update = setState;
            const left = useDataRef('left', state);
            const right = useDataRef('right', state);
            const [ToolUI] = useViewTypeTool('Workspace', 'run', {
                description: 'Run', params: PARAMS,
            }, async () => ({ success: true }), { enabled: state.enabled });
            return h('section', {}, [
                h('p', {key:'left'}, left('Fixed label')),
                h('p', {key:'right'}, right('Fixed label')),
                h(ToolUI, {key:'tool'}, 'Run'),
            ]);
        }
        function App() { return h(View, { id: 'workspace', type: 'Workspace' }, h(Content, {})); }
        const x = setup(App);
        const seen: Array<{ left?: string; right?: string; tool: boolean; ready: boolean }> = [];
        const unsubscribe = x.kernel.getProjectionCoordinator().subscribe(token => {
            const refs = x.kernel.exportRefsToIndexMap() as Record<string, { id?: string }>;
            seen.push({
                left: refs['workspace:left']?.id,
                right: refs['workspace:right']?.id,
                tool: !!x.kernel.getAllTypeTools().get('Workspace')?.length,
                ready: token.ready,
            });
        });
        try {
            await x.open();
            await sleep(20);
            seen.length = 0;
            update({ id: 'B', enabled: false });
            await sleep(45);
            expect(seen.length).toBeGreaterThan(0);
            expect(seen).toEqual(seen.map(() => ({
                left: 'B', right: 'B', tool: false, ready: true,
            })));
            expect(x.kernel.getProjectionCoordinator().token().ready).toBe(true);
        } finally {
            unsubscribe();
            await x.close();
        }
    });
});

describe('M3 typed ArrayRef marker and registry parity', () => {
    it('resolves every emitted typed Ref marker, preserves bare aliases and cleans up stale items', async () => {
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
        function App() { return h(View, { id: 'workspace', type: 'Workspace' }, h(Content, {})); }
        const x = setup(App);
        const key = (ref: string) => 'workspace:' + ref;
        try {
            await x.open();
            const refs = () => x.kernel.exportRefsToIndexMap() as Record<string, any>;
            expect(refs()[key('Task[]:pending')]).toEqual([{ id: 'A' }, { id: 'B' }]);
            expect(refs()[key('Task:pending[0]')]).toEqual({ id: 'A' });
            expect(refs()[key('pending[0]')]).toEqual({ id: 'A' });
            expect(refs()[key('pending')]).toEqual([{ id: 'A' }, { id: 'B' }]);

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
            expect(refs()[key('Task:pending[0]')]).toEqual({ id: 'B' });
            expect(refs()[key('Task[]:pending')]).toEqual([{ id: 'B' }, { id: 'A' }]);
            expect(x.kernel.getProjectionCoordinator().token().epoch).toBeGreaterThan(beforeEpoch);

            setItems({ items: [{ id: 'B' }], itemType: 'Job' });
            await sleep(40);
            expect(refs()[key('Task[]:pending')]).toBeUndefined();
            expect(refs()[key('Task:pending[0]')]).toBeUndefined();
            expect(refs()[key('pending[1]')]).toBeUndefined();
            expect(refs()[key('Job[]:pending')]).toEqual([{ id: 'B' }]);
            expect(refs()[key('Job:pending[0]')]).toEqual({ id: 'B' });

            setItems({ items: [], itemType: 'Job' });
            await sleep(40);
            expect(refs()[key('Job[]:pending')]).toEqual([]);
            expect(refs()[key('pending[0]')]).toBeUndefined();
            expect(refs()[key('Job:pending[0]')]).toBeUndefined();
        } finally {
            await x.close();
        }
    });
});

describe('M3 rapid lifecycle and asynchronous projection resilience', () => {
    it('never exposes dangling Ref/Tool at notification boundaries through repeated mount/reorder/unmount', async () => {
        type Task = { id: string };
        let mutate!: (next: { show: boolean; data: Task[]; enabled: boolean }) => void;
        function Details({ data, enabled }: { data: Task[]; enabled: boolean }) {
            const [list, item] = useArrayRef('tasks', data, { itemType: 'Task' });
            const [ToolUI] = useViewTypeTool('Workspace', 'inspect', {
                description: 'Inspect', params: TOOL_PARAMS,
            }, async () => ({ success: true }), { enabled });
            return h('section', {}, [
                h('p', { key: 'list' }, list('List')),
                data.length ? h('p', { key: 'first' }, item(0, 'Stable')) : null,
                h(ToolUI, { key: 'tool' }, 'Inspect'),
            ]);
        }
        function App() {
            const [state, set] = useState({
                show: true, data: [{ id: 'A' }] as Task[], enabled: true,
            });
            mutate = set;
            return state.show
                ? h(View, { id: 'workspace', type: 'Workspace' },
                    h(Details, { data: state.data, enabled: state.enabled }))
                : null;
        }
        const x = setup(App);
        const observed: string[] = [];
        let torn = 0;
        const unlisten = x.kernel.getProjectionCoordinator().subscribe(token => {
            const views = (x.kernel as any).viewRegistry.getAll();
            const refs = x.kernel.exportRefsToIndexMap() as Record<string, any>;
            const ids = Object.keys(refs);
            const tools = x.kernel.getAllTypeTools().get('Workspace') ?? [];
            if (!token.ready) torn++;
            if (views.length === 0) {
                if (ids.length || tools.length) torn++;
            } else {
                const domNode = x.container.querySelector('[data-view-id="workspace"]');
                if (!domNode || !domNode.getAttribute('data-view-generation')) torn++;
                // An emitted Ref must be registered under the same exact key.
                if (!Object.hasOwn(refs, 'workspace:Task[]:tasks')) torn++;
                if (Object.hasOwn(refs, 'workspace:Task:tasks[0]') &&
                    !Object.hasOwn(refs, 'workspace:tasks[0]')) torn++;
            }
            observed.push(views.length + '/' + ids.length + '/' + tools.length);
        });
        try {
            await x.open();
            // Deterministic pseudo-random changes; include a full close/reopen and
            // zero-item arrays, and vary Tool visibility in the same state update.
            let seed = 9001;
            for (let step = 0; step < 40; step++) {
                seed = (seed * 48271) % 2147483647;
                const show = step % 6 !== 0;
                const count = seed % 4;
                const data: Task[] = Array.from({ length: count }, (_, i) => ({
                    id: 'task_' + step + '_' + i,
                }));
                const enabled = (seed & 1) === 1;
                mutate({ show, data, enabled });
                await sleep(8);
                const currentViews = (x.kernel as any).viewRegistry.getAll();
                const refs = x.kernel.exportRefsToIndexMap();
                if (!show) {
                    expect(currentViews).toHaveLength(0);
                    expect(Object.keys(refs)).toHaveLength(0);
                    expect(x.kernel.getAllTypeTools().get('Workspace')).toBeUndefined();
                } else {
                    expect(currentViews).toHaveLength(1);
                    expect(Object.keys(refs).length).toBe(2 + data.length * 2);
                    const tools = x.kernel.getAllTypeTools().get('Workspace');
                    expect(tools?.length ?? 0).toBe(enabled ? 1 : 0);
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

describe('M3 batched semantic updates', () => {
    it('coalesces rapid component state changes and observes only the final coherent Ref/Tool state', async () => {
        let setState!: (s: { id: string; enabled: boolean }) => void;
        function Content() {
            const [state, setter] = useState({ id: 'first', enabled: true });
            setState = setter;
            const selected = useDataRef('selected', state);
            const [ToolUI] = useViewTypeTool('Workspace', 'inspect', {
                description: 'Inspect', params: TOOL_PARAMS,
            }, async () => ({ success: true }), { enabled: state.enabled });
            return h('section', {}, [
                h('p', {}, selected('Unchanging')),
                h(ToolUI, {}, 'Inspect'),
            ]);
        }
        function App() {
            return h(View, { id: 'workspace', type: 'Workspace' }, h(Content, {}));
        }
        const x = setup(App);
        const events: Array<{ epoch: number; id: string; tool: boolean; visible: boolean }> = [];
        const unsub = x.kernel.getProjectionCoordinator().subscribe(token => {
            events.push({
                epoch: token.epoch,
                id: (x.kernel.exportRefsToIndexMap()['workspace:selected'] as any)?.id,
                tool: !!x.kernel.getAllTypeTools().get('Workspace')?.length,
                visible: !!x.container.querySelector('tool-ref'),
            });
        });
        try {
            await x.open();
            await sleep(20);
            events.length = 0;
            const oldContent = x.container.querySelector('p')?.textContent;
            expect(x.container.querySelector('tool-ref')?.textContent).toBe('Inspect');
            for (let i = 0; i < 20; i++) {
                setState({ id: 'batch-' + i, enabled: i % 2 === 0 });
            }
            await sleep(50);
            expect(x.container.querySelector('p')?.textContent).toBe(oldContent);
            expect(x.container.querySelector('tool-ref')).toBeNull();
            expect((x.kernel.exportRefsToIndexMap()['workspace:selected'] as any).id).toBe('batch-19');
            expect(x.kernel.getAllTypeTools().get('Workspace')).toBeUndefined();
            expect(events.length).toBeGreaterThan(0);
            // No observer should ever receive the intermediate A/B mixed state.
            expect(events.every(x => x.id === 'batch-19' && !x.tool && !x.visible)).toBe(true);
            expect(events.every((x,i) => i === 0 || x.epoch >= events[i-1].epoch)).toBe(true);
        } finally {
            unsub();
            await x.close();
        }
    });
});
