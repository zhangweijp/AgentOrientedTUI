import { h, Component, type ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { renderToString } from 'preact-render-to-string';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as SDK from './index.js';
import { createTUIApp, View, useState, useDataRef, useViewTypeTool, useLLMOutputChannel, useLLMOutputHistory, useAppRuntimeContext } from './index.js';
import { useContext } from 'preact/hooks';
import { ViewRuntimeContext } from './contexts/view-runtime-context.js';
import { AppRuntimeContext } from './context/AppRuntimeContext.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close();vi.restoreAllMocks();vi.unstubAllGlobals(); });
async function mount(Body: () => any, options: { outside?: boolean } = {}) {
    const factory = createTUIApp({ app_name: 'public_api', component: () => options.outside ? h(Body, {}) : h(View, { id: 'detail', type: 'Detail' }, h(Body, {})) });
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);kernel.setId('app' as any);kernel.setAppExecutionInstanceId('public_api_run');
    const container = document.createElement('div');document.body.appendChild(container);let closed = false;
    const close = async () => { if (!closed) { closed = true;await act(async () => { await kernel.onClose(); });container.remove(); } };closing.push(close);
    await act(async () => { await kernel.onOpen({ appId: 'app' as any, desktopId: 'desktop' as any, markDirty() {}, onRender() {} }, container); });
    return { kernel, container, close };
}
const currentOutputEvent = 'aotui:llm-text';
const outputEvents = [currentOutputEvent, 'aotui:llm-output'];
function emit(name = currentOutputEvent, detail: any = { content: 'value' }) { document.dispatchEvent(new CustomEvent(name, { detail })); }
const calls = (spy: any) => spy.mock.calls.filter((args: any[]) => outputEvents.includes(args[0]));
function provider(order: string[], name: string) {
    let listener: any;const stop = vi.fn(() => { order.push(name + ':stop');listener = undefined; });
    return { subscribe: vi.fn((fn: any) => { order.push(name + ':subscribe');listener = fn;return stop; }), getHistory: vi.fn(() => []), stop,
        emit(event: any) { listener?.(event); } };
}
function contextual(Body: () => any, value: any) { return h(ViewRuntimeContext.Provider, { value }, h(Body, {})); }

describe('C04/C09 SDK root exports and app context', () => {
    it('exposes exactly the supported JavaScript entry points', () => {
        expect(Object.keys(SDK).sort()).toEqual([
            'AOTUIError',
            'View',
            'createTUIApp',
            'defineParams',
            'escapeHtml',
            'escapeJsonForAttr',
            'useAppConfig',
            'useAppEnv',
            'useAppLifecycle',
            'useAppRuntimeContext',
            'useArrayRef',
            'useCallback',
            'useDataRef',
            'useEffect',
            'useLLMOutputChannel',
            'useLLMOutputHistory',
            'useMemo',
            'usePersistentState',
            'useReducer',
            'useRef',
            'useState',
            'useViewContext',
            'useViewTypeTool',
        ]);
    });

    it('does not expose retired View registry, InlineView, selector, or ref-registry assembly values', () => {
        for (const name of ['ViewRegistry', 'createInlineView', 'useViewSelector', 'useRefRegistry']) {
            expect(Object.hasOwn(SDK, name), name).toBe(false);
        }
    });
    it('keeps the formal lifecycle and general data Ref APIs without entity/create experiments', () => {
        expect(Object.hasOwn(SDK, 'useAppLifecycle')).toBe(true);
        expect(Object.hasOwn(SDK, 'useDataRef')).toBe(true);
        expect(Object.hasOwn(SDK, 'useArrayRef')).toBe(true);
        for (const name of ['experimental_useAppLifecycle', 'experimental_useCreateIfAbsentTool', 'useEntityRef']) {
            expect(Object.hasOwn(SDK, name), name).toBe(false);
        }
    });

    it('exposes app metadata/config and the same managed instance persistence port', async () => {
        const report = { ok: true, entries: [] };
        const flush = vi.fn(async () => report);
        const bind = vi.fn();
        const captureValue = vi.fn();
        const persistence = { protocol: 'state-session-v1', instanceId: 'public_api_run', captureValue, bind, flush };
        let publicContext: any;
        const fullContext = {
            appId: 'app', desktopId: 'desktop', launchConfig: { workspace: '/project' },
            persistence,
            appLifecycle: { protocol: 'app-lifecycle-v2', register() {} },
            refExporter: { registerRef() {}, unregisterRef() {} },
            markDirty() {}, projection: { beginCommit() {}, endCommit() {} },
            viewTools: { registerTool() {} },
        };
        function CaptureContext() { publicContext = useAppRuntimeContext();return null; }
        renderToString(h(AppRuntimeContext.Provider, { value: fullContext as any }, h(CaptureContext, {})));

        expect(Object.keys(publicContext).sort()).toEqual(['appId', 'desktopId', 'launchConfig', 'persistence']);
        expect(publicContext.persistence).toBe(persistence);
        expect(Object.keys(publicContext.persistence).sort()).toEqual(['bind', 'captureValue', 'flush', 'instanceId', 'protocol']);
        expect(publicContext.persistence.bind).toBe(bind);
        expect(publicContext.persistence.captureValue).toBe(captureValue);
        expect(publicContext.persistence.flush).toBe(flush);
        expect(publicContext).not.toHaveProperty('appLifecycle');
        expect(publicContext).not.toHaveProperty('refExporter');
        expect(publicContext).not.toHaveProperty('projection');
        expect(publicContext).not.toHaveProperty('viewTools');
        await expect(publicContext.persistence.flush()).resolves.toBe(report);
        expect(flush).toHaveBeenCalledOnce();
    });
});

