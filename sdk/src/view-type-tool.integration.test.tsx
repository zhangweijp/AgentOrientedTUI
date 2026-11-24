import { mountedViews } from './__tests__/projection-facts.js';
import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { createAppId, createDesktopId } from '../../runtime/src/spi/core/id-factory.js';
import { Component, type ComponentChildren, h } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import Type from 'typebox';
import { expect, it, vi } from 'vitest';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { DynamicView, StaticView, defineViewType as defineJSXViewType } from './components/View.js';
import { useDataRef } from './hooks/useRef.js';
import { defineViewType, refParam } from './tools/view-type-tool.js';

const increment = { description:'Increment the counter', inputSchema:Type.Object({
        amount:Type.Optional(Type.Integer()),
        observed:Type.Optional(refParam('Count', Type.Object({value:Type.Integer()}))),
    }, {additionalProperties:false}) };

it('keeps the close action with the actual direct and explicit JSX mounts', async () => {
    const Direct = defineJSXViewType({ name: 'Direct', multiplicity: 'single', region: 'dynamic' });
    const Explicit = defineViewType({ name: 'Explicit', multiplicity: 'multiple' });
    const called: string[] = [];
    function App() {
        const [open, setOpen] = useState(['Direct', 'static_page', 'dynamic_page']);
        const close = (name: string) => () => {
            called.push(name);
            setOpen(items => items.filter(item => item !== name));
            return { success: true as const };
        };
        return <>
            {open.includes('Direct') && <Direct onClose={close('Direct')}>direct page</Direct>}
            {open.includes('static_page') && <StaticView type={Explicit} idPrefix="static_page" onClose={close('static_page')}>static</StaticView>}
            {open.includes('dynamic_page') && <DynamicView type={Explicit} idPrefix="dynamic_page" onClose={close('dynamic_page')}>dynamic</DynamicView>}
        </>;
    }
    const factory = createTUIApp({ app_name: 'closable', component: App, viewTypes: [Direct, Explicit] });
    const kernel = new AppKernel({ factory, appId: createAppId('closable'), desktopId: createDesktopId('desktop'),
        instanceId: 'closable-run', projectionLimits: DEFAULT_PROJECTION_LIMITS });
    const frame = () => {
        const publication = kernel.getProjectionCoordinator().nextPublication();
        if (!('draft' in publication)) throw new Error('Expected committed frame');
        return publication.draft;
    };
    try {
        await act(async () => kernel.onOpen());
        const mounts = frame().views.slice();
        expect(mounts.map(view => [view.id, view.region, view.canClose])).toEqual([
            ['Direct', 'dynamic', true], ['static_page_1', 'static', true], ['dynamic_page_1', 'dynamic', true],
        ]);
        for (const view of mounts) {
            await act(async () => {
                expect(await kernel.closeView(view.id, view.viewInstanceId)).toMatchObject({ phase: 'entered-returned' });
            });
            expect(frame().views.some(current => current.viewInstanceId === view.viewInstanceId)).toBe(false);
            expect(await kernel.closeView(view.id, view.viewInstanceId)).toMatchObject({ phase: 'not-entered' });
        }
        expect(called).toEqual(['Direct', 'static_page', 'dynamic_page']);
    } finally { await act(async () => kernel.onClose()); }
});
type CounterContext = {
    id: string;
    generation: number;
    enabled: boolean;
    setCount: (update: (value: number) => number) => void;
};

