import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '@aotui/runtime';
import { DESKTOP_TOOL_NAMES, projectDesktop, routeNativeInvocation, fitWindowPresentation } from '@aotui/runtime/adapters';
import { fixtureAppPath, appClient, fixtureProvider, journal, modelCall } from './batch-two-support.mjs';
import { APP, INPUT, A_NOTE, APP_NOTE, currentReportId, openFiles, onFile, windowAction, pageFor, wireCost, setupFiles, namesOf,
    updateFile } from './batch-four-support.mjs';
import { presentWindows } from './dist/batch-four-readme.js';

const folder = process.argv[2];
const repair = process.argv[3] === 'repair';
await setupFiles(folder, repair ? 'B-STAYS-HINTED ' + 'b'.repeat(45_000) : undefined);
const runtime = createRuntime();
const provider = await fixtureProvider();
const history = [];
const facts = { requests: provider.requests, trials: [], adoptions: [], receipts: [], toolMessages: [], passed: false };
const moduleURL = new URL('./dist/batch-four-files.js', import.meta.url).href;
const desktop = await runtime.createDesktop();
await desktop.registerPendingApp({ installationId: 'files_install', localPath: await fixtureAppPath(moduleURL, APP, folder), config: { folder, staticB: !repair } });
const { app, client } = appClient(desktop, (await desktop.openApp('files_install')).appId);
const fullLayout = { hints: new Set(), managementOnly: false };
let previous = new Map();
let staticOrder = new Map();
let fileAppClosed = false;
let inputLimit = INPUT;
let extra = '';
let lastInput;
const disabled = new Set();
const reports = new Map();
const notes = new Map();
const reportTool = 'system-read_window_budget';
const trialId = '00000000-0000-0000-0000-000000000000';
const windowKey = (appId, mount) => JSON.stringify([appId, mount]);
const noteKey = (windows, mount = '') => windowKey(windows.instanceId, mount);
function displayedWindows(appId, instanceId) {
    const windows = desktop.getAppWindows(appId, instanceId);
    return windows && { ...windows, expanded: !notes.has(noteKey(windows)),
        views: windows.views.map(view => ({ ...view, expanded: !notes.has(noteKey(windows, view.viewInstanceId)) })) };
}

function reportPage(report, page) {
    const start = (page - 1) * 4;
    return { report_id: report.id, page, ...report.summary, windows: report.rows.slice(start, start + 4),
        ...(start + 4 < report.rows.length ? { next_page: page + 1 } : {}) };
}

function necessaryHistory(messages) {
    const user = messages.findLast(message => message.role === 'user');
    const assistant = messages.findLastIndex(message => message.role === 'assistant' && message.tool_calls?.length);
    const ids = new Set(messages[assistant]?.tool_calls.map(call => call.id) ?? []);
    return messages.filter((message, index) => message === user || index === assistant ||
        (index > assistant && message.role === 'tool' && ids.has(message.tool_call_id)));
}

function readable(record) {
    return record.until > Date.now() && record.scope.every(({ installationId, appId, instanceId, views }) => {
        const current = !disabled.has(installationId) && desktop.getAppWindows(appId, instanceId);
        return current?.instanceId === instanceId && views.every(([id, mount]) =>
            current.views.some(view => view.viewId === id && view.viewInstanceId === mount));
    });
}

function retain(report) {
    if (!report || reports.has(report.id)) return;
    reports.set(report.id, { ...report, until: Date.now() + 5 * 60_000 });
    if (reports.size > 8) reports.delete(reports.keys().next().value);
}

function attachReport(message, report) {
    return { ...message, content: JSON.stringify({ result: JSON.parse(message.content), window_budget: reportPage(report, 1) }) };
}

