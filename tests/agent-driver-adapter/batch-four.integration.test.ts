import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createRuntime, type AppInteractionPolicy, type IDesktop, type Observation } from '@aotui/runtime';
import { AgentDriverV2, type DrivenSourceContext, type MessageWithTimestamp, type ToolResult } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { fixtureAppPath, appClient, fixtureProvider, journal, modelCall, observe, watchUntil } from '../fixtures/batch-two-support.mjs';
import { APP, INPUT, OUTPUT, A_NOTE, APP_NOTE, currentReportId, namesOf, onFile, openFiles, pageFor, setupFiles, tool,
    updateFile, windowAction, wireCost } from '../fixtures/batch-four-support.mjs';

const run = promisify(execFile);
let scratch: string, consumer: string, evidence: string, moduleURL: string;
beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'aotui-batch-four-test-'));
    consumer = process.env.AOTUI_BATCH_FOUR_PACKAGE_DIR || join(scratch, 'consumer');
    evidence = process.env.AOTUI_BATCH_FOUR_EVIDENCE || scratch;
    await mkdir(evidence, { recursive: true });
    if (!process.env.AOTUI_BATCH_FOUR_PACKAGE_DIR) await run(process.execPath,
        [new URL('../fixtures/prepare-batch-two-consumer.mjs', import.meta.url).pathname, consumer, 'batch-four']);
    moduleURL = pathToFileURL(join(consumer, 'dist', 'batch-four-files.js')).href;
}, 90_000);
afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

async function start(desktop: IDesktop, folder: string, staticB: boolean, policy?: AppInteractionPolicy) {
    await desktop.registerPendingApp({ installationId: 'files_install', localPath: await fixtureAppPath(moduleURL, APP, folder), config: { folder, staticB } });
    return (await desktop.openApp('files_install', { policy })).appId;
}

async function productSession(name: string, staticB = false, b?: string) {
    const folder = join(scratch, name);
    await setupFiles(folder, b);
    const runtime = createRuntime();
    const provider = await fixtureProvider();
    const desktop = await runtime.createDesktop();
    const id = await start(desktop, folder, staticB);
    const { app, client } = appClient(desktop, id);
    const source = new SemanticAOTUIDrivenSource(desktop);
    const history: MessageWithTimestamp[] = [], errors: Error[] = [];
    const results: { message: unknown; raw: readonly ToolResult[] }[] = [];
    const rawInput = { cap: INPUT, other: '' };
    const adoptions: number[] = [];
    const facts: Record<string, unknown> = { history, errors, results, requests: provider.requests, costs: [], adoptions };
    let wake: (() => void) | undefined;
    let completed = 0;
    const tracked = (context: DrivenSourceContext): DrivenSourceContext => ({
        ...context,
        ...(context.adopt ? { adopt: async () => { await context.adopt!(); adoptions.push(provider.requests.length); } } : {}),
        ...(context.fitModelBudget ? { fitModelBudget: async (...args) => {
            const fit = await context.fitModelBudget!(...args);
            return fit.context ? { ...fit, context: tracked(fit.context) } : fit;
        } } : {}),
    });
    const driver = new AgentDriverV2({
        llm: { model: 'window-fixture', apiKey: 'test-only', provider: { id: 'window-fixture', baseURL: provider.url },
            inputBudget: () => ({ contextWindow: rawInput.cap + OUTPUT, maxOutputTokens: OUTPUT }) },
        sources: [{ name: source.name, getContext: async () => tracked(await source.getContext()),
            onUpdate: callback => { wake = callback; return () => { wake = undefined; }; } },
            { name: 'history', onUpdate: () => () => {}, async getContext() { return { messages: history.slice(), tools: {} }; } },
            { name: 'unrelated projection', onUpdate: () => () => {}, async getContext() { return { tools: {}, messages: rawInput.other ?
                [{ role: 'user' as const, region: 'dynamic' as const, content: rawInput.other, timestamp: Date.now() }] : [] }; } }],
        workLoop: { debounceMs: 1 },
        onAssistantMessage: message => {
            if (message.content !== 'frozen fixture history') history.push({ ...message, timestamp: Date.now() });
        },
        onToolResult: (message, raw) => { history.push({ ...message, timestamp: Date.now() }); results.push({ message, raw }); },
        onRunError: error => errors.push(error),
        onStateChange: (_from, to) => { if (to === 'idle') completed++; },
    });
    const drive = async () => { await driver.trigger(); await (driver as unknown as { runInFlight: Promise<void> }).runInFlight; };
    const notifyUnchanged = async () => {
        const earlier = completed;
        expect(wake).toBeDefined();
        wake!();
        await watchUntil(() => completed > earlier);
        await (driver as unknown as { runInFlight: Promise<void> | null }).runInFlight;
    };
    const turns = async (label: string, calls: ReturnType<typeof modelCall>[] = [], options?: { text?: string; addUser?: boolean }) => {
        const errorCount = errors.length;
        if (options?.addUser !== false) history.push({ role: 'user', content: label, timestamp: Date.now() });
        provider.replyNext({ label, calls, text: options?.text });
        await drive();
        const record = provider.requests.find(request => request.label === label);
        expect(errors.slice(errorCount)).toEqual([]);
        expect(provider.failures).toEqual([]);
        expect(record, label).toBeDefined();
        const cost = wireCost(record.body, rawInput.cap);
        (facts.costs as object[]).push({ label, ...cost });
        expect(cost.inputBytes).toBe(record.inputBytes);
        expect(cost.estimated).toBeLessThanOrEqual(rawInput.cap);
        return { wire: record.body, toolMessage: calls.length ? results.at(-1)?.message as { content: any[] } : undefined };
    };
    const dispose = async () => {
        driver.stop(); driver.dispose(); await source.dispose();
        facts.shutdown = await runtime.beginClose().completion;
        facts.writes = await journal(folder, 'writes');
        facts.closes = await journal(folder, 'closes');
        facts.lifecycle = await journal(folder, 'lifecycle');
        await provider.close();
        await writeFile(join(evidence, name + '.json'), JSON.stringify(facts, null, 2));
        expect(facts.shutdown).toMatchObject({ ok: true, resourcesReleased: true, interactions: { retainedOperations: 0 } });
    };
    return { folder, app, client, desktop, history, provider, source, rawInput, results, errors, facts, turns, drive, notifyUnchanged, adoptions, dispose };
}

