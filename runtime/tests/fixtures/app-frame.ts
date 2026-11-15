import { viewToolReceiver } from '../../src/core/tool/source-binding.js';
import type { AppProjectionFrame } from '../../src/spi/app/app-instance.interface.js';
import type { AppKernel } from '../../src/worker-runtime/app-kernel/AppKernel.js';

type TestView = AppProjectionFrame['views'][number];

export function detailFrame(fields: Partial<TestView> = {}): TestView {
    return {
        id: 'v', type: 'Detail', name: 'Detail', kind: 'state', owner: {}, bindings: [], refs: [],
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