async function prepare(label, upcoming = history, receiptIndex, expansion) {
    const discovered = desktop.listApps().filter(item => !disabled.has(item.installationId));
    const catalog = new Map();
    const captured = [];
    const candidateScope = desktop.createCandidateScope();
    const release = () => { assert.deepEqual(candidateScope.discard(), []); };
    try {
        for (const item of discovered) {
            if (!item.appInstanceId) continue;
            let windows = displayedWindows(item.appId, item.appInstanceId);
            assert.ok(windows);
            if (expansion?.appId === item.appId) {
                assert.equal(windows.instanceId, expansion.instanceId);
                if (expansion.viewInstanceId) windows = { ...windows, views: windows.views.map(view =>
                    view.viewInstanceId === expansion.viewInstanceId ? { ...view, expanded: true } : view) };
                else windows = { ...windows, expanded: true };
            }
            catalog.set(item.appId, windows);
            if (!windows.expanded) continue;
            const { running } = appClient(desktop, item.appId);
            const observed = await candidateScope.observe(running);
            assert.equal(observed.status, 'prepared', JSON.stringify(observed));
            captured.push({ name: item.name, candidate: observed.candidate, observation: observed.candidate.observation, windows });
        }
        const scope = discovered.filter(item => catalog.has(item.appId)).map(item => {
            const windows = catalog.get(item.appId);
            return { installationId: item.installationId, appId: item.appId, instanceId: item.appInstanceId,
                views: windows.expanded ? windows.views.map(view => [view.viewId, view.viewInstanceId]) : [] };
        });
        for (const [id, record] of reports) if (!readable(record)) reports.delete(id);
        const hint = () => 'This View is open. Its body does not fit the current model request. Collapse or close other windows.';
        const make = (layout, report, includeReportTool = false) => {
            const staticPages = new Map(), rows = new Map();
            const dynamicMessages = [];
            const inputs = captured.map(item => {
                const notesByMount = new Map(item.windows.views.filter(view => !view.expanded)
                    .map(view => [view.viewInstanceId, notes.get(noteKey(item.windows, view.viewInstanceId)) ?? '']));
                const hints = new Set(item.observation.views.filter(view => layout.hints.has(windowKey(item.windows.appId, view.viewInstanceId)))
                    .map(view => view.viewInstanceId));
                const windows = new Map(item.observation.views.map(view => [view.viewInstanceId, notesByMount.has(view.viewInstanceId)
                    ? { kind: 'collapsed', note: notesByMount.get(view.viewInstanceId) } :
                        hints.has(view.viewInstanceId) ? { kind: 'hint', text: hint() } : { kind: 'body' }]));
                return { item, notesByMount, hints, windows };
            });
            const projection = projectDesktop({
                apps: inputs.map(({ item, windows }) => ({ observation: item.observation, windows })), compact: layout.managementOnly, includeInstruction: !layout.managementOnly,
                catalog: discovered.map(app => {
                    const windows = catalog.get(app.appId);
                    return { app, windows, note: windows && notes.get(noteKey(windows)) };
                }),
                capabilities: Object.keys(DESKTOP_TOOL_NAMES).filter(key => key !== 'readWindowBudget' || includeReportTool || report || reports.size),
                desktopSuffix: report ? `\nUse ${reportTool} with report_id ${report.id}.` : '',
            });
            assert.deepEqual(projection.issues, []);
            const selections = inputs.flatMap(({ item, hints, notesByMount }) => {
                const selection = projection.appSelections.find(entry => entry.observationId === item.observation.observationId)?.windows;
                // The published single-App example must produce the same pages and active mounts.
                const example = presentWindows(item.name, item.observation, item.windows, { ...layout, hints }, hint, notesByMount);
                assert.deepEqual(example.selection, selection ?? { activeViews: [], closeViews: [] });
                assert.deepEqual(example.pages, projection.views.filter(view => view.appId === item.windows.appId)
                    .map(({ region, content }) => ({ role: 'user', region, content })));
                return selection ? [{ ...item, selection }] : [];
            });
            for (const { appId, viewInstanceId, viewId, region, content, kind } of projection.views) {
                const key = windowKey(appId, viewInstanceId);
                rows.set(key, { app_id: appId, view_id: viewId, bytes: Buffer.byteLength(content), body: kind === 'body' });
                if (region === 'static') staticPages.set(key, content);
                else dynamicMessages.push({ role: 'user', content });
            }
            const directory = { role: 'user', content: projection.desktop };
            const fixed = [...staticOrder.keys()].filter(id => staticPages.has(id) && staticOrder.get(id) === staticPages.get(id));
            const ordered = new Map([...fixed, ...[...staticPages.keys()].filter(id => !fixed.includes(id))].map(id => [id, staticPages.get(id)]));
            const staticMessages = [...ordered.values()].map(content => ({ role: 'user', content }));
            const withReport = report && receiptIndex !== undefined
                ? upcoming.map((message, index) => index === receiptIndex ? attachReport(message, report) : message)
                : upcoming;
            const messages = [...(!layout.managementOnly ? [{ role: 'user', content: projection.instruction }, ...staticMessages] : []),
                directory, ...dynamicMessages,
                ...(extra && !layout.managementOnly ? [{ role: 'user', content: extra }] : []),
                ...(layout.managementOnly ? necessaryHistory(withReport) : withReport)];
            const tools = projection.tools.map(({ name, description, inputSchema }) =>
                ({ type: 'function', function: { name, description, parameters: inputSchema } }));
            const body = { model: 'window-fixture', max_tokens: 750, messages, tools };
            return { measurement: wireCost(body, inputLimit), body, layout, catalog, selections, rows,
                tools: projection.tools, closeRoutes: projection.closeRoutes, ordered, release };
        };
        let full = make(fullLayout);
        if (full.measurement.estimated > inputLimit && !reports.size) full = make(fullLayout, undefined, true);
        const candidates = [...full.rows].filter(([key, row]) => row.body && row.bytes > (previous.get(key)?.bytes ?? -1));
        const hinted = make({ hints: new Set(candidates.map(([key]) => key)), managementOnly: false });
        const expanded = candidates.filter(([key, row]) => hinted.rows.get(key).bytes < row.bytes).map(([key]) => key);
        const keepBodies = new Set(expansion?.bodies);
        for (const key of full.rows.keys()) if (previous.get(key)?.restoreBody) keepBodies.add(key);
        let selected = await fitWindowPresentation(full, expanded, async layout => {
            const first = make(layout, undefined, true);
            const rows = [...full.rows].map(([key, row]) => ({ app_id: row.app_id, view_id: row.view_id, full: row.bytes,
                presented: first.rows.get(key)?.bytes ?? 0 }));
            const report = { id: trialId, rows, summary: { complete: full.measurement,
                short_by: full.measurement.estimated - inputLimit, mode: layout.managementOnly ? 'management' : 'window_hints',
                presented: first.measurement } };
            let measured = make(layout, report);
            for (let pass = 0; pass < 4 && measured.measurement.estimated !== report.summary.presented.estimated; pass++) {
                report.summary.presented = measured.measurement;
                measured = make(layout, report);
            }
            return { ...measured, report };
        }, { keepBodies, requireBodies: !!expansion });
        if (selected.report && !expansion && (selected.measurement.estimated <= inputLimit || receiptIndex !== undefined)) {
            const { rows, summary } = selected.report;
            const key = JSON.stringify([scope, rows, summary]);
            const existing = [...reports.values()].find(record => record.key === key && readable(record));
            const report = { id: existing?.id ?? randomUUID(), rows, summary, key, scope };
            selected = { ...make(selected.layout, report), report };
        }
        facts.trials.push({ label, complete: full.measurement, selected: selected.measurement, managementOnly: selected.layout.managementOnly,
            hints: [...selected.layout.hints] });
        return selected;
    } catch (error) {
        release();
        throw error;
    }
}

