import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { jsonSchema } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { createRuntime } from '@aotui/runtime';
import { appName, setupFiles } from './batch-ten-delivery.mjs';
import { consoleBindings, installFixture, journal, modelCall, watchUntil } from './batch-two-support.mjs';
import { claudeTurn, foundTool, REGEX_SEARCH, wireBlocks } from './claude-tool-search.mjs';
import { fileIO } from './dist/file-io.mjs';
import { fileUnavailable } from './dist/files.js';
import { localModel, sourceContext, userText, wireTools } from './provider-mode-local.mjs';

const actionName = operation => appName + '-' + (operation === 'edit' ? 'file' : 'directory') + '-' + operation;
const edit = actionName('edit');
const entry = 'dispatch_file';
const text = { type: 'string' };
const closed = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const readTool = { description: 'Read a file by name.', inputSchema: jsonSchema(closed({ path: text })) };
const editTool = { description: 'Replace the named file with exact text.', inputSchema: jsonSchema(closed({ path: text, text })) };
const dispatchTool = { description: 'Dispatch a current file operation described in this request.',
    inputSchema: jsonSchema(closed({ operation: { type: 'string', enum: ['open_file', 'edit'] }, target: text, text })) };
const updates = ['first', 'second', 'third', 'fourth'].map(line => '\n' + line);
const moduleURL = new URL('./dist/provider-mode-files.js', import.meta.url).href;
const viewText = body => userText(body).filter(message => message.startsWith('<view '));
const readDisk = async folder => ({ A: await readFile(join(folder, 'A.txt'), 'utf8'), B: await readFile(join(folder, 'B.txt'), 'utf8') });
const result = (toolName, toolCallId, data) => ({ toolName, toolCallId, outcomeStatus: 'succeeded', result: data });

async function signalBackgroundB(folder, running, token, previous) {
    const target = join(folder, 'background-b');
    await writeFile(target + '.next', token);
    await rename(target + '.next', target);
    return watchUntil(async () => {
        const next = (await running.preview()).views.find(view => view.name === 'B.txt');
        return next && next.viewInstanceId !== previous?.viewInstanceId && next;
    });
}

function assertWrite(run, id, data) {
    const executed = run.results.get(id);
    assert.equal(executed?.outcomeStatus, 'succeeded', JSON.stringify(executed));
    if (data) assert.deepEqual(executed.result, data);
    return executed;
}

/** Restrict only the experimental model-facing table, keeping the actual Runtime turn. */
function restrictContext(context, mode) {
    if (mode === 'native') return context;
    const tools = Object.fromEntries(Object.entries(context.tools).filter(([name]) => name.startsWith('system-')));
    const presentation = { ...context, tools };
    if (mode === 'console' && context.tools.run_code) tools.run_code = context.tools.run_code;
    if (mode === 'dispatch' && !context.managementOnly) {
        tools[entry] = dispatchTool;
        const available = ['open_file', 'edit'].filter(operation => context.tools[actionName(operation)]);
        presentation.messages = [...context.messages.filter(message => !String(message.content).startsWith('## Console bindings for this request')),
            { role: 'user', region: 'dynamic', timestamp: Date.now(),
                content: '## Available fixed-dispatch operations\n' + available.map(operation => operation === 'open_file'
                    ? '- open_file. target is a file name from the directory, text is an empty string.'
                    : '- edit. target is the current XML view_id and text is the replacement.').join('\n') }];
        presentation.executeTool = async (name, input, id, budget, signal) => {
            if (name !== entry) return context.executeTool(name, input, id, budget, signal);
            const { operation, target, text } = input;
            if (!available.includes(operation))
                return { toolName: entry, toolCallId: id, outcomeStatus: 'rejected',
                    error: { code: 'TOOL_NOT_AVAILABLE', message: 'Choose an operation in the current request.' } };
            const dispatched = await context.executeTool(actionName(operation),
                operation === 'edit' ? { view_id: target, text } : { name: target }, id, budget, signal);
            return { ...dispatched, toolName: entry };
        };
    }
    if (context.fitModelBudget) presentation.fitModelBudget = async (measure, includeToolFeedback) => {
        const fit = await context.fitModelBudget((candidate, feedback) => measure(restrictContext(candidate, mode), feedback), includeToolFeedback);
        return fit.context ? { ...fit, context: restrictContext(fit.context, mode) } : fit;
    };
    return presentation;
}

