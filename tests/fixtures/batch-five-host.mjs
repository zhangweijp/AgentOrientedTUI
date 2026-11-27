import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DOMParser, parseHTML } from 'linkedom';
import { Marked } from 'marked';
import { createRuntime } from '@aotui/runtime';
import { projectNativeToolSchema, buildPublicToolName, buildViewMessageMarkup, DEFAULT_AOTUI_SYSTEM_INSTRUCTION, escapeXmlText } from '@aotui/runtime/adapters';
import { fixtureAppPath, appClient, fixtureProvider, journal, modelCall, watchUntil } from './batch-two-support.mjs';
import { BACKSLASH_CODE, DIAGRAM, FILES, PLAIN_APP, PIPE_CODE, STOCK_APP, RAW_VIEWS, STOCK } from './dist/batch-five-content.js';

const [mode, folder] = process.argv.slice(2);
assert.ok(['product', 'independent'].includes(mode));
await mkdir(folder, { recursive: true });
const dataDirectory = await mkdtemp(join(folder, 'worker-data-'));
const provider = await fixtureProvider();
const runtime = createRuntime({ worker: { maxWorkers: 2 } });
const desktop = await runtime.createDesktop();
const marked = new Marked({ gfm: true });
const facts = { mode, dataDirectory, requests: provider.requests, calls: [], passed: false };

const change = (id, operation) => modelCall(id, STOCK_APP + '-control-change', { operation });
const apply = (id, view, value = '$ref.' + STOCK_APP + '.left_1.value') => modelCall(id, STOCK_APP + '-item-apply', { view_id: view, value });
const ping = id => modelCall(id, PLAIN_APP + '-healthy-ping', {});
const toolNames = request => request.tools.map(tool => tool.function.name);

function page(request, app, id) {
    const entry = request.messages.find(message => message.role === 'user' && typeof message.content === 'string' &&
        message.content.startsWith(`<view view_id="${id}" `) && message.content.split('\n', 1)[0].includes(` app_id="${app}"`));
    if (!entry) return;
    const xml = entry.content;
    const node = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
    assert.equal(node.localName, 'view');
    assert.deepEqual([...node.getAttributeNames()].sort(), ['app_id', 'app_name', 'region', 'view_id', 'view_type']);
    assert.equal(node.getAttribute('app_id'), app);
    assert.equal(node.getAttribute('app_name'), app);
    assert.equal(node.getAttribute('view_id'), id);
    assert.equal(node.children.length, 0, 'View XML encloses text only');
    assert.ok(node.textContent.startsWith('\n') && node.textContent.endsWith('\n'));
    return { xml, body: node.textContent.slice(1, -1), type: node.getAttribute('view_type') };
}

function tableCells(body) {
    const tokens = marked.lexer(body).map(token => token.type);
    const { document } = parseHTML(marked.parse(body));
    const table = document.querySelector('table');
    if (!table) return { tokens, rows: [] };
    const rows = [...table.querySelectorAll('tr')].map(row => [...row.children]);
    const describe = node => [node.localName, node.textContent, node.getAttribute('href')];
    return { tokens, rows: rows.map(row => row.map(cell => cell.textContent)),
        marks: rows.map(row => row.map(cell => [...cell.querySelectorAll('*')].map(describe))),
        code: [...table.querySelectorAll('code')].map(cell => cell.textContent),
        inline: [...table.querySelectorAll('strong, em, a')].map(describe) };
}

function diagram(body) {
    const token = marked.lexer(body).find(token => token.type === 'code');
    return { lang: token?.lang, text: token?.text };
}

async function boot(name, filename, path) {
    await mkdir(path, { recursive: true });
    await desktop.registerPendingApp({ installationId: name, localPath: await fixtureAppPath(new URL('./dist/' + filename, import.meta.url).href, name, folder),
        config: { folder: path } });
    const id = (await desktop.openApp(name)).appId;
    return appClient(desktop, id);
}

