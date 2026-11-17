import { DEFAULT_PROJECTION_LIMITS } from '../../runtime/src/core/invocation/observation-registry.js';
import { createAppId, createDesktopId } from '../../runtime/src/spi/core/id-factory.js';
/**
 * M3 real SDK + Preact + AppKernel contract probes (NOT hand-authored HTML).
 * Assertions compare mounted View identities, Ref/Tool projections and the Core epoch.
 */
import { describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { createRefCapture } from '@aotui/runtime/spi';
import { View } from './components/View.js';
import { useDataRef } from './hooks/useRef.js';
import { useArrayRef } from './hooks/useArrayRef.js';
import { defineViewType, type ViewType } from './tools/view-type-tool.js';
import Type from 'typebox';
import { ViewRuntimeContext } from './contexts/view-runtime-context.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const refsOf = (kernel: AppKernel) => Object.fromEntries(
    kernel.getViewRefs().map(ref => [`${ref.viewId}:${ref.refId}`, ref.value]),
);

const EmptyWorkspace=defineViewType({name:'Workspace'});
function toolsOf(kernel:AppKernel) {
    const projection=kernel.getProjectionCoordinator();
    if (!projection.token().ready) return [];
    const result=projection.nextPublication();
    return 'draft' in result ? Object.values(result.draft.tools) : [];
}
function setup(component: () => any, viewTypes: readonly ViewType[] = [EmptyWorkspace]) {
    const factory = createTUIApp({ app_name: 'm3_app', component, viewTypes });
    const kernel = new AppKernel({ ...factory.kernelConfig, factory,
        appId: createAppId('m3_app_0'), desktopId: createDesktopId('desktop_0'),
        instanceId: 'projection-test-run', projectionLimits: DEFAULT_PROJECTION_LIMITS,
    });
    return {
        kernel, get container() { return document.getElementById('app-root-m3_app_0')!; },
        async open() {
            await kernel.onOpen();
        },
        async close() {
            await kernel.onClose();
        },
    };
}

