/**
 * Converts standard HTML tags to Markdown after the View-root check.
 */

type ElementTraverser = (el: Element, listInline?: boolean) => string;

/** JSX can split a sentence across Text nodes. The node data carries its word boundaries. */
function renderListChild(node: Node, traverse: ElementTraverser): string {
    if (node.nodeType === 3) return (node as Text).data;
    return node.nodeType === 1 ? traverse(node as Element, true) : '';
}

function renderListChildren(el: Element, traverse: ElementTraverser): string {
    return Array.from(el.childNodes, child => renderListChild(child, traverse)).join('');
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
        mainContent += renderListChild(node, traverse);
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
    children: (el: Element) => string[],
    traverseElement: ElementTraverser,
    listInline: boolean,
): string {
    const tagName = el.tagName.toLowerCase();

    // Skip specialized internal tags
    if (tagName === 'param') return '';

    // Handle line breaks
    if (tagName === 'br') return '\n';
    if (tagName === 'li') {
        return renderListChildren(el, traverseElement).trim();
    }

    const joinedChildren = () => children(el).join(' ');

    // G. Handle standard HTML elements integration from pure.ts
    if (/^h[1-6]$/.test(tagName)) {
        const level = '#'.repeat(parseInt(tagName[1]));
        return `\n${level} ${joinedChildren()}\n`;
    }

    if (tagName === 'p') {
        const content = joinedChildren().trim();
        return content ? `\n${content}\n` : '';
    }

    const strong = tagName === 'strong' || tagName === 'b';
    if (strong || tagName === 'em' || tagName === 'i') {
        const mark = strong ? '**' : '*';
        return listInline
            ? wrapInline(renderListChildren(el, traverseElement), mark, mark)
            : mark + joinedChildren() + mark;
    }

    if (tagName === 'code' && el.parentElement?.tagName.toLowerCase() !== 'pre') {
        const code = el.textContent || '';
        let length = 1;
        for (const match of code.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
        const fence = '`'.repeat(length);
        const pad = code.startsWith('`') || code.endsWith('`') ||
            (code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0) ? ' ' : '';
        return `${fence}${pad}${code}${pad}${fence}`;
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
        const label = listInline ? renderListChildren(el, traverseElement) : joinedChildren();
        const text = label.trim();
        return listInline && text ? wrapInline(label, '[', `](${href})`) : `[${text || href}](${href})`;
    }

    if (tagName === 'blockquote') {
        const quoted = joinedChildren().trim()
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

    return listInline ? renderListChildren(el, traverseElement) : joinedChildren();
}
