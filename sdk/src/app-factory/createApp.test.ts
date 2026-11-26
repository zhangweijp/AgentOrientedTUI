import { describe, expect, it, vi } from 'vitest';
import { APP_LIFECYCLE_PROTOCOL, DEFAULT_PROJECTION_LIMITS, VIEW_TYPE_TOOL_PROTOCOL, type RuntimeContext } from '@aotui/core';
import { AppKernel } from '../../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createAppId, createDesktopId } from '../../../runtime/src/spi/core/id-factory.js';
import * as SDK from '../index.js';
import { createApp, createView, defineViewType, formatRef, ref, type AppAuthorContext, type TUIAppFactory, type ViewHandle } from '../index.js';

const File = defineViewType<{ writable: boolean }>()({
    name: 'File', region: 'dynamic', multiplicity: 'multiple',
    tools: { edit: { description: 'Edit the file', enabled: ({ writable }) => writable, execute: () => ({ success: true }) } },
});
const Directory = defineViewType({ name: 'Directory', region: 'static', multiplicity: 'single' });

function kernel(factory: TUIAppFactory, maxViews = DEFAULT_PROJECTION_LIMITS.maxViews, requestAttention?: () => void) {
    return new AppKernel({
        appId: createAppId('app'), desktopId: createDesktopId('desktop'), instanceId: 'app-run',
        launchConfig: { folder: '/workspace' },
        projectionLimits: { ...DEFAULT_PROJECTION_LIMITS, maxViews }, factory, requestAttention,
    });
}

function draftOf(app: AppKernel) {
    const publication = app.getProjectionCoordinator().nextPublication();
    if (!('draft' in publication)) throw new Error(JSON.stringify(publication.failure));
    return publication.draft;
}

