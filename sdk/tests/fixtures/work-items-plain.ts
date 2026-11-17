import { arrayRef, createApp, createView, formatRef, ref, type ToolResult } from '@aotui/sdk/app';
import { ItemType, WorkspaceType, initialState, itemRefOptions, label, listRefOptions, otherViewId, selectedViewId,
    workViewTypes, workspaceText, type State, type WorkItemOptions } from './work-items.js';

export function workItemsApp(app_name: string, options: WorkItemOptions = {}) {
    return createApp({
        app_name,
        viewTypes: workViewTypes,
        initialize({ prepareProjection, signal, registerCleanup }) {
            let state = initialState();
            registerCleanup({ stop: () => options.onStop?.(), close: () => options.onClose?.() });
            const change = (update: (value: State) => State): ToolResult | void => {
                if (signal.aborted) return;
                state = update(state);
                try { prepareCurrentProjection(); }
                catch (error) {
                    options.onPublicationError?.(error);
                    return { success: true, data: { message: 'Change applied. View refresh failed.' } };
                }
            };
            const workspace = createView(WorkspaceType, {
                id: 'workspace', kind: 'state', render: () => ({ body: workspaceText(state), context: { change, options } }),
            });
            const other = createView(ItemType, {
                id: otherViewId, kind: 'state', render: () => {
                    const selected = ref('selected', false, itemRefOptions);
                    return { body: formatRef('Other item', selected), refs: [selected], context: { change } };
                },
            });
            const selected = createView(ItemType, {
                id: selectedViewId, kind: 'state', render: () => {
                    const selectedRef = ref('selected', state.value, itemRefOptions);
                    const items = arrayRef('items', state.items, listRefOptions);
                    return {
                        body: [formatRef(label, selectedRef), formatRef('All items', items),
                            ...state.items.map((_, index) => formatRef(`Item ${index + 1}`, items, index))].join('\n'),
                        refs: [selectedRef, items],
                        context: { change },
                    };
                },
            });
            function prepareCurrentProjection() {
                return prepareProjection({ views: state.open ? [workspace, other, selected] : [workspace, other] });
            }
            prepareCurrentProjection();
        },
    });
}

export default workItemsApp('work_items');
