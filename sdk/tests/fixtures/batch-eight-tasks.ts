import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';
import Type from 'typebox';
import { arrayRef, createApp, createView, defineViewType, refParam, type ViewHandle, type ToolResult } from '@aotui/sdk/app';

const todo = Type.Object({ title: Type.String(), done: Type.Boolean() }, { additionalProperties: false });
type Writer = { write(label: string, value: object): Promise<ToolResult> };
const detail = defineViewType<Writer>()({ name: 'detail', multiplicity: 'multiple', region: 'dynamic', createId: ({ prefix }) => prefix,
    tools: { edit: { description: 'Edit the open detail.', inputSchema: Type.Object({ value: Type.String() }, { additionalProperties: false }),
        execute: ({ input, context }) => context.write('edit', input) } },
});
const workspace = defineViewType<Writer & { open(): ToolResult }>()({ name: 'workspace', multiplicity: 'single', region: 'dynamic',
    tools: {
        accept: { description: 'Store an ordinary list of Todo values.',
            inputSchema: Type.Object({ items: Type.Array(todo), literal: Type.String(),
                meta: Type.Optional(Type.Tuple([Type.Number(), Type.Union([Type.String(), Type.Null()])])) }, { additionalProperties: false }),
            execute: ({ input, context }) => context.write('accept', input) },
        select: { description: 'Store a selection of published Todo addresses.',
            inputSchema: Type.Object({ item: refParam('Todo', todo), items: Type.Optional(Type.Array(refParam('Todo', todo))) }, { additionalProperties: false }),
            execute: ({ input, context }) => context.write('select', input) },
        native_only: { description: 'Verify an exact object literal through the native route.',
            inputSchema: Type.Object({ constant: Type.Object({ mark: Type.String() }, {
                additionalProperties: false, const: { mark: 'native' },
            }) }, { additionalProperties: false }),
            execute: ({ input, context }) => context.write('native_only', input) },
        open: { description: 'Open the editable detail page.', inputSchema: Type.Object({}, { additionalProperties: false }),
            execute: ({ context }) => context.open() },
    },
});

export default createApp({ app_name: 'console_tasks', viewTypes: [workspace, detail],
    initialize({ launchConfig, prepareProjection, registerCleanup }) {
        const folder = String(launchConfig?.folder);
        const log = (name: string, value: object) => appendFileSync(join(folder, name + '.jsonl'), JSON.stringify({ ...value, threadId }) + '\n');
        let details: ViewHandle | undefined, last = 'empty';
        let count = 0;
        const owner: Writer = { async write(label, value) {
            log('entered', { label, value });
            writeFileSync(join(folder, 'write-' + (++count) + '.json'), JSON.stringify({ label, value }));
            log('writes', { label, value });
            if (label === 'accept' && 'literal' in value && value.literal === 'park') {
                const deadline = Date.now() + 25_000;
                while (existsSync(join(folder, 'park')) && Date.now() < deadline) await delay(15);
            }
            last = label;
            publish();
            return { success: true, data: { saved: true, label, undisplayed: 'TOOL_DATA_NOT_INSPECTED' } };
        } };
        function open(): ToolResult {
            if (!details) details = createView(detail, { idPrefix: 'detail_1', render: () => ({ body: '# Detail available', context: owner }),
                onClose: () => { details = undefined;publish();return { success: true }; } });
            publish();
            return { success: true, data: { opened: true } };
        }
        const page = createView(workspace, { render: () => ({ body: '# Tasks last operation ' + last,
            context: { ...owner, open }, refs: [arrayRef('values', [{ priority: 7 }], { itemType: 'Todo',
                scope: 'public', schema: Type.Array(Type.Object({ priority: Type.Integer() }, { additionalProperties: false })) })] }) });
        const publish = () => prepareProjection({ views: details ? [page, details] : [page] });
        publish();
        log('tasks-life', { event: 'start' });
        registerCleanup({ stop: () => { log('tasks-life', { event: 'stop' }); } });
    },
});