it('reports the once-only write before sealing the result, recovers the newest page and manages real mounts through the HTTP boundary', async () => {
    const p = await productSession('product-windows', true);
    // Include the Console declarations in the real request while keeping both expanded bodies too large.
    p.rawInput.cap = INPUT + 2_000;
    try {
        await p.turns('open A and B', [openFiles('open', 'A', 'B')]);
        const edited = await p.turns('write B once', [onFile('write-b', 'edit', 'B', { mode: 'large' })]);
        const value = edited.toolMessage!.content[0].output.value;
        expect(value.result).toEqual({ saved: true });
        expect(value.window_budget).toMatchObject({ method: 'utf8-bytes', input_available: p.rawInput.cap, output_reserved: OUTPUT,
            mode: 'window_hints', short_by: expect.any(Number) });
        const report = value.window_budget;
        expect(report.short_by).toBeGreaterThan(0);
        expect(report.complete.estimated - report.short_by).toBe(p.rawInput.cap);
        expect(report.windows).toEqual(expect.arrayContaining([
            expect.objectContaining({ view_id: 'file_A_1', presentation: 'body' }),
            expect.objectContaining({ view_id: 'file_B_1', presentation: 'hint' }),
        ]));
        expect(report.complete.window_bytes).toBe(report.windows.reduce((total: number, row: any) => total + row.full, 0));
        expect(report.presented.window_bytes).toBe(report.windows.reduce((total: number, row: any) => total + row.presented, 0));
        const mounted = p.desktop.getAppWindows(p.app.appId, p.app.appInstanceId)!.views.find(view => view.viewId === 'file_B_1');
        expect(mounted?.region).toBe('static');
        const hinted = await p.turns('open with budget hint', [
            onFile('denied-hidden-ref', 'echo', 'A', { value: '$ref.window_files.file_B_1.content' }),
            onFile('hinted-receiver', 'echo', 'B', { value: 'echo while hinted' }),
        ]);
        expect(pageFor(hinted.wire, 'B')).toContain('body does not fit');
        expect(pageFor(hinted.wire, 'B')).not.toMatch(/B-LATEST|Available references/);
        expect(pageFor(hinted.wire, 'A')).toContain('A-BODY');
        expect(namesOf(hinted.wire).filter((name: string) => name === tool('edit'))).toHaveLength(1);
        expect(namesOf(hinted.wire)).toContain('system-read_window_budget');
        expect(hinted.toolMessage!.content[0].output.value.code).toBe('REF_NOT_VISIBLE');
        expect(p.results.at(-1)!.raw[1]).toMatchObject({ error: { code: 'TOOL_UNAVAILABLE' }, outcomeStatus: 'rejected' });
        expect(pageFor(hinted.wire, 'B')).not.toContain('input tokens');

        await p.turns('collapse A to make room', [windowAction('note-a', 'collapse_view', 'A', { note: A_NOTE }),
            onFile('old-a', 'echo', 'A', { value: 'attempt at collapsed A' }), onFile('still-hinted-b', 'echo', 'B', { value: 'B stays paused this turn' })]);
        const collapseResults = p.results.at(-1)!.raw;
        expect(collapseResults.map(result => result.outcomeStatus)).toEqual(['succeeded', 'rejected', 'rejected']);
        // Keep the rejection receipts in history and give the next request room for B's body.
        p.rawInput.cap = INPUT + 4_000;
        const restored = (await p.turns('normal restored request', [
            onFile('restored-ref', 'echo', 'B', { value: '$ref.window_files.file_B_1.content', countOnly: true }),
        ])).wire;
        expect(pageFor(restored, 'A')).toContain('Check A &lt;later&gt; &amp; keep the original note.');
        expect(pageFor(restored, 'A')).not.toContain('A-BODY');
        expect(pageFor(restored, 'B')).toContain('B-LATEST');
        expect(p.results.at(-1)!.raw[0]?.result).toEqual({ characters: 'B-LATEST '.length + 8_000 });
        expect(p.desktop.getAppWindows(p.app.appId, p.app.appInstanceId)!.views.find(view => view.viewId === 'file_B_1')).toEqual(mounted);
        expect((await journal(p.folder, 'writes')).map(row => row.name)).toEqual(['B']);
        expect(await readFile(join(p.folder, 'B.txt'), 'utf8')).toMatch(/^B-LATEST/);

        p.rawInput.cap = INPUT;
        const largeFailedExpansion = await p.turns('too large to expand A', [windowAction('a-too-large', 'expand_view', 'A')]);
        expect(largeFailedExpansion.toolMessage!.content[0].output.value.code).toBe('WINDOW_EXPANSION_BUDGET_EXCEEDED');
        p.rawInput.cap = 60_000;
        const beforeAppCollapse = await p.turns('collapse with app note', [windowAction('app-note', 'collapse_app', undefined, { note: APP_NOTE })]);
        expect(pageFor(beforeAppCollapse.wire, 'A')).toContain('Check A');
        expect(pageFor(beforeAppCollapse.wire, 'A')).toContain('Check A &lt;later&gt; &amp;');
        const appExpanded = (await p.turns('expand the app', [windowAction('app-expand', 'expand_app')])).wire;
        expect(appExpanded.messages.some((message: { content: string | null }) =>
            message.content?.includes('Return to this workspace &lt;later&gt; &amp;'))).toBe(true);
        expect(pageFor(appExpanded, 'A')).toBeUndefined();
        expect(pageFor(appExpanded, 'B')).toBeUndefined();
        expect(p.results.at(-1)!.raw[0]?.outcomeStatus).toBe('succeeded');
        const restoredApp = (await p.turns('notes survive App expand', [openFiles('open-more', 'C', 'D', 'E')])).wire;
        expect(pageFor(restoredApp, 'A')).toContain('Check A');
        expect(pageFor(restoredApp, 'B')).toContain('B-LATEST');
        const closings = await p.turns('close results do not imply disappearance', [windowAction('no-callback', 'close_view', 'C'),
            windowAction('refuses-close', 'close_view', 'D'), windowAction('accepts-close', 'close_view', 'E')]);
        expect(closings.toolMessage?.content.map(part => part.output.value.code)).toEqual(['VIEW_CLOSE_NOT_GRANTED', 'UNSAVED', undefined]);
        expect(p.results.at(-1)!.raw[2]).toMatchObject({outcomeStatus:'succeeded',result:{removal:'unconfirmed'}});
        expect(p.desktop.getAppWindows(p.app.appId, p.app.appInstanceId)!.views.map(view => view.viewId)).toEqual(
            expect.arrayContaining(['file_C_1', 'file_D_1', 'file_E_1']));

        const hiddenFolder = join(scratch, 'disabled-app');
        await setupFiles(hiddenFolder, 'DISABLED APP BODY');
        await p.desktop.registerPendingApp({ installationId: 'disabled_install', localPath: await fixtureAppPath(moduleURL, APP, hiddenFolder), config: { folder: hiddenFolder } });
        const hiddenId = (await p.desktop.openApp('disabled_install')).appId;
        const hidden = appClient(p.desktop, hiddenId).client;
        const hiddenObservation: Observation = await observe(hidden, true);
        await hidden.invoke({ observationId: hiddenObservation.observationId, invocationId: 'open-disabled-window',
            input: { names: ['B'] }, toolId: hiddenObservation.tools.find(tool => tool.name === 'open_file')!.id });
        hidden.release(hiddenObservation.observationId);
        p.source.setAppEnabled('disabled_install', false);
        p.rawInput.cap = INPUT;
        p.rawInput.other = 'EXCLUDED SOURCE ' + 'x'.repeat(25_000);
        const managed = await p.turns('manage only and close A', [windowAction('close-a', 'close_view', 'A')]);
        const management = managed.wire;
        expect(namesOf(management).every((name: string) => name.startsWith('system-'))).toBe(true);
        expect(namesOf(management)).toEqual(expect.arrayContaining(['system-open_app', 'system-close_app', 'system-close_view', 'system-read_window_budget']));
        expect(pageFor(management, 'B')).toBeUndefined();
        expect(JSON.stringify(management)).not.toMatch(/EXCLUDED SOURCE|DISABLED APP BODY|disabled_install|A-BODY|Available references/);
        expect(p.results.at(-1)!.raw[0]).toMatchObject({ outcomeStatus: 'succeeded', result: { removal: 'unconfirmed' } });
        expect(p.desktop.getAppWindows(p.app.appId, p.app.appInstanceId)!.views.find(view => view.viewId === 'file_A_1')).toBeUndefined();
        expect((await journal(p.folder, 'closes')).map(row => row.name)).toEqual(['D', 'E', 'A']);
        const paged = managed.toolMessage!.content[0].output.value.window_budget;
        expect(paged).toMatchObject({ next_page: 2, mode: 'management' });
        await p.turns('read the same report next page', [modelCall('next-budget-page', 'system-read_window_budget',
            { report_id: paged.report_id, page: paged.next_page })]);
        expect(p.results.at(-1)!.raw[0]?.result).toMatchObject({ report_id: paged.report_id, page: 2,
            windows: [expect.objectContaining({ view_id: 'file_E_1' })] });

        const before = p.provider.requests.length;
        p.rawInput.cap = 300;
        p.history.push({ role: 'user', content: 'minimum cannot fit', timestamp: Date.now() });
        await p.drive();
        expect(p.provider.requests).toHaveLength(before);
        expect(p.errors.at(-1)).toMatchObject({ code: 'MODEL_INPUT_BUDGET_EXCEEDED', details: { inputLimit: 300 } });
        expect((await journal(p.folder, 'writes')).map(row => row.name)).toEqual(['B']);
        p.facts.passed = true;
    } finally { await p.dispose(); }

    const independent = join(scratch, 'independent');
    await run(process.execPath, [join(consumer, 'batch-four-public-host.mjs'), independent], { cwd: consumer, timeout: 30_000 });
    const proof = JSON.parse(await readFile(join(independent, 'independent-windows.json'), 'utf8'));
    await writeFile(join(evidence, 'independent-windows.json'), JSON.stringify(proof, null, 2));
    expect(proof).toMatchObject({ passed: true, shutdown: { resourcesReleased: true }, writes: [{ name: 'B' }] });
    for (const label of ['write B once', 'open with budget hint', 'normal restored request', 'manage only and close A']) {
        const product = p.provider.requests.find(request => request.label === label)!.body;
        const portable = proof.requests.find((request: { label: string }) => request.label === label).body;
        expect(pageFor(product, 'A')).toEqual(pageFor(portable, 'A'));
        if (label === 'open with budget hint') {
            expect(pageFor(product, 'B')!.split('\n')[0]).toEqual(pageFor(portable, 'B')!.split('\n')[0]);
            expect(pageFor(portable, 'B')).toContain('Its body does not fit');
        } else expect(pageFor(product, 'B')).toEqual(pageFor(portable, 'B'));
        const native = (wire: any) => wire.tools.filter((tool: any) => tool.function.name.startsWith(APP + '-'))
            .map((tool: any) => [tool.function.name, tool.function.parameters]).sort();
        expect(native(product)).toEqual(native(portable));
    }
}, 60_000);