async function step(label, calls, { addUser = true, saveText = true } = {}) {
    if (addUser) history.push({ role: 'user', content: label });
    const turn = await prepare(label);
    let active;
    try {
        assert.ok(turn.measurement.estimated <= inputLimit, JSON.stringify(turn.measurement));
        const encoded = JSON.stringify(turn.body);
        if (encoded === lastInput) return;
        const selected = turn.selections.filter(item => item.selection.activeViews.length || item.selection.closeViews.length);
        const adopted = desktop.adoptTurn({ apps: selected.map(({ candidate, selection }) => ({ candidate, windows: selection })) });
        assert.equal(adopted.status, 'adopted', JSON.stringify(adopted));
        assert.deepEqual(adopted.cleanupIssues, []);
        active = adopted.turn;
        turn.release();
        for (const { observation, selection } of selected) facts.adoptions.push({ label, appId: observation.source.appId, selection });
        retain(turn.report);
        staticOrder = turn.ordered;
        previous = new Map([...turn.rows].filter(([, row]) => row.body).map(([key, row]) => [key, { bytes: row.bytes }]));
        lastInput = encoded;
        provider.replyNext({ label, calls });
        const response = await fetch(provider.url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: encoded, signal: AbortSignal.timeout(5_000) });
        assert.ok(response.ok, await response.clone().text());
        const message = (await response.json()).choices[0].message;
        if (message.tool_calls?.length || saveText) history.push(message);
        const outputs = [];
        for (const call of message.tool_calls ?? []) {
            const name = call.function.name;
            const input = JSON.parse(call.function.arguments);
            const offered = turn.tools.find(tool => tool.name === name);
            let result;
            if (!name.startsWith('system-') || offered?.route) {
                const routed = routeNativeInvocation(turn.tools, name, input, call.id);
                if (routed.status === 'ready') {
                    const { appId, instanceId: _instanceId, ...request } = routed.invocation;
                    result = await active.invoke(appId, request);
                } else result = routed.issue;
                facts.receipts.push({ label, id: call.id, result });
                result = result.receipt?.outcome ?? result;
            } else if (name === reportTool) {
                const stored = reports.get(input.report_id);
                result = stored && readable(stored) ? reportPage(stored, input.page) : { code: 'WINDOW_BUDGET_REPORT_UNAVAILABLE' };
                facts.receipts.push({ label, id: call.id, result });
            } else if (name === 'system-open_app') {
                const install = input.installation_id === app.installationId &&
                    desktop.listApps().find(candidate => candidate.installationId === app.installationId);
                result = install && ['pending', 'closed'].includes(install.status)
                    ? { app_id: (await desktop.openApp(install.installationId)).appId, status: 'succeeded' }
                    : { code: 'INVALID_APP_TARGET' };
            } else {
                const windows = turn.catalog.get(input.app_id);
                assert.ok(windows);
                const target = windows.views.find(view => view.viewId === input.view_id);
                const bound = target && { appId: windows.appId, instanceId: windows.instanceId,
                    viewId: target.viewId, viewInstanceId: target.viewInstanceId };
                if (name === 'system-collapse_view') {
                    desktop.revokeWindowAccess(active, bound);
                    notes.set(noteKey(windows, target.viewInstanceId), input.note ?? '');
                }
                else if (name === 'system-close_view') {
                    const route = turn.closeRoutes.find(route => route.appId === input.app_id && route.viewId === input.view_id);
                    result = route ? await desktop.closeView({turn:active, invocationId:call.id, target:{appId:route.appId,
                        instanceId:route.instanceId,viewId:route.viewId,viewInstanceId:route.viewInstanceId}})
                        : {kind:'refused',code:'VIEW_CLOSE_NOT_GRANTED'};
                }
                else if (name === 'system-close_app') {
                    assert.equal((await appClient(desktop, windows.appId).running.beginClose().completion).ok, true);
                    if (windows.appId === app.appId) fileAppClosed = true;
                }
                else if (name === 'system-expand_view' || name === 'system-expand_app') {
                    const mounts = bound ? [bound] : windows.views.filter(view => view.expanded);
                    const bodies = new Set(mounts.map(view => windowKey(windows.appId, view.viewInstanceId)));
                    const expansion = { appId: windows.appId, instanceId: windows.instanceId, ...bound, bodies };
                    const provisional = { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ status: 'succeeded' }) };
                    const pending = message.tool_calls.slice(outputs.length + 1).map(call =>
                        ({ role: 'tool', tool_call_id: call.id, content: '{"pending":true}' }));
                    const receipts = [...history, ...outputs, provisional, ...pending];
                    const feedbackIndex = history.length;
                    const trial = await prepare('expansion preflight ' + call.id, receipts, feedbackIndex, expansion);
                    trial.release();
                    let cost = trial.measurement;
                    if (cost.estimated <= inputLimit && trial.report) {
                        receipts[feedbackIndex] = attachReport(receipts[feedbackIndex], trial.report);
                        const sealed = await prepare('sealed expansion ' + call.id, receipts, undefined, expansion);
                        sealed.release();
                        cost = sealed.measurement;
                    }
                    if (cost.estimated > inputLimit) result = { code: 'WINDOW_EXPANSION_BUDGET_EXCEEDED', cost };
                    else {
                        assert.deepEqual(displayedWindows(windows.appId, windows.instanceId), windows);
                        notes.delete(noteKey(windows, target?.viewInstanceId));
                        for (const key of bodies) previous.set(key, { ...previous.get(key), restoreBody: true });
                    }
                }
                else if (name === 'system-collapse_app') {
                    desktop.revokeWindowAccess(active, { appId: windows.appId, instanceId: windows.instanceId }, 'all');
                    notes.set(noteKey(windows), input.note ?? '');
                }
                else throw new Error('No request route for ' + name);
                result ??= { status: 'succeeded' };
                facts.receipts.push({ label, id: call.id, result });
            }
            outputs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        if (outputs.length) {
            if (!fileAppClosed) {
                const trial = await prepare(label + ' before tool message', [...history, ...outputs], history.length);
                trial.release();
                if (trial.report) {
                    retain(trial.report);
                    outputs[0] = attachReport(outputs[0], trial.report);
                }
            }
            history.push(...outputs);
            facts.toolMessages.push({ label, outputs });
        }
        return turn.body;
    } finally { active?.release(); turn.release(); }
}

