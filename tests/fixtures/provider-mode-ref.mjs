import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { createProviderToolSchemaPolicy, jsonSchema } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { createRuntime } from '@aotui/runtime';
import { projectNativeToolSchema } from '@aotui/runtime/adapters';
import { installFixture, journal, modelCall } from './batch-two-support.mjs';
import { localModel, providerConfig, providerIds, sourceContext, wireTools } from './provider-mode-local.mjs';

const draftName = 'reference_draft';
const fields = { count: 'set_count', mode: 'set_mode', exact: 'set_exact', to: 'set_recipients', text: 'set_text' };
const name = field => draftName + '-draft-' + fields[field];
const address = field => '$ref.contacts.list.' + field;
const first = 'first@example.test', second = 'second@example.test', other = 'copy@example.test';
const emails = [first, second, first];
const localMode = '$ref.reference_draft.options.mode';
const whole = address('emails');
const numeric = address('numbers');
const score = address('score');
const options = name => new URL('./dist/' + name + '.js', import.meta.url).href;
const clone = object => JSON.parse(JSON.stringify(object));

function replaceFields(context, schemas, onlyField) {
    const tools = { ...context.tools };
    for (const field of onlyField ? [onlyField] : Object.keys(fields)) {
        const tool = tools[name(field)];
        if (!tool) continue;
        const previous = tool.inputSchema.jsonSchema;
        tools[name(field)] = { ...tool, inputSchema: jsonSchema({
            ...previous, properties: { ...previous.properties, [field]: schemas[field].properties[field] },
        }) };
    }
    return { ...context, tools };
}

async function observations({ draft, contacts }) {
    const store = [];
    try {
        for (const app of [draft, contacts].filter(Boolean)) {
            const prepared = await app.observe();
            assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
            store.push(prepared.candidate);
        }
        return store.map(candidate => candidate.observation);
    } finally {
        for (const candidate of store) candidate.discard();
    }
}

function schemasFor([draft]) {
    return Object.fromEntries(Object.entries(fields).flatMap(([field, operation]) => {
        const tool = draft.tools.find(value => value.name === operation);
        return tool ? [[field, projectNativeToolSchema(tool)]] : [];
    }));
}

async function setup(folder, { explicit = false, includeConst = true } = {}) {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'people.json'), JSON.stringify({
        revision: 'experiment', people: [], emails, numbers: [2, 7], score: 7,
    }));
    const runtime = createRuntime(), desktop = await runtime.createDesktop();
    const authorizations = new Map();
    const granted = view => ({ viewId: view.ownerViewId, viewInstanceId: view.ownerViewInstanceId, refId: view.id });
    const targetPolicy = { project: ({ source }) => ({
        refs: Object.values(source.refs).map(granted),
        toolIds: Object.values(source.tools).filter(tool => includeConst || tool.name !== fields.exact).map(tool => tool.id),
    }), authorize({ invocationId, observationId }) {
        authorizations.set(invocationId, { invocationId, observationId });
        return true;
    }, canReadReceipt: () => true };
    const { running: draft } = await installFixture(desktop, draftName, draftName, options('provider-mode-values'), folder, targetPolicy);
    const without = await observations({ draft });
    const view = without[0].views.find(view => view.type === 'draft');
    const receiver = { appId: draft.appId, instanceId: draft.instanceId, viewId: view.id, viewInstanceId: view.viewInstanceId };
    const contactPolicy = { project: ({ source }) => ({
        refs: Object.values(source.refs).map(view => ({ ...granted(view),
            ...(explicit && view.scope === 'public' ? { consumers: [receiver] } : {}) })),
        toolIds: Object.keys(source.tools),
    }), authorize: () => true, canReadReceipt: () => true };
    const { running: contacts } = await installFixture(desktop, 'contacts', 'contacts', options('batch-three-contacts'), folder, contactPolicy);
    const withContacts = await observations({ draft, contacts });
    const source = new SemanticAOTUIDrivenSource(desktop);
    return { without, withContacts, source, readReceipt: id => draft.readReceipt(authorizations.get(id)), async close() {
        await source.dispose();
        const shutdown = await runtime.beginClose().completion;
        assert.equal(shutdown.resourcesReleased, true);
        await writeFile(join(folder, 'shutdown.json'), JSON.stringify(shutdown, null, 2));
    } };
}

