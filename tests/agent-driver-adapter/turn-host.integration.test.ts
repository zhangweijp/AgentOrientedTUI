import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime, type ActiveTurn, type AppID, type AppInvocation, type IDesktop, type InvocationReceipt, type Observation, type RunningApp } from '@aotui/runtime';
import { projectCompleteViews } from '@aotui/core/host';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { AgentDriverV2, type MessageWithTimestamp } from '@aotui/agent-driver-v2';
import { fixtureProvider, journal, modelCall, watchUntil } from '../fixtures/batch-two-support.mjs';

const localPath = process.env.AOTUI_TURN_FILE_APP ?? fileURLToPath(new URL('../../runtime/examples/files/', import.meta.url));
const installationId = 'files';
const appId = 'turn_files';
const succeed = { kind: 'receipt', receipt: { executionPhase: 'entered-returned', outcome: { status: 'succeeded' } } };

async function workspace(root = tmpdir()) {
    const folder = await mkdtemp(join(root, 'aotui-turn-files-'));
    await Promise.all([writeFile(join(folder, 'a.txt'), 'Alpha'), writeFile(join(folder, 'b.txt'), 'Bravo')]);
    return folder;
}
async function prepare(app: RunningApp) {
    const result = await app.observe();
    if (result.status !== 'prepared') throw new Error(result.issue.code + ' ' + result.issue.message);
    return result.candidate;
}
function adopt(desktop: IDesktop, candidate: Awaited<ReturnType<typeof prepare>>, windows?: Parameters<IDesktop['adoptTurn']>[0]['apps'][number]['windows']) {
    const result = desktop.adoptTurn({ apps: [{ candidate, windows }] });
    if (result.status !== 'adopted') throw new Error(result.issue.code + ' ' + result.issue.message);
    const request = (name: string, invocationId: string, input: AppInvocation['input']) => {
        const tool = candidate.observation.tools.find(tool => tool.name === name);
        if (!tool) throw new Error('Missing observed Tool ' + name);
        const { view_id, ...business } = input;
        return { observationId: candidate.observation.observationId, invocationId, toolId: tool.id,
            ...(typeof view_id === 'string' ? { viewId: view_id } : {}), input: business };
    };
    return { turn: result.turn, observation: candidate.observation, request,
        call(name: string, id: string, input: AppInvocation['input']) { return result.turn.invoke(appId, request(name, id, input)); } };
}

