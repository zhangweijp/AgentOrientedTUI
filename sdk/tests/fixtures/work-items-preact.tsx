import { useState } from 'preact/hooks';
import { createTUIApp, useAppLifecycle, useArrayRef, useDataRef, DynamicView } from '@aotui/sdk';
import { ItemType, WorkspaceType, initialState, itemRefOptions, label, listRefOptions, otherViewId, selectedViewId,
    workViewTypes, workspaceText, type State, type WorkItemOptions } from './work-items.js';

function Item({ value, items }: { readonly value: State['value']; readonly items?: State['items'] }) {
    const selected = useDataRef('selected', value, itemRefOptions);
    return <div>
        <p>{selected(items === undefined ? 'Other item' : label)}</p>
        {items === undefined ? null : <Items values={items} />}
    </div>;
}

function Items({ values }: { readonly values: State['items'] }) {
    const [list, element] = useArrayRef('items', values, listRefOptions);
    return <>
        <p>{list('All items')}</p>
        {values.map((_, index) => <p key={index}>{element(index, `Item ${index + 1}`)}</p>)}
    </>;
}

export function workItemsApp(app_name: string, options: WorkItemOptions = {}) {
    function WorkItems() {
        const [state, setState] = useState(initialState);
        useAppLifecycle({ stop: () => options.onStop?.(), close: () => options.onClose?.() });
        return <>
            <DynamicView idPrefix="workspace" type={WorkspaceType} context={{ change: setState, options }} ><p>{workspaceText(state)}</p></DynamicView>
            <DynamicView idPrefix={otherViewId} type={ItemType} context={{ change: setState }} ><Item value={false} /></DynamicView>
            {state.open && <DynamicView idPrefix={selectedViewId} type={ItemType} context={{ change: setState }} ><Item value={state.value} items={state.items} /></DynamicView>}
        </>;
    }
    return createTUIApp({ app_name, component: WorkItems, viewTypes: workViewTypes });
}

export default workItemsApp('work_items');