export async function traditionalFiles(folder, long) {
    await setupFiles(folder);
    const io = fileIO(folder);
    const run = await localModel('openai', [sourceContext('traditional files', async () => ({
        messages: [], tools: { read: readTool, edit: editTool }, preserveTools: true,
        async executeTool(name, input, id) {
            if (name === 'read') {
                const text = io.read(input.path);
                if (text !== undefined) return result(name, id, { text });
            } else if (io.write(input.path, input.text)) {
                return result(name, id, { saved: true });
            }
            return { toolName: name, toolCallId: id, outcomeStatus: 'failed', error: fileUnavailable.error };
        },
    }))]);
    try {
        const steps = long ? updates : [''];
        for (const [index, suffix] of steps.entries()) {
            const read = 'read-' + index, write = 'edit-' + index;
            await run.step(read, [modelCall(read, 'read', { path: long ? 'B.txt' : 'A.txt' })]);
            const prior = assertWrite(run, read).result.text;
            const editRequest = await run.step(write, [modelCall(write, 'edit', { path: 'B.txt', text: prior + suffix })]);
            const seenRead = editRequest.body.messages.find(message => message.role === 'tool' && message.tool_call_id === read);
            assert.ok(seenRead?.content.includes(prior.replaceAll('\n', '\\n')), JSON.stringify(seenRead));
            assertWrite(run, write, { saved: true });
        }
        const final = await run.step('finish');
        assert.equal(viewText(final.body).length, 0);
        const historyReads = final.body.messages.filter(message => message.role === 'tool' && message.tool_call_id.startsWith('read-'));
        assert.equal(historyReads.length, steps.length);
        const disk = await readDisk(folder);
        assert.deepEqual(disk, { A: 'Original A', B: long ? 'Original B' + updates.join('') : 'Original A' });
        const writes = await journal(folder, 'writes');
        assert.equal(writes.length, steps.length);
        assert.ok(writes.every(write => write.name === 'B.txt' && write.threadId === 0));
        assert.ok(run.requests.every(request => JSON.stringify(request.body.tools) === JSON.stringify(final.body.tools)));
        return { disk, writes, requests: run.requests, results: Object.fromEntries(run.results) };
    } finally { await run.close(); }
}

