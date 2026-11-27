import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { arrayRef, createApp, createView, defineViewType, formatRef } from '@aotui/sdk';

const List = defineViewType({ name: 'list', multiplicity: 'single', region: 'dynamic' });
type Contacts = { emails: string[]; scope?: 'public' | 'protected'; withdrawn?: boolean };

export default createApp({
    app_name: 'contacts',
    viewTypes: [List],
    initialize({ launchConfig, publish: commit, registerLifecycle }) {
        const folder = launchConfig?.folder;
        if (typeof folder !== 'string') throw new Error('Missing contacts folder');
        const stateFile = join(folder, 'contacts.json');
        const witness = join(folder, 'contacts-lifecycle.jsonl');
        let last = readFileSync(stateFile, 'utf8');
        let state = JSON.parse(last) as Contacts;
        const list = (() => { const handle = createView(List); return { handle, frame: () => {
            const schema = Type.Array(Type.String());
            const recipients = arrayRef('emails', state.emails, { scope: state.scope ?? 'public', schema });
            const personal = arrayRef('personal', state.emails, { scope: 'private', schema });
            const team = arrayRef('team', state.emails, { scope: 'protected', schema });
            return handle.frame({ body: ['# Contacts', state.emails.join(', '),
                ...(state.withdrawn ? [] : [formatRef('Recipients', recipients), ...state.emails.map((email, index) => formatRef(email, recipients, index))]),
                formatRef('My contacts', personal), formatRef('Team contacts', team)].join('\n'), refs: [...(state.withdrawn ? [] : [recipients]), personal, team] });
        } }; })();
        function publish() { commit(() => ([list]).map(page => page.frame())); }
        publish();
        appendFileSync(witness, JSON.stringify({ event: 'start', threadId }) + '\n');
        const timer = setInterval(() => {
            const next = readFileSync(stateFile, 'utf8');
            if (next === last) return;
            state = JSON.parse(next) as Contacts;
            last = next;
            publish();
        }, 15);
        registerLifecycle({ stop: () => {
            clearInterval(timer);
            appendFileSync(witness, JSON.stringify({ event: 'stop', threadId }) + '\n');
        } });
    },
});
