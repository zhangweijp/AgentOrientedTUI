import { DynamicView, createTUIApp, useAppLifecycle, useAppRuntimeContext, useState } from '@aotui/sdk';
import { createDraft, Sheet } from './storage-draft.js';

function App() {
    const { persistence, prepareProjection } = useAppRuntimeContext();
    const [, update] = useState(0);
    const [draft] = useState(() => createDraft(persistence, () => prepareProjection(() => update(value => value + 1))));
    useAppLifecycle({ close: draft.close });
    return <DynamicView type={Sheet} context={draft}>{draft.body()}</DynamicView>;
}

export default createTUIApp({ app_name: 'storage_draft', persistence: true, viewTypes: [Sheet], component: App });
