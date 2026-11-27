import { arrayRef, createApp, createView, formatRef, ref, type ToolResult } from '@aotui/sdk';
import { ItemType, WorkspaceType, initialState, itemRefOptions, label, listRefOptions, otherViewPrefix, selectedViewPrefix,
    workViewTypes, workspaceText, type State, type WorkItemOptions } from './work-items.js';

export function workItemsApp(app_name: string, options: WorkItemOptions = {}) {
    return createApp({
        app_name,
        viewTypes: workViewTypes,
        initialize({ publish: commit, signal, registerLifecycle }) {
            let state = initialState();
            registerLifecycle({ stop: () => options.onStop?.(), close: () => options.onClose?.() });
            const change = (update: (value: State) => State): ToolResult | void => {
                if (signal.aborted) return;
                state = update(state);
                const published = prepareCurrentProjection();
                if (!published.ok) {
                    options.onPublicationError?.(published.issue);
                    return { success: true, data: { message: 'Change applied. View refresh failed.' } };
                }
            };
            const workspace = (() => { const handle = createView(WorkspaceType, { idPrefix: 'workspace', region: 'dynamic' }); return { handle, frame: () => handle.frame({ body: workspaceText(state), context: { change, options } }) }; })();
            const other = (() => { const handle = createView(ItemType, { idPrefix: otherViewPrefix, region: 'dynamic' }); return { handle, frame: () => {
                    const selected = ref('selected', false, itemRefOptions);
                    return handle.frame({ body: formatRef('Other item', selected), refs: [selected], context: { change } });
                } }; })();
            const selected = (() => { const handle = createView(ItemType, { idPrefix: selectedViewPrefix, region: 'dynamic' }); return { handle, frame: () => {
                    const selectedRef = ref('selected', state.value, itemRefOptions);
                    const items = arrayRef('items', state.items, listRefOptions);
                    return handle.frame({ body: [formatRef(label, selectedRef), formatRef('All items', items),
                            ...state.items.map((_, index) => formatRef(`Item ${index + 1}`, items, index))].join('\n'), refs: [selectedRef, items], context: { change } });
                } }; })();
            function prepareCurrentProjection() {
                return commit(() => (state.open ? [workspace, other, selected] : [workspace, other]).map(page => page.frame()));
            }
            prepareCurrentProjection();
        },
    });
}

export default workItemsApp('work_items');