async function productHost() {
    const { AgentDriverV2 } = await import('@aotui/agent-driver-v2');
    const { SemanticAOTUIDrivenSource } = await import('@aotui/agent-driver-adapter');
    const source = new SemanticAOTUIDrivenSource(desktop);
    const history = [], errors = [], receipts = [];
    facts.toolMessages = receipts;
    const driver = new AgentDriverV2({
        llm: { model: 'stock-fixture', apiKey: 'test-only', provider: { id: 'stock-fixture', baseURL: provider.url },
            inputBudget: () => ({ contextWindow: 100_000, maxOutputTokens: 750 }) },
        sources: [{ name: source.name, getContext: () => source.getContext(), onUpdate: () => () => {} },
            { name: 'history', onUpdate: () => () => {}, async getContext() { return { messages: history.slice(), tools: {} }; } }],
        onAssistantMessage: message => history.push({ ...message, timestamp: Date.now() }),
        onToolResult: (message, raw) => { receipts.push({ message, raw }); history.push({ ...message, timestamp: Date.now() }); },
        onRunError: error => errors.push(error),
    });
    return {
        async step(label, calls = [], beforeReply) {
            history.push({ role: 'user', content: label, timestamp: Date.now() });
            provider.replyNext({ label, calls, beforeReply });
            await driver.trigger();
            await driver.runInFlight;
            assert.deepEqual(errors, []);
            assert.deepEqual(provider.failures, []);
            const request = provider.requests.find(request => request.label === label);
            assert.ok(request, label);
            return { wire: request.body, results: calls.length ? receipts.at(-1).raw : [] };
        },
        async close() { driver.stop(); driver.dispose(); await source.dispose(); },
    };
}

function independentHost(apps) {
    const history = [], receipts = [];
    facts.toolMessages = receipts;
    return {
        async step(label, calls = [], beforeReply) {
            history.push({ role: 'user', content: label });
            const observed = [], issues = [], routes = new Map();
            let turn;
            try {
                for (const { app, client } of apps) {
                    const result = await client.observe();
                    if (result.status === 'observed') observed.push({ app, client, observation: result.observation });
                    else issues.push(`${app.appId}: ${result.issue.code}: ${result.issue.message} (at ${result.issue.path})`);
                }
                const catalog = desktop.listApps().filter(item => item.appInstanceId);
                const directory = [...catalog.map(item => `app_id ${item.appId}`), ...issues].map(escapeXmlText).join('\n');
                const pages = observed.flatMap(({ app, observation }) => observation.views.map(view => ({ region: view.region,
                    content: buildViewMessageMarkup({ appId: app.appId, appName: app.name, viewId: view.id, viewType: view.type, region: view.region,
                        markup: view.content.value, refs: observation.refs.filter(ref => ref.viewId === view.id && ref.viewInstanceId === view.viewInstanceId) }),
                })));
                const tools = observed.flatMap(({ observation }) => observation.tools.map(tool => {
                    const name = buildPublicToolName(observation.source.appId, tool.viewType, tool.name);
                    routes.set(name, { appId: observation.source.appId, observationId: observation.observationId, toolId: tool.id });
                    return { type: 'function', function: { name, description: tool.description, parameters: projectNativeToolSchema(tool) } };
                }));
                tools.push({ type: 'function', function: { name: 'system-close_app', description: 'Close the selected application.',
                    parameters: { type: 'object', properties: { app_id: { type: 'string' } }, required: ['app_id'], additionalProperties: false } } });
                const user = content => ({ role: 'user', content });
                const wire = { model: 'stock-fixture', max_tokens: 750, messages: [user(DEFAULT_AOTUI_SYSTEM_INSTRUCTION),
                    ...pages.filter(page => page.region === 'static').map(page => user(page.content)),
                    user(`<desktop>\n${directory}\n</desktop>`), ...pages.filter(page => page.region === 'dynamic').map(page => user(page.content)), ...history], tools };
                const adopted = desktop.adoptTurn({ apps: observed.map(({ client, observation }) =>
                    ({ candidate: client.candidate(observation.observationId) })) });
                assert.equal(adopted.status, 'adopted', JSON.stringify(adopted));
                turn = adopted.turn;
                provider.replyNext({ label, calls, beforeReply });
                const response = await fetch(provider.url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(wire), signal: AbortSignal.timeout(8_000) });
                assert.ok(response.ok, await response.clone().text());
                const message = (await response.json()).choices[0].message;
                history.push(message);
                const results = [];
                for (const call of message.tool_calls ?? []) {
                    const name = call.function.name, input = JSON.parse(call.function.arguments);
                    const route = routes.get(name);
                    let result;
                    if (route) {
                        const { appId, observationId, toolId } = route;
                        const { view_id: viewId, ...business } = input;
                        const receipt = await turn.invoke(appId, { invocationId: call.id, observationId, toolId,
                            ...(viewId === undefined ? {} : { viewId }), input: business });
                        const outcome = receipt.receipt?.outcome;
                        result = outcome?.status === 'succeeded' ? { outcomeStatus: 'succeeded', result: outcome.value?.data ?? outcome.value }
                            : { outcomeStatus: outcome?.status ?? 'rejected', error: { code: outcome?.code ?? receipt.code, message: outcome?.message ?? receipt.message } };
                        receipts.push({ id: call.id, receipt });
                    } else {
                        assert.equal(name, 'system-close_app');
                        const app = catalog.find(app => app.appId === input.app_id);
                        assert.ok(app);
                        assert.equal((await appClient(desktop, app.appId).running.beginClose().completion).ok, true);
                        result = { outcomeStatus: 'succeeded' };
                    }
                    results.push({ toolCallId: call.id, ...result });
                    history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
                }
                assert.deepEqual(provider.failures, []);
                return { wire: provider.requests.find(request => request.label === label).body, results };
            } finally {
                turn?.release();
                for (const { client, observation } of observed) client.release(observation.observationId);
            }
        },
    };
}