export async function isolatedReplay(folder) {
    const { without, withContacts, source, close } = await setup(folder, { includeConst: false });
    const before = schemasFor(without), after = schemasFor(withContacts);
    const facts = {};
    try {
        assert.deepEqual(before, after);
        assert.deepEqual(after.count.properties.count.anyOf.map(branch => branch.type), ['integer', 'string']);
        for (const id of providerIds) {
            const policy = await createProviderToolSchemaPolicy(providerConfig(id, 'http://127.0.0.1:1/v1'));
            const base = await source.getContext(policy);
            try {
                const preamble = { role: 'user', region: 'static', timestamp: 0,
                    content: [{ type: 'text', text: 'Experiment transcript prefix. Keep this text fixed.\n'.repeat(400),
                        ...(id === 'anthropic' ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } } : {}) }] };
                const { messages, tools } = base;
                let selected = before;
                const run = await localModel(id, [sourceContext('fixed replay', async () =>
                    replaceFields({ messages: [preamble, ...messages], tools, preserveTools: true }, selected, 'count'))], { saveHistory: false });
                try {
                    const first = await run.step('A original');
                    const repeated = await run.step('A original replay');
                    selected = after;
                    const switched = await run.step('A with reference Schema');
                    const repeatedSwitch = await run.step('A reference replay');
                    assert.equal(first.raw, repeated.raw);
                    assert.equal(switched.raw, repeatedSwitch.raw);
                    assert.deepEqual(first.body, switched.body);
                    if (id === 'anthropic') assert.ok(first.body.messages.flatMap(message => message.content)
                        .some(part => part.cache_control?.type === 'ephemeral'));
                    facts[id] = run.requests;
                } finally { await run.close(); }
            } finally { await base.release(); }
        }
        return facts;
    } finally { await close(); }
}