export async function runtimeFiles(folder, provider, mode, task = 'lifecycle') {
    await setupFiles(folder);
    const runtime = createRuntime();
    const desktop = await runtime.createDesktop();
    const { running } = await installFixture(desktop, appName, appName, moduleURL, folder);
    const source = new SemanticAOTUIDrivenSource(desktop);
    const run = await localModel(provider, [sourceContext(source.name, async policy => restrictContext(await source.getContext(policy), mode))]);
    const program = (id, code, useRefs = false) => modelCall(id, 'run_code',
        { code, imports: useRefs ? (provider === 'deepseek' ? 'default' : null) : [], reset: false });
    const statement = (operation, args) => 'await tools[' + JSON.stringify(actionName(operation)) + '](' + JSON.stringify(args) + ')';
    const action = (id, name, args) => mode === 'console' ? program(id, statement(name, args))
        : mode === 'dispatch' ? modelCall(id, entry, { operation: name, target: args.view_id ?? args.name, text: args.text ?? '' })
            : modelCall(id, actionName(name), args);
    const close = (id, view) => modelCall(id, 'system-close_view', { app_id: appName, view_id: view.id });
    const page = async name => (await running.preview()).views.find(view => view.name === name);
    const background = (token, previous) => signalBackgroundB(folder, running, token, previous);
    const available = request => mode === 'native' ? wireTools(request.body).filter(tool => tool.name === edit).length
        : mode === 'dispatch' ? Number(userText(request.body).some(message => message.includes('\n- edit. target is')))
            : Number(consoleBindings(request.body).includes(JSON.stringify(edit)));
    const writeReason = id => {
        const value = run.results.get(id);
        return value?.result?.subcalls?.[0]?.code ?? value?.error?.code;
    };

    try {
        const first = await run.step('workspace', [action('open-a', 'open_file', { name: 'A.txt' })]);
        const a = await page('A.txt');
        assert.ok(a);
        const one = await run.step('only A open', [action('open-b', 'open_file', { name: 'B.txt' })]);
        const b = await page('B.txt');
        assert.ok(b && b.id !== a.id);
        let mounts;
        if (task === 'short') {
            const ref = '$ref.' + appName + '.' + a.id + '.content';
            const copy = mode === 'console' ? program('copy', 'await tools[' + JSON.stringify(edit) + ']({ view_id: ' +
                JSON.stringify(b.id) + ', text: refs.' + appName + '.' + a.id + '.content });', true)
                : action('copy', 'edit', { view_id: b.id, text: ref });
            const request = await run.step('copy A to B', [copy]);
            assert.ok(viewText(request.body).some(body => body.includes(ref)));
            assertWrite(run, 'copy');
            await run.step('finish');
        } else if (task === 'long') {
            let next = 'Original B';
            if (mode === 'console') {
                const ref = 'refs.' + appName + '.' + b.id + '.content';
                await run.step('apply four edits to B', [program('loop-edits',
                    'let body = ' + ref + '; for (const suffix of ' + JSON.stringify(updates) + ') { body += suffix; await tools[' +
                        JSON.stringify(edit) + ']({ view_id: ' + JSON.stringify(b.id) + ', text: body }); }', true)]);
                assert.equal(assertWrite(run, 'loop-edits').result.subcalls.length, updates.length);
            } else {
                for (const [index, suffix] of updates.entries()) {
                    const prior = next;
                    next += suffix;
                    const id = 'append-' + index;
                    const request = await run.step(id, [action(id, 'edit', { view_id: b.id, text: next })]);
                    assert.ok(viewText(request.body).some(body => body.includes('\n' + prior + '\n')), id);
                    assertWrite(run, id);
                }
            }
            await run.step('finish');
        } else {
            const calls = [close('close-a', a)];
            if (mode === 'console') calls.push(program('check-closed-a-and-edit-b',
                'try { ' + statement('edit', { view_id: a.id, text: 'must not write A' }) +
                ' } catch (error) { inspect(error.code); } ' + statement('edit', { view_id: b.id, text: 'Original A' })));
            else calls.push(action('closed-a', 'edit', { view_id: a.id, text: 'must not write A' }),
                action('copy-to-b', 'edit', { view_id: b.id, text: 'Original A' }));
            const both = await run.step('both files open, close A and copy its captured text to B', calls);
            assert.deepEqual(viewText(both.body).filter(body => body.includes('view_type="file"')).length, 2);
            assert.ok(viewText(both.body).some(body => body.includes('Original A')));
            assert.deepEqual([first, one, both].map(available), [0, 1, 1]);
            assertWrite(run, 'close-a');
            const closedA = mode === 'console' ? assertWrite(run, 'check-closed-a-and-edit-b').result.subcalls[0].code
                : writeReason('closed-a');
            assert.equal(closedA, 'VIEW_INSTANCE_REVOKED');
            if (mode === 'console') assert.deepEqual(run.results.get('check-closed-a-and-edit-b').result.subcalls.map(call => call.status), ['rejected', 'succeeded']);
            else assertWrite(run, 'copy-to-b');
            assert.ok(!(await page('A.txt')));
            assert.equal((await page('B.txt')).viewInstanceId, b.viewInstanceId);
            await run.step('close the last file', [close('close-b', b)]);
            const vacant = await run.step('last edit route withdrawn');
            assert.equal(available(vacant), 0);
            const previousResults = run.results.size;
            const newlyOpened = await background('open B without a tool result', b);
            const observedBackground = await run.step('background page entered the next observation');
            assert.equal(previousResults, run.results.size);
            assert.equal(available(observedBackground), 1);
            assert.ok(viewText(observedBackground.body).some(body => body.includes('view_id="' + newlyOpened.id + '"') &&
                body.includes('Original A')));
            let replacement;
            await run.step('submit captured view_id after another background remount',
                [action('old-mount', 'edit', { view_id: newlyOpened.id, text: 'must not write the new B' })],
                async () => { replacement = await background('replace B after adoption', newlyOpened); });
            assert.equal(writeReason('old-mount'), 'VIEW_INSTANCE_REVOKED');
            const current = await run.step('show only the replacement');
            assert.ok(viewText(current.body).some(body => body.includes('view_id="' + replacement.id + '"')));
            assert.equal(replacement.name, newlyOpened.name);
            assert.notEqual(replacement.viewInstanceId, newlyOpened.viewInstanceId);
            mounts = { firstA: a, firstB: b, openedInBackground: newlyOpened, replacement, closedA,
                staleB: writeReason('old-mount'), writesWhileStale: (await journal(folder, 'writes')).length - 1 };
        }
        const tables = run.requests.map(({ label, body }) => ({ label, tools: wireTools(body) }));
        const initialTools = tables[0].tools;
        const controls = tables.map(({ tools }) => tools.filter(tool => tool.name.startsWith('system-')));
        for (const [index, { tools }] of tables.entries()) {
            const actual = controls[index];
            for (const before of controls.slice(0, index)) {
                assert.deepEqual(actual.filter(tool => before.some(control => control.name === tool.name)),
                    before.filter(tool => actual.some(control => control.name === tool.name)));
            }
            for (const name of ['system-open_app', 'system-close_app', mode === 'dispatch' ? entry : 'run_code'])
                assert.deepEqual(tools.find(tool => tool.name === name), initialTools.find(tool => tool.name === name), name);
        }
        const disk = await readDisk(folder);
        assert.deepEqual(disk, { A: 'Original A', B: task === 'long' ? 'Original B' + updates.join('') : 'Original A' });
        const writes = await journal(folder, 'writes');
        assert.equal(writes.length, task === 'long' ? updates.length : 1);
        assert.ok(writes.every(write => write.name === 'B.txt' && write.threadId > 0));
        return { disk, writes, mounts, tables, requests: run.requests, results: Object.fromEntries(run.results) };
    } finally {
        await run.close();
        await source.dispose();
        const shutdown = await runtime.beginClose().completion;
        assert.equal(shutdown.resourcesReleased, true);
        await writeFile(join(folder, 'shutdown.json'), JSON.stringify(shutdown, null, 2));
    }
}

