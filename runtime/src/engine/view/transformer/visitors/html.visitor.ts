/**
 * HTML Visitor (Fallback)
 * 
 * Handles generic HTML elements not matched by other visitors.
 * Converts standard HTML tags to Markdown.
 */

import type { IElementVisitor, ChildrenTraverser, ElementTraverser } from './interface.js';
import type { TransformContext } from '../types.js';

// ============ List Helper Functions ============

/**
 * Single element traverser type (for recursive calls)
 * 
 * This enables nested HTML elements inside list items to use the same rendering rules.
 * 
 * @deprecated Use ElementTraverser from interface.ts instead
 */
type SingleElementTraverser = (el: Element, ctx: TransformContext) => string;

/**
 * Transform nested list with proper prefixes using recursive Visitor calls
 * 
 * [RFC-FIX] Use traverse instead of textContent to preserve semantic information
 */
function transformNestedList(
    list: Element,
    ctx: TransformContext,
    traverse: SingleElementTraverser
): string[] {
    const items: string[] = [];
    const isOrdered = list.tagName.toLowerCase() === 'ol';
    const children = list.children;

    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.tagName.toLowerCase() === 'li') {
            const prefix = isOrdered ? `${i + 1}. ` : '- ';
            // [FIX] Use recursive traversal instead of textContent
            const content = traverse(child, ctx);
            items.push(prefix + content.trim());
        }
    }

    return items;
}

/**
 * Transform list item with proper indentation for nested lists
 * 
 * [RFC-FIX] Use recursive Visitor Pattern for all child elements,
 * ensuring nested markup inside <li> keeps its normal HTML presentation.
 */
function transformListItem(
    li: Element,
    prefix: string,
    ctx: TransformContext,
    traverse: SingleElementTraverser
): string {
    const parts: string[] = [];
    let mainContent = '';

    // Process children of li
    const childNodes = li.childNodes;
    for (let i = 0; i < childNodes.length; i++) {
        const node = childNodes[i];

        if (node.nodeType === 3) { // Text node
            mainContent += (node as Text).textContent?.trim() || '';
        } else if (node.nodeType === 1) { // Element node
            const el = node as Element;
            const tagName = el.tagName.toLowerCase();

            if (tagName === 'ul' || tagName === 'ol') {
                // Nested list - process with indentation using recursive traversal
                const nestedItems = transformNestedList(el, ctx, traverse);
                parts.push(...nestedItems);
            } else {
                // Use recursive traversal for all nested elements.
                const childOutput = traverse(el, ctx);
                mainContent += childOutput;
            }
        }
    }

    // Build result: main content with prefix, then nested items indented
    let result = prefix + mainContent.trim();
    if (parts.length > 0) {
        result += '\n' + parts.map(p => '    ' + p).join('\n');
    }

    return result;
}

// ============ HTML Visitor ============

export const htmlVisitor: IElementVisitor = {
    name: 'html-fallback',
    priority: 100, // Lowest priority

    matches(el: Element, ctx: Readonly<TransformContext>): boolean {
        return true;
    },

    transform(
        el: Element,
        ctx: TransformContext,
        children: ChildrenTraverser,
        traverseElement?: ElementTraverser
    ): string {
        const tagName = el.tagName.toLowerCase();

        // Skip specialized internal tags
        if (tagName === 'param') return '';

        // Handle line breaks
        if (tagName === 'br') return '\n';

        const childTexts = children(el, ctx);

        // G. Handle standard HTML elements integration from pure.ts
        if (/^h[1-6]$/.test(tagName)) {
            const level = '#'.repeat(parseInt(tagName[1]));
            return `\n${level} ${childTexts.join(' ')}\n`;
        }

        if (tagName === 'p') {
            const content = childTexts.join(' ').trim();
            return content ? `\n${content}\n` : '';
        }

        if (tagName === 'strong' || tagName === 'b') {
            return `**${childTexts.join(' ')}**`;
        }

        if (tagName === 'em' || tagName === 'i') {
            return `*${childTexts.join(' ')}*`;
        }

        if (tagName === 'code' && el.parentElement?.tagName.toLowerCase() !== 'pre') {
            return `\`${childTexts.join('')}\``;
        }

        if (tagName === 'pre') {
            const codeEl = el.querySelector('code');
            const lang = codeEl?.getAttribute('class')?.replace('language-', '') || '';
            const codeContent = codeEl ? (codeEl.textContent || '') : childTexts.join('\n');
            return `\n\`\`\`${lang}\n${codeContent.trim()}\n\`\`\`\n`;
        }

        if (tagName === 'a') {
            const href = el.getAttribute('href') || '';
            const text = childTexts.join(' ').trim() || href;
            return `[${text}](${href})`;
        }

        if (tagName === 'blockquote') {
            const quoted = childTexts.join(' ').trim()
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

            // Use ElementTraverser for nested list elements.
            const singleTraverse: SingleElementTraverser = traverseElement
                ? traverseElement
                : (childEl, childCtx) => children(childEl, childCtx).join(' '); // Fallback

            let liIndex = 0;
            for (let i = 0; i < listChildren.length; i++) {
                const child = listChildren[i];
                const childTag = child.tagName.toLowerCase();

                if (childTag === 'li') {
                    // Standard list item
                    const prefix = tagName === 'ol' ? `${++liIndex}. ` : '- ';
                    const liContent = transformListItem(child, prefix, ctx, singleTraverse);
                    items.push(liContent);
                } else {
                    // Use ElementTraverser for non-list children.
                    const childOutput = singleTraverse(child, ctx);
                    if (childOutput.trim()) {
                        items.push(childOutput.trim());
                    }
                }
            }

            return '\n' + items.join('\n') + '\n';
        }

        // Handle orphan li (shouldn't happen normally)
        if (tagName === 'li') {
            return childTexts.join(' ');
        }

        // Default: Join children
        return childTexts.join(' ');
    }
};
