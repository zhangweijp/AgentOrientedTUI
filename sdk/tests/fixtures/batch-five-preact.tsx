import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Type from 'typebox';
import { createTUIApp, defineViewType, StaticView, DynamicView, useAppRuntimeContext, useDataRef, useEffect, useState,
    type ToolResult } from '@aotui/sdk';
import { AUTHOR_TABLE, BACKSLASH_CODE, DIAGRAM, FILES, ORDINARY_PIPES, PIPE_CODE, PREACT_APP, RAW, RAW_PARTS, SPACES } from './batch-five-content.js';

const Raw = defineViewType({ name: 'raw_markdown', multiplicity: 'multiple', createId: ({ prefix }) => prefix });
const Stock = defineViewType({ name: 'inventory', multiplicity: 'single', region: 'static' });
const string = Type.String();
const Item = defineViewType<{ writable: boolean; apply(value: string): ToolResult }>()({
    name: 'item', multiplicity: 'multiple', region: 'dynamic', createId: ({ prefix }) => prefix,
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

function ItemBody({ id, value }: { id: string; value: string }) {
    useDataRef('value', value, { scope: 'protected', schema: string });
    return <>{id} item has a stable body</>;
}

function Table({ state }: { state: 'initial' | 'invalid' | 'repaired' }) {
    return <table>
        <thead><tr><th>商品</th><th>库存</th></tr></thead>
        <tbody>
            <tr><td rowSpan={state === 'invalid' ? 2 : 1}>钉子</td><td>12</td></tr>
            <tr><td>垫片</td><td>{state === 'repaired' ? '4' : '3'}</td></tr>
            <tr><td>{'  small  parts　 '}</td><td /></tr>
            {ORDINARY_PIPES.map((part, i) => {
                const pipe = part.indexOf('|');
                return <tr key={part}><td>{part.slice(0, pipe)}{part.slice(pipe)}</td><td>{i + 1}</td></tr>;
            })}
            <tr><td><code>{PIPE_CODE}</code></td><td><code>{BACKSLASH_CODE}</code></td></tr>
            <tr><td><strong>Ready</strong> <em>today</em>{' ('}<a href="https://example.test/box">box</a>)!</td><td>2</td></tr>
        </tbody>
    </table>;
}

function Files() {
    return <table>
        <thead><tr><th>{FILES.headers[0]}</th><th><span>{FILES.headers[1]}</span></th></tr></thead>
        <tbody>
            <tr><td>literal_plain</td><td><span>{FILES.literalName}</span></td></tr>
            <tr><td>literal_link</td><td>{FILES.linkShapedName}</td></tr>
            <tr><td>explicit_link</td><td>report<a href="draft">old</a>.txt</td></tr>
            <tr><td>literal_entity</td><td>{FILES.entityName.slice(0, 1)}{FILES.entityName.slice(1)}</td></tr>
            <tr><td>explicit_code</td><td><code>{FILES.literalName}</code></td></tr>
            <tr><td>explicit_emphasis</td><td><strong>{FILES.literalName}</strong> <em>{FILES.entityName}</em></td></tr>
            <tr><td>link_with_space</td><td><a href={FILES.spacedTarget}>stock list</a></td></tr>
            <tr><td>link_with_punctuation</td><td>!<a href={FILES.mixedTarget}><span>{FILES.mixedLabel}</span></a></td></tr>
            <tr><td>literal_urls</td><td>{FILES.literalUrls.slice(0, 2)}<span>{FILES.literalUrls.slice(2)}</span></td></tr>
            <tr><td>pipe_and_backslashes</td><td>{FILES.pipeAndBackslashes.slice(0, 2)}<span>{FILES.pipeAndBackslashes.slice(2)}</span>{' and '}
                <code>{FILES.codeWithPipe}</code></td></tr>
        </tbody>
    </table>;
}

function App() {
    const { launchConfig, prepareProjection } = useAppRuntimeContext();
    const folder = launchConfig?.folder;
    if (typeof folder !== 'string') throw new Error('Missing test directory');
    const [readOnly, setReadOnly] = useState(false);
    const [value, setValue] = useState('left in original observation');
    const [table, setTable] = useState<'initial' | 'invalid' | 'repaired'>('initial');
    const journal = (name: string, entry: object) => appendFileSync(join(folder, name + '.jsonl'), JSON.stringify(entry) + '\n');

    useEffect(() => {
        const command = join(folder, 'update.txt');
        let previous = '';
        const watcher = setInterval(() => {
            if (!existsSync(command)) return;
            const next = readFileSync(command, 'utf8');
            if (next === previous) return;
            previous = next;
            void prepareProjection(() => {
                if (next === 'new_ref') setValue('left after Provider request');
                if (next === 'repair') setTable('repaired');
            }).then(() => journal('updates', { next }), error => journal('update-errors', { next, error: String(error) }));
        }, 20);
        return () => clearInterval(watcher);
    }, [folder, prepareProjection]);

    const change = async (operation: Operation): Promise<ToolResult> => {
        if (operation === 'read_only') {
            await prepareProjection(() => setReadOnly(true));
            return { success: true, data: { read_only: 'left' } };
        }
        writeFileSync(join(folder, 'saved.txt'), 'stored once');
        journal('writes', { operation });
        try {
            await prepareProjection(() => setTable('invalid'));
            return { success: true, data: { saved: true } };
        } catch (error) {
            const issue = error as { code: string; path: string; message: string };
            const projection = { code: issue.code, path: issue.path, message: issue.message };
            journal('diagnostics', projection);
            return { success: true, data: { saved: true, projection } };
        }
    };

    const item = (id: 'left' | 'right', writable: boolean) => ({ writable, apply: (value: string): ToolResult => {
        journal('handler', { id, value });
        return { success: true, data: { id, value } };
    } });

    return <>
        <Raw idPrefix="raw" region="dynamic">{RAW}</Raw>
        <StaticView type={Raw} idPrefix="split_raw">{RAW_PARTS[0]}{RAW_PARTS[1]}{RAW_PARTS[2]}{RAW_PARTS[3]}{RAW_PARTS[4]}{RAW_PARTS[5]}</StaticView>
        <Raw idPrefix="whitespace" region="dynamic">{SPACES}</Raw>
        <DynamicView type={Raw} idPrefix="author_table">{AUTHOR_TABLE}</DynamicView>
        <Stock id="stock"><Table state={table} /></Stock>
        <DynamicView type={Raw} idPrefix="files"><Files /></DynamicView>
        <DynamicView type={Raw} idPrefix="diagram"><pre><code class="language-mermaid">{DIAGRAM}</code></pre></DynamicView>
        <Raw idPrefix="inline_flow" region="dynamic"><p>Hello <strong>world</strong>!<br />Done.</p><div><span>First</span><em> second</em>.</div></Raw>
        <Control context={{ change }}><p>Inventory controls</p></Control>
        <Item idPrefix="left" context={item('left', !readOnly)}><ItemBody id="left" value={value} /></Item>
        <DynamicView type={Item} idPrefix="right" context={item('right', true)}><ItemBody id="right" value="right Ref" /></DynamicView>
    </>;
}

export default createTUIApp({ app_name: PREACT_APP, component: App, viewTypes: [Raw, Stock, Item, Control] });
