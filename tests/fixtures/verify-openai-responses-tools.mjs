import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureProvider, journal, watchUntil } from './batch-two-support.mjs';
import { responsesFrames } from './batch-six-usage-support.mjs';

const [consumerPath, outputPath, requestedMode] = process.argv.slice(2);
const consumer = resolve(consumerPath), output = resolve(outputPath);
const require = createRequire(pathToFileURL(join(consumer, 'package.json')));
const appFolder = await mkdtemp(join(consumer, 'responses-files-'));
const entry = join(appFolder, 'entry.mjs');
await writeFile(entry, `export { createRuntime } from '@aotui/runtime';
export { AgentDriverV2 } from '@aotui/agent-driver-v2';
export { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
`);
const { createRuntime, AgentDriverV2, SemanticAOTUIDrivenSource } = await import(pathToFileURL(entry).href);
const appPath = join(appFolder, 'app.mjs');
await cp(new URL('./openai-responses-files.mjs', import.meta.url), appPath);
const driverRequire = createRequire(require.resolve('@aotui/agent-driver-v2'));
const versions = Object.fromEntries(['ai', '@ai-sdk/openai'].map(name => [name, driverRequire(name + '/package.json').version]));
const official = 'https://api.openai.com/v1/responses';
const listName = 'responses_files-list', editName = 'responses_files-edit';
const path = '/v1/responses';
const historyText = 'Open files in the background and then write B only.';
const written = '$$ref.literal';
const maxBudget = 65_536;
const listDefinition = { type: 'function', name: listName,
    description: 'List the names of the files in this workspace.\nApp ID responses_files, view_type directory (single).',
    parameters: { type: 'object', properties: {}, additionalProperties: false, required: [] }, strict: false, defer_loading: true };
await mkdir(output, { recursive: true });

function itemFrames(items) {
    const finish = responsesFrames('response.completed', 'unused').at(-1);
    return [...items.flatMap((item, output_index) => [
        { type: 'response.output_item.added', output_index, item: item.type === 'function_call'
            ? { ...item, arguments: '' } : { ...item, status: 'in_progress' } },
        ...(item.type === 'function_call' ? [{ type: 'response.function_call_arguments.delta', item_id: item.id,
            output_index, delta: item.arguments }] : []),
        { type: 'response.output_item.done', output_index, item },
    ]), finish];
}

function call(id, args) {
    return itemFrames([{ type: 'function_call', id: 'fc_' + id, call_id: id, name: editName,
        arguments: JSON.stringify(args), status: 'completed' }]);
}

function checkSearch(body, mode, searchId) {
    const calls = body.input.filter(item => item.type === 'tool_search_call');
    const outputs = body.input.filter(item => item.type === 'tool_search_output');
    const execution = mode === 'hosted' ? 'server' : 'client';
    const callId = mode === 'hosted' ? null : searchId;
    assert.equal(calls.length, 1);
    assert.equal(outputs.length, 1);
    assert.equal(calls[0].id, 'ts_' + mode);
    if (mode === 'hosted') assert.equal(outputs[0].id, 'tso_hosted');
    for (const item of [calls[0], outputs[0]]) {
        assert.equal(item.execution, execution);
        assert.equal(item.call_id, callId);
        assert.equal(item.status, 'completed');
    }
    assert.ok(body.input.indexOf(calls[0]) < body.input.indexOf(outputs[0]));
    assert.deepEqual(outputs[0].tools, [listDefinition]);
    assert.equal(body.input.filter(item => item.type === 'function_call' && item.name === 'tool_search').length, 0);
    if (callId) assert.equal(body.input.filter(item => item.type === 'function_call_output' && item.call_id === callId).length, 0);
}