it('uses only the selected file mount, keeps the observed value on disk conflict, and revokes folded or replaced mounts', async () => {
    const folder = await workspace();
    const runtime = createRuntime();
    try {
        const policy = { project: projectCompleteViews, authorize: () => false, canReadReceipt: () => true };
        const desktop = await runtime.createDesktop({ policyForApp: () => policy });
        await desktop.registerPendingApp({ installationId, localPath, config: { folder } });
        const opened = await desktop.openApp(installationId, { policy: { ...policy, authorize: () => true } });
        expect(desktop.getRunningApp(opened.appId, opened.instanceId)).toEqual({ status: 'ready', app: opened });
        const root = adopt(desktop, await prepare(opened));
        expect(root.observation.tools.map(tool => tool.name)).not.toContain('edit');
        expect(await root.call('open_file', 'open-a', { name: 'a.txt' })).toMatchObject(succeed);
        expect(await root.call('open_file', 'open-b', { name: 'b.txt' })).toMatchObject(succeed);

        const both = adopt(desktop, await prepare(opened));
        const a = both.observation.views.find(view => view.name === 'a.txt')!;
        const b = both.observation.views.find(view => view.name === 'b.txt')!;
        const edit = both.observation.tools.filter(tool => tool.name === 'edit');
        const target = (view: typeof a) => ({ appId: opened.appId, instanceId: opened.instanceId, viewId: view.id, viewInstanceId: view.viewInstanceId });
        const address = (view: typeof a) => '$ref.' + appId + '.' + view.id + '.text';
        const editInput = (view: typeof a, text: string) => ({ view_id: view.id, text, expected: address(view) });
        expect(edit).toHaveLength(1);
        const changed = await both.call('edit', 'edit-b', editInput(b, 'Bravo updated'));
        expect(changed).toMatchObject(succeed);
        expect(await readFile(join(folder, 'a.txt'), 'utf8')).toBe('Alpha');
        expect(await readFile(join(folder, 'b.txt'), 'utf8')).toBe('Bravo updated');
        expect(await both.turn.inspectRef(address(b), 'value')).toEqual({ status: 'ready', value: 'Bravo' });

        await writeFile(join(folder, 'a.txt'), 'External');
        expect(await both.call('open_file', 'refresh-from-disk', { name: 'a.txt' })).toMatchObject(succeed);
        expect((await opened.preview())).toMatchObject({ status: 'previewed', views: expect.arrayContaining([
            expect.objectContaining({ id: a.id, viewInstanceId: a.viewInstanceId, content: expect.objectContaining({ value: expect.stringContaining('External') }) }),
        ]) });
        expect(await both.turn.inspectRef(address(a), 'value')).toEqual({ status: 'ready', value: 'Alpha' });
        expect(await both.call('edit', 'conflict', editInput(a, 'Do not write'))).toMatchObject({ kind: 'receipt', receipt: {
            outcome: { status: 'failed', details: { result: { error: { code: 'FILE_CHANGED' } } } },
        } });
        expect(await readFile(join(folder, 'a.txt'), 'utf8')).toBe('External');

        const alreadyPrepared = await prepare(opened);
        desktop.revokeWindowAccess(both.turn, target(a));
        expect(desktop.adoptTurn({ apps: [{ candidate: alreadyPrepared }] })).toMatchObject({
            status: 'rejected', issue: { code: 'OBSERVATION_WINDOW_CHANGED' },
        });
        alreadyPrepared.discard();
        expect(await both.turn.inspectRef(address(a), 'value')).toMatchObject({ status: 'rejected' });
        expect(await both.call('edit', 'folded-a', editInput(a, 'Still no write'))).toMatchObject({ kind: 'receipt', receipt: {
            executionPhase: 'not-dispatched', outcome: { code: 'TOOL_UNAVAILABLE' },
        } });
        const pendingFolded = await prepare(opened);
        const shown = pendingFolded.observation.views.filter(view => view.id !== a.id)
            .map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
        const folded = adopt(desktop, pendingFolded, { activeViews: shown });
        expect(() => desktop.revokeWindowAccess(both.turn, target(b))).toThrow(expect.objectContaining({ code: 'TURN_NOT_ACTIVE' }));
        expect(await folded.turn.inspectRef(address(a), 'value')).toMatchObject({ status: 'rejected' });
        expect(await folded.call('edit', 'expanded-with-old-turn', editInput(a, 'Still no write'))).toMatchObject({ kind: 'receipt', receipt: {
            executionPhase: 'not-dispatched', outcome: { code: 'TOOL_UNAVAILABLE' },
        } });
        expect(await folded.call('edit', 'still-edit-b', editInput(b, 'Bravo folded'))).toMatchObject(succeed);

        const pending = await prepare(opened);
        const all = pending.observation.views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
        const budget = adopt(desktop, pending, { activeViews: all.filter(view => view.viewId !== a.id) });
        expect(await budget.turn.inspectRef(address(a), 'value')).toMatchObject({ status: 'rejected' });
        expect(await budget.call('edit', 'budget-body-hidden', { view_id: a.id, expected: 'External', text: 'Alpha matched' })).toMatchObject({ receipt: { executionPhase: 'not-dispatched', outcome: { code: 'TOOL_UNAVAILABLE' } } });
        expect(await opened.readReceipt({ observationId: both.observation.observationId, invocationId: 'edit-b' })).toEqual(changed);

        expect(await budget.call('set_writable', 'disable', { name: 'b.txt', writable: false })).toMatchObject(succeed);
        expect(await budget.call('set_writable', 'enable', { name: 'b.txt', writable: true })).toMatchObject(succeed);
        expect(await budget.call('edit', 'finishing-with-stale-activation', { view_id: b.id, expected: 'Bravo folded', text: 'Stale' }))
            .toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'not-dispatched', outcome: { code: 'TOOL_SOURCE_STALE' } } });
        const restored = adopt(desktop, await prepare(opened));
        expect((await desktop.closeView(target(a), restored.turn)).status).toBe('closed');
        expect(await restored.call('open_file', 'reopen-a', { name: 'a.txt' })).toMatchObject(succeed);
        expect(await restored.call('edit', 'referring-to-closed-mount', { view_id: a.id, expected: 'External', text: 'Stale' }))
            .toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'not-dispatched', outcome: { code: 'VIEW_INSTANCE_REVOKED' } } });
        expect(await readFile(join(folder, 'a.txt'), 'utf8')).toBe('External');
        expect(await readFile(join(folder, 'b.txt'), 'utf8')).toBe('Bravo folded');

        expect((await opened.beginClose().completion).ok).toBe(true);
        const reopened = await desktop.openApp(installationId);
        expect(reopened.instanceId).not.toBe(opened.instanceId);
        expect(desktop.getRunningApp(opened.appId, opened.instanceId)).toMatchObject({ status: 'rejected' });
        const denied = adopt(desktop, await prepare(reopened));
        expect(await denied.call('open_file', 'denied-by-default', { name: 'b.txt' })).toMatchObject({ kind: 'receipt', receipt: {
            executionPhase: 'not-dispatched', outcome: { code: 'TOOL_PERMISSION_DENIED' },
        } });
    } finally {
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
        await rm(folder, { recursive: true, force: true });
    }
}, 15_000);