export async function claudeBackgroundFiles(folder) {
    await setupFiles(folder);
    const runtime = createRuntime();
    const desktop = await runtime.createDesktop();
    const { running } = await installFixture(desktop, appName, appName, moduleURL, folder);
    const source = new SemanticAOTUIDrivenSource(desktop);
    const require = createRequire(import.meta.url);
    const { anthropic } = createRequire(require.resolve('@aotui/agent-driver-v2'))('@ai-sdk/anthropic');
    const searchTool = anthropic.tools.toolSearchRegex_20251119({});
    const adopt = desktop.adoptTurn.bind(desktop);
    let adopted;
    desktop.adoptTurn = selection => {
        const result = adopt(selection);
        if (result.status === 'adopted') adopted = selection.apps[0]?.candidate.observation;
        return result;
    };

    function withSearch(context) {
        const liveEdit = context.tools[edit];
        const tools = { ...context.tools, [REGEX_SEARCH]: searchTool,
            ...(liveEdit ? { [edit]: { ...liveEdit, providerOptions: { anthropic: { deferLoading: true } } } } : {}) };
        const fit = context.fitModelBudget;
        return { ...context, tools, ...(fit ? { async fitModelBudget(measure, withFeedback) {
            const plan = await fit((candidate, feedback) => measure(withSearch(candidate), feedback), withFeedback);
            return plan.context ? { ...plan, context: withSearch(plan.context) } : plan;
        } } : {}) };
    }
    const run = await localModel('anthropic', [sourceContext(source.name, async policy => withSearch(await source.getContext(policy)))],
        { strict: false });
    const writes = () => journal(folder, 'writes');
    const searchId = 'srvtoolu_background_b', staleId = 'toolu_old_background_b';
    const findEdit = body => body.tools.find(tool => tool.name === edit);
    try {
        const vacant = await run.step('Inspect workspace before background open');
        assert.equal(findEdit(vacant.body), undefined);
        assert.equal(viewText(vacant.body).length, 1, 'only the directory View is open');
        const firstB = await signalBackgroundB(folder, running, 'Open B in the App background');
        const beforeDiscovery = { requests: run.requests.length, results: run.results.size,
            toolMessages: run.history.filter(message => message.role === 'tool').length, writes: (await writes()).length };
        assert.deepEqual(beforeDiscovery, { requests: 1, results: 0, toolMessages: 0, writes: 0 });

        const label = 'Find the editing tool for the newly visible B page';
        const search = await run.step(label, [], undefined, claudeTurn(label, foundTool(searchId, edit)).frames);
        assert.ok(viewText(search.body).some(page => page.includes('view_id="' + firstB.id + '"') && page.includes('Original B')));
        const definition = findEdit(search.body);
        assert.equal(definition?.defer_loading, true);
        assert.deepEqual(definition.input_schema.required, ['view_id', 'text']);
        assert.ok(search.body.tools.some(tool => tool.type === 'tool_search_tool_regex_20251119'));
        assert.equal(run.results.size, 0);
        assert.ok(run.history.every(message => message.role !== 'tool'));
        assert.ok(run.history.some(message => message.role === 'assistant' && Array.isArray(message.content) &&
            message.content.some(part => part.type === 'tool-call' && part.toolCallId === searchId && part.providerExecuted)));

        let replacement, observationId;
        const stale = await run.step('Try the captured B route after background replacement',
            [modelCall(staleId, edit, { view_id: firstB.id, text: 'This must never be written' })], async body => {
                assert.deepEqual(findEdit(body), definition);
                assert.ok(adopted?.views.some(view => view.id === firstB.id && view.viewInstanceId === firstB.viewInstanceId));
                observationId = adopted.observationId;
                replacement = await signalBackgroundB(folder, running, 'Replace B during the model request', firstB);
            });
        const replay = wireBlocks(stale.body);
        assert.deepEqual(replay.filter(block => block.type === 'server_tool_use').map(block => block.id), [searchId]);
        assert.deepEqual(replay.filter(block => block.type === 'tool_search_tool_result').map(block => [block.tool_use_id, block.content.tool_references]),
            [[searchId, [{ type: 'tool_reference', tool_name: edit }]]]);
        assert.ok(replay.every(block => block.type !== 'tool_result'));
        const rejected = run.results.get(staleId);
        assert.equal(rejected?.error?.code, 'VIEW_INSTANCE_REVOKED');
        assert.equal(run.results.size, 1);
        const original = await running.readReceipt({ observationId, invocationId: staleId });
        assert.equal(original.kind, 'receipt', JSON.stringify(original));
        assert.equal(original.receipt.executionPhase, 'not-dispatched');
        assert.equal(original.receipt.outcome.code, 'VIEW_INSTANCE_REVOKED');
        assert.equal(replacement.name, firstB.name);
        assert.notEqual(replacement.viewInstanceId, firstB.viewInstanceId);

        const latest = await run.step('Observe B after the rejected stale edit');
        const liveFiles = viewText(latest.body).filter(page => page.includes('view_type="file"'));
        assert.equal(liveFiles.length, 1);
        assert.ok(liveFiles[0].includes('view_id="' + replacement.id + '"'));
        const results = wireBlocks(latest.body).filter(block => block.type === 'tool_result');
        assert.deepEqual(results.map(block => block.tool_use_id), [staleId]);
        assert.match(JSON.stringify(results[0]), /VIEW_INSTANCE_REVOKED/);
        const disk = await readDisk(folder);
        assert.deepEqual(disk, { A: 'Original A', B: 'Original B' });
        const journal = await writes();
        assert.equal(journal.length, 0);
        return { requests: run.requests, beforeDiscovery, discovery: { searchId, definition },
            firstB, replacement, rejected, original, disk, writes: journal, history: run.history };
    } finally {
        await run.close();
        await source.dispose();
        const shutdown = await runtime.beginClose().completion;
        assert.equal(shutdown.resourcesReleased, true);
        assert.equal(shutdown.workers.report.total, 0);
        await writeFile(join(folder, 'shutdown.json'), JSON.stringify(shutdown, null, 2));
    }
}
