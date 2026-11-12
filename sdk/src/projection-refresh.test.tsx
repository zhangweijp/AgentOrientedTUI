import { afterEach, describe, expect, it } from 'vitest';
import { Component, h, options } from 'preact';
import { act } from 'preact/test-utils';
import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
import Type from 'typebox';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { AppTools } from './components/AppTools.js';
import { View } from './components/View.js';
import { useDataRef } from './hooks/useRef.js';
import { useArrayRef } from './hooks/useArrayRef.js';
import { defineToolSet, defineViewTypeTool } from './tools/view-type-tool.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createSnapshotCore } from '../../runtime/src/core/index.js';

const previous = options.debounceRendering;
afterEach(() => { options.debounceRendering = previous; });

async function fixture(insideAct = false) {
    const queue: Array<() => void> = [];
    options.debounceRendering = callback => { queue.push(callback); };
    let update!: (value: number) => void;
    const tools = defineToolSet({ edit: defineViewTypeTool({ viewType: 'File', name: 'edit',
        description: 'Edit', inputSchema: Type.Object({}) }) });
    function Content({ value }: { value: number }) {
        const data = useMemo(() => ({ value }), [value]);
        const ref = useDataRef('selected', data);
        return h('p', {}, 'body:' + value + ref('Selection'));
    }
    function App() {
        const [value, set] = useState(0); update = set;
        return h(AppTools, { definition: tools, bindings: { edit: { enabled: value > 0, execute: () => ({ success: true }) } } },
            h(View, {kind: 'state', id: 'file', type: 'File' }, h(Content, { value })));
    }
    const factory = createTUIApp({ app_name: 'refresh_app', component: App });
    const kernel = new AppKernel({ ...factory.kernelConfig, factory } as any);
    kernel.setId('refresh_app' as any);
    const open = () => kernel.onOpen({ appId: 'refresh_app' as any, desktopId: 'desktop' as any,
         });
    if (insideAct) await act(async () => { await open(); }); else await open();
    return { kernel, get container() { return document.getElementById('app-root-refresh_app')!; }, update, queue, flush: () => { while (queue.length) queue.shift()!(); } };
}

