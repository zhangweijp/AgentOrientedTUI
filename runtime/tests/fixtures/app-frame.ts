import { viewToolReceiver } from '@aotui/core/producer';
import type { AppProjectionFrame } from '@aotui/core';
import type { AppKernel } from '../../src/worker-runtime/app-kernel/AppKernel.js';

type TestView = AppProjectionFrame['views'][number];

export function detailFrame(fields: Partial<TestView> = {}): TestView {
    return {
        idPrefix: 'v', type: 'Detail', name: 'Detail', region: 'dynamic', owner: {}, bindings: [], refs: [],
        content: { format: 'markdown-v1', value: 'Detail' }, ...fields,
    };
}

export function publishedTool(kernel: AppKernel, name: string) {
    const publication = kernel.getProjectionCoordinator().nextPublication();
    if (!('draft' in publication)) throw Error('Expected a committed App frame');
    const tool = Object.values(publication.draft.tools).find(tool => tool.name === name);
    if (!tool) throw Error('Expected Tool ' + name);
    const receiver = viewToolReceiver(publication.draft.views[0]!, tool.id);
    if (!receiver) throw Error('Expected a View-bound Tool ' + name);
    return { tool, receiver };
}
