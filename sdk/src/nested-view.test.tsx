import { Component, h, type ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';
import { describe, expect, it, vi } from 'vitest';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
import { useDataRef } from './hooks/useRef.js';
import { useViewTypeTool } from './hooks/useViewTypeTool.js';

function setup(component: () => any) {
    const factory = createTUIApp({ app_name: 'nested_view_fixture', component });
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);
    kernel.setId('nested_fixture' as any);
    kernel.setAppExecutionInstanceId('nested_fixture_run');
    const container = document.createElement('div');
    document.body.appendChild(container);

    return {
        kernel,
        container,
        async open() {
            await act(async () => kernel.onOpen({
                appId: 'nested_fixture' as any,
                desktopId: 'desktop_nested' as any,
                markDirty() {},
                onRender() {},
            }, container));
        },
        async close() {
            await act(async () => kernel.onClose());
            container.remove();
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

const instances = (kernel: AppKernel) => kernel.getViewOwnedViewInstances().map(view => view.viewId).sort();
const refs = (kernel: AppKernel) => kernel.getViewRefs().map(ref => `${ref.viewId}:${ref.refId}`).sort();
const toolTargets = (kernel: AppKernel) => kernel.getViewOwnedToolDefinitions()
    .flatMap(tool => tool.targets.map(target => `${tool.name}:${target.viewId}`)).sort();

describe('View nesting boundary', () => {
    it.each(['direct', 'wrapped'] as const)('rejects %s nested Views before mounting child bindings and can recover', async kind => {
        let captured: unknown;
        let setNested!: (open: boolean) => void;
        let nestedPayloadRendered = false;
        const nestedHandler = vi.fn(async () => ({ success: true }));
        const recoveryHandler = vi.fn(async () => ({ success: true }));

        function NestedPayload() {
            nestedPayloadRendered = true;
            const value = useDataRef('nested_record', { value: 'nested' });
            useViewTypeTool('nested_probe', { description: 'Nested probe', params: {} }, nestedHandler);
            return h('p', {}, value('Nested'));
        }
        function NestedWrapper() {
            return h(View, { id: 'child' }, h(NestedPayload, {}));
        }
        function RecoveryPayload() {
            const value = useDataRef('recovered_record', { value: 'recovered' });
            useViewTypeTool('recovery_probe', { description: 'Recovery probe', params: {} }, recoveryHandler);
            return h('p', {}, value('Recovered'));
        }
        function Root() {
            const [nested, update] = useState(true);
            setNested = update;
            const nestedAttempt = kind === 'direct'
                ? h(View, { id: 'child' }, h(NestedPayload, {}))
                : h(NestedWrapper, {});
            return h('main', {}, [
                h(View, { id: 'parent' }, h('section', {}, [
                    h('p', {}, 'Ordinary component content'),
                    h(ErrorBoundary, {
                        key: nested ? 'attempt' : 'recovered',
                        onError(error) { captured = error; },
                    }, nested ? nestedAttempt : h('p', {}, 'Removed nested declaration')),
                ])),
                !nested ? h(View, { id: 'recovered' }, h(RecoveryPayload, {})) : null,
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
            expect((captured as Error).message).toContain('Declare both Views as independent siblings');
            expect(nestedPayloadRendered).toBe(false);
            expect(x.container.querySelector('[data-view-id="child"]')).toBeNull();
            expect(instances(x.kernel)).toEqual(['parent']);
            expect(refs(x.kernel)).toEqual([]);
            expect(toolTargets(x.kernel)).toEqual([]);
            expect(nestedHandler).not.toHaveBeenCalled();

            await act(async () => setNested(false));
            expect(x.container.querySelector('[data-view-id="recovered"]')).not.toBeNull();
            expect(instances(x.kernel)).toEqual(['parent', 'recovered']);
            expect(refs(x.kernel)).toEqual(['recovered:recovered_record']);
            expect(toolTargets(x.kernel)).toEqual(['recovery_probe:recovered']);
            expect(x.container.textContent).toContain('Recovered');
        } finally {
            await x.close();
        }

        expect(instances(x.kernel)).toEqual([]);
        expect(refs(x.kernel)).toEqual([]);
        expect(toolTargets(x.kernel)).toEqual([]);
    });

    it('rethrows an uncaught Preact render error without leaving View bindings behind', async () => {
        let nestedPayloadRendered = false;
        function ExistingPayload() {
            const value = useDataRef('existing_record', { value: 'existing' });
            useViewTypeTool('existing_probe', { description: 'Existing probe', params: {} }, async () => ({ success: true }));
            return h('p', {}, value('Existing'));
        }
        function NestedPayload() {
            nestedPayloadRendered = true;
            const value = useDataRef('nested_record', { value: 'nested' });
            useViewTypeTool('nested_probe', { description: 'Nested probe', params: {} }, async () => ({ success: true }));
            return h('p', {}, value('Nested'));
        }
        function Root() {
            return h('main', {}, [
                h(View, { id: 'ready' }, h(ExistingPayload, {})),
                h(View, { id: 'parent' }, h(View, { id: 'child' }, h(NestedPayload, {}))),
            ]);
        }

        const x = setup(Root);
        const registerRef = vi.spyOn(x.kernel, 'registerRef');
        try {
            await expect(x.open()).rejects.toMatchObject({
                code: 'NESTED_VIEW_UNSUPPORTED',
                parentViewId: 'parent',
                childViewId: 'child',
            });

            expect(nestedPayloadRendered).toBe(false);
            expect(registerRef.mock.calls.every(([viewId]) => viewId !== 'child')).toBe(true);
            expect(instances(x.kernel)).toEqual([]);
            expect(refs(x.kernel)).toEqual([]);
            expect(toolTargets(x.kernel)).toEqual([]);
            expect(x.container.querySelectorAll('[data-view-id]')).toHaveLength(0);
        } finally {
            await x.close();
        }

        expect(instances(x.kernel)).toEqual([]);
        expect(refs(x.kernel)).toEqual([]);
        expect(toolTargets(x.kernel)).toEqual([]);
    });

    it('allows ordinary component nesting and independently declared sibling Views through dynamic close and reopen', async () => {
        let setLeftOpen!: (open: boolean) => void;
        const leftHandler = vi.fn(async () => ({ success: true }));
        const rightHandler = vi.fn(async () => ({ success: true }));

        function Content({ owner, handler }: { owner: string; handler: () => Promise<{ success: true }> }) {
            const value = useDataRef(`${owner}_record`, { owner });
            useViewTypeTool(`${owner}_probe`, { description: `${owner} probe`, params: {} }, handler);
            return h('section', {}, h('p', {}, value(owner)));
        }
        function OrdinaryWrapper({ children }: { children?: ComponentChildren }) {
            return h('article', {}, children);
        }
        function Root() {
            const [leftOpen, updateLeft] = useState(true);
            setLeftOpen = updateLeft;
            return h('main', {}, [
                h('p', {}, 'Application content'),
                leftOpen ? h(View, { id: 'left', key: 'left', type: 'Card' },
                    h(OrdinaryWrapper, {}, h(Content, { owner: 'left', handler: leftHandler }))) : null,
                h(View, { id: 'right', key: 'right', type: 'Card' },
                    h(OrdinaryWrapper, {}, h(Content, { owner: 'right', handler: rightHandler }))),
            ]);
        }

        const x = setup(Root);
        try {
            await x.open();
            expect(instances(x.kernel)).toEqual(['left', 'right']);
            expect(refs(x.kernel)).toEqual(['left:left_record', 'right:right_record']);
            expect(toolTargets(x.kernel)).toEqual(['left_probe:left', 'right_probe:right']);
            expect(x.container.querySelectorAll('[data-view-id]')).toHaveLength(2);
            expect(x.container.textContent).toContain('Application content');

            await act(async () => setLeftOpen(false));
            expect(instances(x.kernel)).toEqual(['right']);
            expect(refs(x.kernel)).toEqual(['right:right_record']);
            expect(toolTargets(x.kernel)).toEqual(['right_probe:right']);

            await act(async () => setLeftOpen(true));
            expect(instances(x.kernel)).toEqual(['left', 'right']);
            expect(refs(x.kernel)).toEqual(['left:left_record', 'right:right_record']);
            expect(toolTargets(x.kernel)).toEqual(['left_probe:left', 'right_probe:right']);
        } finally {
            await x.close();
        }

        expect(instances(x.kernel)).toEqual([]);
        expect(refs(x.kernel)).toEqual([]);
        expect(toolTargets(x.kernel)).toEqual([]);
    });
});
