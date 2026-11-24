import { mountedViews } from './__tests__/projection-facts.js';
import { h, type ComponentType } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECTION_LIMITS } from '@aotui/core';
import { createAppId, createDesktopId } from '../../runtime/src/spi/core/id-factory.js';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createApp, createView } from './app-factory/createApp.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { defineViewType, DynamicView } from './components/View.js';

const Guide = defineViewType({ name: 'Guide', multiplicity: 'single', region: 'static' });
const Detail = defineViewType({ name: 'FileDetail', multiplicity: 'multiple' });

function kernelFor(factory: ReturnType<typeof createApp> | ReturnType<typeof createTUIApp>) {
    return new AppKernel({ factory,
        appId: createAppId('metadata'), desktopId: createDesktopId('desktop'),
        instanceId: 'metadata_run', projectionLimits: DEFAULT_PROJECTION_LIMITS,
    });
}

describe('explicit View metadata', () => {
    it.each([undefined, null, 'other'])('requires a valid region for a direct View without a default (%s)', async region => {
        const component = () => h(Detail as unknown as ComponentType<{ region: unknown }>, { region });
        const kernel = kernelFor(createTUIApp({ app_name: 'metadata', viewTypes: [Detail], component }));
        try {
            await expect(kernel.onOpen()).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID', path: 'ViewType FileDetail.region' });
        } finally { await kernel.onClose(); }
    });

    it('rejects invalid View IDs in both authoring paths, including final line breaks and all-numeric names', async () => {
        const ids = ['', '123', 'file.a', 'file a', 'file-a', '文件', 'file"', 'file\n', 'file\r\n'];
        for (const id of ids) {
            const preact = createTUIApp({ app_name: 'metadata', viewTypes: [Guide], component: () => h(Guide, { id }) });
            const plain = createApp({ app_name: 'metadata', viewTypes: [Guide], initialize({ prepareProjection }) {
                prepareProjection({ views: [createView(Guide, { id, render: () => ({ body: 'File data' }) })] });
            } });
            for (const factory of [preact, plain]) {
                const kernel = kernelFor(factory);
                try {
                    await expect(kernel.onOpen()).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' });
                    expect(mountedViews(kernel)).toEqual([]);
                } finally { await kernel.onClose(); }
            }
        }
    });

    it('commits direct and wrapper Views without interpreting descendant roles and releases their mounted identities', async () => {
        const item = h('p', { 'data-role': 'application-instruction' }, 'File data');
        const component = () => h('main', {}, [
            h(Guide, { id: '1_guide' }, 'Instructions'),
            h(DynamicView, { idPrefix: 'file', type: Detail }, item),
        ]);
        const kernel = kernelFor(createTUIApp({ app_name: 'metadata', viewTypes: [Guide, Detail], component }));
        try {
            await act(async () => kernel.onOpen());
            const publication = kernel.getProjectionCoordinator().nextPublication();
            if (!('draft' in publication)) throw new Error('Expected a View projection');
            expect(publication.draft.views.map(({ id, type, region }) => ({ id, type, region }))).toEqual([
                { id: '1_guide', type: 'Guide', region: 'static' },
                { id: 'file_1', type: 'FileDetail', region: 'dynamic' },
            ]);
            expect(document.body.lastElementChild?.querySelector('[view]')).toBeNull();
        } finally { await act(async () => kernel.onClose()); }
        expect(mountedViews(kernel)).toEqual([]);
    });

    it('preserves framework-assigned multi-instance identities across reordering and region changes', async () => {
        const File = defineViewType<{ file: string }>()({ name: 'File', multiplicity: 'multiple', region: 'dynamic' });
        let update!: () => void;
        function Component() {
            const [changed, setChanged] = useState(false);
            update = () => setChanged(true);
            return (changed ? ['B', 'A'] : ['A', 'B']).map(file =>
                h(File, { key: file, idPrefix: 'doc', context: { file }, region: changed ? 'static' : 'dynamic' }, file));
        }
        const kernel = kernelFor(createTUIApp({ app_name: 'metadata', viewTypes: [File], component: () => h(Component, {}) }));
        const views = () => {
            const publication = kernel.getProjectionCoordinator().nextPublication();
            if (!('draft' in publication)) throw new Error('Expected a View projection');
            return publication.draft.views;
        };
        try {
            await act(async () => kernel.onOpen());
            const original = new Map(views().map(view => [view.id, view.viewInstanceId]));
            expect([...original.keys()]).toEqual(['doc_1', 'doc_2']);
            await act(() => update());
            expect(views().map(view => [view.id, view.viewInstanceId, view.region])).toEqual([
                ['doc_2', original.get('doc_2'), 'static'],
                ['doc_1', original.get('doc_1'), 'static'],
            ]);
        } finally { await act(async () => kernel.onClose()); }
    });

    it('rejects two simultaneous mounts of a tool-free single ViewType', async () => {
        const component = () => h('main', {}, [h(Guide, { id: 'one' }), h(Guide, { id: 'two' })]);
        const kernel = kernelFor(createTUIApp({ app_name: 'metadata', viewTypes: [Guide], component }));
        try {
            await kernel.onOpen();
            expect(kernel.getProjectionCoordinator().nextPublication()).toMatchObject({
                failure: { issue: { message: expect.stringMatching(/single/i) } },
            });
            expect(mountedViews(kernel)).toEqual([]);
        } finally { await kernel.onClose(); }
    });
});
