import FixtureType from 'typebox';
import { mountedViews, preparedRefs } from './__tests__/projection-facts.js';
import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { createAppId, createDesktopId } from '../../runtime/src/spi/core/id-factory.js';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { renderToString } from 'preact-render-to-string';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as SDK from './index.js';
import { createApp } from './app.js';
import { createTUIApp, defineViewType, DynamicView, useState, useDataRef, useAppRuntimeContext } from './index.js';
import { useContext } from 'preact/hooks';
import { ViewRuntimeContext } from './contexts/view-runtime-context.js';
import { AppRuntimeContext } from './context/AppRuntimeContext.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close();vi.restoreAllMocks();vi.unstubAllGlobals(); });
const Detail = defineViewType({ multiplicity: 'multiple', name:'Detail'});
async function mount(Body: () => any) {
    const factory = createTUIApp({ app_name: 'public_api', viewTypes:[Detail], component: () => h(DynamicView, {idPrefix: 'detail', type: Detail }, h(Body, {})) });
    const kernel = new AppKernel({ factory,
        appId: createAppId('app'), desktopId: createDesktopId('desktop'),
        instanceId: 'public_api_run', projectionLimits: DEFAULT_PROJECTION_LIMITS,
    });
    let closed = false;
    const close = async () => { if (!closed) { closed = true;await act(async () => { await kernel.onClose(); }); } };closing.push(close);
    await act(async () => { await kernel.onOpen(); });
    return { kernel, container: document.body.lastElementChild!, close };
}