describe('TypeScript App factory', () => {
    it('publishes the root entry and captures factory metadata without reading accessors', () => {
        expect(Object.keys(SDK).sort()).toEqual([
            'AOTUIError', 'ViewMultiplicity', 'ViewRegion', 'arrayRef', 'createApp', 'createView',
            'defineViewType', 'formatRef', 'ref', 'refParam',
        ]);
        const initialize = vi.fn();
        const readName = vi.fn(() => 'file_app');
        expect(() => createApp({ viewTypes: [], get app_name() { return readName(); }, initialize }))
            .toThrow(expect.objectContaining({ code: 'APP_METADATA_INVALID', path: 'app_name' }));
        expect(readName).not.toHaveBeenCalled();
        const original = { app_name: 'file_app', viewTypes: [], whatItIs: 'Catalog copy', initialize };
        const factory = createApp(original);
        original.app_name = 'changed';
        expect(factory).toEqual({
            app_name: 'file_app', initialize: expect.any(Function),
            appLifecycleSupport: APP_LIFECYCLE_PROTOCOL, toolAuthoringProtocol: VIEW_TYPE_TOOL_PROTOCOL,
        });
        for (const app_name of [null, [], {}, 1, 'System-Ide']) {
            expect(() => createApp({ app_name, viewTypes: [], initialize } as never))
                .toThrow(expect.objectContaining({ code: 'APP_METADATA_INVALID', path: 'app_name' }));
        }
        expect(initialize).not.toHaveBeenCalled();
    });

    it('keeps cleanup and attention on the instance and exposes the author context', async () => {
        let context!: AppAuthorContext;
        const notify = vi.fn();
        const order: string[] = [];
        const factory = createApp({ app_name: 'file_app', viewTypes: [],
            initialize(author) {
                context = author;
                author.registerCleanup({
                    stop: () => { expect(context.signal.aborted).toBe(true); order.push('stop'); },
                    async close() { order.push('close'); },
                });
                author.prepareProjection({ views: [] });
            },
        });
        await expect(factory.initialize({} as RuntimeContext)).rejects.toThrow('APP_LIFECYCLE_UNSUPPORTED');
        const app = kernel(factory, undefined, notify);
        try {
            await app.onOpen();
            expect(Object.keys(context).sort()).toEqual([
                'appId', 'desktopId', 'launchConfig', 'prepareOpeningProjection', 'prepareProjection', 'projectionLimits',
                'readViewId', 'registerCleanup', 'requestAttention', 'signal',
            ]);
            expect(context.launchConfig).toEqual({ folder: '/workspace' });
            expect(draftOf(app).views).toEqual([]);
            context.requestAttention();
            expect(notify).toHaveBeenCalledOnce();
        } finally { await app.onClose(); }
        expect(order).toEqual(['stop', 'close']);
        context.requestAttention();
        expect(notify).toHaveBeenCalledOnce();
        expect(() => context.prepareOpeningProjection({ views: [] }))
            .toThrow(expect.objectContaining({ code: 'APP_KERNEL_CLOSED' }));
    });

    it('uses handles for same-name pages, reordering and display-name changes', async () => {
        let context!: AppAuthorContext;
        let first!: ViewHandle, second!: ViewHandle, extra!: ViewHandle;
        let title = 'index.ts';
        let writable = true;
        const value = { 'file.path': 'src/index.ts' };
        const page = () => createView(File, { idPrefix: 'fd', name: 'index.ts', render: () => ({ body: 'File', context: { writable } }) });
        const factory = createApp({ app_name: 'files', viewTypes: [File],
            initialize(author) {
                context = author;
                first = createView(File, { idPrefix: 'fd', name: 'Initial', render() {
                    const content = ref('file', value, { scope: 'public', schema: { type: 'object' } });
                    return { name: title, body: '<view>Literal</view>\n' + formatRef('File', content), refs: [content], context: { writable } };
                } });
                second = page();
                extra = page();
                expect(author.readViewId(first)).toBeUndefined();
                author.prepareProjection({ views: [first] });
            },
        });
        const app = kernel(factory, 2);
        try {
            await app.onOpen();
            expect(context.readViewId(first)).toBe('fd_1');
            const firstMount = draftOf(app).views[0]!.viewInstanceId;
            expect(context.prepareOpeningProjection({ views: [first, second, extra] }))
                .toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_CAPACITY' } });
            expect(context.readViewId(second)).toBeUndefined();
            expect(context.readViewId(extra)).toBeUndefined();
            expect(draftOf(app).views).toHaveLength(1);
            expect(context.prepareOpeningProjection({ views: [first, second] })).toEqual({ status: 'prepared' });
            expect(context.readViewId(first)).toBe('fd_1');
            expect(context.readViewId(second)).toBe('fd_2');
            expect(draftOf(app).views.map(view => view.name)).toEqual(['index.ts', 'index.ts']);

            title = 'src/index.ts';
            writable = false;
            value['file.path'] = 'src/renamed.ts';
            const original = draftOf(app);
            expect(Object.values(original.refs)[0]?.target.payload).toEqual({ 'file.path': 'src/index.ts' });
            expect(Object.keys(original.tools)).toHaveLength(1);
            context.prepareProjection({ views: [second, first] });
            const updated = draftOf(app);
            expect(updated.views.map(view => view.id)).toEqual(['fd_2', 'fd_1']);
            expect(updated.views[1]).toMatchObject({
                name: title, viewInstanceId: firstMount, content: { value: expect.stringContaining('<view>Literal</view>') },
            });
            expect(Object.values(updated.refs)[0]?.target.payload).toEqual(value);
            expect(Object.keys(updated.tools)).toHaveLength(0);

            context.prepareProjection({ views: [first] });
            expect(context.readViewId(second)).toBeUndefined();
            expect(context.prepareOpeningProjection({ views: [first, second] })).toEqual({ status: 'prepared' });
            expect(context.readViewId(second)).toBe('fd_3');
        } finally { await app.onClose(); }
        expect(context.readViewId(first)).toBeUndefined();
    });

    it('propagates the original render error and rejects handles from another App', async () => {
        const error = new Error('File could not render');
        let broken = false;
        let foreign!: ViewHandle;
        let context!: AppAuthorContext;
        const app = kernel(createApp({ app_name: 'first', viewTypes: [Directory],
            initialize(author) {
                context = author;
                foreign = createView(Directory, { render() {
                    if (broken) throw error;
                    return { body: 'File directory' };
                } });
                author.prepareProjection({ views: [foreign] });
            },
        }));
        const other = kernel(createApp({ app_name: 'second', viewTypes: [Directory],
            initialize(author) {
                expect(author.readViewId(foreign)).toBeUndefined();
                expect(() => author.prepareProjection({ views: [foreign] })).toThrow(/belonging to this App/);
                author.prepareProjection({ views: [] });
            },
        }));
        try {
            await app.onOpen();
            await other.onOpen();
            broken = true;
            expect(() => context.prepareProjection({ views: [foreign] })).toThrow(error);
            const render = vi.fn(() => ({ body: 'Replacement' }));
            const candidate = createView(Directory, { render });
            expect(() => context.prepareOpeningProjection({ views: [candidate] })).toThrow(error);
            expect(render).not.toHaveBeenCalled();
            expect(context.readViewId(foreign)).toBeUndefined();
            broken = false;
            expect(context.prepareProjection({ views: [foreign] })).toEqual({ status: 'prepared' });
            expect(context.readViewId(foreign)).toBe('Directory');
        } finally { await Promise.all([app.onClose(), other.onClose()]); }
    });

    it('validates placement without inventing a region or accepting invalid route IDs', async () => {
        const Nothing = defineViewType({ name: 'Nothing', multiplicity: 'single' });
        const app = kernel(createApp({ app_name: 'placement', viewTypes: [Nothing, Directory],
            initialize({ prepareProjection }) {
                for (const region of [undefined, null, 'other']) {
                    const page = createView(Nothing, { region, render: () => ({ body: 'Page without region' }) } as never);
                    expect(() => prepareProjection({ views: [page] })).toThrow(expect.objectContaining({
                        code: 'SNAPSHOT_INVALID', path: 'ViewType Nothing.region',
                    }));
                }
                for (const id of ['', '123', 'file.a', 'file a', 'file-a', '文件', 'file"', 'file\n', 'file\r\n']) {
                    const page = createView(Directory, { id, render: () => ({ body: 'Invalid route' }) });
                    expect(() => prepareProjection({ views: [page] })).toThrow(expect.objectContaining({
                        code: 'SNAPSHOT_INVALID', path: 'ViewType Directory.id',
                    }));
                }
                const invalidName = createView(Directory, { render: () => ({ name: null, body: 'Invalid name' }) } as never);
                expect(() => prepareProjection({ views: [invalidName] })).toThrow(expect.objectContaining({
                    code: 'SNAPSHOT_INVALID', path: '$.views[0].name',
                }));
                const lateRender = createView(Directory, { render: () => Promise.reject(new Error('Late render')) } as never);
                expect(() => prepareProjection({ views: [lateRender] })).toThrow(/return a Markdown body synchronously/);
                const page = createView(Nothing, { region: 'static', render: () => ({ body: '' }) });
                expect(prepareProjection({ views: [page] })).toEqual({ status: 'prepared' });
            },
        }));
        try {
            await app.onOpen();
            expect(draftOf(app).views[0]?.content.value).toBe('');
        } finally { await app.onClose(); }
    });
});