it('restores the selected View and App bodies without requiring unrelated hinted pages', async () => {
    const p = await productSession('product-expansion', false, 'B-STAYS-HINTED ' + 'b'.repeat(45_000));
    const last = () => p.results.at(-1)!.raw;
    const windows = () => p.desktop.getAppWindows(p.app.appId, p.app.appInstanceId)!;
    const body = (name: string) => windows().views.find(view => view.viewId === `file_${name}_1`)!;
    try {
        await p.turns('open B, C and A', [openFiles('open-for-expansion', 'B', 'C', 'A', 'D')]);
        const collapse = await p.turns('save a place at C and A', [
            windowAction('note-c', 'collapse_view', 'C', { note: 'Return to C' }),
            windowAction('keep-a', 'collapse_view', 'A', { note: A_NOTE }),
        ]);
        expect(pageFor(collapse.wire, 'B')).toContain('body does not fit');
        const mountC = body('C').viewInstanceId;
        await updateFile(p.folder, p.client, 'C', 'C-LATEST-WHILE-COLLAPSED', false);
        const before = p.provider.requests.length;
        const adopted = p.adoptions.length;
        const expanding = await p.turns('expand the small C', [windowAction('restore-c', 'expand_view', 'C'),
            onFile('not-yet-a-source', 'echo', 'D', { value: '$ref.window_files.file_C_1.content' })]);
        expect(pageFor(expanding.wire, 'C')).toContain('Return to C');
        expect(p.provider.requests.length - before).toBe(1);
        expect(p.adoptions.length - adopted).toBe(1);
        expect(last()[0]).toMatchObject({ outcomeStatus: 'succeeded', result: { view_id: 'file_C_1' } });
        expect(last()[1]).toMatchObject({ outcomeStatus: 'rejected', error: { code: 'REF_NOT_VISIBLE' } });
        expect(body('C')).toMatchObject({ viewInstanceId: mountC });
        const restored = await p.turns('read C after new adoption', [onFile('now-a-source', 'echo', 'C', { value: '$ref.window_files.file_C_1.content' }),
            onFile('b-still-not-a-source', 'echo', 'C', { value: '$ref.window_files.file_B_1.content' })], { addUser: false });
        expect(pageFor(restored.wire, 'B')).toContain('body does not fit');
        expect(pageFor(restored.wire, 'C')).toMatch(/C-LATEST-WHILE-COLLAPSED[\s\S]+Available references/);
        expect(last()[0]).toMatchObject({ result: { value: 'C-LATEST-WHILE-COLLAPSED' } });
        expect(last()[1]).toMatchObject({ error: { code: 'REF_NOT_VISIBLE' } });

        await updateFile(p.folder, p.client, 'A', 'A-TOO-LARGE ' + 'a'.repeat(45_000), false);
        const rejected = await p.turns('try to restore the too-large A', [windowAction('reject-large-a', 'expand_view', 'A')]);
        expect(last()[0]).toMatchObject({ error: { code: 'WINDOW_EXPANSION_BUDGET_EXCEEDED' }, result: { inputLimit: INPUT } });
        expect((last()[0]!.result as { estimated: number }).estimated).toBeGreaterThan(INPUT);
        expect(pageFor(rejected.wire, 'A')).toContain('Check A &lt;later&gt; &amp;');

        p.history.length = 0;
        const smallFolder = join(scratch, 'product-small-app');
        await setupFiles(smallFolder);
        await p.desktop.registerPendingApp({ installationId: 'small_install', localPath: await fixtureAppPath(moduleURL, APP, smallFolder), config: { folder: smallFolder } });
        const smallId = (await p.desktop.openApp('small_install')).appId;
        await p.turns('open small App children', [modelCall('open-small-app-children', smallId + '-workspace-open_file', { names: ['C', 'D'] })]);
        await p.turns('save a child note and fold the small App', [
            windowAction('collapse-small-child', 'collapse_view', 'D', { app_id: smallId, note: 'D child <note>' }),
            windowAction('collapse-small-app', 'collapse_app', undefined, { app_id: smallId, note: APP_NOTE }),
        ]);
        const appExpansion = await p.turns('expand just the small App', [windowAction('resume-small-app', 'expand_app', undefined, { app_id: smallId })]);
        expect(pageFor(appExpansion.wire, 'C', smallId)).toBeUndefined();
        expect(last()[0]).toMatchObject({ outcomeStatus: 'succeeded', result: { app_id: smallId } });
        const next = await p.turns('small App restores the open child and keeps the child note', [
            modelCall('read-restored-child', smallId + '-file-echo', { view_id: 'file_C_1', value: `$ref.${smallId}.file_C_1.content` }),
            modelCall('child-note-has-no-ref', smallId + '-file-echo', { view_id: 'file_C_1', value: `$ref.${smallId}.file_D_1.content` }),
        ], { addUser: false });
        expect(pageFor(next.wire, 'C', smallId)).toMatch(/C-BODY[\s\S]+Available references/);
        expect(pageFor(next.wire, 'D', smallId)).toContain('D child &lt;note&gt;');
        expect(pageFor(next.wire, 'D', smallId)).not.toMatch(/D-BODY|Available references/);
        expect(pageFor(next.wire, 'B')).toContain('body does not fit');
        expect(last()[0]?.result).toEqual({ value: 'C-BODY' });
        expect(last()[1]?.error?.code).toBe('REF_NOT_VISIBLE');
        p.rawInput.other = 'UNCHANGED OTHER SOURCE ' + 'x'.repeat(27_000);
        await p.turns('fold C while operating in management mode', [windowAction('c-only-management', 'collapse_view', 'C', { note: 'Keep C folded' })]);
        await p.turns('management could fit but C cannot', [windowAction('reject-only-management', 'expand_view', 'C')]);
        expect(last()[0]?.error?.code).toBe('WINDOW_EXPANSION_BUDGET_EXCEEDED');
        const after = await p.source.getContext();
        expect(after.messages.some(message => typeof message.content === 'string' && message.content.includes('Keep C folded'))).toBe(true);
        await after.release!();
        expect(await journal(p.folder, 'writes')).toEqual([]);
        p.facts.passed = true;
    } finally { await p.dispose(); }

    const folder = join(scratch, 'independent-expansion');
    await run(process.execPath, [join(consumer, 'batch-four-public-host.mjs'), folder, 'repair'], { cwd: consumer, timeout: 30_000 });
    const proof = JSON.parse(await readFile(join(folder, 'independent-windows.json'), 'utf8'));
    await writeFile(join(evidence, 'independent-expansion-and-idle.json'), JSON.stringify(proof, null, 2));
    expect(proof).toMatchObject({ passed: true, shutdown: { resourcesReleased: true, workers: { report: { total: 0 } } }, writes: [] });
    for (const idle of proof.idle) {
        expect(idle.after).toEqual(idle.before);
        expect(idle).toMatchObject({ writes: 0, historyUnchanged: true, reportId: expect.any(String) });
    }
    for (const label of ['read C after new adoption', 'small App restores the open child and keeps the child note']) {
        const local = p.provider.requests.find(request => request.label === label)!.body;
        const portable = proof.requests.find((request: { label: string }) => request.label === label).body;
        expect(pageFor(local, 'C')).toEqual(pageFor(portable, 'C'));
        expect(pageFor(portable, 'B')!.split('\n')[0]).toEqual(pageFor(local, 'B')!.split('\n')[0]);
        const native = (wire: any) => wire.tools.filter((tool: any) => !tool.function.name.startsWith('system-') && tool.function.name !== 'run_code')
            .map((tool: any) => [tool.function.name, tool.function.parameters]).sort();
        expect(native(local)).toEqual(native(portable));
    }
}, 40_000);

