import { arrayRef, createApp, defineToolSet, defineViewTypeTool, formatRef, ref, refParam,
    type PublishedView, type ToolBindings, type ToolResult, type ToolSetMap } from '@aotui/sdk/app';
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

const tools = defineToolSet({
    openItem: defineViewTypeTool({
        viewType: 'WorkList', name: 'open_item', description: 'Open a work item from the current list.',
        inputSchema: Type.Object({ item: refParam('WorkItem', selector) }, { additionalProperties: false }),
    }),
    refresh: defineViewTypeTool({
        viewType: 'WorkList', name: 'refresh', description: 'Read the latest list and selected item from SQLite.',
        inputSchema: Type.Object({}, { additionalProperties: false }),
    }),
    setStatus: defineViewTypeTool({
        viewType: 'WorkDetail', name: 'set_status', description: 'Set the status of the currently selected work item.',
        inputSchema: Type.Object({ item: refParam('WorkItem', selector), status }, { additionalProperties: false }),
    }),
    closeItem: defineViewTypeTool({
        viewType: 'WorkDetail', name: 'close_item', description: 'Close the selected work item.',
        inputSchema: Type.Object({}, { additionalProperties: false }),
    }),
});

const root: PublishedView = {
    id: 'root', type: 'WorkInstructions', kind: 'instruction', name: 'SQLite work items',
    body: [
        'WorkList offers open_item and refresh. WorkDetail offers set_status and close_item when available.',
        'Choose an item by its title. For `[label](WorkItem:local_ref)`, pass `view_id.local_ref` as the item argument. Use `detail.current` to update the selected item.',
        'After an operation, observe the current Views for work item data. Use refresh after a conflict, a partial or unknown write, or an unavailable View.',
    ].join('\n'),
};

function failure(error: SqliteIssue): ToolResult { return { success: false, error, effects: 'none' }; }

function itemLine(item: Item, localRef: string): string {
    return `${formatRef(item.title, localRef, 'WorkItem')} · ${item.status} · revision ${item.revision}`;
}

function literalBlock(text: string): string {
    let fenceLength = 3;
    for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    return `${fence}\n${text}\n${fence}`;
}

export default createApp({
    app_name: 'sqlite_work_items',
    tools,
    async initialize({ launchConfig, publish, registerCleanup, signal }) {
        const sqlite = openSqlite(launchConfig?.databasePath, launchConfig?.sqliteExecutable);
        registerCleanup({ stop: sqlite.stop, close: sqlite.close });
        let selectedId: number | undefined;

        function bindings(available: boolean): ToolBindings<ToolSetMap<typeof tools>> {
            return {
                openItem: { enabled: available, async execute({ item }) {
                    selectedId = item.id;
                    return refreshReceipt();
                } },
                refresh: { execute: refreshReceipt },
                setStatus: { enabled: available, async execute({ item, status: nextStatus }) {
                    if (item.id !== selectedId) return failure({
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
                        return { success: false, effects: 'partial', error: { ...issue, message: `${issue.message} Use refresh to check SQLite.` } };
                    }
                    const refreshIssue = await refresh();
                    return { success: true, data: refreshIssue
                        ? { written: true, refreshed: false, refreshIssue }
                        : { written: true, refreshed: true } };
                } },
                closeItem: { async execute() {
                    selectedId = undefined;
                    return refreshReceipt();
                } },
            };
        }

        function unavailable(issue: SqliteIssue): SqliteIssue {
            if (signal.aborted) return issue;
            const body = `Work item data is unavailable (${issue.code}). ${issue.message} Use refresh to read SQLite.`;
            const views: PublishedView[] = [root, { id: 'items', type: 'WorkList', kind: 'state', name: 'Work items', body }];
            if (selectedId !== undefined) views.push({
                id: 'detail', type: 'WorkDetail', kind: 'state', name: 'Work item detail', body: 'Detail unavailable. Use refresh to read it again.',
            });
            try { publish({ views, bindings: bindings(false) }); }
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
            const views: PublishedView[] = [root, {
                id: 'items', type: 'WorkList', kind: 'state', name: 'Work items',
                body: items.map((item, index) => `- ${itemLine(item, `items[${index}]`)}`).join('\n') || 'No work items.',
                refs: [arrayRef('items', items.map(({ id, revision }) => ({ id, revision })), { itemType: 'WorkItem', schema: selectors })],
            }];
            if (selected) {
                if (selected.body === null) return unavailable({ code: 'SQLITE_INVALID_OUTPUT', message: 'SQLite omitted the selected body.' });
                views.push({
                    id: 'detail', type: 'WorkDetail', kind: 'state', name: 'Work item detail',
                    body: `${itemLine(selected, 'current')}\n\n${literalBlock(selected.body)}`,
                    refs: [ref('current', { id: selected.id, revision: selected.revision }, { refType: 'WorkItem', schema: selector })],
                });
            }
            try { publish({ views, bindings: bindings(true) }); }
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
