import { mountedViews, preparedRefs } from './__tests__/projection-facts.js';
import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { createAppId, createDesktopId } from '../../runtime/src/spi/core/id-factory.js';
import { Component, h, type ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';
import { describe, expect, it } from 'vitest';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { DynamicView } from './components/View.js';
import { useDataRef } from './hooks/useRef.js';
import { defineViewType, type ViewType } from './tools/view-type-tool.js';
import Type from 'typebox';

const descriptors=Object.fromEntries(['child','parent','ready','recovered'].map(name=>[name,defineViewType({ multiplicity: 'multiple', name})]));
function toolsOf(kernel:AppKernel) {
    const projection=kernel.getProjectionCoordinator();
    if (!projection.token().ready) return [];
    const result=projection.nextPublication();
    return 'draft' in result ? Object.values(result.draft.tools) : [];
}
function setup(component: () => any, viewTypes:readonly ViewType[]=Object.values(descriptors)) {
    const factory = createTUIApp({ app_name: 'nested_view_fixture', component, viewTypes });
    const kernel = new AppKernel({ factory,
        appId: createAppId('nested_fixture'), desktopId: createDesktopId('desktop'),
        instanceId: 'nested_fixture_run', projectionLimits: DEFAULT_PROJECTION_LIMITS,
    });

    let container: Element;
    return {
        kernel,
        get container() { return container; },
        async open() {
            await act(async () => kernel.onOpen());
            container = document.body.lastElementChild!;
        },
        async close() {
            await act(async () => kernel.onClose());
        },
    };
}

class ErrorBoundary extends Component<{
    children?: ComponentChildren;
    onError(error: unknown): void;
}, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        this.props.onError(error);
    }

    render() {
        return this.state.failed ? h('p', { 'data-testid': 'caught' }, 'Nested View rejected') : this.props.children;
    }
}

const instances = (kernel: AppKernel) => mountedViews(kernel).map(view => view.viewId).sort();
const refs = (kernel: AppKernel) => preparedRefs(kernel).map(ref => `${ref.viewId}:${ref.refId}`).sort();

