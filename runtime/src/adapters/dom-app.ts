import { parseHTML } from 'linkedom';
import type { ViewInstance } from '../core/tool/view-owned-tools.js';
import { captureDOMViews } from '../worker-runtime/dom-snapshot-producer.js';
import { extractViewFragments } from '../worker-runtime/view-fragment-extractor.js';

/** The Preact adapter alone initializes a document in its Worker. */
export function createDOMAppRoot(appId: string): HTMLElement {
    if (typeof globalThis.document === 'undefined') {
        const { window, document } = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
        Object.assign(globalThis, { document, window, MutationObserver: window.MutationObserver });
    }
    const root = document.createElement('div');
    root.id = `app-root-${appId}`;
    root.setAttribute('data-app-root', '');
    document.body.appendChild(root);
    return root;
}

export function readDOMAppViews(root: Element, mounted: readonly ViewInstance[]) {
    return captureDOMViews(root, extractViewFragments(root), mounted);
}

export function dispatchDOMAppEvent(root: Element, type: string, detail: unknown): void {
    const CustomEvent = root.ownerDocument.defaultView?.CustomEvent;
    if (CustomEvent) root.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
}
