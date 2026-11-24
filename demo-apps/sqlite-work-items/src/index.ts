import pkg from '../package.json' with { type: 'json' };
import { arrayRef, createApp, createView, defineViewType, formatRef, ref, refParam,
    type PublishedRef, type ToolResult } from '@aotui/sdk/app';
import Type from 'typebox';
import { Check } from 'typebox/value';
import { openSqlite, type SqliteIssue } from './sqlite.js';

const maxRevision = Number.MAX_SAFE_INTEGER;
const maxItems = 100;
const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const revision = Type.Integer({ minimum: 0, maximum: maxRevision });
const status = Type.Enum(['open', 'done']);
const selector = Type.Object({ id, revision }, { additionalProperties: false });
const row = Type.Object({ id, revision, status, title: Type.String(), body: Type.Union([Type.String(), Type.Null()]) },
    { additionalProperties: false });
const rowsSchema = Type.Array(row);
const selectors = Type.Array(selector, { maxItems });
const writeCounts = Type.Array(Type.Object({
    direct: Type.Integer({ minimum: 0, maximum: 1 }),
    total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false }), { minItems: 1, maxItems: 1 });
type Item = Type.Static<typeof row>;
type ItemSelector = Readonly<Type.Static<typeof selector>>;
type ItemStatus = Type.Static<typeof status>;
type WorkListContext = { available: boolean; openItem: (id: number) => Promise<ToolResult>; refresh: () => Promise<ToolResult> };
type WorkDetailContext = { available: boolean; id: number; setStatus: (id: number, item: ItemSelector, status: ItemStatus) => Promise<ToolResult>;
    closeItem: () => Promise<ToolResult> };

export const WorkInstructionsType = defineViewType({ name: 'WorkInstructions', multiplicity: 'single', region: 'static' });

export const WorkListType = defineViewType<WorkListContext>()({ name: 'WorkList', multiplicity: 'single', region: 'dynamic', tools: {
        open_item: { description: 'Open a work item from the current list.',
            inputSchema: Type.Object({ item: refParam('WorkItem', selector) }, { additionalProperties: false }),
            enabled: ({ available }) => available,
            execute: ({ input, context }) => context.openItem(input.item.id),
        },
        refresh: { description: 'Read the latest list and selected item from SQLite.',
            inputSchema: Type.Object({}, { additionalProperties: false }),
            execute: ({ context }) => context.refresh(),
        },
} });

export const WorkDetailType = defineViewType<WorkDetailContext>()({ name: 'WorkDetail', multiplicity: 'single', region: 'dynamic', tools: {
        set_status: { description: 'Set the status of the currently selected work item.',
            inputSchema: Type.Object({ item: refParam('WorkItem', selector), status }, { additionalProperties: false }),
            enabled: ({ available }) => available,
            execute: ({ input, context }) => context.setStatus(context.id, input.item, input.status),
        },
        close_item: { description: 'Close the selected work item.',
            inputSchema: Type.Object({}, { additionalProperties: false }),
            execute: ({ context }) => context.closeItem(),
        },
} });

export const workViewTypes = [WorkInstructionsType, WorkListType, WorkDetailType] as const;

const instructions = [
    'Each page type has one instance. Supply the business parameters shown in the native tool.',
    'Choose an item by its title. Use the actual app_id and view_id from the XML in $ref.app_id.view_id.items[0] to select a list item. For an update select $ref.app_id.detail.current.',
    'After an operation, observe the current Views for work item data. Use refresh after a conflict, a partial or unknown write, or an unavailable View.',
].join('\n');

function failure(error: SqliteIssue): ToolResult { return { success: false, error }; }

function itemLine(item: Item, marker: string): string {
    return `${marker} · ${item.status} · revision ${item.revision}`;
}

function literalBlock(text: string): string {
    let fenceLength = 3;
    for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    return `${fence}\n${text}\n${fence}`;
}

