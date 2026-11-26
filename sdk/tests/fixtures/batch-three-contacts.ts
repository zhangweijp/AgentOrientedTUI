import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { arrayRef, createApp, createView, defineViewType, ref, type ToolResult } from '@aotui/sdk';

const Contact = Type.Object({ email: Type.String(), 'display.name': Type.String() }, { additionalProperties: false });
const People = Type.Array(Contact);
const Text = Type.String();
const SaveInput = Type.Object({ text: Text }, { additionalProperties: false });
type Save = { save(input: string): ToolResult };
const save = { description: 'Store a text selection from this request.', inputSchema: SaveInput,
    execute: ({ input, context }: { input: Type.Static<typeof SaveInput>; context: Save }) => context.save(input.text) };
const List = defineViewType<Save>()({ name: 'list', multiplicity: 'single', region: 'dynamic', tools: { store_here: save } });
const Team = defineViewType<Save>()({ name: 'team', multiplicity: 'single', region: 'dynamic', tools: { store_team: save } });
type Directory = { revision: string; people: Type.Static<typeof People>; withdrawn?: boolean; privateScore?: boolean;
    score?: number; emails?: string[]; numbers?: number[] };

export default createApp({
    app_name: 'contacts',
    viewTypes: [List, Team],
    initialize({ launchConfig, prepareProjection, registerCleanup }) {
        const folder = launchConfig?.folder;
        if (typeof folder !== 'string') throw new Error('Missing contacts folder');
        const file = join(folder, 'people.json');
        const lifecycle = join(folder, 'contacts-lifecycle.jsonl');
        let published = '';
        let directory: Directory;
        const storeOn = (view: string): Save => ({ save(text) {
            appendFileSync(join(folder, 'contacts-writes.jsonl'), JSON.stringify({ view, text, threadId }) + '\n');
            return { success: true };
        } });
        const list = createView(List, { onClose: () => { opened = false; publish(); return { success: true }; }, render: () => ({
            body: '# Contacts\nDirectory version ' + directory.revision,
            context: storeOn('list'),
            refs: directory.withdrawn ? [] : [
                arrayRef('people', directory.people, { scope: 'public', itemType: 'Contact', schema: People }),
                ref('secret', 'only-on-list', { scope: 'private', schema: Text }),
                ref('team', 'inside-contacts', { scope: 'protected', schema: Text }),
                arrayRef('empty', [], { scope: 'protected', itemType: 'Contact', schema: People }),
                ref('score', directory.score ?? 7, { scope: directory.privateScore ? 'private' : 'public', schema: Type.Integer() }),
                ...(directory.emails ? [arrayRef('emails', directory.emails, { scope: 'public', schema: Type.Array(Text) })] : []),
                ...(directory.numbers ? [arrayRef('numbers', directory.numbers, { scope: 'public', schema: Type.Array(Type.Integer()) })] : []),
            ],
        }) });
        const team = createView(Team, { render: () => ({ body: '# Team notes', context: storeOn('team') }) });
        let opened = true;
        const publish = () => prepareProjection({ views: opened ? [list, team] : [team] });
        const refresh = () => {
            const current = readFileSync(file, 'utf8');
            if (current === published) return;
            directory = JSON.parse(current) as Directory;
            publish();
            appendFileSync(join(folder, 'contacts-commits.jsonl'), JSON.stringify({ revision: directory.revision }) + '\n');
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
