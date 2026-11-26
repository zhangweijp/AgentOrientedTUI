import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '@aotui/runtime';
import { buildViewMessageMarkup, DEFAULT_AOTUI_SYSTEM_INSTRUCTION, projectNativeToolSchema } from '@aotui/runtime/adapters';
import { AgentDriverV2 } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { fixtureAppPath, fixtureProvider, journal, modelCall, watchUntil } from './batch-two-support.mjs';

const [folder, mode = 'product'] = process.argv.slice(2);
assert.ok(folder, 'Provide a new absolute test directory.');
await mkdir(folder, { recursive: true });
const people = [
    { email: 'first@example.test', 'display.name': '甲' },
    { email: 'second@example.test', 'display.name': '乙' },
];
async function publish(revision, entries, privateScore = false) {
    const path = join(folder, 'people.json');
    await writeFile(path + '.next', JSON.stringify({ revision, people: entries, privateScore }));
    await rename(path + '.next', path);
}
async function waitForCommit(revision) {
    await watchUntil(async () => (await journal(folder, 'contacts-commits')).some(item => item.revision === revision));
}
await publish('observed', people);
const runtime = createRuntime();
const provider = await fixtureProvider();
const authorizations = [];
const errors = [];
const history = [];
const receipts = {};
const activeTurns = [];
let permittedReceiver;
const policy = {
    project({ source }) {
        return { toolIds: Object.keys(source.tools), refs: Object.values(source.refs).map(ref => ({
            refId: ref.id, viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId,
            ...(ref.id === 'team' && permittedReceiver ? { consumers: [permittedReceiver] } : {}),
        })) };
    },
    authorize({ signal, ...record }) { authorizations.push(record); return true; },
    canReadReceipt: () => true,
};
const desktop = await runtime.createDesktop({ policyForApp: () => policy });
const running = new Map();
for (const name of ['contacts', 'mail']) {
    const localPath = await fixtureAppPath(new URL('./dist/batch-three-' + name + '.js', import.meta.url).href, name, folder);
    const config = { folder, settings: { theme: 'light' } };
    const pending = desktop.registerPendingApp({ installationId: name, localPath, config });
    config.settings.theme = 'dark';
    await pending;
    running.set(name, await desktop.openApp(name));
}
const contacts = running.get('contacts');
const views = (await contacts.preview()).views;
const list = views.find(view => view.id === 'list');
const team = views.find(view => view.id === 'team');
const publishingMount = {
    appId: contacts.appId, instanceId: contacts.instanceId, viewId: list.id, viewInstanceId: list.viewInstanceId,
};
permittedReceiver = { ...publishingMount, viewId: team.id, viewInstanceId: team.viewInstanceId };
const source = mode === 'product' ? new SemanticAOTUIDrivenSource(desktop) : undefined;
const driver = source && new AgentDriverV2({
    llm: { model: 'ref-test', provider: { id: 'fixture', baseURL: provider.url }, apiKey: 'test-only' },
    sources: [
        { name: source.name, onUpdate: () => () => {}, getContext: schema => source.getContext(schema) },
        { name: 'history', onUpdate: () => () => {}, async getContext() { return { messages: history.slice(), tools: {} }; } },
    ],
    onAssistantMessage: message => history.push({ ...message, timestamp: Date.now() }),
    onToolResult: message => history.push({ ...message, timestamp: Date.now() }),
    onRunError: error => errors.push(String(error)),
});
const folded = new Set();
const inspector = 'system-inspect_ref';
const inspectInput = { type: 'object', properties: { address: { type: 'string' }, mode: { type: 'string', enum: ['schema', 'value'] } },
    additionalProperties: false, required: ['address', 'mode'] };
const wireTool = (name, parameters, description) => ({ type: 'function', function: { name, parameters, description } });

