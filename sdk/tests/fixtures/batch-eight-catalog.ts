import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { arrayRef, createApp, createView, defineViewType } from '@aotui/sdk';

const list = defineViewType({ name: 'list', multiplicity: 'single', region: 'dynamic' });
const todo = Type.Object({ title: Type.String(), done: Type.Boolean() }, { additionalProperties: false });
type Catalog = {
    revision: string;
    todos: { title: string; done: boolean }[];
    people: { email: string | number; phone: string }[];
    narrowed?: boolean;
    padding?: string;
};

export default createApp({ app_name: 'console_catalog', viewTypes: [list],
    initialize({ launchConfig, prepareProjection, registerCleanup }) {
        const folder = String(launchConfig?.folder);
        const file = join(folder, 'catalog.json');
        const witness = (event: string) => appendFileSync(join(folder, 'catalog-life.jsonl'), JSON.stringify({ event, threadId }) + '\n');
        let previous = '';
        const view = createView(list, { render() {
            const data = JSON.parse(previous) as Catalog;
            const email = typeof data.people[0]?.email === 'number' ? Type.Number() : Type.String();
            const person = Type.Object({ email }, { additionalProperties: false });
            return { body: '# Console catalog ' + data.revision + (data.padding ?? ''),
                refs: [
                    arrayRef('todos', data.todos, { scope: 'public', itemType: 'Todo', schema: Type.Array(todo) }),
                    arrayRef('people', data.people.map(({ email }) => ({ email })), { scope: data.narrowed ? 'private' : 'public', itemType: 'Person', schema: Type.Array(person) }),
                    arrayRef('other_kind', data.todos, { scope: 'public', itemType: 'Other', schema: Type.Array(todo) }),
                    arrayRef('private_rows', data.todos, { schema: Type.Array(Type.Object({})), scope: 'private', itemType: 'Todo' }),
                    arrayRef('team_rows', data.todos, { schema: Type.Array(Type.Object({})), scope: 'protected', itemType: 'Todo' }),
                ] };
        } });
        const update = () => {
            const next = readFileSync(file, 'utf8');
            if (next === previous) return;
            previous = next;
            prepareProjection({ views: [view] });
        };
        update();
        witness('start');
        const timer = setInterval(update, 15);
        registerCleanup({ stop: () => { clearInterval(timer);witness('stop'); } });
    },
});
