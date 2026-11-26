import { appendFileSync, readFileSync } from 'node:fs';
import Type from 'typebox';
import { createApp, createView, defineViewType, ref, refParam, type JsonValue, type ToolResult } from '@aotui/sdk';

const seat = Type.Tuple([Type.String({ description: 'Row' }), Type.Integer({ minimum: 1, description: 'Seat number' })]);
type Seat = readonly [string, number];
type Writer = (operation: string, parameters: Readonly<Record<string, JsonValue>>) => ToolResult;
const Hall = defineViewType<Writer>()({ name: 'Hall', region: 'dynamic', multiplicity: 'single', tools: {
    lookup: { description: 'Look up the reserved seat', inputSchema: Type.Object({ seat }, { additionalProperties: false }),
        execute({ context, input }) {
            const checked: Seat = input.seat;
            return context('lookup', { seat: checked });
        } },
    selection: { description: 'Choose a published Seat',
        inputSchema: Type.Object({ seat: refParam('Seat', seat) }, { additionalProperties: false }),
        execute({ context, input }) { return context('selection', input); } },
} });
const Desk = defineViewType<Writer>()({ name: 'Desk', region: 'dynamic', multiplicity: 'multiple', tools: {
    lookup_at: { description: 'Look up a seat at a specific desk',
        inputSchema: Type.Object({ seat, label: Type.String(), tags: Type.Array(Type.String()) }, { additionalProperties: false }),
        execute({ context, input }) { return context('lookup_at', input); } },
} });

export default createApp({ app_name: 'cinema', viewTypes: [Hall, Desk],
    initialize({ prepareProjection, registerCleanup }) {
        const file = new URL('./seat.json', import.meta.url);
        const journal = new URL('./cinema-effects.jsonl', import.meta.url);
        const record = (event: object) => appendFileSync(journal, JSON.stringify(event) + '\n');
        const write = (desk: string): Writer => (operation, parameters) => {
            const result = { desk, operation, parameters };
            record(result);
            return { success: true, data: result };
        };
        let previous = '';
        const hall = createView(Hall, { id: 'hall', render() {
            const state: { seat: Seat; withdrawn?: boolean } = JSON.parse(previous);
            return { body: `Reserved seat ${state.seat.join(' ')}`, context: write('hall'), refs: [
                ...(state.withdrawn ? [] : [ref('seat', state.seat, { scope: 'public', refType: 'Seat', schema: seat })]),
                ref('row', state.seat[0], { scope: 'public', schema: Type.String() }),
            ] };
        } });
        const desks = ['east', 'west'].map(name => createView(Desk, { idPrefix: name,
            render: () => ({ body: `Desk ${name}`, context: write(name) }) }));
        const refresh = () => {
            const text = readFileSync(file, 'utf8');
            if (previous === text) return;
            previous = text;
            prepareProjection({ views: [hall, ...desks] });
            record({ event: 'published', state: JSON.parse(text) });
        };
        refresh();
        const timer = setInterval(refresh, 12);
        registerCleanup({ stop: () => clearInterval(timer) });
    },
});
