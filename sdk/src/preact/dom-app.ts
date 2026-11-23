import { parseHTML } from 'linkedom';
import { MARKDOWN_VIEW_FORMAT, SnapshotDataError, type AppFrameView } from '@aotui/core';
import { transformElement } from './transformer/pure.js';

type DOMAttachment = Omit<AppFrameView, 'content'>;
const selector = '[data-aotui-view]';

function shortIdentity(id: string): string {
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

export function readDOMAppViews(root: Element, attachment: (node: Element) => DOMAttachment | undefined,
    attachedCount?: number): AppFrameView[] {
    const nodes = [...root.querySelectorAll(selector)];
    for (const node of nodes) {
        const parent = node.parentElement?.closest(selector);
        if (parent && parent !== root && root.contains(parent)) {
            const code = 'NESTED_VIEW_UNSUPPORTED';
            throw Object.assign(new Error(
                `${code}: View "${shortIdentity(node.getAttribute('data-aotui-view') || '<unknown>')}" is nested inside View ` +
                `"${shortIdentity(parent.getAttribute('data-aotui-view') || '<unknown>')}". Declare independent Views.`,
            ), { code });
        }
    }
    if (attachedCount !== undefined && nodes.length !== attachedCount)
        throw new Error('DOM projection does not contain the complete attached View set');
    return nodes.map((node, index) => {
        const current = attachment(node);
        if (!current || current.type !== node.getAttribute('data-aotui-view'))
            throw new Error('DOM projection does not match the attached View owner');
        const value = transformElement(node, message => {
            const view = shortIdentity(current.id ?? current.idPrefix ?? current.type);
            throw new SnapshotDataError('SNAPSHOT_INVALID', `$.views[${index}].content`,
                `View "${view}", ${message}. Use a simple table or list.`);
        });
        return { ...current, content: { format: MARKDOWN_VIEW_FORMAT, value } };
    });
}
