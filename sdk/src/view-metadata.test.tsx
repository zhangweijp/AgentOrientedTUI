import { DEFAULT_PROJECTION_LIMITS } from '../../runtime/src/core/invocation/observation-registry.js';
import { createAppId, createDesktopId } from '../../runtime/src/spi/core/id-factory.js';
import { h } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it } from 'vitest';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { createApp, createView } from './app-factory/createApp.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';
const _FixtureGuide = defineViewType({ name:'Guide' });
const _FixtureFileDetail = defineViewType({ name:'FileDetail' });

import { defineViewType } from './tools/view-type-tool.js';

describe('explicit View author metadata', () => {
    it.each([
        { id: 'detail', type: 'Detail' },
        { id: 'detail', type: 'Detail', kind: 'other' },
    ])('rejects invalid metadata before registering a View: %j', props => {
        expect(() => View(props as any)).toThrow(/VIEW_METADATA_INVALID/);
    });

    it('rejects empty and non-ASCII View IDs in both authoring paths, including final line breaks', async () => {
        for (const id of ['', 'file.a', 'file a', 'file-a', '文件', 'file"', 'file\n', 'file\r\n']) {
            expect(() => View({ id, type: _FixtureFileDetail, kind: 'state' })).toThrow(/View.*[Ii][Dd]/);
            const factory = createApp({ app_name: 'metadata', viewTypes:[_FixtureFileDetail], initialize({ prepareProjection }) {
                prepareProjection({views:[createView(_FixtureFileDetail,{id,kind:'state',render:()=>({body:'File data'})})]});
            } });
            const kernel = new AppKernel({ ...factory.kernelConfig, factory,
                appId: createAppId('metadata'), desktopId: createDesktopId('desktop'),
                instanceId: 'metadata-run', projectionLimits: DEFAULT_PROJECTION_LIMITS,
            });
            try {
                await expect(kernel.onOpen())
                    .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID', path: '$.views' });
            } finally { await kernel.onClose(); }
        }
    });

    it('publishes explicit metadata without interpreting descendant roles and releases mounted identity', async () => {
        const component = () => h('main', {}, [
            h(View, { id: 'guide', type: _FixtureGuide, kind: 'instruction' }, 'Instructions'),
            h(View, { id: 'file_1', type: _FixtureFileDetail, kind: 'state' },
                h('p', { 'data-role': 'application-instruction' }, 'File data')),
        ]);
        const factory = createTUIApp({viewTypes:[_FixtureGuide,_FixtureFileDetail],  app_name: 'metadata', component });
        const kernel = new AppKernel({ ...factory.kernelConfig, factory,
            appId: createAppId('metadata'), desktopId: createDesktopId('desktop'),
            instanceId: 'metadata-run', projectionLimits: DEFAULT_PROJECTION_LIMITS,
        });
        try {
            await act(async () => kernel.onOpen());
            const container = document.getElementById('app-root-metadata')!;
            const publication = kernel.getProjectionCoordinator().nextPublication();
            if (!('draft' in publication)) throw Error('Expected a View projection');
            expect(publication.draft.views.map(({ id, type, kind }) => ({ viewId: id, viewType: type, kind })))
                .toEqual([
                    { viewId: 'guide', viewType: 'Guide', kind: 'instruction' },
                    { viewId: 'file_1', viewType: 'FileDetail', kind: 'state' },
                ]);
            expect(kernel.getViewOwnedViewInstances().map(view => view.viewType).sort()).toEqual(['FileDetail', 'Guide']);
            expect(container.querySelector('[view]')).toBeNull();
        } finally {
            await act(async () => kernel.onClose());
        }
        expect(kernel.getViewOwnedViewInstances()).toEqual([]);
    });
});
