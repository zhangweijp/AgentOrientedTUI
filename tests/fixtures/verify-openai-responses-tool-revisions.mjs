import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureProvider, watchUntil } from './batch-two-support.mjs';
import { responsesFrames } from './batch-six-usage-support.mjs';

const [driverEntry, output, budgetMode] = process.argv.slice(2);
const { AgentDriverV2, jsonSchema } = await import(pathToFileURL(realpathSync(resolve(driverEntry))).href);
const provider = await fixtureProvider();
const fetch = globalThis.fetch;
globalThis.fetch = (request, options) => {
    assert.equal(new URL(request instanceof Request ? request.url : request).href, 'https://api.openai.com/v1/responses');
    return fetch(new URL('/v1/responses', provider.url), options);
};

const path = '/v1/responses';
const collisionName = 'aotui_previous_1', oldRegistration = 'aotui_previous_2';
const history = [], errors = [], deliveries = [], executed = [], trials = [], adoptions = [];
let timestamp = 0, phase, pickType = 'string';
const save = message => history.push({ ...message, timestamp: ++timestamp });
const functionTool = (description, key, type) => ({ description,
    inputSchema: jsonSchema({ type: 'object', properties: { [key]: { type } }, required: [key], additionalProperties: false }),
});
const driver = new AgentDriverV2({
    llm: { model: 'gpt-5.4', apiKey: 'loopback-only', provider: { id: 'openai', baseURL: 'https://api.openai.com/v1',
        openaiResponsesTools: { search: 'hosted', additionalTools: ['select_note'] } },
        ...(budgetMode === 'unbudgeted' ? {} : { inputBudget: () => ({ contextWindow: 65_536, maxOutputTokens: 512 }) }),
    },
    sources: [{ name: 'notes', onUpdate: () => () => {}, async getContext() {
        const context = {
            messages: history.slice(),
            tools: { [collisionName]: functionTool('The real collision test function.', 'flag', 'boolean'),
                ...(pickType ? { select_note: functionTool('Choose a note.', 'pick', pickType) } : {}) },
            adopt: () => adoptions.push(phase),
            fitModelBudget: async measure => {
                const measurement = await measure(context);
                trials.push({ phase, ...measurement });
                return { measurement };
            },
            async executeTool(toolName, input, toolCallId) {
                executed.push({ toolName, input, toolCallId });
                return { toolName, toolCallId, outcomeStatus: 'succeeded', result: { ok: true } };
            },
        };
        return context;
    } }],
    onAssistantMessage: save,
    onToolResult: (message, results) => { save(message); deliveries.push({ phase, results }); },
    onRunError: error => errors.push(String(error)),
});

function response(name, input, callId) {
    const item = { type: 'function_call', id: 'fc_' + callId, call_id: callId, name, arguments: JSON.stringify(input), status: 'completed' };
    return [{ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
        { type: 'response.output_item.done', output_index: 0, item }, responsesFrames('response.completed', '').at(-1)];
}

async function step(label, type, frames = responsesFrames('response.completed', label + ' done')) {
    phase = label;
    pickType = type;
    save({ role: 'user', content: label });
    const count = provider.requests.length;
    provider.replyNext({ label, path, frames });
    await driver.trigger();
    await watchUntil(() => driver.getState() === 'idle' && (provider.requests.length > count || errors.length || provider.failures.length));
    assert.deepEqual([...errors, ...provider.failures], []);
    assert.equal(provider.requests.length, count + 1);
    const request = provider.requests.at(-1);
    if (budgetMode !== 'unbudgeted') assert.equal(trials.find(trial => trial.phase === label)?.inputBytes, request.inputBytes);
    assert.equal(request.path, path);
    assert.equal(adoptions.length, count + 1);
    assert.equal(JSON.stringify(request.body).includes(oldRegistration), false);
    assert.deepEqual(request.body.tools.find(tool => tool.name === collisionName)?.parameters.properties, { flag: { type: 'boolean' } });
    return request.body.input;
}

const loads = input => input.filter(item => item.type === 'additional_tools');
try {
    const first = await step('Original', 'string');
    const second = await step('Changed', 'integer', response(collisionName, { flag: true }, 'real_collision'));
    assert.deepEqual(loads(second)[0], loads(first)[0]);
    assert.deepEqual(loads(second).map(item => item.tools[0].parameters.properties.pick.type), ['string', 'integer']);
    assert.deepEqual(loads(second).map(item => item.tools[0].name), ['select_note', 'select_note']);
    const assistant = second.findIndex(item => item.role === 'assistant');
    assert.ok(second.indexOf(loads(second)[0]) < assistant && assistant < second.indexOf(loads(second)[1]));
    assert.deepEqual(loads(await step('Repeat', 'integer')), loads(second));
    assert.deepEqual(loads(await step('Closed', null, response('select_note', { pick: 'old' }, 'closed_logical'))), loads(second));
    assert.deepEqual(loads(await step('Unknown', null, response(oldRegistration, { pick: 'old' }, 'guessed_registration'))), loads(second));
    assert.deepEqual(executed, [{ toolName: collisionName, input: { flag: true }, toolCallId: 'real_collision' }]);
    assert.deepEqual(deliveries.slice(-2).map(({ results: [result] }) => [result.toolCallId, result.error?.code]), [
        ['closed_logical', 'E_TOOL_NOT_FOUND'], ['guessed_registration', 'E_TOOL_NOT_FOUND'],
    ]);
    console.log('PASS positioned definition versions, current routes and name collision');
} finally {
    driver.dispose();
    globalThis.fetch = fetch;
    await provider.close();
    await writeFile(output, JSON.stringify({ requests: provider.requests, errors, failures: provider.failures,
        trials, adoptions, executed, deliveries, history }, null, 2));
}
