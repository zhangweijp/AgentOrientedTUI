import { MARKDOWN_VIEW_FORMAT } from '../core/snapshot/types.js';
import type { AppFrameView } from '../spi/app/app-instance.interface.js';
import type { WorkerRuntimeViewFragment } from './view-fragment-extractor.js';

type DOMAttachment = Pick<AppFrameView, 'id' | 'type' | 'owner' | 'bindings'>;

/** Match each rendered fragment with the author bindings on its actual DOM node. */
export function captureDOMViews(
    container: Element, fragments: readonly WorkerRuntimeViewFragment[],
    attachment: (node: Element) => DOMAttachment | undefined,
): AppFrameView[] {
    const nodes = new Map<string, Element>();
    for (const node of Array.from(container.querySelectorAll('[data-view-id]'))) {
        const id = node.getAttribute('data-view-id');
        if (!id || nodes.has(id)) throw new Error('Duplicate or missing DOM View identity');
        nodes.set(id, node);
    }
    if (nodes.size !== fragments.length || new Set(fragments.map(view => view.viewId)).size !== nodes.size)
        throw new Error('DOM View projection is not a complete set');
    return fragments.map(({ viewId, viewType, viewName, kind, markup }) => {
        const node = nodes.get(viewId);
        const current = node && attachment(node);
        if (!current || current.id !== viewId || current.type !== viewType)
            throw new Error('DOM projection does not match the attached View owner');
        return {
            id: viewId, type: viewType, name: viewName || viewId, kind,
            owner: current.owner, bindings: current.bindings,
            content: { format: MARKDOWN_VIEW_FORMAT, value: markup },
        };
    });
}
