import { h, Component, type ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { renderToString } from 'preact-render-to-string';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTUIApp, View, useState, useDataRef, useViewTypeTool, useLLMOutputChannel, useLLMOutputHistory } from './index.js';
import { useContext } from 'preact/hooks';
import { ViewRuntimeContext } from './contexts/view-runtime-context.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close();vi.restoreAllMocks();vi.unstubAllGlobals(); });
async function mount(Body: () => any, options: { outside?: boolean; missingLegacy?: boolean } = {}) {
    const factory = createTUIApp({ app_name: 'public_api', component: () => options.outside ? h(Body, {}) : h(View, { id: 'detail', type: 'Detail' }, h(Body, {})) });
    const initialize = factory.initializeComponent;
    factory.initializeComponent = (container, context) => initialize(container, { ...context, ...(options.missingLegacy ? { typeTools: undefined } : {}) } as any);
    const kernel = new AppKernel({ ...factory.kernelConfig, component: factory } as any);kernel.setId('app' as any);kernel.setAppExecutionInstanceId('public_api_run');
    const container = document.createElement('div');document.body.appendChild(container);let closed = false;
    const close = async () => { if (!closed) { closed = true;await act(async () => { await kernel.onClose(); });container.remove(); } };closing.push(close);
    await act(async () => { await kernel.onOpen({ appId: 'app' as any, desktopId: 'desktop' as any, markDirty() {}, onRender() {} }, container); });
    return { kernel, container, close };
}
const names = ['aotui:llm-output', 'aotui:llm-text'];
function emit(name = names[0], detail: any = { content: 'value' }) { document.dispatchEvent(new CustomEvent(name, { detail })); }
const calls = (spy: any) => spy.mock.calls.filter((args: any[]) => names.includes(args[0]));
function provider(order: string[], name: string) {
    let listener: any;const stop = vi.fn(() => { order.push(name + ':stop');listener = undefined; });
    return { subscribe: vi.fn((fn: any) => { order.push(name + ':subscribe');listener = fn;return stop; }), getHistory: vi.fn(() => []), stop,
        emit(event: any) { listener?.(event); } };
}
function contextual(Body: () => any, value: any) { return h(ViewRuntimeContext.Provider, { value }, h(Body, {})); }

describe('C01/C02 actual component capability honesty', () => {
    it('keeps actual View/Ref registration without obsolete component registries', async () => {
        let context: any;
        function Body() { context = useContext(ViewRuntimeContext);const ref = useDataRef('record', { label: 'value' });return h('p', {}, ref('Record')); }
        const x = await mount(Body);expect(context.llmOutput).toBeUndefined();expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(1);
        expect(Object.hasOwn(x.kernel.exportRefsToIndexMap(), 'detail:record')).toBe(true);expect(x.container.textContent).toContain('[Record](record)');
        expect(Object.hasOwn(context, 'mountable')).toBe(false);
        expect(Object.hasOwn(context, 'dynamic')).toBe(false);
        await x.close();expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(0);expect(Object.keys(x.kernel.exportRefsToIndexMap())).toHaveLength(0);
    });
    it('registers/calls/releases the real legacy Tool across enabled transitions', async () => {
        let toggle!: () => void;const handler = vi.fn(async (args: { value?: string }) => ({ success: true, data: { value: args.value } }));
        function Body() { const [enabled, set] = useState(true);toggle = () => set(!enabled);useViewTypeTool('Detail', 'read', { description: 'Read', params: { value: { type: 'string' } } }, handler, { enabled });return null; }
        const x = await mount(Body);expect(x.kernel.getTypeTools('Detail')).toHaveLength(1);
        expect(await x.kernel.callTypeTool('Detail', 'read', { value: 'actual' })).toMatchObject({ success: true, data: { value: 'actual' } });expect(handler).toHaveBeenCalledOnce();
        await act(toggle);expect(x.kernel.getTypeTools('Detail')).toHaveLength(0);await act(toggle);expect(x.kernel.getTypeTools('Detail')).toHaveLength(1);await x.close();expect(x.kernel.getTypeTools('Detail')).toHaveLength(0);
    });
    it.each([true, false])('missing legacy typeTools with enabled=%s has an explicit result', async enabled => {
        function Body() { useViewTypeTool('Detail', 'read', { description: 'Read', params: {} }, async () => ({ success: true }), { enabled });return null; }
        if (enabled) await expect(mount(Body, { missingLegacy: true })).rejects.toThrow(/SDK_TYPE_TOOLS_UNAVAILABLE.*legacy useViewTypeTool.*Runtime/);
        else { const x = await mount(Body, { missingLegacy: true });expect(x.kernel.getTypeTools('Detail')).toHaveLength(0); }
    });
});

describe('C03–C06 actual component subscriptions and controlled Providers', () => {
    it('retains View-outside Root DOM delivery, both names, reasoning/usage and the latest callback with exact cleanup', async () => {
        const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener'), received: any[] = [];let update!: () => void;
        function Body() { const [revision, set] = useState(1);update = () => set(2);useLLMOutputChannel(e => received.push({ revision, event: e }), { includeHistory: undefined });return null; }
        const x = await mount(Body, { outside: true });expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(0);expect(calls(add)).toHaveLength(2);
        emit(names[0], { content: 'content' });emit(names[1], { reasoning: 'reasoning' });emit(names[1], { meta: { usage: { totalTokens: 3 } } });expect(received).toHaveLength(3);
        expect(received[0].event.content).toBe('content');expect(received[1].event.reasoning).toBe('reasoning');expect(received[2].event.meta.usage.totalTokens).toBe(3);
        await act(update);emit();expect(received.at(-1).revision).toBe(2);expect(calls(add)).toHaveLength(2);
        await x.close();expect(calls(remove)).toHaveLength(2);emit(names[0]);emit(names[1]);expect(received).toHaveLength(4);
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
    it.each([true, false, null, 0, 'history'])('rejects explicit includeHistory=%j before any subscription', async includeHistory => {
        const add = vi.spyOn(document, 'addEventListener'), subscribe = vi.fn(() => () => {});
        function Child() { useLLMOutputChannel(() => {}, { includeHistory } as any);return null; }
        function Body() { return contextual(Child, { llmOutput: { subscribe, getHistory: () => [] } }); }
        await expect(mount(Body)).rejects.toThrow(/SDK_LLM_HISTORY_OPTION_UNSUPPORTED/);expect(subscribe).not.toHaveBeenCalled();expect(calls(add)).toHaveLength(0);
    });
    it('leaves Provider-owned synchronous replay unchanged when the option is omitted or undefined', async () => {
        const received: any[] = [], subscribe = vi.fn((listener: any) => { listener({ content: 'provider replay' });return () => {}; });
        function Child() { useLLMOutputChannel(e => received.push(e));useLLMOutputChannel(e => received.push(e), { includeHistory: undefined });return null; }
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