it.each(['window_hints', 'management'])('keeps report IDs stable on unchanged Host wakeups in %s mode', async mode => {
    const p = await productSession('product-idle-' + mode, true);
    const reportTool = 'system-read_window_budget';
    try {
        await p.turns('open enough pages for report paging', [openFiles('open-idle-fixture', 'B', 'C', 'D', 'E')]);
        const normal = await p.turns('remember C', [windowAction('idle-note-c', 'collapse_view', 'C', { note: 'Unchanged note' })]);
        expect(namesOf(normal.wire)).not.toContain(reportTool);
        await updateFile(p.folder, p.client, 'B', 'B-PERSISTENT-HINT ' + 'b'.repeat(45_000), false);
        if (mode === 'management') p.rawInput.other = 'OMIT THIS SOURCE ' + 'x'.repeat(28_000);
        const seed = (await p.turns('freeze the conversation', [], { text: 'frozen fixture history' })).wire;
        const id = currentReportId(seed);
        expect(id).toBeDefined();
        expect(pageFor(seed, 'B')?.includes('body does not fit') ?? false).toBe(mode === 'window_hints');
        const count = () => [p.adoptions.length, p.provider.requests.length];
        const before = count();
        const history = JSON.stringify(p.history);
        await p.notifyUnchanged();
        await p.notifyUnchanged();
        expect(count()).toEqual(before);
        expect(JSON.stringify(p.history)).toEqual(history);
        const writes = await journal(p.folder, 'writes');
        expect(writes).toEqual([]);
        p.facts.idle = { reportId: id, before, after: count(), writes: writes.length, historyUnchanged: true };

        await p.turns('read the original report second page', [modelCall('read-old-page', reportTool, { report_id: id, page: 2 })]);
        expect(p.results.at(-1)!.raw[0]?.result).toMatchObject({ report_id: id, page: 2, mode,
            windows: [expect.objectContaining({ view_id: 'file_E_1' })] });
        const failedBefore = count();
        p.history.push({ role: 'user', content: 'new provider input for a failed send', timestamp: Date.now() });
        p.provider.replyNext({ label: 'intentional HTTP failure', errorStatus: 400 });
        await p.drive();
        expect(p.errors).toHaveLength(1);
        expect(count()).toEqual(failedBefore.map(n => n + 1));
        const failed = p.provider.requests.at(-1)!;
        expect(failed).toMatchObject({ status: 400, label: 'intentional HTTP failure' });
        await p.notifyUnchanged();
        expect(count()).toEqual(failedBefore.map(n => n + 1));
        p.provider.replyNext({ label: 'explicit retry with identical input', text: 'frozen fixture history' });
        await p.drive();
        expect(count()).toEqual(failedBefore.map(n => n + 2));
        expect(p.errors).toHaveLength(1);
        expect(p.provider.requests.at(-1)!.body).toEqual(failed.body);
        const stale = currentReportId(failed.body);
        expect(stale).toBeDefined();
        expect(stale).not.toBe(id);
        p.facts.retry = { before: failedBefore, after: count(), identicalBody: true, reportId: stale };

        const oldMount = p.desktop.getAppWindows(p.app.appId, p.app.appInstanceId)!.views.find(view => view.viewId === 'file_E_1')!;
        await updateFile(p.folder, p.client, 'E', 'E-REPLACED', true);
        const newMount = p.desktop.getAppWindows(p.app.appId, p.app.appInstanceId)!.views.find(view => view.viewId === 'file_E_2')!;
        expect(oldMount.viewInstanceId).not.toBe(newMount.viewInstanceId);
        const remount = await p.turns('replace a View while stale report is still in history', [
            modelCall('reject-old-mount-report', reportTool, { report_id: stale, page: 1 }),
        ]);
        expect(p.results.at(-1)!.raw[0]?.error?.code).toBe('WINDOW_BUDGET_REPORT_UNAVAILABLE');
        const revoked = currentReportId(remount.wire);
        expect(revoked).toBeDefined();
        expect(revoked).not.toBe(stale);
        // Keep the budget tool available after the permission change by forcing management mode.
        p.rawInput.other = 'OMIT AFTER PERMISSION CHANGE ' + 'x'.repeat(28_000);
        p.source.setAppEnabled(p.app.installationId, false);
        const denied = await p.turns('old locators stop working after permission revocation', [
            modelCall('reject-revoked-report', reportTool, { report_id: revoked, page: 1 }),
        ]);
        expect(p.results.at(-1)!.raw[0]?.error?.code).toBe('WINDOW_BUDGET_REPORT_UNAVAILABLE');
        expect(JSON.stringify(denied.wire)).not.toContain(p.app.installationId);
        p.facts.revocation = { oldMount: oldMount.viewInstanceId, newMount: newMount.viewInstanceId, stale, revoked,
            errors: ['WINDOW_BUDGET_REPORT_UNAVAILABLE', 'WINDOW_BUDGET_REPORT_UNAVAILABLE'] };
        expect(await journal(p.folder, 'writes')).toEqual([]);
        p.facts.passed = true;
    } finally { await p.dispose(); }
}, 35_000);

