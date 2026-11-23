import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { arrayRef, createApp, createView, defineViewType } from '@aotui/sdk/app';

const List = defineViewType({ name: 'list', multiplicity: 'single', region: 'dynamic' });
const Contact = Type.Object({ email: Type.String(), phone: Type.String() }, { additionalProperties: false });
const People = Type.Array(Contact, { description: 'Parent directory schema' });
type Directory = { revision: string; people: Type.Static<typeof People>; withdrawn?: boolean };

export default createApp({
    app_name: 'contacts',
    viewTypes: [List],
    initialize({ launchConfig, prepareProjection, registerCleanup }) {
        const folder = launchConfig?.folder;
        if (typeof folder !== 'string') throw new Error('Missing contacts folder');
        const file = join(folder, 'people.json');
        const lifecycle = join(folder, 'contacts-lifecycle.jsonl');
        let published = '';
        let directory: Directory;
        const list = createView(List, { render: () => ({
            body: '# Contacts\nDirectory version ' + directory.revision,
            refs: directory.withdrawn ? [] : [arrayRef('people', directory.people, { scope: 'public', itemType: 'Contact', schema: People })],
        }) });
        const refresh = () => {
            const current = readFileSync(file, 'utf8');
            if (current === published) return;
            directory = JSON.parse(current) as Directory;
            prepareProjection({ views: [list] });
            published = current;
        };
        refresh();
        appendFileSync(lifecycle, JSON.stringify({ event: 'start', threadId }) + '\n');
        const watcher = setInterval(refresh, 15);
        registerCleanup({ stop: () => {
            clearInterval(watcher);
            appendFileSync(lifecycle, JSON.stringify({ event: 'stop', threadId }) + '\n');
        } });
    },
});
