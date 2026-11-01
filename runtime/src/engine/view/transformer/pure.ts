/**
 * Pure Function Transformer
 * 
 * Refactored to use Visitor Pattern (RFC-005).
 * Stateless, thread-safe, and extensible.
 * 
 * @module @aotui/runtime/engine/transformer/pure
 */

import type { TransformResult, TransformContext } from './types.js';
import { createTransformContext } from './types.js';
import { isElement, isText, DOMNode } from './helpers.js';
import { DEFAULT_VISITORS } from './visitors/index.js';
import { IElementVisitor } from './visitors/interface.js';

// ============================================================================
// Public Pure Functions
// ============================================================================

/**
 * Transform a single Element to TUI Markup
 */
export function transformElement(element: Element, _appId?: string): TransformResult {
    const ctx = createTransformContext();
    const markup = traverse(element, ctx);
    return { markup };
}

// ============================================================================
// Internal Implementation
// ============================================================================

/**
 * Core Traversal Function (Visitor Pattern)
 */
function traverse(
    node: DOMNode,
    ctx: TransformContext,
    visitors: IElementVisitor[] = DEFAULT_VISITORS
): string {
    // 1. Text Nodes
    if (isText(node)) {
        return node.data.trim();
    }

    // 2. Element Check
    if (!isElement(node)) return '';

    const el = node;

    // 3. Global Checks
    const state = el.getAttribute('data-state');
    if (state === 'hidden') return '';

    // 4. Find Matching Visitor
    // Visitors are strict priority ordered. The first match wins.
    const visitor = visitors.find(v => v.matches(el, ctx));

    if (visitor) {
        // Log visitor usage for debug?
        // console.log(`[Visitor] ${visitor.name} matched ${el.tagName}`);

        // [RFC-FIX] Provide both ChildrenTraverser and ElementTraverser to visitors
        // - ChildrenTraverser: traverse child nodes (existing behavior)
        // - ElementTraverser: traverse a single element with full Visitor Chain
        const childrenTraverser = (el: Element, ctx: TransformContext) => traverseChildren(el, ctx, visitors);
        const elementTraverser = (el: Element, ctx: TransformContext) => traverse(el, ctx, visitors);

        return visitor.transform(el, ctx, childrenTraverser, elementTraverser);
    }

    // 5. Fallback (Should be handled by HtmlVisitor if configured correctly, but as safety)
    return traverseChildren(el, ctx, visitors).join(' ');
}

/**
 * Child Traverser Helper
 */
function traverseChildren(
    el: Element,
    ctx: TransformContext,
    visitors: IElementVisitor[] = DEFAULT_VISITORS
): string[] {
    const results: string[] = [];
    for (const child of Array.from(el.childNodes)) {
        const text = traverse(child, ctx, visitors);
        if (text) results.push(text);
    }
    return results;
}
