/** Transform committed DOM content to a View body; metadata is projected separately. */
import { transformHtml } from './visitors/html.visitor.js';

export function transformElement(element: Element): { markup: string } {
    return { markup: traverse(element) };
}

function traverse(node: Node): string {
    if (node.nodeType === 3) return (node as Text).data.trim();
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    if (el.getAttribute('data-state') === 'hidden') return '';
    if (el.hasAttribute('data-view-id')) return traverseChildren(el).join('\n');
    return transformHtml(el, traverseChildren, traverse);
}

function traverseChildren(el: Element): string[] {
    const results: string[] = [];
    for (const child of Array.from(el.childNodes)) {
        const text = traverse(child);
        if (text) results.push(text);
    }
    return results;
}
