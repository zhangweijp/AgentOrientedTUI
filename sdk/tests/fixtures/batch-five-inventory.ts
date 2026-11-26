import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Type from 'typebox';
import { createApp, createView, defineViewType, ref, type ToolResult } from '@aotui/sdk';
import { SnapshotDataError } from '@aotui/core';
import { AUTHOR_TABLE, BACKSLASH_CODE, DIAGRAM, FILES, ORDINARY_PIPES, PIPE_CODE, STOCK_APP, RAW, RAW_PARTS, SPACES } from './batch-five-content.js';

const Raw = defineViewType({ name: 'raw_markdown', multiplicity: 'multiple' });
const Stock = defineViewType({ name: 'inventory', multiplicity: 'single', region: 'static' });
const string = Type.String();
const Item = defineViewType<{ writable: boolean; apply(value: string): ToolResult }>()({
    name: 'item', multiplicity: 'multiple', region: 'dynamic',
    tools: { apply: { description: 'Apply a value to the selected item.', enabled: context => context.writable,
        inputSchema: Type.Object({ value: string }), execute: ({ input, context }) => context.apply(input.value) } },
});
type Operation = 'read_only' | 'save_bad_table';
const Control = defineViewType<{ change(operation: Operation): Promise<ToolResult> }>()({
    name: 'control', multiplicity: 'single', region: 'static', tools: {
        change: { description: 'Change the test inventory.', inputSchema: Type.Object({ operation: Type.Union([
            Type.Literal('read_only'), Type.Literal('save_bad_table'),
        ]) }), execute: ({ input, context }) => context.change(input.operation) },
    },
});

const literal = (text: string) => [...text].map(char => /[a-zA-Z0-9\p{L}]/u.test(char) ? char : '&#' + char.codePointAt(0) + ';').join('');
const code = (text: string) => {
    const marks = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
    const fence = '`'.repeat(marks + 1);
    return fence + ' ' + text.replaceAll('|', '\\|') + ' ' + fence;
};
const link = (label: string, target: string) =>
    '[' + literal(label) + '](<' + target.replaceAll(' ', '%20').replaceAll('&', '&amp;').replaceAll('|', '%7C') + '>)';
const table = (head: readonly string[], rows: readonly (readonly string[])[]) =>
    [head, head.map(() => '---'), ...rows].map(row => '| ' + row.join(' | ') + ' |').join('\n');
const filesBody = table(FILES.headers.map(literal), [
    ['literal_plain', literal(FILES.literalName)],
    ['literal_link', literal(FILES.linkShapedName)],
    ['explicit_link', 'report[old](draft).txt'],
    ['literal_entity', literal(FILES.entityName)],
    ['explicit_code', code(FILES.literalName)],
    ['explicit_emphasis', '**' + literal(FILES.literalName) + '** *' + literal(FILES.entityName) + '*'],
    ['link_with_space', link('stock list', FILES.spacedTarget)],
    ['link_with_punctuation', '&#33;' + link(FILES.mixedLabel, FILES.mixedTarget)],
    ['literal_urls', literal(FILES.literalUrls)],
    ['pipe_and_backslashes', literal(FILES.pipeAndBackslashes) + ' and ' + code(FILES.codeWithPipe)],
]);
function inventory(state: 'initial' | 'invalid' | 'repaired') {
    if (state === 'invalid') throw new SnapshotDataError('SNAPSHOT_INVALID', '$.views[4].content', 'Inventory data could not render a complete Markdown table.');
    return table(['商品', '库存'], [
        ['钉子', '12'], ['垫片', state === 'repaired' ? '4' : '3'], [literal('  small  parts　 '), ''],
        ...ORDINARY_PIPES.map((part, i) => [literal(part), String(i + 1)]),
        [code(PIPE_CODE), code(BACKSLASH_CODE)],
        ['**Ready** *today* ([box](https://example.test/box))!', '2'],
    ]);
}

export default createApp({
    app_name: STOCK_APP, viewTypes: [Raw, Stock, Item, Control],
    initialize({ launchConfig, prepareProjection, registerCleanup }) {
        const configuredFolder = launchConfig?.folder;
        if (typeof configuredFolder !== 'string') throw new Error('Missing test directory');
        const folder: string = configuredFolder;
        let readOnly = false, value = 'left in original observation';
        let state: 'initial' | 'invalid' | 'repaired' = 'initial';
        const journal = (name: string, entry: object) => appendFileSync(join(folder, name + '.jsonl'), JSON.stringify(entry) + '\n');
        const raw = (idPrefix: string, body: string, region: 'static' | 'dynamic' = 'dynamic') =>
            createView(Raw, { idPrefix, region, render: () => ({ body }) });
        const views = [
            raw('raw', RAW), raw('split_raw', RAW_PARTS.join(''), 'static'), raw('whitespace', SPACES),
            raw('author_table', AUTHOR_TABLE), createView(Stock, { id: 'stock', render: () => ({ body: inventory(state) }) }),
            raw('files', filesBody), raw('diagram', '```mermaid\n' + DIAGRAM + '\n```'),
            raw('inline_flow', 'Hello **world**!\nDone.\n\nFirst *second*.'),
            createView(Control, { render: () => ({ body: 'Inventory controls', context: { change } }) }),
            item('left'), item('right'),
        ];
        function item(idPrefix: 'left' | 'right') {
            return createView(Item, { idPrefix, render() {
                const data = ref('value', idPrefix === 'left' ? value : 'right Ref', { scope: 'protected', schema: string });
                return { body: idPrefix + ' item has a stable body', refs: [data], context: {
                    writable: idPrefix !== 'left' || !readOnly,
                    apply(value: string) { journal('handler', { id: idPrefix, value }); return { success: true, data: { id: idPrefix, value } }; },
                } };
            } });
        }
        const publish = () => prepareProjection({ views });
        async function change(operation: Operation): Promise<ToolResult> {
            if (operation === 'read_only') {
                readOnly = true; publish();
                return { success: true, data: { read_only: 'left' } };
            }
            writeFileSync(join(folder, 'saved.txt'), 'stored once');
            journal('writes', { operation });
            state = 'invalid';
            try { publish(); return { success: true, data: { saved: true } }; }
            catch (error) {
                const issue = error as { code: string; path: string; message: string };
                const projection = { code: issue.code, path: issue.path, message: issue.message };
                journal('diagnostics', projection);
                return { success: true, data: { saved: true, projection } };
            }
        }
        const command = join(folder, 'update.txt');
        let previous = '';
        const watcher = setInterval(() => {
            if (!existsSync(command)) return;
            const next = readFileSync(command, 'utf8');
            if (next === previous) return;
            previous = next;
            if (next === 'new_ref') value = 'left after Provider request';
            if (next === 'repair') state = 'repaired';
            try { publish(); journal('updates', { next }); }
            catch (error) { journal('update-errors', { next, error: String(error) }); }
        }, 20);
        registerCleanup({ stop() { clearInterval(watcher); } });
        publish();
    },
});