async function independentStep(label) {
    const apps = [];
    for (const app of running.values()) {
        const observed = await app.observe();
        assert.equal(observed.status, 'prepared', JSON.stringify(observed));
        const { candidate } = observed;
        const views = candidate.observation.views.filter(view => !folded.has(view.viewInstanceId))
            .map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
        apps.push({ candidate, windows: { activeViews: views } });
    }
    const refs = apps.flatMap(({ candidate: { observation }, windows }) => observation.refs.filter(ref =>
        windows.activeViews.some(view => view.viewInstanceId === ref.viewInstanceId)).map(ref => ({ source: observation.source, ref })));
    const tools = [];
    const routes = new Map();
    const messages = [{ role: 'user', content: DEFAULT_AOTUI_SYSTEM_INSTRUCTION }];
    for (const { candidate: { observation }, windows } of apps) {
        const { source } = observation;
        for (const view of observation.views) {
            const hidden = folded.has(view.viewInstanceId);
            messages.push({ role: 'user', content: buildViewMessageMarkup({ appId: source.appId, appName: source.appId,
                viewType: view.type, region: view.region, viewId: view.id, markup: hidden ? 'Collapsed' : view.content.value,
                refs: hidden ? [] : observation.refs.filter(ref => ref.viewInstanceId === view.viewInstanceId) }) });
        }
        for (const tool of observation.tools) {
            const receivers = windows.activeViews.filter(receiver => observation.views.some(view => view.id === receiver.viewId &&
                view.type === tool.viewType && (!tool.eligibleViewIds || tool.eligibleViewIds.includes(view.id))));
            if (!receivers.length) continue;
            const name = source.appId + '-' + tool.name;
            routes.set(name, { appId: source.appId, tool, observationId: observation.observationId });
            tools.push(wireTool(name, projectNativeToolSchema(tool, source, receivers, refs), tool.description));
        }
    }
    if (refs.length) tools.push(wireTool(inspector, inspectInput, 'Inspect an eligible Ref.'));
    const prepared = desktop.adoptTurn({ apps });
    assert.equal(prepared.status, 'adopted', JSON.stringify(prepared));
    activeTurns.push(prepared.turn);
    const response = await fetch(provider.url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'loopback', messages: [...messages, { role: 'user', content: label }], tools }) });
    assert.equal(response.status, 200, await response.clone().text());
    const reply = (await response.json()).choices[0].message;
    for (const call of reply.tool_calls ?? []) {
        const { name, arguments: json } = call.function;
        const { view_id, ...input } = JSON.parse(json);
        if (name === inspector) receipts[call.id] = await prepared.turn.inspectRef(input.address, input.mode);
        else {
            const route = routes.get(name);
            const result = await prepared.turn.invoke(route.appId, { invocationId: call.id, toolId: route.tool.id,
                observationId: route.observationId, ...(view_id === undefined ? {} : { viewId: view_id }), input });
            receipts[call.id] = result;
            if (result.locator) assert.deepEqual(await desktop.readReceipt(result.locator), result);
        }
    }
}

