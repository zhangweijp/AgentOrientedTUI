import { MARKDOWN_VIEW_FORMAT, type ViewSnapshotV2 } from '../core/snapshot/types.js';
import type { WorkerRuntimeViewFragment } from './view-fragment-extractor.js';
import type { ViewInstance } from '../core/tool/view-owned-tools.js';

/** Capture only the View body and validate its binding to real mounted identities. */
export function captureDOMViews(
    container: Element, fragments: readonly WorkerRuntimeViewFragment[], registeredViews: readonly ViewInstance[],
): ViewSnapshotV2[] {
    const byId = new Map(registeredViews.map(view => [view.viewId, view]));
    if (byId.size !== registeredViews.length) throw new Error('Duplicate Runtime View ID');

    const domNodes = new Map<string, Element>();
    for (const node of Array.from(container.querySelectorAll('[data-view-id]'))) {
        const id = node.getAttribute('data-view-id');
        if (!id || domNodes.has(id)) throw new Error('Duplicate or missing DOM View identity');
        domNodes.set(id, node);
    }
    if (registeredViews.length !== fragments.length || domNodes.size !== registeredViews.length ||
        new Set(fragments.map(fragment => fragment.viewId)).size !== registeredViews.length) {
        throw new Error('Runtime View and DOM projection are not a complete set');
    }
    return fragments.map(fragment => {
        const view = byId.get(fragment.viewId);
        const node = domNodes.get(fragment.viewId);
        if (!view || !node ||
            node.getAttribute('data-view-instance-id') !== view.viewInstanceId ||
            view.viewType !== fragment.viewType) {
            throw new Error('V3 View identity is not bound to the mounted Runtime View');
        }
        return {
            id: fragment.viewId,
            viewInstanceId: view.viewInstanceId,
            type: fragment.viewType,
            name: fragment.viewName || fragment.viewId,
            kind: fragment.kind,
            content: { format: MARKDOWN_VIEW_FORMAT, value: fragment.markup },
        };
    });

}