describe('C01/C02 actual component capability honesty', () => {
    it('keeps actual View/Ref registration without obsolete component registries', async () => {
        let context: any;
        function Body() { context = useContext(ViewRuntimeContext);const ref = useDataRef('record', { label: 'value' });return h('p', {}, ref('Record')); }
        const x = await mount(Body);expect(context.llmOutput).toBeUndefined();expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(1);
        expect(x.kernel.getViewRefs()).toContainEqual(expect.objectContaining({ viewId: 'detail', refId: 'record' }));expect(x.container.textContent).toContain('[Record](record)');
        expect(Object.hasOwn(context, 'mountable')).toBe(false);
        expect(Object.hasOwn(context, 'dynamic')).toBe(false);
        expect(Object.hasOwn(context, 'operations')).toBe(false);expect(Object.hasOwn(context, 'typeTools')).toBe(false);expect(Object.hasOwn(context, 'config')).toBe(false);
        await x.close();expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(0);expect(x.kernel.getViewRefs()).toHaveLength(0);
    });
    it('registers/calls/releases a View-owned Tool across enabled transitions', async () => {
        let toggle!: () => void;const handler = vi.fn(async (args: { value?: string }) => ({ success: true, data: { value: args.value } }));
        function Body() { const [enabled, set] = useState(true);toggle = () => set(!enabled);const [ToolUI] = useViewTypeTool('read', { description: 'Read', params: { value: { type: 'string' } } }, handler, { enabled });return h(ToolUI, {}, 'Read'); }
        const x = await mount(Body);const tool = x.kernel.getViewOwnedToolDefinitions()[0];
        expect(tool.targets).toHaveLength(1);
        expect((await x.kernel.invokeBoundOrdinaryParametersViewTool(tool, tool.targets[0], { value: 'actual' })).result).toMatchObject({ success: true, data: { value: 'actual' } });expect(handler).toHaveBeenCalledOnce();
        await act(toggle);expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);await act(toggle);expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(1);await x.close();expect(x.kernel.getViewOwnedToolDefinitions()).toHaveLength(0);
    });
});