describe('SDK queued render commit completion', () => {
    it('uses the value declared in render when another layout changes the original during the same commit', async () => {
        const record = { value: 1 };
        function OtherLayout() {
            useLayoutEffect(() => { record.value = 2; }, []);
            return null;
        }
        function Body() {
            const ref = useDataRef('selected', record);
            return h('p', {}, ref('Value ' + record.value));
        }
        const factory = createTUIApp({ app_name: 'render_capture', component: () =>
            h(View, { id: 'file', type: 'File', kind: 'state' }, [h(OtherLayout, { key: 'layout' }), h(Body, { key: 'body' })]) });
        const kernel = new AppKernel({ ...factory.kernelConfig, factory });
        try {
            await kernel.onOpen({ appId: 'render_capture' as any, desktopId: 'desktop' as any });
            const publication = kernel.getProjectionCoordinator().nextPublication();
            expect(publication).toMatchObject({ draft: { views: [{ content: { value: expect.stringContaining('Value 1') } }] } });
            expect(kernel.getViewRefs()[0]?.value).toEqual({ value: 1 });
            expect(record.value).toBe(2);
        } finally { await kernel.onClose(); }
    });

    it.each(['render', 'layout', 'class', 'capture', 'schema'] as const)(
        'discards a failed %s batch, keeps an unrelated commit degraded, and repairs the affected owners', async stage => {
            type Stage = typeof stage | 'ready' | 'fixed';
            let changeA!: (stage: Stage) => void;
            let updateB!: () => void;
            const error = new Error('controlled ' + stage + ' failure');
            class ClassLayout extends Component {
                componentDidMount() { throw error; }
                render() { return null; }
            }
            function A() {
                const [step, setStep] = useState<Stage>('ready'); changeA = setStep;
                const value = step === 'ready' ? 1 : step === 'fixed' ? 3 : 9;
                const ref = useDataRef('selected', step === 'capture' ? { value: () => value } : { value });
                useLayoutEffect(() => { if (step === 'layout') throw error; });
                if (step === 'render') throw error;
                return h('p', {}, ref('A:' + value), step === 'schema' ? 'x'.repeat(512 * 1024) : '',
                    step === 'class' ? h(ClassLayout, {}) : null);
            }
            function B() {
                const [value, setValue] = useState(2); updateB = () => setValue(4);
                const ref = useDataRef('selected', { value });
                return h('p', {}, ref('B:' + value));
            }
            const factory = createTUIApp({ app_name: 'failure_batch', component: () => [
                h(View, { id: 'aa', key: 'a', type: 'File', kind: 'state' }, h(A, {})),
                h(View, { id: 'bb', key: 'b', type: 'File', kind: 'state' }, h(B, {})),
            ] });
            const kernel = new AppKernel({ ...factory.kernelConfig, factory });
            const core = createSnapshotCore();
            kernel.setAppExecutionInstanceId('run');
            core.lifecycle.startApp('failure_batch', 'run');
            const projection = kernel.getProjectionCoordinator();
            const publish = () => projection.publishTo(core.committer);
            try {
                await kernel.onOpen({ appId: 'failure_batch' as any, desktopId: 'desktop' as any });
            const container = document.getElementById('app-root-failure_batch')!;
                const initial = publish();
                if (initial.status !== 'published') throw new Error('Missing initial snapshot');
                const epoch = projection.token().epoch;
                const attempt = async () => { await act(() => changeA(stage)); };
                if (stage === 'render' || stage === 'layout' || stage === 'class') await expect(attempt()).rejects.toBe(error);
                else await attempt();
                expect(publish().status).toBe('rejected');
                expect(projection.token()).toEqual({ epoch, ready: true });
                await act(updateB);
                expect(container.textContent).toContain('B:4');
                expect(publish().status).toBe('rejected');
                expect(core.store.readLatest('failure_batch')).toMatchObject({
                    status: 'degraded', lastGood: { id: initial.snapshot.id },
                });
                expect(kernel.getViewRefs().map(ref => ref.value)).toEqual([{ value: 1 }, { value: 2 }]);

                await act(() => changeA('fixed'));
                expect(projection.token().epoch).toBe(epoch + 1);
                const repaired = publish();
                expect(repaired).toMatchObject({ status: 'published', snapshot: { revision: 2,
                    views: [{ content: { value: expect.stringContaining('A:3') } },
                        { content: { value: expect.stringContaining('B:4') } }] } });
                expect(kernel.getViewRefs().map(ref => ref.value)).toEqual([{ value: 3 }, { value: 4 }]);
            } finally { await kernel.onClose(); core.lifecycle.dispose(); }
        },
    );

    it('captures Ref values only when their owner commits, including in-place array changes', async () => {
        const selected = { value: 1 };
        const other = { value: 2 };
        const items = [selected, other];
        let updateA!: () => void;
        let updateB!: () => void;
        function A() {
            const [, tick] = useState(0);
            updateA = () => tick(n => n + 1);
            const label = useDataRef('selected', selected, { refType: 'Record' });
            const [list] = useArrayRef('items', items, { itemType: 'Record' });
            return h('p', {}, label(`A:${selected.value}`), list('Items'));
        }
        function B() {
            const [value, tick] = useState(0);
            updateB = () => tick(n => n + 1);
            return h('p', {}, `B:${value}`);
        }
        const factory = createTUIApp({ app_name: 'ref_refresh', component: () => [
            h(View, { id: 'aa', type: 'File', kind: 'state', key: 'a' }, h(A, {})),
            h(View, { id: 'bb', type: 'File', kind: 'state', key: 'b' }, h(B, {})),
        ] });
        const kernel = new AppKernel({ ...factory.kernelConfig, factory });
        const refs = () => Object.fromEntries(kernel.getViewRefs().map(({ refId, value }) => [refId, value]));
        try {
            await kernel.onOpen({ appId: 'ref_refresh' as any, desktopId: 'desktop' as any });
            const container = document.getElementById('app-root-ref_refresh')!;
            selected.value = 3;
            items.push({ value: 4 });
            await act(updateB);
            expect(container.textContent).toContain('A:1');
            expect(container.textContent).toContain('B:1');
            expect(refs()).toEqual({ selected: { value: 1 }, items: [{ value: 1 }, { value: 2 }],
                'items[0]': { value: 1 }, 'items[1]': { value: 2 } });

            await act(updateA);
            expect(container.textContent).toContain('A:3');
            expect(refs()).toEqual({ selected: { value: 3 }, items: [{ value: 3 }, { value: 2 }, { value: 4 }],
                'items[0]': { value: 3 }, 'items[1]': { value: 2 }, 'items[2]': { value: 4 } });

            items.splice(1, 1);
            items.reverse();
            await act(updateA);
            expect(refs()).toEqual({ selected: { value: 3 }, items: [{ value: 4 }, { value: 3 }],
                'items[0]': { value: 4 }, 'items[1]': { value: 3 } });
            expect(Object.isFrozen(selected)).toBe(false);
            expect(Object.isFrozen(items)).toBe(false);
        } finally { await kernel.onClose(); }
    });

    it.each([false, true])('joins the real queued callback after initialization in act: %s', async insideAct => {
        const x = await fixture(insideAct);
        let committed: Promise<void> | undefined;
        try {
            x.update(1);
            let complete = false;
            committed = x.kernel.whenProjectionCommitted().then(() => { complete = true; });
            // Expose premature settlement while the actual scheduler is still blocked.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(x.queue).toHaveLength(1);
            expect(complete).toBe(false);
            expect(x.container.textContent).toContain('body:0');
            expect(x.kernel.getViewRefs()[0]?.value).toEqual({ value: 0 });
            expect(x.kernel.getToolDefinitions()).toEqual([]);
            x.flush(); await committed;
            expect(complete).toBe(true);
            expect(x.container.textContent).toContain('body:1');
            expect(x.kernel.getViewRefs()[0]?.value).toEqual({ value: 1 });
            expect(x.kernel.getToolDefinitions().map(t => t.name)).toEqual(['edit']);
            const epoch = x.kernel.getProjectionCoordinator().token();
            await x.kernel.whenProjectionCommitted();
            expect(x.kernel.getProjectionCoordinator().token()).toEqual(epoch);
        } finally { x.flush(); await committed; await x.kernel.onClose(); }
    });

    it('ends its wait on App close even when the application scheduler never runs', async () => {
        const x = await fixture();
        x.update(1);
        const waiting = x.kernel.whenProjectionCommitted();
        x.kernel.beginShutdown();
        await expect(waiting).rejects.toMatchObject({ code: 'PROJECTION_CLOSED' });
        await x.kernel.onClose();
        x.flush();
    });
});
