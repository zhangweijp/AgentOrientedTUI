import { arrayRef, createApp, formatRef, ref, type PublishedView } from '@aotui/sdk/app';
import { bindings, initialState, itemValue, label, tools, workspaceText, type WorkItemOptions } from './work-items.js';

export function workItemsApp(app_name: string, options: WorkItemOptions = {}) {
    return createApp({
        app_name,
        tools,
        initialize({ publish, signal, registerCleanup }) {
            let state = initialState();
            registerCleanup({ stop: () => options.onStop?.(), close: () => options.onClose?.() });
            const execute = bindings(update => {
                if (signal.aborted) return;
                state = update(state);
                try { publishState(); }
                catch (error) {
                    if (!options.onPublicationError) throw error;
                    options.onPublicationError(error);
                }
            }, options);

            function publishState() {
                const views: PublishedView[] = [
                    { id: 'workspace', type: 'Workspace', kind: 'state', body: workspaceText(state) },
                    { id: 'item_b', type: 'Item', kind: 'state', body: formatRef('Other item', 'selected', 'Data'),
                        refs: [ref('selected', false, { refType: 'Data', schema: itemValue })] },
                ];
                if (state.open) views.push({
                    id: 'item_a', type: 'Item', kind: 'state',
                    body: [formatRef(label, 'selected', 'Data'), formatRef('All items', 'items', 'Data[]'),
                        ...state.items.map((_, index) => formatRef(`Item ${index + 1}`, `items[${index}]`, 'Data'))].join('\n'),
                    refs: [ref('selected', state.value, { refType: 'Data', schema: itemValue }), arrayRef('items', state.items, { itemType: 'Data' })],
                });
                publish({ views, bindings: execute });
            }
            publishState();
        },
    });
}

export default workItemsApp('work_items');
