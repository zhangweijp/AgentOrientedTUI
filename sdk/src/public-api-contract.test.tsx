import { DEFAULT_PROJECTION_LIMITS } from '../../runtime/src/core/invocation/observation-registry.js';
import { createAppId, createDesktopId } from '../../runtime/src/spi/core/id-factory.js';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { renderToString } from 'preact-render-to-string';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as SDK from './index.js';
import { createApp } from './app.js';
import { createTUIApp, defineViewType, View, useState, useDataRef, useLLMUsage, useAppRuntimeContext } from './index.js';
import { useContext } from 'preact/hooks';
import { ViewRuntimeContext } from './contexts/view-runtime-context.js';
import { AppRuntimeContext } from './context/AppRuntimeContext.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close();vi.restoreAllMocks();vi.unstubAllGlobals(); });
const Detail = defineViewType({name:'Detail'});
async function mount(Body: () => any, options: { outside?: boolean } = {}) {
    const factory = createTUIApp({ app_name: 'public_api', viewTypes:[Detail], component: () => options.outside ? h(Body, {}) : h(View, {kind: 'state', id: 'detail', type: Detail }, h(Body, {})) });
    const kernel = new AppKernel({ ...factory.kernelConfig, factory,
        appId: createAppId('app'), desktopId: createDesktopId('desktop'),
        instanceId: 'public_api_run', projectionLimits: DEFAULT_PROJECTION_LIMITS,
    });
    let closed = false;
    const close = async () => { if (!closed) { closed = true;await act(async () => { await kernel.onClose(); }); } };closing.push(close);
    await act(async () => { await kernel.onOpen(); });
    return { kernel, container: document.getElementById('app-root-app')!, close };
}
const currentOutputEvent = 'aotui:llm-usage';
const outputEvents = [currentOutputEvent, 'aotui:llm-text'];
const usage = { timestamp: 10, providerId: 'provider', modelId: 'model', promptTokens: 2, completionTokens: 1, totalTokens: 3 };
function emit(name = currentOutputEvent, detail = usage) { document.dispatchEvent(new CustomEvent(name, { detail })); }
const calls = (spy: any) => spy.mock.calls.filter((args: any[]) => outputEvents.includes(args[0]));