it('commits Preact body, Ref and context-derived tools as one frame', async () => {
    const entered = vi.fn();
    const Counter = defineViewType<CounterContext>()({ multiplicity: 'multiple', name:'Counter', tools:{
        increment: {
            ...increment,
            execute({ input, context: { id, generation, setCount } }) {
                entered(id,generation,input,Object.isFrozen(input),Object.isFrozen(input.observed));
                setCount(value => value + (input.observed?.value ?? input.amount ?? 1));
                return {success:true};
            },
            enabled: context => context.enabled,
        },
    } });
    let advance!: (phase: number) => void;
    function CounterPage({id, generation, enabled, broken}: {
        id:string; generation:number; enabled:boolean; broken:boolean;
    }) {
        const [count,setCount] = useState(id === 'a' ? 0 : 10);
        const context = { id, generation, enabled, setCount };
        const content = <Content count={count} broken={broken} />;
        return <DynamicView idPrefix={id}  type={Counter} context={context}>{content}</DynamicView>;
    }
    function Content({count, broken}: {count:number;broken:boolean}) {
        const mark = useDataRef('count',{value:count},{ schema: Type.Object({}), scope: 'protected',refType:'Count'});
        if (broken) throw Error('failed-render');
        return <p>{mark(String(count))}</p>;
    }
    class Boundary extends Component<{children:ComponentChildren},{failed:boolean}> {
        state = {failed:false};
        static getDerivedStateFromError() { return {failed:true}; }
        render() { return this.state.failed ? null : this.props.children; }
    }
    function Fault() { throw Error('failed-render'); }
    function App() {
        const [phase,set] = useState(0);
        advance = set;
        return <>
            {phase !== 6 && <CounterPage key={phase === 5 ? 'new-a' : 'a'} id="a" generation={phase} enabled={phase !== 3} broken={false} />}
            <CounterPage key="b" id="b" generation={phase} enabled broken={false} />
            {phase === 2 && <Boundary><Fault /></Boundary>}
        </>;
    }
    const factory = createTUIApp({ app_name:'counter',viewTypes:[Counter],component:App });
    const kernel = new AppKernel({ factory,
        appId: createAppId('counter'), desktopId: createDesktopId('desktop'),
        instanceId: 'counter-run', projectionLimits: DEFAULT_PROJECTION_LIMITS,
    });
    const projection = kernel.getProjectionCoordinator();
    const frame = () => {
        const publication = projection.nextPublication();
        if (!('draft' in publication)) throw Error(JSON.stringify(publication.failure.issue));
        return publication.draft;
    };
    try {
        await act(async () => kernel.onOpen());
        const first = frame();
        expect(Object.keys(first.tools)).toHaveLength(1);
        const [tool] = Object.values(first.tools);
        const receiver = (draft: typeof first, id: string) => {
            const view = draft.views.find(view => view.id === id)!;
            return {viewId:id,viewInstanceId:view.viewInstanceId,activationId:view.toolBindings[0]!.activationId};
        };
        const a = receiver(first,'a_1'), b = receiver(first,'b_1');
        expect(a.activationId).not.toBe(b.activationId);
        const call = (target = a,args = {}) => kernel.invokeBoundTypeTool(tool!,target,args);
        expect(await call(a,{amount:'invalid'})).toMatchObject({phase:'not-entered'});
        expect(await call(a,{view_id:'b_1'})).toMatchObject({phase:'not-entered'});
        await act(async () => { expect(await call(b,{observed:{value:2}})).toMatchObject({phase:'entered-returned'}); });
        expect(entered).toHaveBeenLastCalledWith('b',0,{observed:{value:2}},true,true);
        expect(frame().views.find(view => view.id === 'b_1')!.content.value).toContain('[12](protected count: Count)');
        expect(frame().views.find(view => view.id === 'a_1')!.content.value).toContain('[0](protected count: Count)');
        await act(async () => advance(1));
        expect(receiver(frame(),'a_1')).toEqual(a);
        await act(async () => { await call(); });
        expect(entered).toHaveBeenLastCalledWith('a',1,{},true,true);

        await act(async () => advance(2)).catch(() => {});
        expect(projection.failed).toBe(true);
        expect(await call()).toMatchObject({phase:'not-entered'});
        expect(mountedViews(kernel).find(view => view.viewId === 'a_1')?.viewInstanceId).toBe(a.viewInstanceId);

        await act(async () => advance(3));
        const restricted = frame();
        expect(Object.keys(restricted.tools)).toHaveLength(1);
        expect(restricted.views.find(view => view.id === 'a_1')!.toolBindings).toEqual([]);
        expect(await call()).toMatchObject({phase:'not-entered'});
        expect(receiver(restricted,'b_1')).toEqual(b);
        await act(async () => advance(4));
        const enabled = receiver(frame(),'a_1');
        expect(enabled.viewInstanceId).toBe(a.viewInstanceId);
        expect(enabled.activationId).not.toBe(a.activationId);
        expect(await call()).toMatchObject({phase:'not-entered'});

        await act(async () => advance(5));
        const replaced = receiver(frame(),'a_2');
        expect(replaced.viewInstanceId).not.toBe(a.viewInstanceId);
        expect(await call(enabled)).toMatchObject({phase:'not-entered'});
        await act(async () => advance(6));
        expect(frame().views.map(view => view.id)).toEqual(['b_1']);
        expect(receiver(frame(),'b_1')).toEqual(b);
    } finally {
        await act(async () => kernel.onClose());
    }
    expect(mountedViews(kernel)).toEqual([]);
});