it('lets only the body-visible file receive an edit when its sibling is a budget hint', async () => {
    const p = await productSession('only-visible-file-writes');
    try {
        const original = 'A-HINTED ' + 'a'.repeat(45_000);
        await writeFile(join(p.folder, 'A.txt'), original);
        await p.turns('open the two files for edit', [openFiles('open-both', 'A', 'B')]);
        const edited = await p.turns('edit the visible B and attempt the hinted A', [
            onFile('denied-hinted-write', 'edit', 'A', { mode: 'short' }),
            onFile('allowed-visible-write', 'edit', 'B', { mode: 'short' }),
        ]);
        expect(pageFor(edited.wire, 'A')).toContain('body does not fit');
        expect(pageFor(edited.wire, 'A')).not.toMatch(/A-HINTED|Available references|input tokens/);
        expect(pageFor(edited.wire, 'B')).toMatch(/B-INITIAL[\s\S]+Available references/);
        expect(namesOf(edited.wire).filter((name: string) => name === tool('edit'))).toHaveLength(1);
        expect(p.results.at(-1)?.raw).toMatchObject([
            { outcomeStatus: 'rejected', error: { code: 'TOOL_UNAVAILABLE' } },
            { outcomeStatus: 'succeeded', result: { saved: true } },
        ]);
        expect(await readFile(join(p.folder, 'A.txt'), 'utf8')).toBe(original);
        expect(await readFile(join(p.folder, 'B.txt'), 'utf8')).toBe('B-EDITED');
        expect((await journal(p.folder, 'writes')).map(row => row.name)).toEqual(['B']);
        p.facts.passed = true;
    } finally { await p.dispose(); }
}, 20_000);