it('publishes a selective turn from the real TypeScript Source and Driver to a loopback Provider', async () => {
    const folder = await workspace();
    const runtime = createRuntime();
    const desktop = await runtime.createDesktop();
    const receipts: Record<string, InvocationReceipt> = {};
    const refChecks: Record<string, unknown> = {};
    const turns: { turn: ActiveTurn; observation?: Observation }[] = [];
    const adoptTurn = desktop.adoptTurn.bind(desktop);
    vi.spyOn(desktop, 'adoptTurn').mockImplementation(selection => {
        const result = adoptTurn(selection);
        if (result.status === 'adopted') turns.push({ turn: result.turn, observation: selection.apps[0]?.candidate.observation });
        return result;
    });
    const provider = await fixtureProvider();
    const source = new SemanticAOTUIDrivenSource(desktop);
    const history: MessageWithTimestamp[] = [];
    const errors: unknown[] = [];
    const driver = new AgentDriverV2({
        llm: { model: 'turn-host-local', provider: { id: 'fixture', baseURL: provider.url }, apiKey: 'test-only' },
        sources: [
            { name: source.name, onUpdate: () => () => {}, getContext: schema => source.getContext(schema) },
            { name: 'history', onUpdate: () => () => {}, async getContext() { return { messages: history.slice(), tools: {} }; } },
        ],
        onAssistantMessage: message => { history.push({ ...message, timestamp: Date.now() }); },
        onToolResult: message => { history.push({ ...message, timestamp: Date.now() }); },
        onRunError: error => { errors.push(error); },
    });
    async function step(label: string, calls: ReturnType<typeof modelCall>[] = [], beforeReply?: () => void | Promise<void>) {
        history.push({ role: 'user', content: label, timestamp: Date.now() });
        provider.replyNext({ label, calls, beforeReply });
        await driver.trigger();
        await (driver as unknown as { runInFlight?: Promise<void> }).runInFlight;
        expect(errors).toEqual([]);
        expect(provider.failures).toEqual([]);
        const request = provider.requests.find(request => request.label === label);
        expect(request).toBeDefined();
        const observation = turns.at(-1)?.observation;
        if (observation) for (const call of calls) {
            if (!call.function.name.startsWith(appId + '-')) continue;
            const result = await desktop.readReceipt({ desktopId: desktop.id, appId: observation.source.appId as AppID,
                instanceId: observation.source.instanceId, observationId: observation.observationId, invocationId: call.id });
            if (result.kind === 'receipt') receipts[call.id] = result.receipt;
        }
        return request!.body;
    }
    try {
        await desktop.registerPendingApp({ installationId, localPath, config: { folder, traceProjection: true } });
        const started = await step('open-app', [modelCall('open', 'system-open_app', { installation_id: installationId })]);
        expect(started.tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(['system-open_app', 'system-close_app']));
        const opens = await step('open-files', [modelCall('open-a', appId + '-open_file', { name: 'a.txt' }),
            modelCall('open-b', appId + '-open_file', { name: 'b.txt' })]);
        expect(opens.tools.map((tool: any) => tool.function.name)).not.toContain(appId + '-edit');
        const run = desktop.listApps().find(app => app.appId === appId)!;
        const running = desktop.getRunningApp(run.appId!, run.appInstanceId!);
        if (running.status !== 'ready') throw Error(running.issue.code);
        expect((await running.app.preview()).status).toBe('previewed');
        const windows = desktop.getAppWindows(run.appId!, run.appInstanceId!)!;
        const a = windows.views.find(view => view.name === 'a.txt')!;
        const b = windows.views.find(view => view.name === 'b.txt')!;
        const bRef = '$ref.' + appId + '.' + b.viewId + '.text';
        const aRef = '$ref.' + appId + '.' + a.viewId + '.text';
        const editing = await step('edit-b', [modelCall('edit-b', appId + '-edit', { view_id: b.viewId, expected: bRef, text: 'Bravo updated' })]);
        expect(editing.tools.filter((tool: any) => tool.function.name === appId + '-edit')).toHaveLength(1);
        expect(JSON.stringify(editing.messages)).toContain('# a.txt');
        expect(JSON.stringify(editing.messages)).toContain('# b.txt');
        const receipt = receipts['edit-b']!;
        expect(receipt).toMatchObject(succeed.receipt);
        const disk = async () => ({ 'a.txt': await readFile(join(folder, 'a.txt'), 'utf8'), 'b.txt': await readFile(join(folder, 'b.txt'), 'utf8') });
        const files = await disk();
        expect(files).toEqual({ 'a.txt': 'Alpha', 'b.txt': 'Bravo updated' });

        await step('fold-a', [modelCall('fold', 'system-collapse_view', { app_id: appId, view_id: a.viewId, note: 'Wait <A>' }),
            modelCall('read-folded-a', 'system-inspect_ref', { address: aRef, mode: 'value' }),
            modelCall('read-visible-b', 'system-inspect_ref', { address: bRef, mode: 'value' })]);
        const firstFold = turns.at(-1)!.turn;
        const resultFor = (toolCallId: string) => history.flatMap(message => message.role === 'tool' ? message.content : [])
            .find(part => typeof part === 'object' && part.toolCallId === toolCallId)?.output;
        refChecks.immediate = { a: resultFor('read-folded-a'), b: resultFor('read-visible-b') };
        expect(refChecks.immediate).toMatchObject({ a: { type: 'error-json' }, b: { type: 'json', value: { value: 'Bravo updated' } } });
        const folded = await step('folded', [modelCall('run-folded', 'run_code', {
            code: `inspect(Object.hasOwn(refs.${appId}, ${JSON.stringify(a.viewId)}));`,
        }), modelCall('edit-only-b', appId + '-edit', { view_id: b.viewId, expected: bRef, text: 'Bravo after fold' })]);
        const modelPages = folded.messages.filter((message: any) => typeof message.content === 'string' && message.content.startsWith('<view'));
        expect(JSON.stringify(modelPages)).toContain('Wait &lt;A&gt;');
        const foldedBody = modelPages.find((message: any) => message.content.includes(`view_id="${a.viewId}"`)).content;
        expect(foldedBody).not.toContain('Available references');
        expect(foldedBody).not.toContain('Alpha');
        expect(modelPages.find((message: any) => message.content.includes(`view_id="${b.viewId}"`)).content).toContain('- public ' + bRef + ' (string)');
        expect(folded.tools.filter((tool: any) => tool.function.name === appId + '-edit')).toHaveLength(1);
        expect(receipts['edit-only-b']).toMatchObject(succeed.receipt);
        const consoleResult = history.flatMap(message => message.role === 'tool' ? message.content : [])
            .find(part => typeof part === 'object' && part.toolCallId === 'run-folded');
        expect(consoleResult?.output).toMatchObject({ type: 'json', value: { output: ['false'] } });
        await step('expand-a', [modelCall('expand', 'system-expand_view', { app_id: appId, view_id: a.viewId }),
            modelCall('still-folded', appId + '-edit', { view_id: a.viewId, expected: 'Alpha', text: 'Forbidden same turn' })]);
        expect(receipts['still-folded']).toMatchObject({ executionPhase: 'not-dispatched', outcome: { code: 'TOOL_UNAVAILABLE' } });
        const restored = await step('restored', [
            modelCall('fold-a-again', 'system-collapse_view', { app_id: appId, view_id: a.viewId, note: 'Keep <A>' }),
            modelCall('fold-b', 'system-collapse_view', { app_id: appId, view_id: b.viewId }),
        ]);
        expect(restored.messages.find((message: any) => typeof message.content === 'string' &&
            message.content.startsWith(`<view view_id="${a.viewId}"`)).content).toContain('- public ' + aRef + ' (string)');
        const bothFolded = await step('both-folded', [
            modelCall('unfold-a', 'system-expand_view', { app_id: appId, view_id: a.viewId }),
            modelCall('unfolded-ref', 'run_code', { code: `inspect(Boolean(refs.${appId}?.[${JSON.stringify(a.viewId)}]));` }),
        ]);
        const bothPages = bothFolded.messages.filter((message: any) => typeof message.content === 'string' && message.content.startsWith('<view'));
        const bothMarkup = JSON.stringify(bothPages);
        expect(bothMarkup).toContain('Keep &lt;A&gt;');
        expect(bothMarkup).not.toContain('Alpha');
        expect(bothMarkup).not.toContain('Bravo after fold');
        expect(bothFolded.tools.map((tool: any) => tool.function.name)).not.toContain(appId + '-edit');
        expect(history.flatMap(message => message.role === 'tool' ? message.content : []).find(part =>
            typeof part === 'object' && part.toolCallId === 'unfolded-ref')?.output)
            .toMatchObject({ type: 'json', value: { output: ['false'] } });
        const aRestored = await step('a-restored', [], async () => {
            const current = turns.at(-1)!.turn;
            expect(() => desktop.revokeWindowAccess(firstFold, { appId: run.appId!, instanceId: run.appInstanceId!,
                viewId: a.viewId, viewInstanceId: a.viewInstanceId })).toThrow(expect.objectContaining({ code: 'TURN_NOT_ACTIVE' }));
            refChecks.afterOldCommand = { a: await current.inspectRef(aRef, 'value'), b: await current.inspectRef(bRef, 'value') };
            expect(refChecks.afterOldCommand).toMatchObject({ a: { status: 'ready', value: 'Alpha' }, b: { status: 'rejected' } });
        });
        expect(JSON.stringify(aRestored.messages.filter((message: any) => typeof message.content === 'string' && message.content.startsWith('<view'))))
            .toContain('Alpha');
        expect(aRestored.tools.filter((tool: any) => tool.function.name === appId + '-edit')).toHaveLength(1);
        const foldedFiles = await disk();
        expect(foldedFiles).toEqual({ 'a.txt': 'Alpha', 'b.txt': 'Bravo after fold' });
        const writes = await journal(folder, 'edits');
        expect(writes).toEqual([{ name: 'b.txt', text: 'Bravo updated' }, { name: 'b.txt', text: 'Bravo after fold' }]);
        const handle = desktop.getRunningApp(run.appId!, run.appInstanceId!);
        if (handle.status !== 'ready') throw Error(handle.issue.code);
        const recovered = await handle.app.readReceipt({ observationId: receipt.observationId, invocationId: receipt.invocationId });
        expect(recovered).toMatchObject({ kind: 'receipt', receipt });
        const shutdown = await runtime.beginClose().completion;
        expect(shutdown).toMatchObject({ ok: true, resourcesReleased: true, workers: { report: { total: 0 } } });
        if (process.env.AOTUI_TURN_PRODUCT_EVIDENCE) await writeFile(process.env.AOTUI_TURN_PRODUCT_EVIDENCE, JSON.stringify({
            requests: provider.requests, history, files, foldedFiles, writes, receipts, refChecks, recovered, shutdown,
        }, null, 2));
    } finally {
        await driver.dispose();
        await source.dispose();
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
        await provider.close();
        await rm(folder, { recursive: true, force: true });
    }
}, 30_000);

