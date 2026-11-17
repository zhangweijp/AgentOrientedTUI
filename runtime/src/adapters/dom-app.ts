import { parseHTML } from 'linkedom';
import type { AppFrameView } from '../core/projection/coordinator.js';
import { MARKDOWN_VIEW_FORMAT } from '../core/snapshot/types.js';
import { transformElement } from '../engine/view/transformer/pure.js';

type DOMAttachment = Pick<AppFrameView, 'id' | 'type' | 'owner' | 'bindings' | 'refs'>;
const selector = '[data-view-id], [data-view-type], [data-view-kind], [data-view-name]';

function viewIdentity(node: Element): string {
    const id = node.getAttribute('data-view-id') || '<unknown>';
    if (id.length <= 26) return id;
    return id.slice(0, 25).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

/** The Preact adapter alone initializes a document in its Worker. */
export function createDOMAppRoot(appId: string): HTMLElement {
    if (typeof globalThis.document === 'undefined') {
        const { window, document } = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
        Object.assign(globalThis, { document, window });
    }
    const root = document.createElement('div');
    root.id = `app-root-${appId}`;
    root.setAttribute('data-app-root', '');
    document.body.appendChild(root);
    return root;
}

export function readDOMAppViews(root: Element, attachment: (node: Element) => DOMAttachment | undefined): AppFrameView[] {
    const ids = new Set<string>();
    const views: AppFrameView[] = [];
    for (const node of root.querySelectorAll(selector)) {
        const parent = node.parentElement?.closest(selector);
        if (parent && parent !== root && root.contains(parent)) {
            const code = 'NESTED_VIEW_UNSUPPORTED';
            throw Object.assign(new Error(
                `${code}: View "${viewIdentity(node)}" is nested inside View "${viewIdentity(parent)}". Declare independent Views.`,
            ), { code });
        }
        const id = node.getAttribute('data-view-id');
        if (!id?.trim() || ids.has(id)) throw new Error('Duplicate or missing DOM View identity');
        ids.add(id);
        const type = node.getAttribute('data-view-type');
        const kind = node.getAttribute('data-view-kind');
        if (!type?.trim() || (kind !== 'instruction' && kind !== 'state')) {
            const code = 'VIEW_METADATA_INVALID';
            throw Object.assign(new Error(
                `${code}: View "${viewIdentity(node)}" requires explicit data-view-type and data-view-kind="instruction" or "state".`,
            ), { code });
        }
        const current = attachment(node);
        if (!current || current.id !== id || current.type !== type)
            throw new Error('DOM projection does not match the attached View owner');
        views.push({
            id, type, kind, name: node.getAttribute('data-view-name') || id,
            owner: current.owner, bindings: current.bindings, refs: current.refs,
            content: { format: MARKDOWN_VIEW_FORMAT, value: transformElement(node) },
        });
    }
    return views;
}

export function dispatchDOMAppEvent(root: Element, type: string, detail: unknown): void {
    const CustomEvent = root.ownerDocument.defaultView?.CustomEvent;
    if (CustomEvent) root.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
}