it.each([false, true])('keeps the original region and identity after an initially oversized open (static B=%s)', async staticB => {
    const p = await productSession('open-' + (staticB ? 'static' : 'dynamic'), staticB, 'B-ON-OPEN ' + 'b'.repeat(8_900));
    try {
        await p.turns('open the small file', [openFiles('open-a', 'A')]);
        const opened = await p.turns('open the large file', [openFiles('open-b', 'B')]);
        expect(opened.toolMessage!.content[0].output.value).toMatchObject({ result: { opened: ['B'] },
            window_budget: { mode: 'window_hints', windows: expect.arrayContaining([expect.objectContaining({
                view_id: 'file_B_1', presentation: 'hint',
            })]) } });
        const mount = p.desktop.getAppWindows(p.app.appId, p.app.appInstanceId)!.views.find(view => view.viewId === 'file_B_1');
        expect(mount?.region).toBe(staticB ? 'static' : 'dynamic');
        const first = (await p.turns('first successful B projection')).wire;
        expect(pageFor(first, 'B')).toContain('Its body does not fit');
        expect(pageFor(first, 'A')).toContain('A-BODY');
        await updateFile(p.folder, p.client, 'B', 'LATEST WHILE HINTED ' + 'v'.repeat(7_200), false);
        await p.turns('fold the first file', [windowAction('fold-a', 'collapse_view', 'A')]);
        const next = (await p.turns('restored B shows latest')).wire;
        expect(pageFor(next, 'B')).toContain('LATEST WHILE HINTED');
        expect(pageFor(next, 'B')).not.toMatch(/B-ON-OPEN|Its body does not fit/);
        expect(p.desktop.getAppWindows(p.app.appId, p.app.appInstanceId)!.views.find(view => view.viewId === 'file_B_1')).toEqual(mount);
        expect(await journal(p.folder, 'writes')).toEqual([]);
        p.facts.passed = true;
    } finally { await p.dispose(); }
}, 25_000);