it('settles a file write once when the following observation fails, then sees the repaired projection', async () => {
    const folder = await workspace();
    const runtime = createRuntime();
    try {
        const desktop = await runtime.createDesktop();
        const fixture = fileURLToPath(new URL('../../sdk/tests/fixtures/batch-fifteen-files.ts', import.meta.url));
        const file = join(folder, 'refresh_files.txt');
        await writeFile(file, 'Before\n');
        const app = await desktop.installDynamicWorkerApp(fixture, { name: 'refresh_files', config: { folder } });
        const start = await prepare(app);
        const accepted = desktop.adoptTurn({ apps: [{ candidate: start }] });
        if (accepted.status !== 'adopted') throw new Error(accepted.issue.code);
        const tool = start.observation.tools.find(tool => tool.name === 'append_and_fail_projection')!;
        const query = { observationId: start.observation.observationId, invocationId: 'save-and-fault' };
        const request = { ...query, toolId: tool.id, input: { text: 'Saved once' } };
        const written = await accepted.turn.invoke(app.appId, request);
        expect(written).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded',
            value: { data: { saved: true, projection: 'SNAPSHOT_SERIALIZATION_ERROR' } } } } });
        expect(await app.observe()).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR' } });
        expect(await app.readReceipt(query)).toEqual(written);
        expect(await readFile(file, 'utf8')).toBe('Before\nSaved once\n');
        await writeFile(join(folder, 'refresh_files.repair'), 'repair');
        const next = await watchUntil(async () => {
            const result = await app.observe();
            return result.status === 'prepared' && result.candidate;
        });

        const latest = desktop.adoptTurn({ apps: [{ candidate: next }] });
        expect(latest.status).toBe('adopted');
        expect(next.observation.views.find(view => view.type === 'editor')?.content.value).toContain('Saved once');
        expect(await accepted.turn.invoke(app.appId, request)).toMatchObject({ kind: 'refused', code: 'TURN_NOT_ACTIVE' });
        expect(await app.readReceipt(query)).toEqual(written);
        expect(await readFile(file, 'utf8')).toBe('Before\nSaved once\n');
    } finally {
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
        await rm(folder, { recursive: true, force: true });
    }
}, 15_000);