async function update(path, client, operation) {
    const filename = join(path, 'update.txt');
    await writeFile(filename + '.next', operation);
    await rename(filename + '.next', filename);
    return watchUntil(async () => {
        assert.deepEqual(await journal(path, 'update-errors'), []);
        if (!(await journal(path, 'updates')).some(entry => entry.next === operation)) return;
        const preview = await client.preview();
        return preview.status === 'previewed' ? preview : undefined;
    });
}

async function inspect(client) {
    const result = await client.observe();
    assert.equal(result.status, 'observed');
    client.release(result.observation.observationId);
    return result.observation;
}

async function scenario(host, inventory, inventoryPath, plainPath) {
    const initial = (await host.step('initial Markdown')).wire;
    const rawIds = Object.keys(RAW_VIEWS).map(key => [key, `${key}_1`]);
    const raw = Object.fromEntries([STOCK_APP, PLAIN_APP].map(app => [app, Object.fromEntries(rawIds
        .map(([key, id]) => [key, page(initial, app, id)]))]));
    const filePage = page(initial, STOCK_APP, 'files_1');
    const files = tableCells(filePage.body);
    facts.initial = { raw, expected: { raw: RAW_VIEWS, stock: STOCK, diagram: DIAGRAM },
        stock: tableCells(page(initial, STOCK_APP, 'stock').body), files: { ...filePage, ...files },
        diagram: [page(initial, STOCK_APP, 'diagram_1').body, page(initial, PLAIN_APP, 'diagram_1').body].map(diagram) };

    for (const app of [STOCK_APP, PLAIN_APP]) for (const [id, value] of Object.entries(RAW_VIEWS)) {
        assert.equal(raw[app][id].type, 'raw_markdown');
        assert.equal(raw[app][id].body, value, `${app} ${id}`);
        assert.doesNotMatch(raw[app][id].xml, /Available references/);
    }
    assert.match(raw[STOCK_APP].split_raw.xml, /&amp;amp; &lt;literal&gt; 🧪/);
    assert.match(raw[PLAIN_APP].raw.xml, /&#13;\n&#13;\n/);
    assert.deepEqual(facts.initial.stock.rows, STOCK);
    assert.deepEqual(facts.initial.stock.code, [PIPE_CODE, BACKSLASH_CODE]);
    assert.deepEqual(facts.initial.stock.inline, [['strong', 'Ready', null], ['em', 'today', null], ['a', 'box', 'https://example.test/box']]);
    const fileCases = [
        ['literal_plain', FILES.literalName, []],
        ['literal_link', FILES.linkShapedName, []],
        ['explicit_link', 'reportold.txt', [['a', 'old', 'draft']]],
        ['literal_entity', FILES.entityName, []],
        ['explicit_code', FILES.literalName, [['code', FILES.literalName, null]]],
        ['explicit_emphasis', `${FILES.literalName} ${FILES.entityName}`, [['strong', FILES.literalName, null], ['em', FILES.entityName, null]]],
        ['link_with_space', 'stock list', [['a', 'stock list', FILES.spacedTarget]]],
        ['link_with_punctuation', `!${FILES.mixedLabel}`, [['a', FILES.mixedLabel, FILES.mixedTarget]]],
        ['literal_urls', FILES.literalUrls, []],
        ['pipe_and_backslashes', `${FILES.pipeAndBackslashes} and ${FILES.codeWithPipe}`, [['code', FILES.codeWithPipe, null]]],
    ];
    assert.deepEqual(files.rows, [FILES.headers, ...fileCases.map(([name, text]) => [name, text])]);
    const marks = files.marks.map(row => row.map(cell => cell.map(([type, text, href]) => [type, text, href === null ? null : decodeURI(href)])));
    assert.deepEqual(marks, [[[], []], ...fileCases.map(([, , expected]) => [[], expected])]);
    assert.deepEqual(facts.initial.diagram, [{ lang: 'mermaid', text: DIAGRAM }, { lang: 'mermaid', text: DIAGRAM }]);
    assert.match(page(initial, STOCK_APP, 'diagram_1').xml, /A --&gt; B/);
    assert.match(page(initial, STOCK_APP, 'inline_flow_1').body, /Hello \*\*world\*\*!\nDone\.[\s\S]+First \*second\*\./);

    const first = await inspect(inventory);
    assert.equal((await host.step('make left read-only', [change('readonly', 'read_only')])).results[0].outcomeStatus, 'succeeded');
    const readOnly = await inspect(inventory);
    const itemViews = view => view.views.filter(view => view.type === 'item').map(({ id, viewInstanceId, content }) => ({ id, viewInstanceId, content }));
    assert.deepEqual(itemViews(readOnly), itemViews(first));
    assert.equal(new Set(itemViews(first).map(view => view.viewInstanceId)).size, 2);
    assert.equal(readOnly.refs.filter(ref => ref.refId === 'value').length, 2);
    assert.ok(readOnly.source.revision > first.source.revision);
    let newer;
    const selected = await host.step('use the shared tool after read-only', [apply('blocked-left', 'left_1'), apply('captured-ref', 'right_1')],
        async () => { newer = await update(inventoryPath, inventory, 'new_ref'); });
    assert.ok(newer.source.revision > readOnly.source.revision);
    assert.deepEqual(itemViews(newer), itemViews(first));
    assert.deepEqual(readOnly.tools.find(tool => tool.name === 'apply').eligibleViewIds, ['right_1']);
    for (const id of ['left_1', 'right_1']) assert.equal(page(selected.wire, STOCK_APP, id).xml, page(initial, STOCK_APP, id).xml);
    assert.equal(toolNames(selected.wire).filter(name => name === STOCK_APP + '-item-apply').length, 1);
    const schema = selected.wire.tools.find(tool => tool.function.name === STOCK_APP + '-item-apply').function.parameters;
    assert.equal(schema.properties.view_id.type, 'string');
    assert.equal(Object.hasOwn(schema.properties.view_id, 'enum'), false);
    assert.ok(schema.required.includes('view_id'));
    assert.equal(selected.results[0].outcomeStatus, 'rejected');
    assert.deepEqual({ ...selected.results[1].result }, { id: 'right', value: 'left in original observation' }, JSON.stringify(selected.results[1]));
    facts.eligibility = { original: itemViews(first), readOnly: readOnly.tools.find(tool => tool.name === 'apply').eligibleViewIds,
        newerRevision: newer.source.revision, originalRevision: readOnly.source.revision, schema, results: selected.results };

    const faulty = await host.step('save then produce an invalid table', [change('write-once', 'save_bad_table'), apply('fault-stale-call', 'right_1')]);
    assert.equal(faulty.results[0].outcomeStatus, 'succeeded');
    assert.equal(faulty.results[0].result.saved, true);
    const issue = { ...faulty.results[0].result.projection };
    assert.equal(issue.code, 'SNAPSHOT_INVALID');
    assert.equal(issue.path, '$.views[4].content');
    assert.match(issue.message, /Inventory data could not render a complete Markdown table/);
    assert.equal(faulty.results[1].outcomeStatus, 'rejected');
    const diagnosis = await inventory.preview();
    assert.deepEqual({ ...diagnosis.issue }, issue);
    const degraded = await host.step('use the healthy App while inventory is degraded', [ping('healthy-during-fault')]);
    assert.equal(degraded.wire.messages.some(message => typeof message.content === 'string' && message.content.startsWith('<view ') &&
        message.content.split('\n', 1)[0].includes(` app_id="${STOCK_APP}"`)), false);
    assert.ok(toolNames(degraded.wire).every(name => !name.startsWith(STOCK_APP + '-')));
    assert.ok(toolNames(degraded.wire).includes('system-close_app'));
    assert.ok(toolNames(degraded.wire).includes(PLAIN_APP + '-healthy-ping'));
    assert.deepEqual({ ...degraded.results[0].result }, { peer: 'healthy' });
    const notice = degraded.wire.messages.find(message => typeof message.content === 'string' && message.content.startsWith('<desktop>')).content;
    assert.match(notice, /SNAPSHOT_INVALID.*Inventory data.*\$\.views\[4\]\.content/);
    const repaired = await update(inventoryPath, inventory, 'repair');
    assert.deepEqual(itemViews(repaired), itemViews(first));
    const restored = await host.step('show the repaired table');
    const cells = tableCells(page(restored.wire, STOCK_APP, 'stock').body);
    assert.deepEqual(cells.rows, STOCK.map((row, index) => index === 2 ? [row[0], '4'] : row));
    assert.equal(page(restored.wire, STOCK_APP, 'files_1').xml, filePage.xml);
    assert.ok(toolNames(restored.wire).includes(STOCK_APP + '-item-apply'));

    facts.calls = [selected, faulty, degraded].flatMap(turn => turn.results);
    facts.fault = { issue, diagnosis, notice, repaired: cells };
    facts.effects = { writes: await journal(inventoryPath, 'writes'), stored: await readFile(join(inventoryPath, 'saved.txt'), 'utf8'),
        diagnostics: await journal(inventoryPath, 'diagnostics'), handlers: await journal(inventoryPath, 'handler'), pings: await journal(plainPath, 'pings') };
    assert.deepEqual(facts.effects, { writes: [{ operation: 'save_bad_table' }], stored: 'stored once', diagnostics: [issue],
        handlers: [{ id: 'right', value: 'left in original observation' }], pings: [{ peer: 'healthy' }] });
    facts.passed = true;
}

let host;
try {
    const inventoryPath = join(dataDirectory, 'inventory'), plainPath = join(dataDirectory, 'plain');
    const inventory = await boot(STOCK_APP, 'batch-five-inventory.js', inventoryPath);
    const plain = await boot(PLAIN_APP, 'batch-five-plain.js', plainPath);
    host = mode === 'product' ? await productHost() : independentHost([inventory, plain]);
    await scenario(host, inventory.client, inventoryPath, plainPath);
} finally {
    await host?.close?.();
    facts.shutdown = await runtime.beginClose().completion;
    await provider.close();
    await writeFile(join(folder, mode + '.json'), JSON.stringify(facts, null, 2));
}
assert.equal(facts.shutdown.resourcesReleased, true);
