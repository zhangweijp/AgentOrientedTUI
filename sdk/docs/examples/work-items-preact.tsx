import { useState } from 'preact/hooks';
import { createTUIApp, useAppLifecycle, useArrayRef, useDataRef, View } from '@aotui/sdk';
import type { JsonValue } from '@aotui/sdk/app';
import { ItemType, WorkspaceType, initialState, itemValue, label, otherViewId, selectedViewId, workViewTypes, workspaceText, type WorkItemOptions } from './work-items.js';

function Item({ value, items }: { readonly value: JsonValue; readonly items?: readonly JsonValue[] }) {
    const selected = useDataRef('selected', value, { refType: 'Data', schema: itemValue });
    return <div>
        <p>{selected(items === undefined ? 'Other item' : label)}</p>
        {items === undefined ? null : <Items values={items} />}
    </div>;
}

function Items({ values }: { readonly values: readonly JsonValue[] }) {
    const [list, element] = useArrayRef('items', values, { itemType: 'Data' });
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
            <View id="workspace" type={WorkspaceType} context={{ change: setState, options }} kind="state"><p>{workspaceText(state)}</p></View>
            <View id={otherViewId} type={ItemType} context={{ change: setState }} kind="state"><Item value={false} /></View>
            {state.open && <View id={selectedViewId} type={ItemType} context={{ change: setState }} kind="state"><Item value={state.value} items={state.items} /></View>}
        </>;
    }
    return createTUIApp({ app_name, component: WorkItems, viewTypes: workViewTypes });
}

export default workItemsApp('work_items');
