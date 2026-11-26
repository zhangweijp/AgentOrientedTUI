import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '@aotui/runtime';
import { AgentDriverV2, createProviderToolSchemaPolicy } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { consoleBindings, fixtureProvider, installFixture, journal, modelCall, watchUntil } from './batch-two-support.mjs';

const [folder, providerId] = process.argv.slice(2);
await mkdir(folder, { recursive: true });
const provider = await fixtureProvider();
const beta = providerId === 'deepseek', claude = providerId === 'anthropic';
const config = { model: beta ? 'deepseek-chat' : claude ? 'claude-sonnet-4-5' : 'gpt-4.1',
    provider: { id: providerId, baseURL: provider.url + (beta ? '/beta' : ''), toolSchemaMode: 'strict' }, apiKey: 'test-only' };
const path = claude ? '/v1/messages' : beta ? '/v1/beta/chat/completions' : '/v1/chat/completions';

function claudeFrames(calls) {
    const blocks = calls.length ? calls.flatMap(({ id, function: fn }, index) => [
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: fn.name, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fn.arguments } },
        { type: 'content_block_stop', index },
    ]) : [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
        { type: 'content_block_stop', index: 0 },
    ];
    return [{ type: 'message_start', message: { id: 'msg_' + provider.requests.length, type: 'message', role: 'assistant',
        model: config.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    ...blocks, { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 } }, { type: 'message_stop' }];
}

const runtime = createRuntime(), desktop = await runtime.createDesktop();
const source = new SemanticAOTUIDrivenSource(desktop);
const history = [], failures = [], authorizations = [];
let selectedTools, unsupported;
const driver = new AgentDriverV2({ llm: config,
    sources: [{ name: source.name, onUpdate: () => () => {}, async getContext(schema) {
        const context = await source.getContext(schema);
        selectedTools = context.tools;
        return context;
    } },
        { name: 'history', onUpdate: () => () => {}, async getContext() { return { messages: history.slice(), tools: {} }; } }],
    onAssistantMessage: message => history.push({ ...message, timestamp: Date.now() }),
    onToolResult: message => history.push({ ...message, timestamp: Date.now() }),
    onRunError: error => failures.push(String(error)),
});
const policy = {
    project({ source }) {
        return { refs: Object.values(source.refs).map(ref => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })),
            toolIds: Object.values(source.tools).filter(tool => tool.name !== 'set_recipients').map(tool => tool.id) };
    },
    authorize({ signal, ...context }) { authorizations.push(context); return true; },
    canReadReceipt: () => true,
};
const functions = body => body.tools.map(tool => claude ? { ...tool, parameters: tool.input_schema } : tool.function);
async function turn(label, calls = [], beforeReply) {
    provider.replyNext({ label, path, calls, beforeReply, ...(claude ? { frames: claudeFrames(calls) } : {}) });
    history.push({ role: 'user', content: label, timestamp: Date.now() });
    await driver.trigger();
    await driver.runInFlight;
    assert.deepEqual(failures, []);
    assert.deepEqual(provider.failures, []);
    const request = provider.requests.find(request => request.label === label);
    assert.equal(request.path, path);
    const wire = functions(request.body);
    assert.ok(wire.every(tool => tool.strict === true));
    assert.deepEqual(wire.map(({ name, description, parameters }) => [name, description, parameters]),
        JSON.parse(JSON.stringify(Object.entries(selectedTools).map(([name, tool]) =>
            [name, tool.description, tool.inputSchema.jsonSchema]))));
    for (const call of calls) assert.ok(wire.some(tool => tool.name === call.function.name));
    return request.body;
}
const result = id => history.filter(message => message.role === 'tool').flatMap(message => message.content)
    .find(part => part.toolCallId === id)?.output.value;
