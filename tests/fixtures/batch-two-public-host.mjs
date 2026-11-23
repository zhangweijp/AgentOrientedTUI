import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '@aotui/runtime';
import { buildPublicToolName, buildViewMessageMarkup, DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from '@aotui/runtime/adapters';
import { CHANGED, MAIL_TOOL, ORIGINAL, TO_CONTACTS, fixtureProvider, installFixture, journal, modelCall, observe, setContacts, watchUntil } from './batch-two-support.mjs';

const folder = process.argv[2];
await mkdir(folder, { recursive: true });
await setContacts(folder, ORIGINAL);
const runtime = createRuntime();
const provider = await fixtureProvider();
const facts = { adopted: [], authorize: [], receiptReads: [], calls: [], outcomes: {} };
try {
    const desktop = runtime.getDesktop(await runtime.createDesktop());
    const contacts = await installFixture(runtime, desktop, 'contacts', 'contacts_install',
        new URL('./dist/batch-two-contacts.js', import.meta.url).href, folder);
    const mail = await installFixture(runtime, desktop, 'mail', 'mail_install',
        new URL('./dist/batch-two-mail.js', import.meta.url).href, folder, {
            project: ({ source }) => ({ refs: [], toolIds: Object.keys(source.tools) }),
            authorize: context => { facts.authorize.push({ ...context, signal: undefined }); return true; },
            canReadReceipt: metadata => { facts.receiptReads.push(metadata); return true; },
        });
    const select = async (...apps) => Promise.all(apps.map(async app => ({ ...app, observation: await observe(app.client) })));
    function release(selection) {
        for (const { client, observation } of selection) client.releaseObservation(observation.observationId);
    }
    async function send(label, selection, calls, { beforeReply, maxInputBytes = Infinity } = {}) {
        const pages = selection.flatMap(({ app, observation }) => observation.views.map(view => {
            const refs = observation.refs.filter(ref => ref.viewId === view.id && ref.viewInstanceId === view.viewInstanceId);
            return buildViewMessageMarkup({ appId: app.appId, appName: app.name, viewId: view.id, viewType: view.type, markup: view.content.value, refs });
        }));
        const routes = new Map();
        const tools = selection.flatMap(({ app, client, observation }) => observation.tools.map(tool => {
            const name = tool.nameSharedAcrossViewTypes ? buildPublicToolName(app.appId, tool.viewType, tool.name) : buildPublicToolName(app.appId, tool.name);
            assert.ok(!routes.has(name));
            routes.set(name, { client, observationId: observation.observationId, toolId: tool.id });
            return { type: 'function', function: { name, parameters: tool.inputSchema,
                description: `${tool.description}\nApp ID ${app.appId}, view_type ${tool.viewType} (${tool.multiplicity}).` } };
        }));
        const body = JSON.stringify({ model: 'batch-two-local', messages: [DEFAULT_AOTUI_SYSTEM_INSTRUCTION, ...pages]
            .map(content => ({ role: 'user', content })), tools });
        if (Buffer.byteLength(body) > maxInputBytes) { release(selection); return { status: 'budget-rejected' }; }
        try {
            for (const { client, observation } of selection) {
                assert.equal(client.adoptObservation(observation.observationId).status, 'adopted');
                facts.adopted.push({ label, id: observation.observationId });
            }
            const sources = desktop.bindRequestSources({ apps: selection.map(({ client, observation }) =>
                ({ client, observationId: observation.observationId })) });
            provider.replyNext({ label, calls, beforeReply });
            const wire = await fetch(provider.url + '/chat/completions', { method: 'POST',
                headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
            if (!wire.ok) throw new Error(await wire.text());
            const response = await wire.json();
            return { status: 'sent', sources, routes, calls: response.choices[0].message.tool_calls ?? [] };
        } catch (error) { release(selection); throw error; }
    }
    async function invoke(turn, timeoutMs) {
        assert.equal(turn.status, 'sent');
        const call = turn.calls[0];
        assert.equal(call?.type, 'function');
        const route = turn.routes.get(call.function.name);
        assert.ok(route);
        const { client, observationId, toolId } = route;
        const request = { observationId, toolId, invocationId: call.id, input: JSON.parse(call.function.arguments) };
        const result = await client.invoke(request, timeoutMs, turn.sources);
        facts.calls.push({ request, result });
        return { request, result };
    }
    const first = await select(contacts, mail);
    const turn = await send('original', first, [modelCall('cross-original', MAIL_TOOL, TO_CONTACTS)], { beforeReply: async () => {
        await setContacts(folder, CHANGED);
        facts.contactsAfterSend = await watchUntil(async () => {
            const preview = await contacts.client.preview();
            return preview.status === 'previewed' && preview.source.revision > first[0].observation.source.revision && preview;
        });
    } });
    const original = (await invoke(turn)).result;
    assert.equal(facts.contactsAfterSend.views[0].content.value.split('\n')[1], CHANGED.join(', '));
    assert.equal(original.kind, 'receipt');
    assert.equal(original.receipt.outcome.status, 'succeeded');
    assert.deepEqual((await invoke(turn)).result, original);
    assert.deepEqual(JSON.parse(await readFile(join(folder, 'draft.json'), 'utf8')), { to: ORIGINAL });
    assert.deepEqual({ ...facts.authorize[0].rawInput }, TO_CONTACTS);
    assert.deepEqual({ ...facts.authorize[0].effectiveInput }, { to: ORIGINAL });
    assert.equal(facts.authorize[0].refSources[0].snapshotId, first[0].observation.source.snapshotId);
    release(first);

    const tooBig = await send('budget', await select(contacts, mail), [], { maxInputBytes: 1 });
    assert.equal(tooBig.status, 'budget-rejected');
    assert.equal(provider.requests.length, 1);
    assert.equal(facts.adopted.length, 2);
    const targetOnly = await select(mail);
    const missing = await send('target-only', targetOnly, [modelCall('absent-contacts', MAIL_TOOL, TO_CONTACTS)]);
    const rejected = (await invoke(missing)).result;
    assert.equal(rejected.receipt.executionPhase, 'not-dispatched');
    assert.equal(rejected.receipt.outcome.code, 'REF_NOT_VISIBLE');
    release(targetOnly);
    assert.equal((await journal(folder, 'draft-handler')).length, 1);

    const pending = await select(contacts, mail);
    const parked = join(folder, 'park-draft');
    await writeFile(parked, '');
    const late = await send('late', pending, [modelCall('cross-late', MAIL_TOOL, TO_CONTACTS)]);
    const { request, result } = await invoke(late, 200);
    assert.equal(result.code, 'INVOCATION_WAIT_TIMEOUT');
    await watchUntil(async () => (await journal(folder, 'draft-handler')).length === 2);
    release(pending);
    const duplicate = (await invoke(late, 40)).result;
    assert.equal(duplicate.code, 'INVOCATION_WAIT_TIMEOUT');
    const staleWhileBusy = await mail.client.invoke({ ...request, invocationId: 'while-busy' }, undefined, late.sources);
    assert.equal(staleWhileBusy.code, 'INVOCATION_CAPACITY');
    const query = { observationId: request.observationId, invocationId: request.invocationId };
    const readPending = await mail.client.readReceipt(query, 40);
    assert.equal(readPending.code, 'INVOCATION_WAIT_TIMEOUT');

    let sourceCloseCompleted = false;
    const closeSource = desktop.closeApp(contacts.app.appId, contacts.app.appInstanceId).then(() => { sourceCloseCompleted = true; });
    await watchUntil(async () => (await journal(folder, 'contacts-lifecycle')).some(event => event.event === 'stop'));
    assert.equal(sourceCloseCompleted, false, 'The dispatched operation still holds the source.');
    await rm(parked);
    const recovered = await mail.client.readReceipt(query, 5_000);
    assert.equal(recovered.kind, 'receipt');
    assert.equal(recovered.receipt.outcome.status, 'succeeded');
    await closeSource;
    assert.equal(sourceCloseCompleted, true);
    const stale = await mail.client.invoke({ ...request, invocationId: 'after-release' }, undefined, late.sources);
    assert.equal(stale.code, 'OBSERVATION_UNAVAILABLE');
    const next = await select(mail);
    await send('after-late', next, []);
    assert.match(next[0].observation.views[0].content.value, /To: alpha@example\.test, beta@example\.test/);
    release(next);
    facts.outcomes = { original, rejected, tooBig, result, duplicate, staleWhileBusy, stale, readPending, recovered, sourceCloseCompleted };
    facts.requests = provider.requests;
    assert.deepEqual(provider.failures, []);
    facts.handler = await journal(folder, 'draft-handler');
    facts.writes = await journal(folder, 'draft-writes');
    facts.draft = JSON.parse(await readFile(join(folder, 'draft.json'), 'utf8'));
    assert.deepEqual(facts.handler, facts.writes);
    assert.deepEqual(facts.writes.map(item => item.to), [ORIGINAL, CHANGED]);
} finally {
    await rm(join(folder, 'park-draft'), { force: true });
    facts.shutdown = await runtime.beginShutdown().completion;
    await provider.close();
    facts.workers = { contacts: await journal(folder, 'contacts-lifecycle'), mail: await journal(folder, 'mail-lifecycle') };
    await writeFile(join(folder, 'independent-host.json'), JSON.stringify(facts, null, 2));
}
assert.equal(facts.shutdown.ok, true);
assert.equal(facts.shutdown.resourcesReleased, true);
assert.deepEqual(facts.workers.contacts.map(item => item.event), ['start', 'stop']);
assert.deepEqual(facts.workers.mail.map(item => item.event), ['start', 'stop']);
assert.notEqual(facts.workers.contacts[0].threadId, facts.workers.mail[0].threadId);