it('reports the local snapshot capacity error before headroom can be mistaken for an open View', async () => {
    const p = await productSession('local-capacity', false, 'too large for a single local View ' + 'x'.repeat(550 * 1024));
    try {
        p.rawInput.cap = 100_000;
        const opened = await p.turns('try a locally unpublishable file', [openFiles('open-too-big', 'B')]);
        const failure = opened.toolMessage!.content[0].output.value;
        expect(failure.code).toMatch(/^SNAPSHOT_/);
        expect(failure).not.toHaveProperty('window_budget');
        expect(p.desktop.getAppWindows(p.app.appId, p.app.appInstanceId)!.views.map(view => view.viewId)).toEqual(['workspace']);
        expect(pageFor((await p.turns('confirm unopened')).wire, 'B')).toBeUndefined();
        expect(await journal(p.folder, 'writes')).toEqual([]);
        p.facts.passed = true;
    } finally { await p.dispose(); }
}, 20_000);

it('revokes old mount permissions across collapse and remount while leaving accepted work and its receipt with the original Worker', async () => {
    const folder = join(scratch, 'qualification');
    await setupFiles(folder);
    const runtime = createRuntime();
    const facts: Record<string, unknown> = {};
    const gate = Promise.withResolvers<boolean>();
    const waiting = Promise.withResolvers<void>();
    const policy: AppInteractionPolicy = {
        project: ({ source }) => ({ refs: Object.values(source.refs).map(ref => ({
            refId: ref.id, viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId,
        })), toolIds: Object.keys(source.tools), closeViews:source.views.filter(v=>v.closeActivationId).map(v=>({viewId:v.id,viewInstanceId:v.viewInstanceId})) }),
        authorize(context) {
            if (context.invocationId !== 'await-former-mount') return true;
            waiting.resolve();
            return gate.promise;
        },
        canReadReceipt: () => true,
    };
    try {
        const desktop = await runtime.createDesktop();
        const id = await start(desktop, folder, false, policy);
        const { app, client } = appClient(desktop, id);
        const call = (observation: Observation, name: string, invocationId: string, input: object, viewId?: string, timeout?: number) =>
            client.invoke({ observationId: observation.observationId, invocationId, input, ...(viewId ? { viewId } : {}),
                toolId: observation.tools.find(tool => tool.name === name)!.id }, timeout);
        const initial: Observation = await observe(client, true);
        expect(await call(initial, 'open_file', 'both', { names: ['A', 'B'] })).toMatchObject({ receipt: { outcome: { status: 'succeeded' } } });
        client.release(initial.observationId);
        const observation: Observation = await observe(client);
        const all = observation.views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
        const layout = { activeViews: all.filter(view => view.viewId !== 'file_B_1') };
        expect(client.adopt(observation.observationId, {
            activeViews: [{ viewId: 'file_B_1', viewInstanceId: 'fake' }],
        })).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_INVALID' } });
        expect(client.adopt(observation.observationId, layout)).toMatchObject({ status: 'adopted' });
        const normalized = client.adopt(observation.observationId, { activeViews: layout.activeViews.slice().reverse() });
        expect(normalized).toMatchObject({ status: 'adopted' });
        expect(client.adopt(observation.observationId, { activeViews: all })).toMatchObject({ status: 'rejected' });
        expect(await call(observation, 'echo', 'hidden-source', { value: '$ref.window_files.file_B_1.content' }, 'file_A_1')).toMatchObject({
            receipt: { executionPhase: 'not-dispatched', outcome: { code: 'REF_NOT_VISIBLE' } },
        });
        expect(await call(observation, 'echo', 'hinted-receiver', { value: 'test' }, 'file_B_1')).toMatchObject({
            kind:'refused',code:'TOOL_UNAVAILABLE',
        });
        const views = () => desktop.getAppWindows(app.appId, app.appInstanceId)!.views;
        const a = () => views().find(view => view.viewId.startsWith('file_A_'))!;
        const formerA = { appId: app.appId, instanceId: app.appInstanceId, viewId: a().viewId, viewInstanceId: a().viewInstanceId };
        desktop.revokeWindowAccess(normalized.turn, formerA);
        expect(await call(observation, 'echo', 'old-after-expand', { value: 'test' }, 'file_A_1')).toMatchObject({
            kind:'refused',code:'TOOL_UNAVAILABLE',
        });
        const beforeRemount: Observation = await observe(client);
        const remountTurn = client.adopt(beforeRemount.observationId,{activeViews:beforeRemount.views.map(v=>({viewId:v.id,viewInstanceId:v.viewInstanceId})),closeViews:beforeRemount.views.filter(v=>v.canClose).map(v=>({viewId:v.id,viewInstanceId:v.viewInstanceId}))});
        expect(remountTurn.status).toBe('adopted');
        const pending = call(beforeRemount, 'echo', 'await-former-mount', { value: '$ref.window_files.file_A_1.content' }, 'file_B_1');
        await Promise.race([waiting.promise, pending.then(() => { throw new Error('Expected waiting authorization'); })]);
        desktop.revokeWindowAccess(remountTurn.turn, formerA);
        await updateFile(folder, client, 'A', 'A replaced', true);
        expect(a().viewInstanceId).not.toBe(formerA.viewInstanceId);
        expect(a().viewId).toBe('file_A_2');
        gate.resolve(true);
        facts.revoked = await pending;
        expect(facts.revoked).toMatchObject({ receipt: { executionPhase: 'not-dispatched', outcome: { code: 'REF_VIEW_UNAVAILABLE' } } });
        facts.staleClose = await desktop.closeView({target:formerA,turn:remountTurn.turn,invocationId:'stale-close'});
        expect(facts.staleClose).toMatchObject({kind:'refused',code:'VIEW_INSTANCE_REVOKED'});
        expect(await journal(folder, 'closes')).toEqual([]);

        const current: Observation = await observe(client);
        const currentTurn = client.adopt(current.observationId);
        expect(currentTurn.status).toBe('adopted');
        const late = call(current, 'edit', 'late-write', { mode: 'late' }, 'file_B_1', 100);
        await watchUntil(async () => (await journal(folder, 'writes')).length === 1);
        desktop.revokeWindowAccess(currentTurn.turn, { appId: app.appId, instanceId: app.appInstanceId });
        facts.wait = await late;
        expect(facts.wait).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_WAIT_TIMEOUT' });
        client.release(current.observationId);
        facts.receipt = await client.readReceipt({ observationId: current.observationId, invocationId: 'late-write' }, 1000);
        expect(facts.receipt).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } });
        expect((await journal(folder, 'writes')).map(row => row.name)).toEqual(['B']);
        expect(await readFile(join(folder, 'B.txt'), 'utf8')).toBe('B-EDITED');
        facts.passed = true;
    } finally {
        gate.resolve(true);
        facts.shutdown = await runtime.beginClose().completion;
        facts.writes = await journal(folder, 'writes');
        await writeFile(join(evidence, 'qualification.json'), JSON.stringify(facts, null, 2));
    }
    expect(facts.shutdown).toMatchObject({ ok: true, resourcesReleased: true, interactions: { retainedOperations: 0 } });
}, 20_000);
