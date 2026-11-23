import { createApp, createView } from '@aotui/sdk/app';
import { createDraft, Sheet } from './storage-draft.js';

export default createApp({ app_name: 'storage_draft', persistence: true, viewTypes: [Sheet],
    initialize({ persistence, prepareProjection, registerCleanup }) {
        const draft = createDraft(persistence, publish);
        const sheet = createView(Sheet, { render: () => ({ body: draft.body(), context: draft }) });
        function publish() { return prepareProjection({ views: [sheet] }); }
        registerCleanup({ close: draft.close });
        publish();
    },
});
