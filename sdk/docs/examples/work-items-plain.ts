import { arrayRef, createApp, createView, formatRef, ref, type ToolResult } from '@aotui/sdk/app';
import { ItemType, WorkspaceType, initialState, itemValue, label, otherViewId, selectedViewId, workViewTypes, workspaceText, type State, type WorkItemOptions } from './work-items.js';

export function workItemsApp(app_name: string, options: WorkItemOptions = {}) {
    return createApp({
        app_name,
        viewTypes: workViewTypes,
        initialize({ publish, signal, registerCleanup }) {
            let state = initialState();
            registerCleanup({ stop: () => options.onStop?.(), close: () => options.onClose?.() });
            const change = (update: (value: State) => State): ToolResult | void => {
                if (signal.aborted) return;
                state = update(state);
                try { publishState(); }
                catch (error) {
                    options.onPublicationError?.(error);
                    return { success: true, data: { message: 'Change applied. View refresh failed.' } };
                }
            };
            const workspace = createView(WorkspaceType, {
                id: 'workspace', kind: 'state', render: () => ({ body: workspaceText(state), context: { change, options } }),
            });
            const other = createView(ItemType, {
                id: otherViewId, kind: 'state', render: () => ({
                    body: formatRef('Other item', 'selected', 'Data'),
                    refs: [ref('selected', false, { refType: 'Data', schema: itemValue })],
                    context: { change },
                }),
            });
            const selected = createView(ItemType, {
                id: selectedViewId, kind: 'state', render: () => ({
                    body: [formatRef(label, 'selected', 'Data'), formatRef('All items', 'items', 'Data[]'),
                        ...state.items.map((_, index) => formatRef(`Item ${index + 1}`, `items[${index}]`, 'Data'))].join('\n'),
                    refs: [ref('selected', state.value, { refType: 'Data', schema: itemValue }), arrayRef('items', state.items, { itemType: 'Data' })],
                    context: { change },
                }),
            });
            function publishState() {
                return publish({ views: state.open ? [workspace, other, selected] : [workspace, other] });
            }
            publishState();
        },
    });
}

export default workItemsApp('work_items');