it('binds each counter instance policy before startup and reads the timed-out call through both public entry points', async () => {
    const folder = await workspace(fileURLToPath(new URL('.', import.meta.url)));
    const module = join(folder, 'counter.mjs');
    const entered = join(folder, 'entered');
    const resume = join(folder, 'resume');
    const runtime = createRuntime();
    const counters = { created: 0, observed: 0, receiptReads: 0 };
    const setupFailure = new Error('Test policy construction failed');
    let failFactory = true;
    const desktop = await runtime.createDesktop({ policyForApp(target) {
        expect(target).toEqual({ desktopId: desktop.id, installationId: 'counter', appId: 'turn_counter', name: 'turn_counter' });
        counters.created++;
        if (failFactory) throw setupFailure;
        return { project(context) { counters.observed++; return projectCompleteViews(context); },
            authorize: () => true, canReadReceipt: () => { counters.receiptReads++; return true; } };
    } });
    const foreign = await runtime.createDesktop();
    try {
        await writeFile(module, `
            import { writeFileSync, existsSync, appendFileSync } from 'node:fs';
            import { setTimeout as wait } from 'node:timers/promises';
            import { createApp, createView, defineViewType } from '@aotui/sdk';
            const Counter = defineViewType()({ name: 'Counter', multiplicity: 'single', region: 'dynamic', tools: {
                add: { description: 'Add one', execute({ context }) { return context.add(); } },
            } });
            export default createApp({ app_name: 'turn_counter', viewTypes: [Counter], initialize({ prepareProjection }) {
                appendFileSync(${JSON.stringify(entered + '.init')}, 'start\\n');
                let value = 0;
                const view = createView(Counter, { render: () => ({ body: 'Count ' + value, context: { async add() {
                    appendFileSync(${JSON.stringify(entered)}, 'entered\\n');
                    while (!existsSync(${JSON.stringify(resume)})) await wait(10);
                    value++;
                    prepareProjection({ views: [view] });
                    writeFileSync(${JSON.stringify(entered + '.count')}, String(value));
                    return { success: true, data: { value } };
                } } }) });
                prepareProjection({ views: [view] });
            } });
        `);
        await writeFile(join(folder, 'aoapp.json'), JSON.stringify({ app_name: 'turn_counter', version: '0.1.0',
            entry: { main: './counter.mjs' }, toolAuthoringProtocol: 'view-type-tools-v8', appLifecycleSupport: 'app-lifecycle-v2' }));
        await desktop.registerPendingApp({ installationId: 'counter', localPath: folder });
        await expect(desktop.openApp('counter')).rejects.toMatchObject({ code: 'APP_INTERACTION_POLICY_CREATION_FAILED', cause: setupFailure });
        await expect(readFile(entered + '.init', 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(desktop.listApps()).toMatchObject([{ status: 'closed', installationId: 'counter' }]);
        expect(desktop.listApps()[0]).not.toHaveProperty('appInstanceId');
        failFactory = false;
        const app = await desktop.openApp('counter');
        const observation = await prepare(app);
        const first = desktop.adoptTurn({ apps: [{ candidate: observation }] });
        if (first.status !== 'adopted') throw Error(first.issue.code);
        const request = { observationId: observation.observation.observationId, invocationId: 'count-once',
            toolId: observation.observation.tools[0]!.id, input: {} };
        const result = await first.turn.invoke(app.appId, request, 500);
        expect(await readFile(entered, 'utf8')).toBe('entered\n');
        expect(result).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_WAIT_TIMEOUT', locator: {
            desktopId: desktop.id, appId: app.appId, instanceId: app.instanceId, observationId: request.observationId, invocationId: 'count-once',
        } });
        if (!result.locator) throw Error('The original call locator was missing');
        const second = desktop.adoptTurn({ apps: [{ candidate: observation }] });
        if (second.status !== 'adopted') throw Error(second.issue.code);
        first.turn.release();
        expect(second.turn.isCurrent).toBe(true);
        expect(await first.turn.invoke(app.appId, { ...request, invocationId: 'stale-count' }))
            .toMatchObject({ kind: 'refused', code: 'TURN_NOT_ACTIVE' });
        await writeFile(resume, '');
        const fromApp = await app.readReceipt({ observationId: request.observationId, invocationId: request.invocationId });
        const fromDesktop = await desktop.readReceipt(result.locator);
        expect(fromApp).toMatchObject({ kind: 'receipt', receipt: { executionPhase: 'entered-returned',
            outcome: { status: 'succeeded', value: { data: { value: 1 } } } }, locator: result.locator });
        expect(fromDesktop).toEqual(fromApp);
        expect(await foreign.readReceipt(result.locator)).toMatchObject({ kind: 'unavailable', code: 'RECEIPT_LOCATOR_UNAVAILABLE' });
        expect(await readFile(entered + '.count', 'utf8')).toBe('1');
        expect(await readFile(entered, 'utf8')).toBe('entered\n');
        const closed = app.beginClose();
        expect((await closed.completion).ok).toBe(true);
        const override = { project: projectCompleteViews, authorize: () => false, canReadReceipt: () => false };
        const newer = await desktop.openApp('counter', { policy: override });
        expect(newer.appId).toBe(app.appId);
        expect(newer.instanceId).not.toBe(app.instanceId);
        expect(await app.observe()).toMatchObject({ status: 'rejected' });
        expect(app.beginClose()).toBe(closed);
        expect(await app.readReceipt({ observationId: request.observationId, invocationId: request.invocationId }))
            .toMatchObject({ kind: 'unavailable', code: 'APP_INTERACTION_UNAVAILABLE' });
        expect(await desktop.readReceipt(result.locator)).toMatchObject({ kind: 'unavailable', code: 'APP_INSTANCE_MISMATCH' });
        expect((await newer.preview())).toMatchObject({ status: 'previewed', views: [{ content: { value: 'Count 0' } }] });
        const prepared = await prepare(newer);
        const adoption = desktop.adoptTurn({ apps: [{ candidate: prepared }] });
        if (adoption.status !== 'adopted') throw Error(adoption.issue.code);
        const blocked = await adoption.turn.invoke(newer.appId, { ...request,
            observationId: prepared.observation.observationId, invocationId: 'blocked' });
        expect(blocked).toMatchObject({ kind: 'unavailable', code: 'RECEIPT_PERMISSION_DENIED' });
        if (!blocked.locator) throw Error('Missing policy-denied receipt locator');
        expect(await desktop.readReceipt(blocked.locator)).toMatchObject({ kind: 'unavailable', code: 'RECEIPT_PERMISSION_DENIED' });
        expect(await readFile(entered, 'utf8')).toBe('entered\n');
        expect(counters).toMatchObject({ created: 2, observed: 1 });
        expect(counters.receiptReads).toBeGreaterThanOrEqual(2);
        expect((await newer.beginClose().completion).ok).toBe(true);
        await desktop.openApp('counter');
        expect(counters.created).toBe(3);
        const current = desktop.listApps()[0]!;
        expect(current.appInstanceId).not.toBe(newer.instanceId);
        expect(await desktop.readReceipt(result.locator)).toMatchObject({ kind: 'unavailable' });
        if (process.env.AOTUI_TURN_COUNTER_EVIDENCE) await writeFile(process.env.AOTUI_TURN_COUNTER_EVIDENCE,
            JSON.stringify({ timedOut: result, sameObservation: observation.observation.observationId,
                receipt: fromDesktop, counters, instances: [app.instanceId, newer.instanceId, current.appInstanceId] }, null, 2));
    } finally {
        await writeFile(resume, '');
        expect(await runtime.beginClose().completion).toMatchObject({ ok: true, resourcesReleased: true });
        await rm(folder, { recursive: true, force: true });
    }
}, 20_000);
