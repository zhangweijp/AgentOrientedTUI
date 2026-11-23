/**
 * Converts standard HTML tags to Markdown after the View-root check.
 */

export type InlineMode = 'inline' | 'cell';
type ElementTraverser = (el: Element, mode?: InlineMode) => string;
const block = /^(article|aside|blockquote|div|dl|figcaption|figure|footer|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|ul)$/i;

const escapeCellPunctuation = (char: string) => char === '&' ? '&amp;' : '\\' + char;
// Escape literal text that could introduce inline markup or a GFM autolink.
const escapeCellText = (text: string) => text.replace(/[&\\|`*_~\[\]<>!.@:]/g, escapeCellPunctuation);

/** JSX can split a sentence across Text nodes. The node data carries its word boundaries. */
function renderChild(node: Node, traverse: ElementTraverser, mode?: InlineMode): string {
    if (node.nodeType === 3) {
        const text = (node as Text).data;
        return mode === 'cell' ? escapeCellText(text) : text;
    }
    return node.nodeType === 1 ? traverse(node as Element, mode) : '';
}

function renderChildren(el: Element, traverse: ElementTraverser, mode?: InlineMode): string {
    if (mode) return Array.from(el.childNodes, child => renderChild(child, traverse, mode)).join('');
    let body = '';
    let afterBlock = false;
    for (const child of Array.from(el.childNodes)) {
        const content = renderChild(child, traverse);
        if (!content) continue;
        const isBlock = child.nodeType === 1 && block.test((child as Element).tagName);
        if ((isBlock || afterBlock) && body && !body.endsWith('\n') && !content.startsWith('\n')) body += '\n';
        body += content;
        afterBlock = isBlock;
    }
    return body;
}

/** Keep authored separators outside Markdown delimiters. */
function wrapInline(text: string, open: string, close: string): string {
    const content = text.trim();
    if (!content) return text;
    const start = text.length - text.trimStart().length;
    return text.slice(0, start) + open + content + close + text.slice(start + content.length);
}

/**
 * Render nested list items recursively to preserve their Markdown markup.
 */
function transformNestedList(
    list: Element,
    traverse: ElementTraverser
): string[] {
    const items: string[] = [];
    const isOrdered = list.tagName.toLowerCase() === 'ol';
    const children = list.children;

    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.tagName.toLowerCase() === 'li') {
            const prefix = isOrdered ? `${i + 1}. ` : '- ';
            const content = traverse(child);
            items.push(prefix + content.trim());
        }
    }

    return items;
}

/**
 * Indent nested lists while preserving the markup of each item.
 */
function transformListItem(
    li: Element,
    prefix: string,
    traverse: ElementTraverser
): string {
    const parts: string[] = [];
    let mainContent = '';

    const childNodes = li.childNodes;
    for (let i = 0; i < childNodes.length; i++) {
        const node = childNodes[i];
        if (node.nodeType === 1) {
            const el = node as Element;
            const tagName = el.tagName.toLowerCase();
            if (tagName === 'ul' || tagName === 'ol') {
                parts.push(...transformNestedList(el, traverse));
                continue;
            }
        }
        mainContent += renderChild(node, traverse, 'inline');
    }

    // Build result: main content with prefix, then nested items indented
    let result = prefix + mainContent.trim();
    if (parts.length > 0) {
        result += '\n' + parts.map(p => '    ' + p).join('\n');
    }

    return result;
}

export function transformHtml(
    el: Element,
    traverseElement: ElementTraverser,
    table: (node: Element, renderCell: (cell: Element) => string) => string,
    mode?: InlineMode,
): string {
    const tagName = el.tagName.toLowerCase();

    // Skip specialized internal tags
    if (tagName === 'param') return '';

    // Handle line breaks
    if (tagName === 'br') return '\n';
    if (tagName === 'table') return table(el, cell => renderChildren(cell, traverseElement, 'cell'));
    const inline = () => renderChildren(el, traverseElement, mode ?? 'inline');
    if (tagName === 'li') return inline().trim();

    if (/^h[1-6]$/.test(tagName)) {
        const level = '#'.repeat(parseInt(tagName[1]));
        return `\n${level} ${inline().trim()}\n`;
    }

    if (tagName === 'p') {
        const content = inline().trim();
        return content ? `\n${content}\n` : '';
    }

    const strong = tagName === 'strong' || tagName === 'b';
    if (strong || tagName === 'em' || tagName === 'i') {
        const mark = strong ? '**' : '*';
        return wrapInline(inline(), mark, mark);
    }

    if (tagName === 'code' && el.parentElement?.tagName.toLowerCase() !== 'pre') {
        const code = el.textContent || '';
        if (mode === 'cell' && /\\\|/.test(code)) {
            // Backtick spans do not consume the backslash pairs left by the table lexer.
            const literal = code.replace(/[!-/:-@[-`{-~]/g, char => `&#${char.charCodeAt(0)};`);
            return `<code>${literal}</code>`;
        }
        let length = 1;
        for (const match of code.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
        const fence = '`'.repeat(length);
        const pad = code.startsWith('`') || code.endsWith('`') ||
            (code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0) ? ' ' : '';
        const content = mode === 'cell' ? code.replace(/\|/g, '\\|') : code;
        return `${fence}${pad}${content}${pad}${fence}`;
    }

    if (tagName === 'pre') {
        const codeEl = el.querySelector('code');
        const lang = codeEl?.getAttribute('class')?.replace('language-', '') || '';
        const codeContent = codeEl ? (codeEl.textContent || '') : (el.textContent || '');
        let fenceLength = 3;
        for (const match of codeContent.matchAll(/`+/g)) {
            fenceLength = Math.max(fenceLength, match[0].length + 1);
        }
        const fence = '`'.repeat(fenceLength);
        const separator = codeContent.endsWith('\n') ? '' : '\n';
        return `\n${fence}${lang}\n${codeContent}${separator}${fence}\n`;
    }

    if (tagName === 'a') {
        const href = el.getAttribute('href') || '';
        const target = mode === 'cell' ? `<${href.replace(/[&\\|<>]/g, escapeCellPunctuation)}>` : href;
        const close = `](${target})`;
        const label = inline();
        return label.trim() ? wrapInline(label, '[', close) : `[${mode === 'cell' ? escapeCellText(href) : href}${close}`;
    }

    if (tagName === 'blockquote') {
        const quoted = renderChildren(el, traverseElement).trim()
            .split('\n')
            .map(line => `> ${line}`)
            .join('\n');
        return `\n${quoted}\n`;
    }

    if (tagName === 'hr') {
        return '\n---\n';
    }

    // Handle lists (ul, ol)
    if (tagName === 'ul' || tagName === 'ol') {
        const items: string[] = [];
        const listChildren = el.children;

        let liIndex = 0;
        for (let i = 0; i < listChildren.length; i++) {
            const child = listChildren[i];
            const childTag = child.tagName.toLowerCase();

            if (childTag === 'li') {
                // Standard list item
                const prefix = tagName === 'ol' ? `${++liIndex}. ` : '- ';
                const liContent = transformListItem(child, prefix, traverseElement);
                items.push(liContent);
            } else {
                // Use ElementTraverser for non-list children.
                const childOutput = traverseElement(child);
                if (childOutput.trim()) {
                    items.push(childOutput.trim());
                }
            }
        }

        return '\n' + items.join('\n') + '\n';
    }

    return renderChildren(el, traverseElement, mode);
}
