/**
 * Application Visitor
 * 
 * Handles <application> tags or elements with data-app-id.
 * Responsible for maintaining currentAppId context.
 */

import type { IElementVisitor, ChildrenTraverser } from './interface.js';
import type { TransformContext } from '../types.js';

export const applicationVisitor: IElementVisitor = {
    name: 'application',
    priority: 10,

    matches(el: Element, ctx: Readonly<TransformContext>): boolean {
        // [Refactor] Corresponds to: if (appId)
        return el.hasAttribute('data-app-id');
    },

    transform(
        el: Element,
        ctx: TransformContext,
        children: ChildrenTraverser
    ): string {
        const appId = el.getAttribute('data-app-id')!;
        const appName = el.getAttribute('name');

        const isCollapsed = el.getAttribute('data-state') === 'collapsed';
        const isClosed = el.getAttribute('data-state') === 'closed';

        if (isCollapsed || isClosed) {
            return `\n<application id="${appId}" name="${appName || ''}" state="${isClosed ? 'closed' : 'collapsed'}" />\n`;
        }

        // Recursively process children
        const childMarkup = children(el, ctx);
        const childrenContent = childMarkup.join('\n');

        return `\n<application id="${appId}" name="${appName || ''}">\n${childrenContent}\n</application>\n`;
    }
};
