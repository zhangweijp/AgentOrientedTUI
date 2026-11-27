import { describe, expect, it, vi } from 'vitest';
import { APP_LIFECYCLE_PROTOCOL, DEFAULT_PROJECTION_LIMITS, DEFAULT_SNAPSHOT_LIMITS, VIEW_TYPE_TOOL_PROTOCOL, type RuntimeContext } from '@aotui/core';
import { AppKernel } from '../../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createAppId, createDesktopId } from '../../../runtime/src/spi/core/id-factory.js';
import * as SDK from '../index.js';
import { createApp, createView, defineViewType, formatRef, ref, type AppAuthorContext, type TUIAppFactory, type ViewHandle, type ViewType } from '../index.js';

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

    it('seals static canonical declarations at factory creation and preserves order across instances', async () => {
        const original = [Directory, File];
        const entries: (readonly typeof original[number][])[] = [];
        const factory = createApp({ app_name: 'static_capture', viewTypes: original,
            initialize(author, types) {
                expect(Object.isFrozen(types)).toBe(true);
                entries.push(types);
                expect(types).toEqual([Directory, File]);
                expect(author.publish(() => [])).toMatchObject({ ok: true });
            },
        });
        original.reverse();
        original.length = 0;
        const a = kernel(factory), b = kernel(factory);
        try {
            await Promise.all([a.onOpen(), b.onOpen()]);
            expect(entries).toHaveLength(2);
            expect(entries[0]).toBe(entries[1]);
            expect(entries[0]?.[0]).toBe(Directory);
        } finally { await Promise.all([a.onClose(), b.onClose()]); }
    });

    it('evaluates dynamic declarations once per instance, using the same captured config and exact canonical types', async () => {
        const configurations: AppAuthorContext['launchConfig'][] = [];
        const actual: ViewType[][] = [];
        const returned: ViewType[][] = [];
        const factory = createApp({ app_name: 'dynamic_capture',
            viewTypes(config) {
                configurations.push(config);
                const tag = config?.tag;
                if (tag === 'fail') throw Object.assign(Error('Invalid tag'), { code: 'BAD_TAG', path: 'tag' });
                const Detail = defineViewType<{ value: string }>()({ name: 'Detail', multiplicity: 'single', region: 'dynamic',
                    tools: { read: { description: 'read', execute: ({ context }) => ({ success: true, data: { value: String(tag) + ':' + context.value } }) } } });
                const result: [typeof Directory, typeof Detail] = [Directory, Detail];
                returned.push(result);
                return result;
            },
            initialize(author, types) {
                expect(author.launchConfig).toBe(configurations.at(-1));
                expect(Object.isFrozen(types)).toBe(true);
                expect(types[0]).toBe(Directory);
                expect(types[1]).toBe(returned.at(-1)?.[1]);
                actual.push([...types]);
                returned.at(-1)!.length = 0;
                expect(author.publish(() => [createView(types[1]!).frame({ body: String(author.launchConfig?.tag), context: { value: 'body' } })])).toMatchObject({ ok: true });
            },
        });
        const start = (tag: string) => new AppKernel({ appId: createAppId('dynamic_capture'),
            desktopId: createDesktopId('desk'), instanceId: 'run-' + tag,
            projectionLimits: DEFAULT_PROJECTION_LIMITS, factory, launchConfig: { tag } });
        const a = start('A'), b = start('B'), bad = start('fail');
        expect(configurations).toHaveLength(0);
        try {
            await a.onOpen();
            await a.onOpen();
            await b.onOpen();
            await expect(bad.onOpen()).rejects.toMatchObject({ code: 'BAD_TAG', path: 'tag' });
            expect(configurations).toHaveLength(3);
            expect(actual).toHaveLength(2);
            expect(actual[0]?.[1]).not.toBe(actual[1]?.[1]);
            expect(draftOf(a).views[0]?.content.value).toBe('A');
            expect(draftOf(b).views[0]?.content.value).toBe('B');
        } finally { await Promise.all([a.onClose(), b.onClose(), bad.onClose()]); }
    });

    it('rejects unsafe declaration arrays without evaluating elements or entering the author', async () => {
        const read = vi.fn(() => Directory);
        const sparse = new Array(1);
        const accessor = Object.defineProperty([Directory], '0', { get: read, enumerable: true });
        const then = vi.fn();
        const thenable = Object.assign([Directory], { then });
        const oversize = new Array(DEFAULT_SNAPSHOT_LIMITS.maxViews + 1);
        const initialize = vi.fn();
        for (const bad of [sparse, accessor, thenable, oversize, [Directory, Directory], null]) {
            expect(() => createApp({ app_name: 'bad_static', viewTypes: bad, initialize } as never)).toThrow();
            const app = kernel(createApp({ app_name: 'bad_dynamic', viewTypes: () => bad, initialize } as never));
            try { await expect(app.onOpen()).rejects.toThrow(); }
            finally { await app.onClose(); }
        }
        const asyncFactory = vi.fn();
        expect(() => createApp({ app_name: 'async', viewTypes: async () => { asyncFactory(); return [Directory]; },
            initialize } as never)).toThrow(/synchronous/);
        const rejected = kernel(createApp({ app_name: 'promise', viewTypes: () => Promise.reject(Error('bad')),
            initialize } as never));
        try { await expect(rejected.onOpen()).rejects.toMatchObject({ code: 'VIEW_TYPE_INVALID' }); }
        finally { await rejected.onClose(); }
        expect(read).not.toHaveBeenCalled();
        expect(then).not.toHaveBeenCalled();
        expect(asyncFactory).not.toHaveBeenCalled();
        expect(initialize).not.toHaveBeenCalled();
    });

    it('keeps cleanup and attention on the instance and exposes the author context', async () => {
        let context!: AppAuthorContext;
        const notify = vi.fn();
        const order: string[] = [];
        const factory = createApp({ app_name: 'file_app', viewTypes: [],
            initialize(author) {
                context = author;
                author.registerLifecycle({
                    stop: () => { expect(context.signal.aborted).toBe(true); order.push('stop'); },
                    async close() { order.push('close'); },
                });
                expect(author.publish(() => [])).toMatchObject({ ok: true });
            },
        });
        await expect(factory.initialize({} as RuntimeContext)).rejects.toThrow('APP_LIFECYCLE_UNSUPPORTED');
        const app = kernel(factory, undefined, notify);
        try {
            await app.onOpen();
            expect(Object.keys(context).sort()).toEqual([
                'appId', 'desktopId', 'launchConfig', 'projectionLimits', 'publish',
                'readViewId', 'registerLifecycle', 'requestAttention', 'signal',
            ]);
            expect(context.launchConfig).toEqual({ folder: '/workspace' });
            expect(draftOf(app).views).toEqual([]);
            context.requestAttention();
            expect(notify).toHaveBeenCalledOnce();
        } finally { await app.onClose(); }
        expect(order).toEqual(['stop', 'close']);
        context.requestAttention();
        expect(notify).toHaveBeenCalledOnce();
        expect(context.publish(() => [], { mode: 'candidate' })).toMatchObject({ ok: false, state: 'preserved', issue: { code: 'APP_STOPPED' } });
    });

    it('rejects the retired author return object without transferring its cleanup ownership', async () => {
        const legacyClose = vi.fn(), stop = vi.fn(), close = vi.fn();
        const app = kernel(createApp({ app_name: 'legacy_return', viewTypes: [],
            initialize: ((author: AppAuthorContext) => {
                author.registerLifecycle({ stop, close });
                expect(author.publish(() => [])).toMatchObject({ ok: true });
                return { close: legacyClose };
            }) as unknown as (author: AppAuthorContext) => void,
        }));
        try {
            await expect(app.onOpen()).rejects.toMatchObject({ code: 'APP_INVALID_INSTANCE', path: 'initialize' });
        } finally { await app.onClose(); }
        expect(stop).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(legacyClose).not.toHaveBeenCalled();
    });

    it('uses pure handles, stable identities, and a commit-local result', async () => {
        let context!: AppAuthorContext;
        const first = createView(File, { idPrefix: 'fd' }), second = createView(File, { idPrefix: 'fd' }), extra = createView(File, { idPrefix: 'fd' });
        let title = 'index.ts', writable = true, key: string | number = 'old';
        const value = { 'file.path': 'src/index.ts' };
        const firstFrame = () => {
            const content = ref('file', value, { scope: 'public', schema: { type: 'object' } });
            return first.frame({ name: title, bindingKey: key, body: '<view>Literal</view>\n' + formatRef('File', content), refs: [content], context: { writable } });
        };
        const frame = (handle: typeof second) => handle.frame({ name: 'index.ts', body: 'File', context: { writable } });
        const factory = createApp({ app_name: 'files', viewTypes: [File], initialize(author) {
            context = author;
            expect(author.readViewId(first)).toBeUndefined();
            expect(author.publish(() => [firstFrame()])).toMatchObject({ ok: true, epoch: 1 });
        } });
        const app = kernel(factory, 2);
        try {
            await app.onOpen();
            const initial = draftOf(app).views[0]!;
            expect(context.publish(() => [firstFrame(), frame(second), frame(extra)], { mode: 'candidate' }))
                .toMatchObject({ ok: false, state: 'preserved', issue: { code: 'OBSERVATION_CAPACITY' } });
            expect(context.readViewId(second)).toBeUndefined();
            expect(context.readViewId(extra)).toBeUndefined();
            expect(draftOf(app).views).toHaveLength(1);
            const opened = context.publish(() => [firstFrame(), frame(second)], { mode: 'candidate' });
            expect(opened).toMatchObject({ ok: true, epoch: 2 });
            if (!opened.ok) throw Error(opened.issue.message);
            expect(opened.viewId(first)).toBe('fd_1');
            expect(opened.viewId(second)).toBe('fd_2');
            const original = draftOf(app);
            expect(original.views.map(view => view.name)).toEqual(['index.ts', 'index.ts']);
            title = 'src/index.ts'; key = 5; value['file.path'] = 'src/renamed.ts';
            expect(context.publish(() => [frame(second), firstFrame()])).toMatchObject({ ok: true });
            const updated = draftOf(app);
            expect(updated.views.map(view => view.id)).toEqual(['fd_2', 'fd_1']);
            expect(updated.views[1]).toMatchObject({ name: title, viewInstanceId: initial.viewInstanceId });
            expect(updated.views[1]?.toolBindings[0]?.activationId).not.toBe(initial.toolBindings[0]?.activationId);
            expect(updated.views[0]?.toolBindings).toEqual(original.views[1]?.toolBindings);
            expect(Object.values(original.refs)[0]?.target.payload).toEqual({ 'file.path': 'src/index.ts' });
            expect(Object.values(updated.refs)[0]?.target.payload).toEqual(value);
            expect(Object.values(updated.refs)[0]?.continuity).toEqual([1,1,1]);
            writable = false;
            expect(context.publish(() => [firstFrame()])).toMatchObject({ ok: true });
            expect(context.readViewId(second)).toBeUndefined();
            expect(Object.keys(draftOf(app).tools)).toHaveLength(0);
            expect(context.publish(() => [firstFrame(), frame(second)], { mode: 'candidate' })).toMatchObject({ ok: true });
            expect(context.readViewId(second)).toBe('fd_3');
            expect(opened.viewId(second)).toBe('fd_2');
        } finally { await app.onClose(); }
        expect(context.readViewId(first)).toBeUndefined();
    });

    it('shares a module handle across instances and preserves candidate errors without poisoning', async () => {
        const error = new Error('File could not render');
        const shared = createView(Directory);
        let context!: AppAuthorContext;
        const app = kernel(createApp({ app_name: 'first', viewTypes: [Directory], initialize(author) {
            context = author;
            expect(author.publish(() => [shared.frame({ body: 'first' })])).toMatchObject({ ok: true });
        } }));
        const other = kernel(createApp({ app_name: 'second', viewTypes: [Directory], initialize(author) {
            expect(author.readViewId(shared)).toBeUndefined();
            expect(author.publish(() => [shared.frame({ body: 'second' })])).toMatchObject({ ok: true });
        } }));
        try {
            await app.onOpen(); await other.onOpen();
            expect(draftOf(other).views[0]?.content.value).toBe('second');
            const failed = context.publish(() => { throw error; }, { mode: 'candidate' });
            expect(failed).toMatchObject({ ok: false, state: 'preserved' });
            if (failed.ok) throw Error('Expected rejection');
            expect(failed.cause).toBe(error);
            expect(Object.keys(failed)).not.toContain('cause');
            expect(draftOf(app).views[0]?.content.value).toBe('first');
            const foreign = createView(defineViewType({name:'Directory', multiplicity:'single',region:'static'}));
            expect(context.publish(() => [foreign.frame({body:'foreign'})], {mode:'candidate'})).toMatchObject({ok:false,state:'preserved'});
            expect(context.publish(() => { throw error; })).toMatchObject({ ok: false, state: 'degraded' });
            const build = vi.fn(() => [shared.frame({body:'replacement'})]);
            expect(context.publish(build, {mode:'candidate'})).toMatchObject({ok:false,state:'preserved',issue:{code:'SNAPSHOT_UNREADY'}});
            expect(build).not.toHaveBeenCalled();
            expect(context.readViewId(shared)).toBeUndefined();
            expect(context.publish(build)).toMatchObject({ok:true,epoch:2});
            expect(context.readViewId(shared)).toBe('Directory');
            expect(draftOf(other).views[0]?.content.value).toBe('second');
        } finally { await Promise.all([app.onClose(), other.onClose()]); }
    });

    it('validates placement, dense builders, and reentrant atomic rejection', async () => {
        const Nothing = defineViewType({ name: 'Nothing', multiplicity: 'single' });
        const app = kernel(createApp({ app_name: 'placement', viewTypes: [Nothing, Directory], initialize(author) {
            const candidate = {mode:'candidate'} as const;
            for (const region of [undefined, null, 'other']) {
                expect(author.publish(() => [createView(Nothing, {region} as never).frame({body:''})], candidate))
                    .toMatchObject({ok:false,state:'preserved',issue:{code:'SNAPSHOT_INVALID',path:'ViewType Nothing.region'}});
            }
            for (const id of ['', '123', 'file.a', 'file a', 'file-a', '文件', 'file"', 'file\n', 'file\r\n']) {
                expect(author.publish(() => [createView(Directory, {id}).frame({body:''})], candidate))
                    .toMatchObject({ok:false,state:'preserved',issue:{code:'SNAPSHOT_INVALID',path:'ViewType Directory.id'}});
            }
            const page = createView(Nothing,{region:'static'});
            expect(author.publish(() => [page.frame({name:null,body:''} as never)],candidate)).toMatchObject({ok:false,state:'preserved'});
            const asyncBuild = vi.fn();
            expect(author.publish((async () => {asyncBuild();return [];}) as never,candidate)).toMatchObject({ok:false,state:'preserved'});
            expect(asyncBuild).not.toHaveBeenCalled();
            expect(author.publish(() => new Array(1),candidate)).toMatchObject({ok:false,state:'preserved'});
            expect(author.publish(() => {
                expect(author.publish(() => [])).toMatchObject({ok:false});
                return [page.frame({body:'nested'})];
            },candidate)).toMatchObject({ok:false,state:'preserved'});
            expect(author.publish(() => [page.frame({body:''})])).toMatchObject({ok:true,epoch:1});
        } }));
        try { await app.onOpen(); expect(draftOf(app).views[0]?.content.value).toBe(''); }
        finally { await app.onClose(); }
    });
});