it.each([
    ['TypeScript', createApp],
    ['Preact', createTUIApp],
] as const)('%s captures a checked, explicit persistence declaration', (_kind, create) => {
    const common = { app_name: 'example', viewTypes: [], initialize() {}, component: () => null };
    const config = { ...common, persistence: true };
    const enabled = create(config);
    config.persistence = false;
    expect(enabled.persistenceSupport).toBe('state-session-v1');
    expect(create(config)).not.toHaveProperty('persistenceSupport');
    expect(create(common)).not.toHaveProperty('persistenceSupport');
    expect(() => create({ ...common, persistence: 1 } as any)).toThrow(expect.objectContaining({
        code: 'CONFIG_INVALID', context: { path: 'AppConfig.persistence', reason: expect.any(String) },
    }));
    let getterCalls = 0;
    const accessor = Object.defineProperty({ ...common }, 'persistence', { enumerable: true, get() { getterCalls++; return true; } });
    expect(() => create(accessor)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(getterCalls).toBe(0);
    const context = { appLifecycle: { protocol: 'app-lifecycle-v2', register() {} } } as any;
    expect(() => enabled.initialize(context)).toThrow(expect.objectContaining({ code: 'PERSISTENCE_UNAVAILABLE' }));
});

describe('C04/C09 SDK root exports and app context', () => {
    it('exposes exactly the supported JavaScript entry points', () => {
        expect(Object.keys(SDK).sort()).toEqual([
            'AOTUIError',
            'ToolCatalog',
            'View',
            'createTUIApp',
            'defineViewType',
            'formatRef', 'getToolCatalog',
            'refParam',
            'useAppLifecycle',
            'useAppRuntimeContext',
            'useArrayRef',
            'useCallback',
            'useDataRef',
            'useEffect',
            'useLLMUsage',
            'useMemo',
            'usePersistentState',
            'useReducer',
            'useRef',
            'useState',
        ]);
    });

    it('does not expose retired View registry, InlineView, selector, or ref-registry assembly values', () => {
        for (const name of [
            'ViewRegistry', 'createInlineView', 'useViewSelector', 'useRefRegistry',
            'defineParams', 'escapeHtml', 'escapeJsonForAttr', 'useAppConfig',
            'useAppEnv', 'useLLMOutputChannel', 'useLLMOutputHistory', 'useViewSnapshotTool',
            'createToolBindings', 'AppTools', 'defineToolSet', 'defineViewTypeTool', 'ToolRef', 'useViewContext',
        ]) {
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

    it('exposes metadata, persistence and local preparation without exposing the renderer ports', async () => {
        const report = { ok: true, entries: [] };
        const flush = vi.fn(async () => report);
        const bind = vi.fn();
        const captureValue = vi.fn();
        const prepareProjection = vi.fn();
        const prepareOpeningProjection = vi.fn();
        const persistence = { protocol: 'state-session-v1', instanceId: 'public_api_run', captureValue, bind, flush };
        let publicContext: any;
        const projectionLimits = Object.freeze({ maxViews: 1, maxRefs: 1, maxTools: 1,
            observation: Object.freeze({ maxDepth: 16, maxNodes: 128, maxApproxBytes: 1024, maxCanonicalBytes: 1024 }),
            metadata: Object.freeze({ maxDepth: 8, maxNodes: 128, maxApproxBytes: 1024, maxCanonicalBytes: 1024 }),
        });
        const fullContext = {
            appId: 'app', desktopId: 'desktop', launchConfig: { workspace: '/project' },
            persistence,
            projectionLimits,
            prepareProjection,
            prepareOpeningProjection,
            appLifecycle: { protocol: 'app-lifecycle-v2', register() {} },
            views: new WeakMap(),
            viewTypes: new Map(),
        };
        function CaptureContext() { publicContext = useAppRuntimeContext();return null; }
        renderToString(h(AppRuntimeContext.Provider, { value: fullContext as any }, h(CaptureContext, {})));

        expect(Object.keys(publicContext).sort()).toEqual(['appId', 'desktopId', 'launchConfig', 'persistence', 'prepareOpeningProjection', 'prepareProjection', 'projectionLimits']);
        expect(publicContext.projectionLimits).toBe(projectionLimits);
        expect(publicContext.persistence).toBe(persistence);
        expect(Object.keys(publicContext.persistence).sort()).toEqual(['bind', 'captureValue', 'flush', 'instanceId', 'protocol']);
        expect(publicContext.persistence.bind).toBe(bind);
        expect(publicContext.persistence.captureValue).toBe(captureValue);
        expect(publicContext.persistence.flush).toBe(flush);
        expect(publicContext.prepareProjection).toBe(prepareProjection);
        expect(publicContext.prepareOpeningProjection).toBe(prepareOpeningProjection);
        expect(publicContext).not.toHaveProperty('appLifecycle');
        expect(publicContext).not.toHaveProperty('views');
        expect(publicContext).not.toHaveProperty('viewTypes');
        await expect(publicContext.persistence.flush()).resolves.toBe(report);
        expect(flush).toHaveBeenCalledOnce();
    });

    it('returns the actual subtree preparation and rejects a render that failed or did not commit', async () => {
        let prepare!: (value: number) => Promise<unknown>;
        let noUpdate!: () => Promise<unknown>;
        const renderFailure = Object.assign(new Error('render failure'), { code: 'SNAPSHOT_INVALID', path: '$.views.detail' });
        function Body() {
            const { prepareProjection } = useAppRuntimeContext();
            const [value, setValue] = useState(0);
            prepare = next => prepareProjection(() => setValue(next));
            noUpdate = () => prepareProjection(() => {});
            if (value < 0) throw renderFailure;
            return h('p', {}, String(value));
        }
        const x = await mount(Body);
        const projection = x.kernel.getProjectionCoordinator();
        const first = projection.token().epoch;
        await expect(prepare(1)).resolves.toEqual({ status: 'prepared', sourceEpoch: first + 1 });
        await expect(prepare(1)).rejects.toMatchObject({
            code: 'SNAPSHOT_INVALID', path: '$.views', message: expect.stringContaining('did not observe a Preact commit for this App'),
        });
        expect(projection.failure).toBeUndefined();
        expect(projection.token().epoch).toBe(first + 1);
        const fault = { code: 'SNAPSHOT_INVALID', path: '$.views.detail', message: 'render failure' };
        await expect(prepare(-1)).rejects.toMatchObject({ ...fault, cause: renderFailure });
        expect(projection.failure).toEqual(fault);
        await expect(noUpdate()).rejects.toMatchObject({ ...fault, cause: renderFailure });
        expect(projection.token().epoch).toBe(first + 1);
        await expect(prepare(2)).resolves.toEqual({ status: 'prepared', sourceEpoch: first + 2 });
        expect(projection.failure).toBeUndefined();
    });

    it('rejects async callbacks and an opening without a revert before invoking the update', async () => {
        let prepare!: (update: () => unknown) => Promise<unknown>;
        let open!: (update: () => unknown, revert?: () => unknown) => Promise<unknown>;
        let update!: () => void;
        let ran = 0;
        async function asynchronous() { ran++; }
        function Body() {
            const context = useAppRuntimeContext();
            prepare = context.prepareProjection as typeof prepare;
            open = context.prepareOpeningProjection as typeof open;
            const [value, setValue] = useState(0);
            update = () => { ran++; setValue(1); };
            return h('p', {}, String(value));
        }
        const x = await mount(Body);
        const epoch = x.kernel.getProjectionCoordinator().token().epoch;
        const error = { code: 'SNAPSHOT_INVALID', message: expect.stringContaining('synchronous') };
        await expect(prepare(asynchronous)).rejects.toMatchObject(error);
        await expect(open(asynchronous, update)).rejects.toMatchObject(error);
        await expect(open(update, asynchronous)).rejects.toMatchObject(error);
        await expect(open(update)).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID', message: expect.stringContaining('revert') });
        expect(ran).toBe(0);
        expect(x.kernel.getProjectionCoordinator().token().epoch).toBe(epoch);
        await expect(prepare(update)).resolves.toEqual({ status: 'prepared', sourceEpoch: epoch + 1 });
    });

    it('observes a returned thenable rejection and refuses the frame scheduled by that callback', async () => {
        let prepare!: (update: () => unknown) => Promise<unknown>, set!: (value: number) => void;
        function Body() {
            prepare = useAppRuntimeContext().prepareProjection as typeof prepare;
            const [value, setValue] = useState(0);
            set = setValue;
            return h('p', {}, String(value));
        }
        const x = await mount(Body);
        const projection = x.kernel.getProjectionCoordinator();
        const epoch = projection.token().epoch;
        const then = vi.fn((_resolve: unknown, reject: (error: Error) => void) => reject(new Error('returned rejection')));
        await expect(prepare(() => { set(1); return { then }; })).rejects.toMatchObject({
            code: 'SNAPSHOT_INVALID', message: expect.stringContaining('synchronous'),
        });
        expect(then).toHaveBeenCalledOnce();
        expect(projection.token().epoch).toBe(epoch);
        expect(projection.failure?.code).toBe('SNAPSHOT_INVALID');
        await expect(prepare(() => set(2))).resolves.toEqual({ status: 'prepared', sourceEpoch: epoch + 1 });
    });
});

describe('C01/C02 actual component capability honesty', () => {
    it('keeps actual View/Ref registration without obsolete component registries', async () => {
        let context: any;
        let refFormatter: any;
        function Body() { context = useContext(ViewRuntimeContext);const ref = useDataRef('record', { label: 'value' });refFormatter = ref;return h('p', {}, ref('Record')); }
        const x = await mount(Body);expect(context).not.toHaveProperty('llmOutput');expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(1);
        expect(x.kernel.getViewRefs()).toContainEqual(expect.objectContaining({ viewId: 'detail', refId: 'record' }));expect(x.container.textContent).toContain('[Record](record)');
        expect(refFormatter).not.toHaveProperty('data');
        expect(refFormatter).not.toHaveProperty('id');
        expect(Object.hasOwn(context, 'mountable')).toBe(false);
        expect(Object.hasOwn(context, 'dynamic')).toBe(false);
        expect(Object.hasOwn(context, 'typeTools')).toBe(false);expect(Object.hasOwn(context, 'config')).toBe(false);
        await x.close();expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(0);expect(x.kernel.getViewRefs()).toHaveLength(0);
    });
});

describe('C03–C06 actual component subscriptions', () => {
    it('subscribes during commit to the current DOM event and cleans it up exactly', async () => {
        const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener'), received: any[] = [];let update!: () => void;
        function Body() { const [revision, set] = useState(1);update = () => set(2);useLLMUsage(e => received.push({ revision, event: e }));return null; }
        const x = await mount(Body, { outside: true });expect(x.kernel.getViewOwnedViewInstances()).toHaveLength(0);expect(calls(add)).toHaveLength(1);
        emit();expect(received).toEqual([{ revision: 1, event: usage }]);
        emit('aotui:llm-text');expect(received).toHaveLength(1);
        await act(update);emit();expect(received.at(-1).revision).toBe(2);expect(calls(add)).toHaveLength(1);
        await x.close();expect(calls(remove)).toHaveLength(1);emit();expect(received).toHaveLength(2);
    });
    it('rejects unavailable live output in a no-document SSR hook environment', () => {
        vi.stubGlobal('document', undefined);
        expect(() => renderToString(h(() => { useLLMUsage(() => {});return null; }, {}))).toThrow(/SDK_LLM_USAGE_UNAVAILABLE.*document event bridge/);
    });
});
