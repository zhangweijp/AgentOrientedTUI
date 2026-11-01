import { transformElement } from '../engine/view/transformer/pure.js';
import type { ViewID } from '../spi/index.js';

export type ViewFragmentKind = 'application-instruction' | 'view-state';

export interface WorkerRuntimeViewFragment {
    viewId: ViewID;
    viewType: string;
    viewName?: string;
    markup: string;
    kind: ViewFragmentKind;
}

function classifyViewFragment(node: Element): ViewFragmentKind {
    if (
        node.getAttribute('data-role') === 'application-instruction' ||
        node.querySelector('[data-role="application-instruction"]')
    ) {
        return 'application-instruction';
    }

    return 'view-state';
}

function viewIdentity(node: Element): string {
    const identity = node.getAttribute('data-view-id') || node.getAttribute('id') || '<unknown>';
    if (identity.length <= 26) return identity;
    const prefix = identity.slice(0, 25).replace(/[\uD800-\uDBFF]$/, '');
    return `${prefix}…`;
}

function assertNoNestedViews(container: Element, viewNodes: readonly Element[]): void {
    for (const node of viewNodes) {
        const parent = node.parentElement?.closest('[data-view-id]');
        if (parent && container.contains(parent)) {
            throw Object.assign(new Error(
                `NESTED_VIEW_UNSUPPORTED: View "${viewIdentity(node)}" is nested inside View "${viewIdentity(parent)}". Declare independent Views.`,
            ), { code: 'NESTED_VIEW_UNSUPPORTED' });
        }
    }
}

export function extractViewFragments(container: Element): WorkerRuntimeViewFragment[] {
    const viewNodes = Array.from(container.querySelectorAll('[data-view-id]')) as Element[];
    assertNoNestedViews(container, viewNodes);

    const result: WorkerRuntimeViewFragment[] = [];
    for (const node of viewNodes) {
        const rawViewId = node.getAttribute('data-view-id') || node.getAttribute('id');
        if (!rawViewId) continue;

        const viewType = node.getAttribute('data-view-type') || rawViewId;
        const viewName = node.getAttribute('data-view-name') || undefined;
        const kind = classifyViewFragment(node);
        const markup = transformElement(node).markup.trim();
        if (!markup) continue;

        result.push({ viewId: rawViewId as ViewID, viewType, viewName, markup, kind });
    }

    return result;
}
