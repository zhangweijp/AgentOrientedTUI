import { h, type JSX } from 'preact';
import { useContext } from 'preact/hooks';
import { AppRuntimeContext } from '../context/AppRuntimeContext.js';
import { getToolCatalog, type ViewType } from '../tools/view-type-tool.js';

export interface ToolCatalogProps {
    readonly viewTypes?: readonly ViewType[];
}

/** Static names for the App's instruction page. */
export function ToolCatalog({ viewTypes }: ToolCatalogProps): JSX.Element {
    const app = useContext(AppRuntimeContext);
    if (viewTypes === undefined) {
        if (!app) throw Object.assign(new Error('ToolCatalog needs a managed App or an explicit viewTypes list.'), {
            code: 'TOOL_CATALOG_CONTEXT_REQUIRED',
        });
        viewTypes = [...app.viewTypes.values()];
    }
    const groups = new Map<string, string[]>();
    for (const { viewType, name } of getToolCatalog(viewTypes)) {
        const names = groups.get(viewType) ?? [];
        names.push(name);
        groups.set(viewType, names);
    }
    return <ul>{[...groups].map(([type, names]) =>
        <li key={type}>{type}: {names.join(', ')}</li>)}</ul>;
}
