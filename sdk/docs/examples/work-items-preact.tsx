import { useState } from 'preact/hooks';
import { AppTools, createTUIApp, useAppLifecycle, useArrayRef, useDataRef, View, type JsonSchemaValue } from '@aotui/sdk';
import { bindings, initialState, itemValue, label, tools, workspaceText, type WorkItemOptions } from './work-items.js';

function Item({ value, items }: { readonly value: JsonSchemaValue; readonly items?: readonly JsonSchemaValue[] }) {
    const selected = useDataRef('selected', value, { refType: 'Data', schema: itemValue });
    return <div>
        <p>{selected(items === undefined ? 'Other item' : label)}</p>
        {items === undefined ? null : <Items values={items} />}
    </div>;
}

function Items({ values }: { readonly values: readonly JsonSchemaValue[] }) {
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
        return <AppTools definition={tools} bindings={bindings(setState, options)}>
            <View id="workspace" type="Workspace" kind="state"><p>{workspaceText(state)}</p></View>
            <View id="item_b" type="Item" kind="state"><Item value={false} /></View>
            {state.open && <View id="item_a" type="Item" kind="state"><Item value={state.value} items={state.items} /></View>}
        </AppTools>;
    }
    return createTUIApp({ app_name, component: WorkItems });
}

export default workItemsApp('work_items');