const result = id => facts.receipts.find(receipt => receipt.id === id)?.result;

async function onceOnly() {
    await step('open A and B', [openFiles('open', 'A', 'B')]);
    await step('write B once', [onFile('write-b', 'edit', 'B', { mode: 'large' })]);
    const hint = await step('open with budget hint', [
        onFile('denied-hidden-ref', 'echo', 'A', { value: '$ref.window_files.file_B_1.content' }),
        onFile('hinted-receiver', 'echo', 'B', { value: 'echo while hinted' }),
    ]);
    assert.match(pageFor(hint, 'B'), /body does not fit/);
    assert.doesNotMatch(pageFor(hint, 'B'), /B-LATEST|Available references/);
    assert.match(pageFor(hint, 'A'), /A-BODY/);
    assert.equal(result('denied-hidden-ref').receipt.outcome.code, 'REF_NOT_VISIBLE');
    assert.equal(result('hinted-receiver').code, 'TOOL_UNAVAILABLE');
    await step('collapse A to make room', [windowAction('note-a', 'collapse_view', 'A', { note: A_NOTE })]);
    const recovered = await step('normal restored request', []);
    assert.match(pageFor(recovered, 'A'), /Check A &lt;later&gt; &amp; keep the original note\./);
    assert.doesNotMatch(pageFor(recovered, 'A'), /A-BODY/);
    assert.match(pageFor(recovered, 'B'), /B-LATEST/);
    await step('too large to expand A', [windowAction('a-too-large', 'expand_view', 'A')]);
    assert.equal(result('a-too-large').code, 'WINDOW_EXPANSION_BUDGET_EXCEEDED');
    const windows = displayedWindows(app.appId, app.appInstanceId);
    const foldedA = windows.views.find(view => view.viewId === 'file_A_1');
    assert.equal(foldedA.expanded, false);
    assert.equal(notes.get(noteKey(windows, foldedA.viewInstanceId)), A_NOTE);

    inputLimit = 60_000;
    await step('collapse with app note', [windowAction('app-note', 'collapse_app', undefined, { note: APP_NOTE })]);
    const appCollapsed = await step('expand the app', [windowAction('app-expand', 'expand_app')]);
    assert.match(appCollapsed.messages.find(message => message.content?.startsWith?.('<desktop>')).content, /Return to this workspace &lt;later&gt; &amp;/);
    assert.equal(pageFor(appCollapsed, 'A'), undefined);
    assert.equal(pageFor(appCollapsed, 'B'), undefined);
    const appExpanded = await step('notes survive App expand', [openFiles('open-more', 'C', 'D', 'E')]);
    assert.match(pageFor(appExpanded, 'A'), /Check A/);
    assert.match(pageFor(appExpanded, 'B'), /B-LATEST/);

    extra = 'EXCLUDED SOURCE ' + 'x'.repeat(25_000);
    inputLimit = INPUT;
    const management = await step('manage only and close A', [windowAction('close-a', 'close_view', 'A')]);
    assert.ok(namesOf(management).includes('system-close_view'));
    assert.ok(namesOf(management).every(name => name.startsWith('system-')));
    assert.equal(pageFor(management, 'B'), undefined);
    assert.doesNotMatch(JSON.stringify(management), /EXCLUDED SOURCE/);
    assert.equal(result('close-a').receipt.outcome.status, 'succeeded');
    assert.equal(desktop.getAppWindows(app.appId, app.appInstanceId).views.some(v=>v.viewId==='file_A_1'), false);
    const budget = JSON.parse(facts.toolMessages.at(-1).outputs[0].content).window_budget;
    assert.equal(budget.next_page, 2);
    const paged = await step('read the same report next page', [modelCall('next-page', reportTool, { report_id: budget.report_id, page: 2 })]);
    assert.ok(namesOf(paged).includes(reportTool));
    const before = [facts.adoptions.length, provider.requests.length];
    inputLimit = 300;
    const minimum = await prepare('minimum cannot fit');
    minimum.release();
    assert.ok(minimum.measurement.estimated > inputLimit);
    assert.deepEqual([facts.adoptions.length, provider.requests.length], before);

    extra = '';
    inputLimit = 60_000;
    await step('close the original app after recovery', [windowAction('close-app', 'close_app')]);
    assert.equal(result('close-app').status, 'succeeded');
    assert.equal(desktop.getAppWindows(app.appId, app.appInstanceId), undefined);
    facts.writes = await journal(folder, 'writes');
    facts.closes = await journal(folder, 'closes');
    assert.deepEqual(facts.writes.map(entry => entry.name), ['B']);
    assert.deepEqual(facts.closes.map(entry => entry.name), ['A']);
    assert.match(await readFile(join(folder, 'B.txt'), 'utf8'), /^B-LATEST/);
}