describe('View nesting boundary', () => {
    it.each(['direct', 'wrapped'] as const)('rejects %s nested Views before mounting child bindings and can recover', async kind => {
        let captured: unknown;
        let setNested!: (open: boolean) => void;
        let nestedPayloadRendered = false;
        function NestedPayload() {
            nestedPayloadRendered = true;
            const value = useDataRef('nested_record', { value: 'nested' }, { schema: Type.Object({}), scope: 'protected' });
            return h('p', {}, value('Nested'));
        }
        function NestedWrapper() {
            return h(DynamicView, {type: descriptors.child, idPrefix: 'child' }, h(NestedPayload, {}));
        }
        function RecoveryPayload() {
            const value = useDataRef('recovered_record', { value: 'recovered' }, { schema: Type.Object({}), scope: 'protected' });
            return h('p', {}, value('Recovered'));
        }
        function Root() {
            const [nested, update] = useState(true);
            setNested = update;
            const nestedAttempt = kind === 'direct'
                ? h(DynamicView, {type: descriptors.child, idPrefix: 'child' }, h(NestedPayload, {}))
                : h(NestedWrapper, {});
            return h('main', {}, [
                h(DynamicView, {type: descriptors.parent, idPrefix: 'parent' }, h('section', {}, [
                    h('p', {}, 'Ordinary component content'),
                    h(ErrorBoundary, {
                        key: nested ? 'attempt' : 'recovered',
                        onError(error) { captured = error; },
                    }, nested ? nestedAttempt : h('p', {}, 'Removed nested declaration')),
                ])),
                !nested ? h(DynamicView, {type: descriptors.recovered, idPrefix: 'recovered' }, h(RecoveryPayload, {})) : null,
            ]);
        }

        const x = setup(Root);
        try {
            await x.open();

            expect(captured).toMatchObject({
                code: 'NESTED_VIEW_UNSUPPORTED',
                parentViewId: 'parent',
                childViewId: 'child',
            });
            expect((captured as Error).message).toContain('Declare independent sibling Views');
            expect(nestedPayloadRendered).toBe(false);
            expect(x.container.querySelector('[data-aotui-view="Child"]')).toBeNull();
            expect(instances(x.kernel)).toEqual([]);
            expect(x.kernel.getProjectionCoordinator().failed).toBe(true);
            expect(refs(x.kernel)).toEqual([]);

            await act(async () => setNested(false));
            expect(x.container.querySelector('[data-aotui-view="Recovered"]')).not.toBeNull();
            expect(instances(x.kernel)).toEqual(['parent_1', 'recovered_1']);
            expect(refs(x.kernel)).toEqual(['recovered_1:recovered_record']);
            expect(x.container.textContent).toContain('Recovered');
        } finally {
            await x.close();
        }

        expect(instances(x.kernel)).toEqual([]);
        expect(refs(x.kernel)).toEqual([]);
    });

    it('rethrows an uncaught Preact render error without leaving View bindings behind', async () => {
        let nestedPayloadRendered = false;
        function ExistingPayload() {
            const value = useDataRef('existing_record', { value: 'existing' }, { schema: Type.Object({}), scope: 'protected' });
            return h('p', {}, value('Existing'));
        }
        function NestedPayload() {
            nestedPayloadRendered = true;
            const value = useDataRef('nested_record', { value: 'nested' }, { schema: Type.Object({}), scope: 'protected' });
            return h('p', {}, value('Nested'));
        }
        function Root() {
            return h('main', {}, [
                h(DynamicView, {type: descriptors.ready, idPrefix: 'ready' }, h(ExistingPayload, {})),
                h(DynamicView, {type: descriptors.parent, idPrefix: 'parent' }, h(DynamicView, {type: descriptors.child, idPrefix: 'child' }, h(NestedPayload, {}))),
            ]);
        }

        const x = setup(Root);
        const before = [...document.body.children];
        try {
            await expect(x.open()).rejects.toMatchObject({
                code: 'NESTED_VIEW_UNSUPPORTED',
                parentViewId: 'parent',
                childViewId: 'child',
            });

            expect(nestedPayloadRendered).toBe(false);
            expect(instances(x.kernel)).toEqual([]);
            expect(refs(x.kernel)).toEqual([]);
            expect([...document.body.children]).toEqual(before);
        } finally {
            await x.close();
        }

        expect(instances(x.kernel)).toEqual([]);
        expect(refs(x.kernel)).toEqual([]);
    });

    it('allows ordinary component nesting and independently declared sibling Views through dynamic close and reopen', async () => {
        let setLeftOpen!: (open: boolean) => void;
        const Card=defineViewType<object>()({ multiplicity: 'multiple', name:'Card',tools:{inspect_card:{description:'Inspect the current Card.',inputSchema:Type.Object({}),execute:()=>({success:true})}}});
        function Content({ owner }: { owner: string }) {
            const value = useDataRef(`${owner}_record`, { owner }, { schema: Type.Object({}), scope: 'protected' });
            return h('section', {}, h('p', {}, value(owner)));
        }
        function OrdinaryWrapper({ children }: { children?: ComponentChildren }) {
            return h('article', {}, children);
        }

        function Root() {
            const [leftOpen, updateLeft] = useState(true);
            setLeftOpen = updateLeft;
            return h('main',{},[
                h('p', {}, 'Application content'),
                leftOpen ? h(DynamicView, {idPrefix: 'left', key: 'left', type: Card, context: {} },
                    h(OrdinaryWrapper, {}, [h(Content, { owner: 'left' })])) : null,
                h(DynamicView, {idPrefix: 'right', key: 'right', type: Card, context: {} },
                    h(OrdinaryWrapper, {}, [h(Content, { owner: 'right' })])),
            ]);
        }

        const x = setup(Root,[Card]);
        try {
            await x.open();
            expect(instances(x.kernel)).toEqual(['left_1', 'right_1']);
            expect(refs(x.kernel)).toEqual(['left_1:left_record', 'right_1:right_record']);
            const initialTool = toolsOf(x.kernel).find(tool => tool.name === 'inspect_card')!;
            expect(initialTool).toMatchObject({name:'inspect_card',viewType:'Card'});
            expect(initialTool).not.toHaveProperty('execution');
            expect(toolsOf(x.kernel)).toHaveLength(1);

            expect(x.container.querySelectorAll('[data-aotui-view]')).toHaveLength(2);
            expect(x.container.textContent).toContain('Application content');

            await act(async () => setLeftOpen(false));
            expect(instances(x.kernel)).toEqual(['right_1']);
            expect(refs(x.kernel)).toEqual(['right_1:right_record']);
            expect(toolsOf(x.kernel)).toHaveLength(1);
            expect(toolsOf(x.kernel)[0]).toEqual(initialTool);

            await act(async () => setLeftOpen(true));
            expect(instances(x.kernel)).toEqual(['left_2', 'right_1']);
            expect(refs(x.kernel)).toEqual(['left_2:left_record', 'right_1:right_record']);
            expect(toolsOf(x.kernel)).toHaveLength(1);
            expect(toolsOf(x.kernel)[0]).toEqual(initialTool);
        } finally {
            await x.close();
        }

        expect(instances(x.kernel)).toEqual([]);
        expect(refs(x.kernel)).toEqual([]);
        expect(toolsOf(x.kernel)).toEqual([]);
    });
});
