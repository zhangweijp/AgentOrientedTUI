/** Transform committed DOM content to a View body; metadata is projected separately. */
import { transformHtml, type InlineMode } from './visitors/html.visitor.js';
import { transformTable } from './visitors/table.visitor.js';

export function transformElement(element: Element, invalidTable = (message: string): never => { throw new Error(message); }): string {
    let tableNumber = 0;
    const table = (node: Element, renderCell: (cell: Element) => string) =>
        transformTable(node, renderCell, ++tableNumber, invalidTable);

    function traverse(el: Element, mode?: InlineMode): string {
        if (!el.hasAttribute('data-aotui-view')) return transformHtml(el, traverse, table, mode);
        let body = '';
        let previousElement = false;
        for (const child of Array.from(el.childNodes)) {
            if (child.nodeType === 3) {
                const data = (child as Text).data;
                body += data;
                if (/\S|[\r\n]/.test(data)) previousElement = false;
            } else if (child.nodeType === 1) {
                const content = traverse(child as Element);
                if (!content) continue;
                if (previousElement) body += '\n';
                body += content;
                previousElement = true;
            }
        }
        return body;
    }
    return traverse(element);
}