describe('M3 SDK semantic projection commit', () => {
    it('exposes View, Ref, ArrayRef and one Tool activation on the initial committed frame', async () => {
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
        const Workspace=defineViewType<object>()({name:'Workspace',tools:{complete:{description:'Complete the current task.',inputSchema:Type.Object({}),execute:()=>({success:true})}}});

        function App() {
            return h(View,{kind:'state',id:'workspace',type:Workspace,context:{}},h(Content,{}));
        }
        const x = setup(App,[Workspace]);
        try {
            await x.open();
            const view = x.container.querySelector('[data-view-id="workspace"]');
            expect(view).not.toBeNull();
            expect(x.kernel.getViewOwnedViewInstances()[0]?.viewInstanceId).toEqual(expect.any(String));
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
            const tools = toolsOf(x.kernel);
            expect(tools).toHaveLength(1);
            expect(tools[0]).toMatchObject({name:'complete',viewType:'Workspace'});
            expect(tools[0]).not.toHaveProperty('execution');
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
        const Workspace=defineViewType<{enabled:boolean}>()({name:'Workspace',tools:{inspect:{description:'Inspect the Workspace.',inputSchema:Type.Object({}),enabled:ct=>ct.enabled,execute:()=>({success:true})}}});

        function App() {
            const [state, setState] = useState({ id: 'A', enabled: true }); update = setState;
            return h(View,{kind:'state',id:'workspace',type:Workspace,context:{enabled:state.enabled}},
                h(Content,{id:state.id}));
        }
        const x = setup(App,[Workspace]);
        const seen: Array<{ left?: string; right?: string; toolCount: number; ready: boolean }> = [];
        const unsubscribe = x.kernel.getProjectionCoordinator().subscribe(token => {
            seen.push({
                left: (refsOf(x.kernel)['workspace:left'] as any)?.id,
                right: (refsOf(x.kernel)['workspace:right'] as any)?.id,
                toolCount: toolsOf(x.kernel).length,
                ready: token.ready,
            });
        });
        try {
            await x.open();
            expect(toolsOf(x.kernel)).toHaveLength(1);
            seen.length = 0;
            await act(async () => update({ id: 'B', enabled: false }));
            expect((refsOf(x.kernel)['workspace:left'] as any)?.id).toBe('B');
            expect((refsOf(x.kernel)['workspace:right'] as any)?.id).toBe('B');
            expect(toolsOf(x.kernel)).toEqual([]);
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every(item => item.left === 'B' && item.right === 'B' && item.toolCount === 0 && item.ready)).toBe(true);

            seen.length = 0;
            await act(async () => update({ id: 'C', enabled: true }));
            expect((refsOf(x.kernel)['workspace:left'] as any)?.id).toBe('C');
            expect((refsOf(x.kernel)['workspace:right'] as any)?.id).toBe('C');
            expect(toolsOf(x.kernel)).toHaveLength(1);
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every(item => item.left === 'C' && item.right === 'C' && item.toolCount === 1 && item.ready)).toBe(true);
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
        function App() { return h(View, {kind: 'state', id: 'workspace', type: EmptyWorkspace }, h(Content, {})); }
        const x = setup(App);
        const epochs: number[] = [];
        const unsub = x.kernel.getProjectionCoordinator().subscribe(token => epochs.push(token.epoch));
        try {
            await x.open();
            await sleep(30);
            const html = x.container.innerHTML;
            const beforeEpoch = x.kernel.getProjectionCoordinator().token().epoch;
            let domChanges = 0;
            const observer = new window.MutationObserver(records => { domChanges += records.length; });
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
            return visible ? h(View, {kind: 'state', id: 'workspace', type: EmptyWorkspace }, h('p', {}, 'Visible')) : null;
        }
        const x = setup(App);
        try {
            await x.open();
            const original = x.kernel.getViewOwnedViewInstances()[0]?.viewInstanceId;
            expect(original).toBeTruthy();
            setVisible(false);
            await sleep(35);
            expect(x.container.querySelector('[data-view-id="workspace"]')).toBeNull();
            expect(x.kernel.getViewOwnedViewInstances()).toEqual([]);
            setVisible(true);
            await sleep(35);
            const fresh = x.kernel.getViewOwnedViewInstances()[0]?.viewInstanceId;
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
        function App() { return h(View, {kind: 'state', id: 'workspace', type: EmptyWorkspace }, h(Content, {})); }
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
        function App() { return h(View, {kind: 'state', id: 'workspace', type: EmptyWorkspace }, h(Content, {})); }
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
            const observer = new window.MutationObserver(records => { domMutations += records.length; });
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
        const Workspace=defineViewType<{enabled:boolean}>()({name:'Workspace',tools:{inspect:{description:'Inspect the current Workspace.',inputSchema:Type.Object({}),enabled:ct=>ct.enabled,execute:()=>({success:true})}}});

        function App() {
            const [state, set] = useState<State>(expected);
            mutate = next => { expected = next; set(next); };
            return state.show
                ? h(View,{kind:'state',id:'workspace',type:Workspace,context:{enabled:state.enabled}},
                    h('section',{},h(Details,{data:state.data})))
                : null;
        }
        const x = setup(App,[Workspace]);
        const observed: string[] = [];
        let torn = 0;
        const unlisten = x.kernel.getProjectionCoordinator().subscribe(token => {
            const views = x.kernel.getViewOwnedViewInstances();
            const refs = refsOf(x.kernel) as Record<string, any>;
            const ids = Object.keys(refs);
            const tools = toolsOf(x.kernel);
            if (!token.ready) torn++;
            if (views.length === 0) {
                if (ids.length || tools.length || x.container.querySelector('[data-view-id=workspace]')) torn++;
            } else {
                const domNode = x.container.querySelector('[data-view-id="workspace"]');
                if (!domNode || !views[0]?.viewInstanceId) torn++;
                // An emitted Ref must be registered under the same exact key.
                if (!Object.hasOwn(refs, 'workspace:tasks')) torn++;
                if (Object.hasOwn(refs, 'workspace:tasks[0]') &&
                    !domNode?.textContent?.includes('(Task:tasks[0])')) torn++;
                if (tools.length !== (expected.enabled ? 1 : 0)) torn++;
                if (tools.length && tools[0]!.viewType !== 'Workspace') torn++;
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
                const tools = toolsOf(x.kernel);
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
            captureRef: createRefCapture(),
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
                value: { viewId: 'example', ...registry },
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
        function App() { return h(View, {kind: 'state', id: 'workspace', type: EmptyWorkspace }, h(Content, {})); }
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
            return h(View, {kind: 'state', id: 'workspace', type: EmptyWorkspace }, h(Content, {}));
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