export default createApp({
    ...pkg.aotui,
    viewTypes: workViewTypes,
    async initialize({ launchConfig, prepareProjection, registerCleanup, signal }) {
        const sqlite = openSqlite(launchConfig?.databasePath, launchConfig?.sqliteExecutable);
        registerCleanup({ stop: sqlite.stop, close: sqlite.close });
        let selectedId: number | undefined;

        type Content = { readonly body: string; readonly refs?: readonly PublishedRef[] };
        let available = false;
        let listContent: Content = { body: 'Loading work items.' };
        let detailContent: Content = { body: 'Detail unavailable. Use refresh to read it again.' };
        const root = createView(WorkInstructionsType, {
            id: 'root', region: 'static', name: 'SQLite work items', render: () => ({ body: instructions }),
        });
        const list = createView(WorkListType, {
            id: 'items', region: 'dynamic', name: 'Work items',
            render: () => ({ ...listContent, context: { available, openItem, refresh: refreshReceipt } }),
        });

        async function openItem(id: number): Promise<ToolResult> {
            selectedId = id;
            return refreshReceipt();
        }

        async function closeItem(): Promise<ToolResult> {
            selectedId = undefined;
            return refreshReceipt();
        }

        async function setStatus(id: number, item: ItemSelector, nextStatus: ItemStatus): Promise<ToolResult> {
            if (item.id !== id || id !== selectedId) return failure({
                code: 'WORK_ITEM_NOT_SELECTED', message: 'Use the item Ref from the current detail View.',
            });
            if (item.revision === maxRevision) return failure({
                code: 'REVISION_EXHAUSTED', message: 'This work item has reached its revision limit.',
            });
            // The Tool contract checks the selected safe integers and the fixed status enum.
            const result = await sqlite.query('rw', `UPDATE work_items SET status = '${nextStatus}', revision = revision + 1
WHERE id = ${item.id} AND revision = ${item.revision};
SELECT changes() AS direct, total_changes() AS total;`);
            if ('issue' in result) return result.started ? unknownWrite(result.issue) : failure(result.issue);
            if (!Check(writeCounts, result.rows) || result.rows[0].total < result.rows[0].direct) {
                return unknownWrite({ code: 'SQLITE_INVALID_OUTPUT', message: 'SQLite did not confirm the selected write.' });
            }
            const [{ direct, total }] = result.rows;
            if (direct === 0) {
                if (total === 0) return failure({
                    code: 'VERSION_CONFLICT', message: 'The conditional update did not apply. Refresh and select the latest Ref.',
                });
                const issue = { code: 'SQLITE_WRITE_PARTIAL', message: 'SQLite recorded row changes while skipping the direct status update.' };
                unavailable(issue);
                return failure({ ...issue, message: `${issue.message} Use refresh to check SQLite.` });
            }
            const refreshIssue = await refresh();
            return { success: true, data: refreshIssue
                ? { written: true, refreshed: false, refreshIssue }
                : { written: true, refreshed: true } };
        }

        function createDetail(id: number) {
            return createView(WorkDetailType, {
                id: 'detail', region: 'dynamic', name: 'Work item detail',
                render: () => ({ ...detailContent, context: { available, id, setStatus, closeItem } }),
            });
        }
        let detail: { id: number; view: ReturnType<typeof createDetail> } | undefined;
        function show(detailId: number | undefined) {
            if (detailId === undefined) detail = undefined;
            else if (detail?.id !== detailId) detail = { id: detailId, view: createDetail(detailId) };
            prepareProjection({ views: detail ? [root, list, detail.view] : [root, list] });
        }

        function unavailable(issue: SqliteIssue): SqliteIssue {
            if (signal.aborted) return issue;
            const body = `Work item data is unavailable (${issue.code}). ${issue.message} Use refresh to read SQLite.`;
            available = false;
            listContent = { body };
            detailContent = { body: 'Detail unavailable. Use refresh to read it again.' };
            try { show(selectedId); }
            catch { return { code: 'WORK_ITEMS_PROJECTION_FAILED', message: 'Could not publish the refresh issue.' }; }
            return issue;
        }

        function unknownWrite(issue: SqliteIssue): ToolResult {
            unavailable({ code: 'SQLITE_WRITE_UNCONFIRMED', message: 'The last write may have changed the database.' });
            return { success: false, error: { code: issue.code,
                message: `${issue.message} The write effect is unknown. Use refresh to check SQLite.` } };
        }

        async function refresh(): Promise<SqliteIssue | undefined> {
            // A single SELECT supplies both Views. Unselected bodies do not enter the output.
            const result = await sqlite.query('ro', `SELECT id, title, status, revision,
CASE WHEN id = ${selectedId ?? 'NULL'} THEN body ELSE NULL END AS body FROM work_items ORDER BY id LIMIT ${maxItems + 1};`);
            if ('issue' in result) return unavailable(result.issue);
            if (signal.aborted) return { code: 'SQLITE_CANCELLED', message: 'The App is closing.' };
            if (!Check(rowsSchema, result.rows)) return unavailable({
                code: 'SQLITE_INVALID_OUTPUT', message: 'SQLite returned an invalid work item.' });
            const items = result.rows;
            if (items.length > maxItems) return unavailable({
                code: 'WORK_ITEM_LIMIT', message: `The demo supports at most ${maxItems} work items.` });
            const selected = items.find(item => item.id === selectedId);
            const missing = selectedId !== undefined && !selected;
            const listRef = arrayRef('items', items.map(({ id, revision }) => ({ id, revision })),
                { scope: 'protected', itemType: 'WorkItem', schema: selectors });
            listContent = {
                body: items.map((item, index) => '- ' + itemLine(item, formatRef(item.title, listRef, index))).join('\n') || 'No work items.',
                refs: [listRef],
            };
            if (selected) {
                if (selected.body === null) return unavailable({ code: 'SQLITE_INVALID_OUTPUT', message: 'SQLite omitted the selected body.' });
                const current = ref('current', { id: selected.id, revision: selected.revision }, { scope: 'private', refType: 'WorkItem', schema: selector });
                detailContent = {
                    body: `${itemLine(selected, formatRef(selected.title, current))}\n\n${literalBlock(selected.body)}`,
                    refs: [current],
                };
            }
            available = true;
            try { show(selected?.id); }
            catch { return unavailable({ code: 'WORK_ITEMS_PROJECTION_FAILED', message: 'Could not publish work item data.' }); }
            if (missing) {
                selectedId = undefined;
                return { code: 'WORK_ITEM_MISSING', message: 'The selected item no longer exists. Choose from the refreshed list.' };
            }
        }

        async function refreshReceipt(): Promise<ToolResult> {
            const issue = await refresh();
            return issue ? failure(issue) : { success: true };
        }

        await refresh();
    },
});