for (const mode of requestedMode ? [requestedMode] : ['hosted', 'client']) {
    assert.ok(mode === 'hosted' || mode === 'client');
    const folder = join(output, mode);
    await mkdir(folder);
    await Promise.all([writeFile(join(folder, 'A.txt'), 'Alpha'), writeFile(join(folder, 'B.txt'), 'Bravo')]);
    const runtime = createRuntime();
    const desktop = await runtime.createDesktop();
    const source = new SemanticAOTUIDrivenSource(desktop);
    const provider = await fixtureProvider();
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        assert.equal(url.href, official, 'The fixture only allows intercepted OpenAI Responses requests.');
        return nativeFetch(new URL(path, provider.url), init);
    };

    let history = [], label, timestamp = 0, inputLimit = maxBudget;
    const measured = {}, errors = [], deliveries = [], adopted = [];
    const originalAdoption = desktop.adoptTurn.bind(desktop);
    desktop.adoptTurn = input => {
        const result = originalAdoption(input);
        if (result.status === 'adopted') adopted.push({ label, observation: input.apps[0]?.candidate.observation });
        return result;
    };
    const save = message => history.push({ ...message, timestamp: ++timestamp });
    const startDriver = () => new AgentDriverV2({
        llm: { model: 'gpt-5.4', provider: { id: 'openai', baseURL: 'https://api.openai.com/v1',
            openaiResponsesTools: { search: mode, additionalTools: [editName], deferredTools: [listName] } },
            apiKey: 'loopback-only', inputBudget: () => ({ contextWindow: maxBudget * 2, maxInputTokens: inputLimit, maxOutputTokens: 512 }) },
        sources: [{ name: source.name, onUpdate: () => () => {}, async getContext(schema) {
            const context = await source.getContext(schema);
            return { ...context, fitModelBudget: (measure, withFeedback) => context.fitModelBudget(async (candidate, feedback) => {
                const value = await measure(candidate, feedback);
                (measured[label] ??= []).push(value);
                return value;
            }, withFeedback) };
        } }, { name: 'history', onUpdate: () => () => {}, async getContext() { return { messages: history.slice(), tools: {} }; } }],
        onAssistantMessage: save,
        onToolResult: (message, results) => { save(message); deliveries.push({ label, message, results }); },
        onRunError: error => errors.push({ label, code: error.code, message: error.message, details: error.details }),
    });
    let driver = startDriver();
    const name = 'responses_files';
    let running, initial, reopen, receipt, oldBinding, release;
    const searchId = 'call_search_' + mode, editId = 'call_edit_b_' + mode;
    const getViews = () => desktop.getAppWindows(running.appId, running.instanceId)?.views ?? [];
    const file = view => ({ appId: running.appId, instanceId: running.instanceId, viewId: view.viewId, viewInstanceId: view.viewInstanceId });
    const at = name => getViews().find(view => view.name === name);
    const takeAdoption = step => adopted.find(value => value.label === step)?.observation;

    async function step(current, frames, prompt = current) {
        label = current;
        if (prompt) save({ role: 'user', content: prompt });
        const requests = provider.requests.length, errorCount = errors.length;
        provider.replyNext({ label, path, frames });
        await driver.trigger();
        await watchUntil(() => driver.getState() === 'idle' && (errors.length > errorCount || provider.requests.length > requests || provider.failures.length));
        assert.deepEqual(errors.slice(errorCount), [], JSON.stringify(errors));
        assert.deepEqual(provider.failures, []);
        assert.equal(provider.requests.length, requests + 1);
        const request = provider.requests.at(-1);
        assert.equal(request.path, path);
        assert.equal(request.body.store, false);
        assert.ok(measured[label]?.some(value => value.inputBytes === request.inputBytes), 'The actual body must equal the encoded budget trial in size.');
        return request.body;
    }

    async function backgroundOpen(names) {
        const current = join(folder, 'open.json');
        await writeFile(current + '.next', JSON.stringify(names));
        await rename(current + '.next', current);
        await watchUntil(async () => {
            await running.preview();
            return names.every(at);
        });
    }

    try {
        running = await desktop.installDynamicWorkerApp(pathToFileURL(appPath).href, { installationId: name, name, config: { folder } });
        const find = { type: 'tool_search_call', id: 'ts_' + mode, status: 'completed',
            ...(mode === 'hosted' ? { execution: 'server', call_id: null, arguments: { paths: [listName] } } :
                { execution: 'client', call_id: searchId, arguments: { names: [listName, 'not_available'] } }) };
        const searchSent = await step('search', itemFrames([find, ...(mode === 'hosted' ? [{ type: 'tool_search_output',
            id: 'tso_hosted', execution: 'server', call_id: null, status: 'completed', tools: [listDefinition] }] : [])]));
        assert.deepEqual(searchSent.tools.filter(tool => tool.type === 'tool_search').map(tool => tool.execution),
            [mode === 'hosted' ? 'server' : 'client']);
        assert.equal(searchSent.tools.some(tool => tool.name === listName), mode === 'hosted');
        if (mode === 'hosted') assert.deepEqual(searchSent.tools.find(tool => tool.name === listName), listDefinition);
        assert.ok(searchSent.tools.some(tool => tool.name === 'system-open_app'));
        assert.equal(searchSent.tools.some(tool => tool.name === editName), false);
        assert.equal(searchSent.input.some(item => item.type === 'additional_tools'), false);
        const searchDeliveries = deliveries.filter(item => item.label === 'search');
        assert.equal(searchDeliveries.length, mode === 'client' ? 1 : 0);
        if (mode === 'client') assert.deepEqual(searchDeliveries[0].results, []);

        await backgroundOpen(['A.txt', 'B.txt']);
        initial = { a: at('A.txt'), b: at('B.txt') };
        label = 'over-budget';
        save({ role: 'user', content: historyText });
        inputLimit = 1;
        await driver.trigger();
        await watchUntil(() => driver.getState() === 'idle' && errors.length > 0);
        assert.equal(errors[0].code, 'MODEL_INPUT_BUDGET_EXCEEDED');
        assert.equal(provider.requests.length, 1);
        assert.equal(takeAdoption('over-budget'), undefined);
        assert.equal(history.some(message => JSON.stringify(message).includes('aotuiToolsLoaded')), false);
        inputLimit = maxBudget;

        const editable = expected => ({ view_id: initial.b.viewId, expected, text: '$' + written });
        const edit = await step('edit-b', call(editId, editable(`$ref.${running.appId}.${initial.b.viewId}.contents`)), '');
        checkSearch(edit, mode, searchId);
        assert.equal(edit.input.some(item => item.type === 'function_call_output'), false, 'The background load has no trigger tool result.');
        const load = edit.input.at(-1);
        assert.equal(load.type, 'additional_tools');
        assert.equal(load.role, 'developer');
        assert.deepEqual(load.tools.map(tool => tool.name), [editName]);
        assert.deepEqual(load.tools[0].parameters.required.slice().sort(), ['expected', 'text', 'view_id']);
        const pageManagement = ['system-close_view', 'system-inspect_ref'];
        assert.deepEqual(edit.tools.filter(tool => pageManagement.includes(tool.name)).map(tool => tool.name).sort(), pageManagement);
        assert.deepEqual(edit.tools.filter(tool => !pageManagement.includes(tool.name)), searchSent.tools);
        const observation = takeAdoption('edit-b');
        assert.equal(observation.views.filter(view => view.type === 'file').length, 2);
        receipt = await running.readReceipt({ observationId: observation.observationId, invocationId: editId });
        assert.equal(receipt.kind, 'receipt');
        assert.equal(receipt.receipt.executionPhase, 'entered-returned');
        assert.equal(receipt.receipt.outcome.status, 'succeeded');

        async function rejectView(label, id) {
            const request = await step(label, call(id, { view_id: initial.a.viewId, expected: 'Alpha', text: 'Forbidden old route' }));
            const delivery = deliveries.find(entry => entry.label === label)?.results.find(result => result.toolCallId === id);
            assert.equal(delivery?.outcomeStatus, 'rejected', JSON.stringify(delivery));
            return { request, delivery };
        }
        const held = await running.observe();
        assert.equal(held.status, 'prepared');
        const heldObservation = held.candidate.observation;
        label = 'original-binding';
        const heldTurn = desktop.adoptTurn({ apps: [{ candidate: held.candidate }] });
        assert.equal(heldTurn.status, 'adopted');
        const invokeOld = invocationId => heldTurn.turn.invoke(running.appId, {
            invocationId, observationId: heldObservation.observationId, toolId: heldObservation.tools.find(tool => tool.name === 'edit').id,
            viewId: initial.a.viewId, input: { expected: 'Alpha', text: 'Forbidden original binding' },
        });
        assert.equal((await desktop.closeView(file(initial.a))).status, 'closed');
        const afterClose = await invokeOld('old_binding_closed_' + mode);
        assert.equal(afterClose.receipt?.executionPhase, 'not-dispatched', JSON.stringify(afterClose));
        assert.equal(afterClose.receipt.outcome.code, 'VIEW_INSTANCE_REVOKED');
        const closedA = await rejectView('closed-a', 'call_closed_a_' + mode);
        assert.equal(closedA.delivery.error.code, 'TOOL_UNAVAILABLE');
        function checkLoadReplay(body) {
            checkSearch(body, mode, searchId);
            const position = body.input.findIndex(item => item.type === 'additional_tools');
            assert.deepEqual(body.input[position], load);
            assert.equal(body.input.filter(item => item.type === 'additional_tools').length, 1);
            assert.equal(body.input[position + 1].call_id, editId);
            assert.equal(body.input[position + 1].type, 'function_call');
            assert.equal(body.input.filter(item => item.type === 'function_call_output' && item.call_id === editId).length, 1);
            assert.equal(body.tools.some(tool => tool.name === editName), false);
        }
        checkLoadReplay(closedA.request);

        assert.equal((await desktop.closeView(file(initial.b))).status, 'closed');
        const historyPath = join(folder, 'saved-history.json');
        await writeFile(historyPath, JSON.stringify(history, null, 2));
        driver.dispose();
        history = JSON.parse(await readFile(historyPath, 'utf8'));
        driver = startDriver();
        const closedAll = await rejectView('no-open-files', 'call_no_view_' + mode);
        checkLoadReplay(closedAll.request);
        assert.equal(closedAll.delivery.error.code, 'E_TOOL_NOT_FOUND');
        assert.equal(takeAdoption('no-open-files').tools.some(tool => tool.name === 'edit'), false);

        await backgroundOpen(['A.txt']);
        reopen = at('A.txt');
        assert.notEqual(reopen.viewId, initial.a.viewId);
        assert.notEqual(reopen.viewInstanceId, initial.a.viewInstanceId);
        const stale = await rejectView('same-file-reopened', 'call_reopened_' + mode);
        assert.equal(stale.delivery.error.code, 'TOOL_UNAVAILABLE');
        const afterReopen = await invokeOld('old_binding_reopened_' + mode);
        assert.equal(afterReopen.kind, 'refused');
        assert.equal(afterReopen.code, 'TURN_NOT_ACTIVE');
        oldBinding = { afterClose, afterReopen };
        checkLoadReplay(stale.request);
        assert.equal(takeAdoption('same-file-reopened').tools.some(tool => tool.name === 'edit'), true);

        assert.equal(await readFile(join(folder, 'A.txt'), 'utf8'), 'Alpha');
        assert.equal(await readFile(join(folder, 'B.txt'), 'utf8'), written);
        assert.deepEqual(await journal(folder, 'edits'), [{ name: 'B.txt', next: written }]);
        assert.equal(provider.requests.length, 5);
        assert.equal(errors.length, 1);
    } finally {
        driver.dispose();
        await source.dispose();
        globalThis.fetch = nativeFetch;
        await provider.close();
        release = await runtime.beginClose().completion;
        await writeFile(join(folder, 'evidence.json'), JSON.stringify({ mode, versions, initial, reopen, receipt, oldBinding, release,
            history, measured, requests: provider.requests, errors, deliveries,
            files: { A: await readFile(join(folder, 'A.txt'), 'utf8'), B: await readFile(join(folder, 'B.txt'), 'utf8') },
            writes: await journal(folder, 'edits'), failures: provider.failures }, null, 2));
    }
    assert.equal(release.resourcesReleased, true);
    assert.equal(release.workers.report.total, 0);
    console.log('PASS OpenAI Responses', { mode, requests: provider.requests.length, versions });
}