describe('C03–C06 actual component subscriptions and controlled Providers', () => {
    it('subscribes during commit to the current DOM event and cleans it up exactly', async () => {
        const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener'), received: any[] = [];let update!: () => void;
        function Body() { const [revision, set] = useState(1);update = () => set(2);useLLMOutputChannel(e => received.push({ revision, event: e }));return null; }
        const x = await mount(Body, { outside: true });expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(0);expect(calls(add)).toHaveLength(1);
        emit(currentOutputEvent, { content: 'content' });emit(currentOutputEvent, { reasoning: 'reasoning' });emit(currentOutputEvent, { meta: { usage: { totalTokens: 3 } } });expect(received).toHaveLength(3);
        expect(received[0].event.content).toBe('content');expect(received[1].event.reasoning).toBe('reasoning');expect(received[2].event.meta.usage.totalTokens).toBe(3);
        emit('aotui:llm-output', { content: 'retired alias' });expect(received).toHaveLength(3);
        await act(update);emit();expect(received.at(-1).revision).toBe(2);expect(calls(add)).toHaveLength(1);
        await x.close();expect(calls(remove)).toHaveLength(1);emit(currentOutputEvent);emit('aotui:llm-output');expect(received).toHaveLength(4);
    });
    it('selects only the actual Provider and cleans its old source before subscribing the replacement', async () => {
        const order: string[] = [], first = provider(order, 'first'), second = provider(order, 'second'), received: any[] = [], add = vi.spyOn(document, 'addEventListener');let replace!: () => void;
        function Child() { useLLMOutputChannel(e => received.push(e));return null; }
        function Body() { const context = useContext(ViewRuntimeContext)!;const [current, set] = useState(first);replace = () => set(second);return contextual(Child, { ...context, llmOutput: current }); }
        const x = await mount(Body);expect(calls(add)).toHaveLength(0);emit();first.emit({ content: 'first' });expect(received).toEqual([{ content: 'first' }]);
        await act(replace);expect(order).toEqual(['first:subscribe', 'first:stop', 'second:subscribe']);first.emit({ content: 'old' });second.emit({ content: 'second' });expect(received).toHaveLength(2);
        await x.close();expect(first.stop).toHaveBeenCalledOnce();expect(second.stop).toHaveBeenCalledOnce();second.emit({ content: 'closed' });expect(received).toHaveLength(2);expect(calls(add)).toHaveLength(0);
    });
    it('propagates Provider subscription failure without adding DOM listeners', async () => {
        const failure = Error('PROVIDER_FAILURE'), add = vi.spyOn(document, 'addEventListener');
        let captured: unknown, entered!: () => void;const caught = new Promise<void>(resolve => { entered = resolve; });
        class Boundary extends Component<{ children?: ComponentChildren }, { failed: boolean }> {
            state = { failed: false };
            static getDerivedStateFromError() { return { failed: true }; }
            componentDidCatch(error: unknown) { captured = error;entered(); }
            render() { return this.state.failed ? null : this.props.children; }
        }
        function Child() { useLLMOutputChannel(() => {});return null; }
        function Body() { return h(Boundary, {}, contextual(Child, { llmOutput: { subscribe() { throw failure; }, getHistory() { return []; } } })); }
        await mount(Body);await caught;expect(captured).toBe(failure);expect(calls(add)).toHaveLength(0);
    });
    it('leaves Provider-owned synchronous replay unchanged', async () => {
        const received: any[] = [], subscribe = vi.fn((listener: any) => { listener({ content: 'provider replay' });return () => {}; });
        function Child() { useLLMOutputChannel(e => received.push(e));useLLMOutputChannel(e => received.push(e));return null; }
        function Body() { return contextual(Child, { llmOutput: { subscribe, getHistory: () => [] } }); }
        await mount(Body);expect(subscribe).toHaveBeenCalledTimes(2);expect(received).toEqual([{ content: 'provider replay' }, { content: 'provider replay' }]);
    });
    it('rejects unavailable live/history in a no-document SSR hook environment without claiming a no-DOM product', () => {
        vi.stubGlobal('document', undefined);
        expect(() => renderToString(h(() => { useLLMOutputChannel(() => {});return null; }, {}))).toThrow(/SDK_LLM_OUTPUT_UNAVAILABLE.*Provider.*document/);
        expect(() => renderToString(h(() => { useLLMOutputHistory();return null; }, {}))).toThrow(/SDK_LLM_HISTORY_UNAVAILABLE.*Provider.*DOM/);
    });
    it.each([[], [{ content: 'history', timestamp: 1 }]])('returns actual Provider history %j and propagates failures', events => {
        const getHistory = vi.fn(() => events);let actual: unknown;
        function Body() { actual = useLLMOutputHistory();return null; }
        renderToString(contextual(Body, { llmOutput: { getHistory, subscribe() { return () => {}; } } }));expect(actual).toBe(events);expect(getHistory).toHaveBeenCalledOnce();
        const failure = Error('HISTORY_FAILURE');expect(() => renderToString(contextual(Body, { llmOutput: { getHistory() { throw failure; } } }))).toThrow(failure);
    });
    it.each(['live', 'history'])('rejects an invalid %s Provider method instead of silently falling back', kind => {
        const add = vi.spyOn(document, 'addEventListener');
        function Body() { if (kind === 'live') useLLMOutputChannel(() => {});else useLLMOutputHistory();return null; }
        expect(() => renderToString(contextual(Body, { llmOutput: { subscribe: 1, getHistory: 1 } }))).toThrow(kind === 'live' ? /SDK_LLM_OUTPUT_UNAVAILABLE.*Provider.subscribe/ : /SDK_LLM_HISTORY_UNAVAILABLE.*Provider.getHistory/);
        expect(calls(add)).toHaveLength(0);
    });
    it('does not report empty history from an actual builtin component View without a Provider', async () => {
        function Body() { useLLMOutputHistory();return null; }
        await expect(mount(Body)).rejects.toThrow(/SDK_LLM_HISTORY_UNAVAILABLE/);
    });
});
