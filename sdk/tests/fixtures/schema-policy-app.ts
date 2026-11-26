import { appendFileSync, readFileSync } from 'node:fs';
import Type from 'typebox';
import { createApp, createView, defineViewType, ref, type JsonValue, type ToolResult } from '@aotui/sdk';

type Context = { mode: string; write(tool: string, input: Readonly<Record<string, JsonValue>>): ToolResult };
const object = <T extends Type.TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const Programme = defineViewType<Context>()({ name: 'Programme', region: 'dynamic', multiplicity: 'single', tools: {
    read_program: { description: 'Read the current programme', inputSchema: object({}),
        execute: ({ context }) => context.write('read_program', {}) },
} });
const Form = defineViewType<Context>()({ name: 'Form', region: 'dynamic', multiplicity: 'multiple', tools: {
    pick: { description: 'Choose a seat', inputSchema: object({ seat: Type.Tuple([Type.String(), Type.Integer()]) }),
        execute: ({ context, input }) => context.write('pick', input) },
} });
const stations = (count: number) => Type.String({ enum: Array.from({ length: count }, (_, i) => 'S' + String(i).padStart(4, '0')) });
const Station = defineViewType<Context>()({ name: 'Station', region: 'dynamic', multiplicity: 'single', tools: {
    at_limit: { description: 'Select a station out of 1000', inputSchema: object({ station: stations(1000) }),
        enabled: context => context.mode === 'at', execute: ({ context, input }) => context.write('at_limit', input) },
    split_at_limit: { description: 'Select two stations from separate lists', inputSchema: object({ from: stations(500), to: stations(500) }),
        enabled: context => context.mode === 'at', execute: ({ context, input }) => context.write('split_at_limit', input) },
    over_limit: { description: 'Select a station out of 1001', inputSchema: object({ station: stations(1001) }),
        enabled: context => context.mode === 'over', execute: ({ context, input }) => context.write('over_limit', input) },
    split_over_limit: { description: 'Select two stations from separate lists', inputSchema: object({ from: stations(500), to: stations(501) }),
        enabled: context => context.mode === 'split-over', execute: ({ context, input }) => context.write('split_over_limit', input) },
} });

export default createApp({ app_name: 'theatre', viewTypes: [Programme, Form, Station],
    initialize({ prepareProjection }) {
        const mode = readFileSync(new URL('./schema-case.txt', import.meta.url), 'utf8');
        const context: Context = { mode, write(tool, input) {
            appendFileSync(new URL('./policy-effects.jsonl', import.meta.url), JSON.stringify({ tool, input }) + '\n');
            return { success: true, data: { ok: true } };
        } };
        const programme = createView(Programme, { id: 'programme', render: () => ({ body: 'Tonight at 20:00', context,
            refs: [ref('when', 'Tonight at 20:00', { scope: 'public', schema: Type.String() })] }) });
        const forms = (mode === 'twins' ? ['form', 'annex'] : ['form']).map(id => createView(Form, { idPrefix: id,
            render: () => ({ body: 'Reservation form', context, refs: [ref('ticket', 'Reservation input', { schema: Type.String(), scope: 'public' })] }) }));
        const station = createView(Station, { id: 'station', render: () => ({ body: 'Rail station selection', context }) });
        prepareProjection({ views: mode === 'window' || mode === 'twins' ? [programme, ...forms] : [station] });
    },
});
