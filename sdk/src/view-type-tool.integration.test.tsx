import { Component, type ComponentChildren, h } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import Type from 'typebox';
import { expect, it, vi } from 'vitest';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useDataRef } from './hooks/useRef.js';
import { defineViewType, refParam } from './tools/view-type-tool.js';

const Counter = defineViewType({ name:'Counter', tools:{
    increment: { description:'Increment the counter', inputSchema:Type.Object({
        amount:Type.Optional(Type.Integer()),
        observed:Type.Optional(refParam('Count', Type.Object({value:Type.Integer()}))),
    }, {additionalProperties:false}) },
} });

it('commits Preact body, Ref and per-instance bindings as one frame', async () => {
    const entered = vi.fn();
    let advance!: (phase: number) => void;
    function CounterPage({id, generation, enabled, broken}: {
        id:string; generation:number; enabled:boolean; broken:boolean;
    }) {
        const [count,setCount] = useState(id === 'a' ? 0 : 10);
        return <View id={id} kind="state" type={Counter} bindings={{
            increment:{ enabled, execute(args) {
                entered(id,generation,args,Object.isFrozen(args),Object.isFrozen(args.observed));
                setCount(value => value + (args.observed?.value ?? args.amount ?? 1));
                return {success:true};
            }},
        }}>
            <Content count={count} broken={broken} />
        </View>;
    }
    function Content({count, broken}: {count:number;broken:boolean}) {
        const mark = useDataRef('count',{value:count},{refType:'Count'});
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
    const kernel = new AppKernel({...factory.kernelConfig,factory});
    kernel.enableAppLifecycle();
    const projection = kernel.getProjectionCoordinator();
    const frame = () => {
        const publication = projection.nextPublication();
        if (!('draft' in publication)) throw Error(JSON.stringify(publication.failure.issue));
        return publication.draft;
    };
    try {
        await act(async () => kernel.onOpen({appId:'counter' as any,desktopId:'desktop' as any}));
        const first = frame();
        expect(Object.keys(first.tools)).toHaveLength(1);
        const [tool] = Object.values(first.tools);
        const receiver = (draft: typeof first, id: string) => {
            const view = draft.views.find(view => view.id === id)!;
            return {viewId:id,viewInstanceId:view.viewInstanceId,activationId:view.toolBindings[0]!.activationId};
        };
        const a = receiver(first,'a'), b = receiver(first,'b');
        expect(a.activationId).not.toBe(b.activationId);
        const call = (target = a,args = {}) => kernel.invokeBoundTypeTool(tool!,target,args);
        expect(await call(a,{amount:'invalid'})).toMatchObject({phase:'not-entered'});
        expect(await call(a,{view_id:'b'})).toMatchObject({phase:'not-entered'});
        await act(async () => { expect(await call(b,{observed:{value:2}})).toMatchObject({phase:'entered-returned'}); });
        expect(entered).toHaveBeenLastCalledWith('b',0,{observed:{value:2}},true,true);
        expect(frame().views.find(view => view.id === 'b')!.content.value).toContain('[12](Count:count)');
        expect(frame().views.find(view => view.id === 'a')!.content.value).toContain('[0](Count:count)');
        await act(async () => advance(1));
        expect(receiver(frame(),'a')).toEqual(a);
        await act(async () => { await call(); });
        expect(entered).toHaveBeenLastCalledWith('a',1,{},true,true);

        await act(async () => advance(2)).catch(() => {});
        expect(projection.failed).toBe(true);
        expect(await call()).toMatchObject({phase:'not-entered'});
        expect(kernel.getViewOwnedViewInstances().find(view => view.viewId === 'a')?.viewInstanceId).toBe(a.viewInstanceId);

        await act(async () => advance(3));
        const restricted = frame();
        expect(Object.keys(restricted.tools)).toHaveLength(1);
        expect(restricted.views.find(view => view.id === 'a')!.toolBindings).toEqual([]);
        expect(await call()).toMatchObject({phase:'not-entered'});
        expect(receiver(restricted,'b')).toEqual(b);
        await act(async () => advance(4));
        const enabled = receiver(frame(),'a');
        expect(enabled.viewInstanceId).toBe(a.viewInstanceId);
        expect(enabled.activationId).not.toBe(a.activationId);
        expect(await call()).toMatchObject({phase:'not-entered'});

        await act(async () => advance(5));
        const replaced = receiver(frame(),'a');
        expect(replaced.viewInstanceId).not.toBe(a.viewInstanceId);
        expect(await call(enabled)).toMatchObject({phase:'not-entered'});
        await act(async () => advance(6));
        expect(frame().views.map(view => view.id)).toEqual(['b']);
        expect(receiver(frame(),'b')).toEqual(b);
    } finally {
        await act(async () => kernel.onClose());
    }
    expect(kernel.getViewOwnedViewInstances()).toEqual([]);
});