it.each([
    ['TypeScript', createApp],
    ['Preact', createTUIApp],
] as const)('%s captures a checked, explicit persistence declaration', (_kind, create) => {
    const common = { app_name: 'example', viewTypes: [], initialize() {}, component: () => null };
    const config = { ...common, persistence: true };
    const enabled = create(config);
    config.persistence = false;
    expect(enabled.persistenceSupport).toBe('state-session-v2');
    expect(create(config)).not.toHaveProperty('persistenceSupport');
    expect(create(common)).not.toHaveProperty('persistenceSupport');
    expect(() => create({ ...common, persistence: 1 } as any)).toThrow(expect.objectContaining({
        code: 'CONFIG_INVALID', context: { path: 'AppConfig.persistence', reason: expect.any(String) },
    }));
    let getterCalls = 0;
    const accessor = Object.defineProperty({ ...common }, 'persistence', { enumerable: true, get() { getterCalls++; return true; } });
    expect(() => create(accessor)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(getterCalls).toBe(0);
    const defineViewTypes = vi.fn();
    const context = { appLifecycle: { protocol: 'app-lifecycle-v2', register() {} }, defineViewTypes } as any;
    expect(() => enabled.initialize(context)).toThrow(expect.objectContaining({ code: 'PERSISTENCE_UNAVAILABLE' }));
    expect(() => enabled.initialize({ ...context, persistence: {
        protocol: 'state-session-v1', instanceId: 'public_api_run', bind() {}, flush() {},
    } })).toThrow(expect.objectContaining({ code: 'PERSISTENCE_UNAVAILABLE' }));
    expect(() => enabled.initialize({ ...context, persistence: {
        protocol: 'state-session-v2', instanceId: 'public_api_run', load() {}, save() {}, flush() {},
    } })).toThrow(expect.objectContaining({ code: 'PERSISTENCE_UNAVAILABLE' }));
    expect(defineViewTypes).not.toHaveBeenCalled();
});

describe('C04/C09 SDK root exports and app context', () => {
    it('exposes exactly the supported JavaScript entry points', () => {
        expect(Object.keys(SDK).sort()).toEqual([
            'AOTUIError',
            'DynamicView',
            'StaticView',
            'ViewMultiplicity',
            'ViewRegion',
            'createTUIApp',
            'defineViewType',
            'formatRef',
            'refParam',
            'useAppLifecycle',
            'useAppRuntimeContext',
            'useArrayRef',
            'useCallback',
            'useDataRef',
            'useEffect',
            'useMemo',
            'useReducer',
            'useRef',
            'useState',
        ]);
    });

    it('exposes metadata, persistence and local preparation without exposing the renderer ports', async () => {
        const report = { status: 'completed', ok: true, entries: [] } as const;
        const flush = vi.fn(async () => report);
        const load = vi.fn(async () => null);
        const save = vi.fn(async () => {});
        const remove = vi.fn(async () => {});
        const prepareProjection = vi.fn();
        const prepareOpeningProjection = vi.fn();
        const readPreparedViewId = vi.fn();
        const persistence: SDK.AppStatePersistence = { protocol: 'state-session-v2', instanceId: 'public_api_run', load, save, remove, flush };
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
            readPreparedViewId,
            appLifecycle: { protocol: 'app-lifecycle-v2', register() {} },
            views: new WeakMap(),
            viewTypes: new Map(),
        };
        function CaptureContext() { publicContext = useAppRuntimeContext();return null; }
        renderToString(h(AppRuntimeContext.Provider, { value: fullContext as any }, h(CaptureContext, {})));

        expect(Object.keys(publicContext).sort()).toEqual(['appId', 'desktopId', 'launchConfig', 'persistence', 'prepareOpeningProjection', 'prepareProjection', 'projectionLimits', 'readPreparedViewId', 'requestAttention']);
        expect(publicContext.projectionLimits).toBe(projectionLimits);
        expect(publicContext.persistence).toBe(persistence);
        expect(Object.keys(publicContext.persistence).sort()).toEqual(['flush', 'instanceId', 'load', 'protocol', 'remove', 'save']);
        expect(publicContext.persistence.load).toBe(load);
        expect(publicContext.persistence.save).toBe(save);
        expect(publicContext.persistence.remove).toBe(remove);
        expect(publicContext.persistence.flush).toBe(flush);
        expect(publicContext.prepareProjection).toBe(prepareProjection);
        expect(publicContext.prepareOpeningProjection).toBe(prepareOpeningProjection);
        expect(publicContext.readPreparedViewId).toBe(readPreparedViewId);
        expect(publicContext).not.toHaveProperty('appLifecycle');
        expect(publicContext).not.toHaveProperty('views');
        expect(publicContext).not.toHaveProperty('viewTypes');
        await expect(publicContext.persistence.flush()).resolves.toBe(report);
        expect(flush).toHaveBeenCalledOnce();
    });

    it('reuses the healthy preparation for the same value and preserves the original render fault', async () => {
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
        await expect(prepare(1)).resolves.toEqual({ status: 'prepared' });
        await expect(prepare(1)).resolves.toEqual({ status: 'prepared' });
        expect(projection.failure).toBeUndefined();
        expect(projection.token().epoch).toBe(first + 1);
        const fault = { code: 'SNAPSHOT_INVALID', path: '$.views.detail', message: 'render failure' };
        await expect(prepare(-1)).rejects.toMatchObject({ ...fault, cause: renderFailure });
        expect(projection.failure).toEqual(fault);
        await expect(noUpdate()).rejects.toMatchObject({ ...fault, cause: renderFailure });
        expect(projection.token().epoch).toBe(first + 1);
        await expect(prepare(2)).resolves.toEqual({ status: 'prepared' });
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
        await expect(prepare(update)).resolves.toEqual({ status: 'prepared' });
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
        await expect(prepare(() => set(2))).resolves.toEqual({ status: 'prepared' });
    });
});

describe('C01/C02 actual component capability honesty', () => {
    it('keeps actual View/Ref registration without obsolete component registries', async () => {
        let context: any;
        let refFormatter: any;
        function Body() { context = useContext(ViewRuntimeContext);const ref = useDataRef('record', { label: 'value' }, { schema: FixtureType.Object({}), scope: 'protected' });refFormatter = ref;return h('p', {}, ref('Record')); }
        const x = await mount(Body);expect(context).not.toHaveProperty('llmOutput');expect(mountedViews(x.kernel)).toHaveLength(1);
        expect(preparedRefs(x.kernel)).toContainEqual(expect.objectContaining({ viewId: 'detail_1', refId: 'record' }));expect(x.container.textContent).toContain('[Record](protected record: object)');
        expect(refFormatter).not.toHaveProperty('data');
        expect(refFormatter).not.toHaveProperty('id');
        expect(Object.hasOwn(context, 'mountable')).toBe(false);
        expect(Object.hasOwn(context, 'dynamic')).toBe(false);
        expect(Object.hasOwn(context, 'typeTools')).toBe(false);expect(Object.hasOwn(context, 'config')).toBe(false);
        await x.close();expect(mountedViews(x.kernel)).toHaveLength(0);expect(preparedRefs(x.kernel)).toHaveLength(0);
    });
});
