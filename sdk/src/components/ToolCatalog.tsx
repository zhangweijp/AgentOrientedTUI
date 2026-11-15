import { h, type JSX } from 'preact';
import { getToolCatalog, type ViewType } from '../tools/view-type-tool.js';

export interface ToolCatalogProps {
    readonly viewTypes: readonly ViewType[];
}

/** Static names for the App's instruction page. */
export function ToolCatalog({ viewTypes }: ToolCatalogProps): JSX.Element {
    const groups = new Map<string, string[]>();
    for (const { viewType, name } of getToolCatalog(viewTypes)) {
        const names = groups.get(viewType) ?? [];
        names.push(name);
        groups.set(viewType, names);
    }
    return <ul>{[...groups].map(([type, names]) =>
        <li key={type}>{type}: {names.join(', ')}</li>)}</ul>;
}