function outcome(id) {
    if (!driver) {
        const result = receipts[id];
        if (result.kind === 'receipt') return { status: result.receipt.outcome.status, code: result.receipt.outcome.code };
        if (result.status === 'ready') return { status: 'succeeded', data: result };
        return { status: 'rejected', code: result.issue?.code ?? result.code };
    }
    const part = history.flatMap(message => message.role === 'tool' ? message.content : []).find(part => part.toolCallId === id);
    assert.ok(part, 'Expected paired result for ' + id);
    const output = part.output.value;
    receipts[id] = output;
    return { status: part.output.type === 'error-json' || part.output.type === 'error-text' ? 'rejected' : 'succeeded',
        code: output?.code ?? output?.error?.code, data: output };
}
async function step(label, calls = [], beforeReply) {
    provider.replyNext({ label, calls, beforeReply });
    if (driver) {
        history.push({ role: 'user', content: label, timestamp: Date.now() });
        await driver.trigger();
        await driver.runInFlight;
    } else await independentStep(label);
    assert.deepEqual(errors, []);
    assert.deepEqual(provider.failures, []);
    const request = provider.requests.find(record => record.label === label);
    assert.ok(request, label);
    return request.body;
}
const contact = suffix => '$ref.contacts.list.' + suffix;
const inspect = (id, suffix, mode) => modelCall(id, inspector, { address: contact(suffix), mode });
const tool = (request, name) => request.tools.find(item => item.function.name === name)?.function;
const call = (id, name, args) => modelCall(id, 'mail-' + name, args);
const consoleCall = (id, code) => modelCall(id, 'run_code', { code });
let result;
try {
    const opening = await step('Open two drafts', driver ? [consoleCall('open-console', [
        "await tools['mail-open_draft']({name:'A'});", "await tools['mail-open_draft']({name:'B'});",
        "inspect(typeof tools['mail-set_recipients']);",
        "try { await tools['mail-set_recipients']({}); } catch (error) { inspect(error.name); }",
    ].join('\n'))] : [call('open-a', 'open_draft', { name: 'A' }), call('open-b', 'open_draft', { name: 'B' })]);
    assert.ok(!tool(opening, 'mail-set_recipients'));
    assert.match(JSON.stringify(opening.messages), /Theme: light/);
    if (driver) assert.deepEqual(outcome('open-console').data.output, ['undefined', 'TypeError']);
    const drafts = (await running.get('mail').preview()).views;
    const a = drafts.find(view => view.name === 'A');
    const b = drafts.find(view => view.name === 'B');
    assert.ok(a && b);
    const mixed = {
        to: ['boss@example.test', contact('people[0].email'), contact('people[0]["display.name"]'), contact('people[0].email'),
            '$HOME', '$100', '$$HOME', '$.items[0].name', '$.ajax(opts)', 'note ' + contact('secret'), '$' + contact('secret')],
        label: '$' + contact('secret'), priority: contact('score'),
        extra: { $ref: '#/defs/User', nested: [contact('secret'), { text: '$$ref.literal.notdecoded' }] },
    };
    const expected = { ...mixed, label: contact('secret'), priority: 7,
        to: [mixed.to[0], people[0].email, people[0]['display.name'], people[0].email, ...mixed.to.slice(4, -1), contact('secret')] };
    const write = [call('native-write', 'set_recipients', { view_id: a.id, ...mixed })];
    if (driver) write.push(consoleCall('console-write', "const r = await tools['mail-set_recipients'](" +
        JSON.stringify({ view_id: b.id, ...mixed }) + "); inspect(r.saved); inspect((await tools['system-inspect_ref'](" +
        JSON.stringify({ address: contact('people[0].email'), mode: 'value' }) + ")).value);"));
    else write.push(call('second-write', 'set_recipients', { view_id: b.id, ...mixed }));
    const common = await step('Route the same mixed arguments to two drafts', write, async () => {
        await publish('changed-in-flight', [people[1]]);
        await waitForCommit('changed-in-flight');
    });
    assert.equal(common.tools.filter(entry => entry.function.name === 'mail-set_recipients').length, 1);
    const wire = tool(common, 'mail-set_recipients').parameters;
    assert.equal(wire.properties.label.type, 'string');
    assert.ok(!wire.properties.label.anyOf);
    assert.deepEqual(wire.properties.extra, {});
    assert.deepEqual(wire.properties.priority.anyOf.map(node => node.type), ['integer', 'string']);
    assert.equal(wire.properties.view_id.type, 'string');
    assert.equal(outcome('native-write').status, 'succeeded');
    if (driver) assert.deepEqual(outcome('console-write').data.output, ['true', 'first@example.test']);
    else assert.equal(outcome('second-write').status, 'succeeded');
    assert.deepEqual(JSON.parse(await readFile(join(folder, 'A.json'), 'utf8')), expected);
    assert.deepEqual(JSON.parse(await readFile(join(folder, 'B.json'), 'utf8')), expected);

    const reads = [inspect('private-live-inspection', 'score', 'value'),
        call('private-live-write', 'set_priority', { view_id: a.id, priority: contact('score') })];
    if (driver) reads.push(modelCall('private-live-console', 'run_code', {
        imports: [contact('score')], code: 'throw new Error("The revoked program must never start")',
    }));
    await step('Revoke the live score without refreshing preview', reads, async () => {
        await publish('private-score', [people[1]], true);
        await waitForCommit('private-score');
    });
    for (const id of ['private-live-inspection', 'private-live-write', ...(driver ? ['private-live-console'] : [])])
        assert.notEqual(outcome(id).status, 'succeeded', id);
    assert.ok(!authorizations.some(context => context.invocationId === 'private-live-write'));

    const pass = (id, name, suffix) => modelCall(id, 'contacts-' + name, { text: contact(suffix) });
    await step('Check scope for inspection and tool use', [
        inspect('public-schema', 'people', 'schema'), inspect('public-value', 'people[0].email', 'value'),
        inspect('private-shape', 'secret', 'schema'), inspect('private-value', 'secret', 'value'),
        inspect('protected-shape', 'empty[0].email', 'schema'), inspect('protected-value', 'team', 'value'),
        pass('same-mount', 'store_here', 'secret'), pass('other-mount-private', 'store_team', 'secret'),
        pass('same-app-granted', 'store_team', 'team'), pass('same-app-ungranted', 'store_here', 'team'),
        call('cross-app-protected', 'set_recipients', { view_id: a.id, ...mixed, to: [contact('team')] }),
        call('wrong-shape', 'set_recipients', { view_id: a.id, ...mixed, to: [contact('people[0]')] }),
        call('real-nominal', 'choose_contact', { view_id: a.id, contact: contact('people[0]') }),
        call('nominal-copy', 'choose_contact', { view_id: a.id, contact: people[1] }),
    ]);
    for (const id of ['public-schema', 'public-value', 'private-shape', 'protected-shape', 'same-mount', 'same-app-granted', 'real-nominal'])
        assert.equal(outcome(id).status, 'succeeded', id);
    for (const id of ['private-value', 'protected-value', 'other-mount-private', 'same-app-ungranted', 'cross-app-protected', 'wrong-shape', 'nominal-copy'])
        assert.equal(outcome(id).status, 'rejected', id);
    assert.deepEqual({ ...outcome('protected-shape').data.schema }, { type: 'string' });
    assert.equal(outcome('public-value').data.value, people[1].email);
    if (driver) {
        await step('Transfer private and protected data without direct reads', [consoleCall('scope-console', [
            "await tools['contacts-store_here']({text:'$ref.contacts.list.secret'});",
            "await tools['contacts-store_team']({text:'$ref.contacts.list.team'});",
            "try { await tools['system-inspect_ref']({ address:'$ref.contacts.list.team', mode:'value' }); } catch (error) { inspect(error.code); }",
        ].join('\n'))]);
        assert.deepEqual(outcome('scope-console').data.output, ['REF_VALUE_PRIVATE']);
        const fold = modelCall('fold-contacts', 'system-collapse_view', { app_id: 'contacts', view_id: 'list', note: 'Read later' });
        await step('Fold the Ref source, then inspect in the same response', [fold, inspect('after-fold', 'score', 'value')]);
        assert.equal(outcome('after-fold').status, 'rejected');
    } else {
        desktop.revokeWindowAccess(activeTurns.at(-1), publishingMount);
        assert.equal((await activeTurns.at(-1).inspectRef(contact('score'), 'value')).status, 'rejected');
        folded.add(list.viewInstanceId);
    }
    const hidden = await step('The folded source supplies no Reference parameter branches');
    assert.equal(tool(hidden, 'mail-set_priority').parameters.properties.priority.type, 'integer');
    assert.equal(tool(hidden, inspector), undefined);
    const old = activeTurns.at(-2);
    if (old) assert.equal((await old.inspectRef(contact('people'), 'schema')).status, 'rejected');
    if (driver) {
        const followUp = provider.requests.find(request => request.label === 'Check scope for inspection and tool use');
        const paired = followUp.body.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'console-write');
        assert.equal(paired.length, 1);
    }
    const disk = await journal(folder, 'draft-writes');
    assert.equal(disk.length, 3);
    assert.ok(disk.every(entry => entry.frozen && entry.threadId > 0));
    const scopes = [['list', 'only-on-list'], ['team', 'inside-contacts']];
    assert.deepEqual((await journal(folder, 'contacts-writes')).map(entry => [entry.view, entry.text]), driver ? [...scopes, ...scopes] : scopes);
    const originalReceipts = {};
    for (const context of authorizations) {
        const app = running.get(context.source.appId);
        const query = { observationId: context.observationId, invocationId: context.invocationId };
        const result = await app.readReceipt(query);
        assert.equal(result.kind, 'receipt');
        assert.equal(result.receipt.outcome.status, 'succeeded');
        originalReceipts[context.invocationId] = result;
    }
    result = { mode, requests: provider.requests, receipts, originalReceipts, authorizations, writes: disk, failed: errors };
} finally {
    if (driver) driver.dispose();
    if (source) await source.dispose();
    const shutdown = await runtime.beginClose().completion;
    assert.equal(shutdown.resourcesReleased, true);
    assert.equal(shutdown.workers.report.total, 0);
    await provider.close();
    if (result) {
        result.shutdown = shutdown;
        result.workers = { mail: await journal(folder, 'mail-lifecycle'), contacts: await journal(folder, 'contacts-lifecycle') };
        await writeFile(join(folder, 'result.json'), JSON.stringify(result, null, 2));
        console.log(mode + ': ' + result.requests.length + ' actual requests, ' + result.writes.length + ' draft writes, all Workers released.');
    }
}