const run = (id, code, imports) => modelCall(id, 'run_code', { code, imports, reset: false });
try {
    if (claude) {
        const model = 'claude-3-haiku-20240307';
        await assert.rejects(createProviderToolSchemaPolicy({ ...config, model }), error => {
            unsupported = { model, code: error.code, reason: error.reason, requests: provider.requests.length };
            return error.code === 'MODEL_TOOL_SCHEMA_UNSUPPORTED' && error.reason.includes(model);
        });
        assert.equal(unsupported.requests, 0);
    }
    const peopleFile = join(folder, 'people.json');
    const directory = {
        revision: 'strict-trial', people: [{ email: 'strict@example.test', 'display.name': '本机' }],
    };
    await writeFile(peopleFile, JSON.stringify(directory));
    const modules = name => new URL('./dist/batch-three-' + name + '.js', import.meta.url).href;
    await installFixture(desktop, 'contacts', 'contacts', modules('contacts'), folder, policy);
    await installFixture(desktop, 'mail', 'mail', modules('mail'), folder, policy);
    const open = await turn('Open the draft', [modelCall('open', 'mail-open_draft', { name: 'Strict' })]);
    const body = await turn('Use the published priority and inspect its structure', [
        modelCall('priority', 'mail-set_priority', { view_id: 'draft_1', priority: '$ref.contacts.list.score' }),
        modelCall('schema', 'system-inspect_ref', { address: '$ref.contacts.list.people', mode: 'schema' }),
    ]);
    const tools = Object.fromEntries(functions(body).map(tool => [tool.name, tool.parameters]));
    assert.equal(tools['contacts-store_team'].properties.text.type, 'string');
    assert.deepEqual(tools['mail-set_priority'].properties.priority.anyOf.map(branch => branch.type), ['integer', 'string']);
    assert.match(consoleBindings(body), /"mail-set_priority"/);
    assert.doesNotMatch(consoleBindings(open), /"mail-set_priority"/);
    assert.deepEqual(functions(open).find(tool => tool.name === 'run_code'), functions(body).find(tool => tool.name === 'run_code'));
    assert.deepEqual(tools.run_code.properties.imports.anyOf, [{ type: 'array', items: { type: 'string' } },
        beta ? { type: 'string', enum: ['default'] } : { type: 'null' }]);
    assert.equal(JSON.parse(await readFile(join(folder, 'Strict.json'), 'utf8')).priority, 7);
    const scoreAddress = '$ref.contacts.list.score';
    await turn('Default imports use the captured score', [run('default', 'inspect(refs.contacts.list.score)', beta ? 'default' : null)], async () => {
        await writeFile(peopleFile + '.next', JSON.stringify({ ...directory, revision: 'new-score', score: 8 }));
        await rename(peopleFile + '.next', peopleFile);
        await watchUntil(async () => (await journal(folder, 'contacts-commits')).some(event => event.revision === 'new-score'));
    });
    await turn('An explicit empty list reads no public Refs', [run('empty', 'inspect(Object.keys(refs).length)', [])]);
    await turn('Exactly 256 explicit imports are accepted', [run('full', 'inspect(refs.contacts.list.score)', Array(256).fill(scoreAddress))]);
    await turn('257 imports fail before executing the program', [run('overflow', 'inspect("must not run")', Array(257).fill(scoreAddress))]);
    assert.deepEqual(result('default').output, ['7']);
    assert.deepEqual(result('empty').output, ['0']);
    assert.deepEqual(result('full').output, ['8']);
    assert.equal(result('overflow').code, 'CONSOLE_INVALID_INPUT');
    assert.equal(result('overflow').output, undefined);
    const terminal = await turn('Return the paired execution', []);
    const paired = claude ? terminal.messages.flatMap(message => message.content)
        .filter(part => part.type === 'tool_result' && part.tool_use_id === 'priority')
        : terminal.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'priority');
    assert.equal(paired.length, 1);
    const query = authorizations.find(context => context.invocationId === 'priority');
    const mail = desktop.listApps().find(app => app.appId === 'mail');
    const receipt = await desktop.readReceipt({ ...query, desktopId: desktop.id, appId: mail.appId, instanceId: mail.appInstanceId });
    assert.equal(receipt.receipt.outcome.status, 'succeeded');
    const wrote = await journal(folder, 'draft-writes');
    assert.equal(wrote.length, 1);
    assert.equal(wrote[0].input.priority, 7);
    assert.ok(wrote[0].threadId > 0);
    await writeFile(join(folder, 'result.json'), JSON.stringify({ providerId, requests: provider.requests, authorization: query,
        receipt, wrote, console: Object.fromEntries(['default', 'empty', 'full', 'overflow'].map(id => [id, result(id)])),
        ...(unsupported ? { unsupported } : {}) }, null, 2));
} finally {
    driver.dispose();
    await source.dispose();
    const report = await runtime.beginClose().completion;
    assert.equal(report.resourcesReleased, true);
    await writeFile(join(folder, 'shutdown.json'), JSON.stringify(report, null, 2));
    await provider.close();
}