async function repairChecks() {
    await step('open B, C and A', [openFiles('open-for-expansion', 'B', 'C', 'A', 'D')]);
    const beforeCollapse = await step('save a place at C and A', [
        windowAction('note-c', 'collapse_view', 'C', { note: 'Return to C' }),
        windowAction('keep-a', 'collapse_view', 'A', { note: A_NOTE }),
    ]);
    assert.match(pageFor(beforeCollapse, 'B'), /body does not fit/);
    const windows = () => displayedWindows(app.appId, app.appInstanceId);
    const mount = name => windows().views.find(view => view.viewId === `file_${name}_1`);
    const originalC = mount('C').viewInstanceId;
    await updateFile(folder, client, 'C', 'C-LATEST-WHILE-COLLAPSED', false);
    const sentBeforeExpansion = provider.requests.length;
    const adopted = facts.adoptions.length;
    const beforeExpand = await step('expand the small C', [windowAction('restore-c', 'expand_view', 'C'),
        onFile('not-yet-a-source', 'echo', 'D', { value: '$ref.window_files.file_C_1.content' })]);
    assert.equal(provider.requests.length - sentBeforeExpansion, 1);
    assert.equal(facts.adoptions.length - adopted, 1);
    assert.match(pageFor(beforeExpand, 'C'), /Return to C/);
    assert.equal(result('restore-c').status, 'succeeded');
    assert.equal(result('not-yet-a-source').receipt.outcome.code, 'REF_NOT_VISIBLE');
    assert.equal(mount('C').expanded, true);
    assert.equal(mount('C').viewInstanceId, originalC);
    const restored = await step('read C after new adoption', [onFile('now-a-source', 'echo', 'C', { value: '$ref.window_files.file_C_1.content' }),
        onFile('b-still-not-a-source', 'echo', 'C', { value: '$ref.window_files.file_B_1.content' })], { addUser: false });
    assert.match(pageFor(restored, 'B'), /body does not fit/);
    assert.match(pageFor(restored, 'C'), /C-LATEST-WHILE-COLLAPSED[\s\S]+Available references/);
    assert.equal(result('now-a-source').receipt.outcome.value.data.value, 'C-LATEST-WHILE-COLLAPSED');
    assert.equal(result('b-still-not-a-source').receipt.outcome.code, 'REF_NOT_VISIBLE');

    await updateFile(folder, client, 'A', 'A-TOO-LARGE ' + 'a'.repeat(45_000), false);
    await step('try to restore the too-large A', [windowAction('reject-large-a', 'expand_view', 'A')]);
    assert.equal(result('reject-large-a').code, 'WINDOW_EXPANSION_BUDGET_EXCEEDED');
    assert.ok(result('reject-large-a').cost.estimated > inputLimit);
    assert.equal(mount('A').expanded, false);
    assert.equal(notes.get(noteKey(windows(), mount('A').viewInstanceId)), A_NOTE);

    history.length = 0;
    const smallFolder = join(folder, 'small');
    await setupFiles(smallFolder);
    await desktop.registerPendingApp({ installationId: 'small_install', localPath: await fixtureAppPath(moduleURL, APP, smallFolder), config: { folder: smallFolder } });
    const smallId = (await desktop.openApp('small_install')).appId;
    await step('open small App children', [modelCall('open-small-app-children', smallId + '-workspace-open_file', { names: ['C', 'D'] })]);
    await step('save a child note and fold the small App', [
        windowAction('collapse-small-child', 'collapse_view', 'D', { app_id: smallId, note: 'D child <note>' }),
        windowAction('collapse-small-app', 'collapse_app', undefined, { app_id: smallId, note: APP_NOTE }),
    ]);
    const appExpansion = await step('expand just the small App', [windowAction('resume-small-app', 'expand_app', undefined, { app_id: smallId })]);
    assert.equal(pageFor(appExpansion, 'C', smallId), undefined);
    assert.equal(result('resume-small-app').status, 'succeeded');
    const next = await step('small App restores the open child and keeps the child note', [
        modelCall('read-restored-child', smallId + '-file-echo', { view_id: 'file_C_1', value: `$ref.${smallId}.file_C_1.content` }),
        modelCall('child-note-has-no-ref', smallId + '-file-echo', { view_id: 'file_C_1', value: `$ref.${smallId}.file_D_1.content` }),
    ], { addUser: false });
    assert.match(pageFor(next, 'C', smallId), /C-BODY[\s\S]+Available references/);
    assert.match(pageFor(next, 'D', smallId), /D child &lt;note&gt;/);
    assert.doesNotMatch(pageFor(next, 'D', smallId), /D-BODY|Available references/);
    assert.match(pageFor(next, 'B'), /body does not fit/);
    assert.equal(result('read-restored-child').receipt.outcome.value.data.value, 'C-BODY');
    assert.equal(result('child-note-has-no-ref').receipt.outcome.code, 'REF_NOT_VISIBLE');

    facts.idle = [];
    for (const mode of ['window_hints', 'management']) {
        if (mode === 'management') extra = 'OTHER SOURCE ' + 'x'.repeat(27_000);
        const seed = await step('freeze history in ' + mode, [], { saveText: false });
        const id = currentReportId(seed);
        assert.ok(id);
        assert.equal(pageFor(seed, 'B')?.includes('body does not fit') ?? false, mode === 'window_hints');
        const count = () => [facts.adoptions.length, provider.requests.length];
        const before = count(), frozen = JSON.stringify(history);
        const notify = () => step('same idle notification', [], { addUser: false, saveText: false });
        await notify();
        await notify();
        assert.deepEqual(count(), before);
        assert.equal(JSON.stringify(history), frozen);
        const writes = (await journal(folder, 'writes')).length + (await journal(smallFolder, 'writes')).length;
        assert.equal(writes, 0);
        facts.idle.push({ mode, reportId: id, before, after: count(), writes, historyUnchanged: true });
        await step('read the old second report page for ' + mode, [modelCall('page-' + mode, reportTool, { report_id: id, page: 2 })]);
        assert.equal(result('page-' + mode).report_id, id);
        assert.equal(result('page-' + mode).mode, mode);
        assert.equal(result('page-' + mode).page, 2);
    }
    await step('fold C while operating in management mode', [windowAction('c-only-management', 'collapse_view', 'C', { note: 'Keep C folded' })]);
    await step('management could fit but C cannot', [windowAction('reject-only-management', 'expand_view', 'C')]);
    assert.equal(result('reject-only-management').code, 'WINDOW_EXPANSION_BUDGET_EXCEEDED');
    assert.equal(mount('C').expanded, false);
    assert.equal(notes.get(noteKey(windows(), mount('C').viewInstanceId)), 'Keep C folded');

    disabled.add(app.installationId);
    const revoked = facts.idle.at(-1).reportId;
    await step('old locators stop working after permission revocation', [modelCall('reject-revoked-report', reportTool, { report_id: revoked, page: 1 })]);
    assert.equal(result('reject-revoked-report').code, 'WINDOW_BUDGET_REPORT_UNAVAILABLE');
    facts.writes = [...await journal(folder, 'writes'), ...await journal(smallFolder, 'writes')];
    assert.deepEqual(facts.writes, []);
}

try {
    await (repair ? repairChecks() : onceOnly());
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    facts.shutdown = await runtime.beginClose().completion;
    await provider.close();
    facts.lifecycle = await journal(folder, 'lifecycle');
    await writeFile(join(folder, 'independent-windows.json'), JSON.stringify(facts, null, 2));
}
assert.equal(facts.shutdown.resourcesReleased, true);
