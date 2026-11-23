import { strict as assert } from 'node:assert';
import type { AppKernel } from '../../../runtime/src/worker-runtime/app-kernel/AppKernel.js';

export function preparedRefs(kernel: AppKernel) {
    const refs = kernel.getProjectionCoordinator()['prepared']?.refs;
    return Object.values(refs ?? {}).map(ref => ({
        viewId: ref.ownerViewId,
        refId: ref.id,
        value: ref.target.payload,
        ...(ref.refType === 'unknown' ? {} : { refType: ref.refType }),
    }));
}

export function mountedViews(kernel: AppKernel) {
    const registry = kernel['viewOwnedTools'];
    const prepared = kernel.getProjectionCoordinator()['prepared']?.views ?? [];
    const views = prepared.flatMap(({ id }) => {
        const view = registry.getView(id);
        return view ? [view] : [];
    });
    assert.equal(views.length, registry.inspect().views);
    return views;
}
