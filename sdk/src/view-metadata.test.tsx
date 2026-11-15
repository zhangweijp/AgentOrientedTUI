import { h } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it } from 'vitest';
import { AppKernel } from '../../runtime/src/worker-runtime/app-kernel/AppKernel.js';
import { extractViewFragments } from '../../runtime/src/worker-runtime/view-fragment-extractor.js';
import { createApp } from './app-factory/createApp.js';
import { createTUIApp } from './app-factory/createTUIApp.js';
import { View } from './components/View.js';

describe('explicit View author metadata', () => {
    it.each([
        { id: 'detail', kind: 'state' },
        { id: 'detail', type: 'Detail' },
        { id: 'detail', type: '', kind: 'state' },
        { id: 'detail', type: 'Detail', kind: 'other' },
    ])('rejects invalid metadata before registering a View: %j', props => {
        expect(() => View(props as any)).toThrow(/VIEW_METADATA_INVALID/);
    });

    it('rejects empty and non-ASCII View IDs in both authoring paths, including final line breaks', async () => {
        for (const id of ['', 'file.a', 'file a', 'file-a', '文件', 'file"', 'file\n', 'file\r\n']) {
            expect(() => View({ id, type: 'File', kind: 'state' })).toThrow(/View.*[Ii][Dd]/);
            const factory = createApp({ app_name: 'metadata', initialize({ publish }) {
                publish({ views: [{ id, type: 'File', kind: 'state', body: 'File data' }] });
            } });
            const kernel = new AppKernel({ ...factory.kernelConfig, factory });
            kernel.setId('metadata' as any);
            kernel.setAppExecutionInstanceId('metadata-run');
            kernel.enableAppLifecycle();
            try {
                await expect(kernel.onOpen({ appId: 'metadata' as any, desktopId: 'desktop' as any }))
                    .rejects.toMatchObject({ code: 'SNAPSHOT_INVALID', path: '$.views' });
            } finally { await kernel.onClose(); }
        }
    });

    it('publishes explicit metadata without interpreting descendant roles and releases mounted identity', async () => {
        const component = () => h('main', {}, [
            h(View, { id: 'guide', type: 'Guide', kind: 'instruction' }, 'Instructions'),
            h(View, { id: 'file_1', type: 'FileDetail', kind: 'state' },
                h('p', { 'data-role': 'application-instruction' }, 'File data')),
        ]);
        const factory = createTUIApp({ app_name: 'metadata', component });
        const kernel = new AppKernel({ ...factory.kernelConfig, factory } as any);
        kernel.setId('metadata' as any);
        kernel.setAppExecutionInstanceId('metadata-run');
        kernel.enableAppLifecycle();
        try {
            await act(async () => kernel.onOpen({ appId: 'metadata' as any, desktopId: 'desktop' as any,
                 }));
            const container = document.getElementById('app-root-metadata')!;
            expect(extractViewFragments(container).map(({ viewId, viewType, kind }) => ({ viewId, viewType, kind })))
                .toEqual([
                    { viewId: 'guide', viewType: 'Guide', kind: 'instruction' },
                    { viewId: 'file_1', viewType: 'FileDetail', kind: 'state' },
                ]);
            container.querySelector('p')!.removeAttribute('data-role');
            expect(extractViewFragments(container)[1]!.kind).toBe('state');
            expect(kernel.getViewOwnedViewInstances().map(view => view.viewType).sort()).toEqual(['FileDetail', 'Guide']);
            expect(container.querySelector('[view]')).toBeNull();
        } finally {
            await act(async () => kernel.onClose());
        }
        expect(kernel.getViewOwnedViewInstances()).toEqual([]);
    });
});