export async function refStrategy(folder, strategy, explicit = false) {
    const { without, withContacts, source, readReceipt, close } = await setup(folder, { explicit });
    const empty = schemasFor(without);
    const selected = schemasFor(withContacts);
    let projection = selected;
    const run = await localModel('openai', [sourceContext(source.name, async policy => {
        const { fitModelBudget, ...context } = await source.getContext(policy);
        return replaceFields(context, projection);
    })], { strict: false });
    const schema = field => selected[field].properties[field];
    const grants = withContacts[1].refs.filter(ref => ref.scope === 'public');
    assert.ok(grants.every(ref => explicit ? ref.consumers?.length === 1 : ref.consumers === undefined));
    const disk = async () => JSON.parse(await readFile(join(folder, 'ref-draft.json'), 'utf8'));
    const writes = () => journal(folder, 'ref-writes');
    const expectWrite = async (id, field, input, expected = input) => {
        const count = (await writes()).length;
        await run.step(id, [modelCall(id, name(field), { [field]: input })]);
        const result = run.results.get(id);
        assert.equal(result?.outcomeStatus, 'succeeded', id + ': ' + JSON.stringify(result));
        const value = await disk();
        assert.deepEqual(value, { field, value: expected });
        assert.equal((await writes()).length, count + 1);
        const original = await readReceipt(id);
        assert.equal(original.kind, 'receipt', JSON.stringify(original));
        assert.equal(original.receipt.executionPhase, 'entered-returned');
        assert.equal(original.receipt.outcome.status, 'succeeded');
        return { input, value, result, receipt: original.receipt };
    };
    const expectReject = async (id, field, input, code) => {
        const before = await disk(), count = (await writes()).length;
        await run.step(id, [modelCall(id, name(field), { [field]: input })]);
        const result = run.results.get(id);
        assert.equal(result?.error?.code, code, id + ': ' + JSON.stringify(result));
        assert.deepEqual(await disk(), before);
        assert.equal((await writes()).length, count);
        return { input, value: before, result, writes: 0 };
    };

    try {
        const request = await run.step('two real Apps with contact and draft pages');
        for (const field of Object.keys(fields)) {
            const tool = wireTools(request.body).find(tool => tool.name === name(field));
            assert.deepEqual(tool.schema.properties[field], clone(schema(field)));
        }
        assert.equal(Check(schema('count'), score), true);
        assert.equal(Check(schema('to'), whole), true);
        assert.equal(Check(schema('to'), [other, whole + '[1]']), true);
        for (const field of ['mode', 'exact']) {
            assert.equal(Check(schema(field), localMode), true);
            assert.equal(Check(schema(field), 'fast'), true);
            assert.equal(Check(schema(field), 'turbo'), false);
        }
        assert.equal(Check(schema('mode'), 'accurate'), true);
        assert.equal(Check(schema('exact'), 'accurate'), false);

        const facts = {};
        facts.whole = { path: 'one native address', extraTools: 0, edit: await expectWrite('send whole address', 'to', whole, emails) };
        facts.integer = { path: 'one native address', extraTools: 0, edit: await expectWrite('send integer address', 'count', score, 7) };
        facts.mixed = await expectWrite('send mixed single items', 'to', [other, whole + '[1]'], [other, second]);
        assert.equal(Check(schema('to'), numeric), true);
        facts.wrongArray = await expectReject('wrong array address', 'to', numeric, 'REF_VALUE_UNSUPPORTED');
        facts.mode = {
            literal: await expectWrite('literal accurate', 'mode', 'accurate'),
            address: await expectWrite('protected mode', 'mode', localMode, 'fast'),
            rejected: await expectReject('synthetic invalid mode', 'mode', 'turbo', 'TOOL_INVALID_ARGS'),
        };
        facts.exact = {
            literal: await expectWrite('literal fast', 'exact', 'fast'),
            address: await expectWrite('protected exact', 'exact', localMode, 'fast'),
            rejected: await expectReject('synthetic invalid exact', 'exact', 'turbo', 'TOOL_INVALID_ARGS'),
        };

        if (strategy === 1) {
            // These are labeled, injected errors; they make no claim about model error frequencies.
            const wrongItem = await expectWrite('synthetic wrong index', 'text', whole + '[1]', second);
            const unescapedRejected = await expectReject('synthetic unescaped malformed address', 'text', '$ref.example', 'TOOL_INVALID_ARGS');
            const unescapedSuccess = await expectWrite('synthetic unescaped literal matches an address', 'text', whole + '[0]', first);
            const escaped = await expectWrite('escaped literal uses exact bytes', 'text', '$' + whole + '[0]', whole + '[0]');
            facts.scoring = {
                wrongElement: { expected: first, actual: wrongItem.value.value, miss: wrongItem.value.value !== first },
                unescapedRejected: { outcome: unescapedRejected.result.error.code, writeSucceeded: false },
                successButWrongDisk: { expected: whole + '[0]', actual: unescapedSuccess.value.value,
                    receipt: unescapedSuccess.receipt, miss: unescapedSuccess.value.value !== whole + '[0]' },
                escaped: escaped.value,
            };
            assert.equal(facts.scoring.wrongElement.miss, true);
            assert.equal(facts.scoring.successButWrongDisk.miss, true);
        }

        await run.step('close the contacts App', [modelCall('close', 'system-close_app', { app_id: 'contacts' })]);
        assert.equal(run.results.get('close').outcomeStatus, 'succeeded');
        projection = empty;
        const after = await run.step('new request with the sources withdrawn');
        assert.ok(!after.body.tools.some(entry => entry.function.name.startsWith('contacts-')));
        assert.deepEqual(wireTools(after.body).find(tool => tool.name === name('count')).schema.properties.count, clone(empty.count.properties.count));
        assert.equal(Check(empty.count.properties.count, score), true);
        assert.deepEqual(selected, empty);
        facts.closedSource = await expectReject('static permits the unavailable address at the wire', 'count', score, 'REF_NOT_VISIBLE');
        facts.literalAfterClose = await expectWrite('write literal count after close', 'count', 8);

        const preflight = {};
        for (const provider of providerIds) {
            const policy = await createProviderToolSchemaPolicy(providerConfig(provider, 'http://127.0.0.1:1/v1'));
            preflight[provider] = Object.fromEntries(Object.entries(selected).map(([field, toolSchema]) => [field, policy.check(toolSchema) ?? null]));
        }
        assert.equal(preflight.openai.exact.path, '$.properties.exact.anyOf[0].const');
        assert.equal(preflight.deepseek.exact.path, '$.properties.exact.anyOf[0].const');
        assert.ok(Object.values(preflight.anthropic).every(issue => issue === null));
        const actualWrites = await writes();
        assert.ok(actualWrites.every(record => record.threadId > 0));
        return { facts, preflight, selected, empty, grants, exactDisk: await disk(), writes: actualWrites,
            requests: run.requests, results: Object.fromEntries(run.results) };
    } finally { await run.close(); await close(); }
}
