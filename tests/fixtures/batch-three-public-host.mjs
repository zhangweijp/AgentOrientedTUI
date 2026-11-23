import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '@aotui/runtime';
import { buildPublicToolName, buildViewMessageMarkup, DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from '@aotui/runtime/adapters';
import { fixtureProvider, installFixture, journal, modelCall, observe, MAIL_TOOL } from './batch-two-support.mjs';
import { changedPeople, contactHints, deniedAddresses, draftFieldGrants, emailAddress, expectedHint, firstEmail, hasPrivateDetails,
    mixedTurns, referenceHints, secondDraftValue, setPeople, unscopedHint, viewMessages, waitForView } from './batch-three-support.mjs';
import { getDraftConsumer, grantPeople, renderAppMessages } from './dist/batch-three-readme.js';

const folder = process.argv[2];
const secondaryFolder = join(folder, 'secondary');
await setPeople(folder, 'initial');
const runtime = createRuntime();
const provider = await fixtureProvider();
const facts = { requests: provider.requests, permission: [], executions: [], observations: [], events: [] };
const allow = Promise.withResolvers(), entered = Promise.withResolvers();
try {
    const desktop = runtime.getDesktop(await runtime.createDesktop());
    let consumer, secondaryConsumer, allowedPaths;
    const sourcePolicy = {
        async project({ source }) {
            consumer ??= await getDraftConsumer(mail.client);
            facts.sourceStats = { refs: Object.keys(source.refs).length, people: Object.values(source.refs)[0]?.target.payload.length };
            return grantPeople(source, draftFieldGrants(consumer, secondaryConsumer, allowedPaths));
        },
        authorize: () => true, canReadReceipt: () => true,
    };
    const contacts = await installFixture(runtime, desktop, 'contacts', 'contacts_install',
        new URL('./dist/batch-three-contacts.js', import.meta.url).href, folder, sourcePolicy);
    const mailPolicy = {
        project: ({ source }) => ({ refs: [], toolIds: Object.keys(source.tools) }),
        authorize: context => {
            facts.permission.push({ ...context, signal: undefined });
            if (context.invocationId === 'tighten') { entered.resolve(); return allow.promise; }
            return true;
        },
        canReadReceipt: () => true,
    };
    const mailModule = new URL('./dist/batch-three-mail.js', import.meta.url).href;
    const mail = await installFixture(runtime, desktop, 'mail', 'mail_install', mailModule, folder, mailPolicy);
    assert.deepEqual(desktop.getInstalledApps().map(app => app.appId), ['contacts', 'mail']);
    async function send(label, calls, beforeReply, recipients = [mail]) {
        // The publisher policy runs before the recipient's current request observation exists.
        const selection = [];
        for (const app of [contacts, ...recipients]) selection.push({ ...app, observation: await observe(app.client) });
        const pages = renderAppMessages(selection.map(({ app, observation }) => ({ appName: app.name, observation })));
        const routes = new Map();
        const tools = selection.flatMap(({ app, client, observation }) => observation.tools.map(tool => {
            const name = buildPublicToolName(app.appId, tool.name);
            routes.set(name, { client, observationId: observation.observationId, toolId: tool.id });
            return { type: 'function', function: { name, parameters: tool.inputSchema } };
        }));
        const body = JSON.stringify({ model: 'field-fixture', tools,
            messages: [{ role: 'user', content: DEFAULT_AOTUI_SYSTEM_INSTRUCTION }, ...pages] });
        try {
            for (const { client, observation } of selection) assert.equal(client.adoptObservation(observation.observationId).status, 'adopted');
            const sources = desktop.bindRequestSources({ apps: selection.map(({ client, observation }) => ({ client, observationId: observation.observationId })) });
            facts.observations.push({ label, observations: selection.map(item => item.observation) });
            provider.replyNext({ label, calls, beforeReply });
            const reply = await fetch(provider.url + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body, signal: AbortSignal.timeout(5000) });
            if (!reply.ok) throw new Error(await reply.text());
            return { selection, sources, routes, calls: (await reply.json()).choices[0].message.tool_calls };
        } catch (error) {
            for (const { client, observation } of selection) client.releaseObservation(observation.observationId);
            throw error;
        }
    }
    const release = turn => {
        for (const { client, observation } of turn.selection) client.releaseObservation(observation.observationId);
    };
    async function invoke(turn, index) {
        const call = turn.calls[index];
        const route = turn.routes.get(call.function.name);
        assert.ok(route);
        const request = { observationId: route.observationId, toolId: route.toolId, invocationId: call.id, input: JSON.parse(call.function.arguments) };
        const result = await route.client.invoke(request, undefined, turn.sources);
        facts.executions.push({ request, result });
        return result;
    }
    const call = (id, address = emailAddress) => modelCall(id, MAIL_TOOL, { to: address });
    const first = await send('original', [call('email'), ...deniedAddresses.map((address, index) => call('denied-' + index, address))], async body => {
        assert.ok(body.messages.some(message => message.role === 'user' && message.content.includes(expectedHint)));
        assert.equal(hasPrivateDetails(body), false);
        facts.events.push('request received');
        await setPeople(folder, 'changed', changedPeople);
        await waitForView(contacts.client, 'Directory version changed');
        facts.events.push('source changed before Provider replied');
    });
    const original = first.selection[0].observation;
    assert.deepEqual(facts.sourceStats, { refs: 1, people: 100 });
    facts.originalPublication = facts.sourceStats;
    assert.equal(original.refs.length, 1);
    assert.deepEqual({ ...original.refs[0].paths[0], consumer: undefined }, { path: [0, 'email'], valueType: 'string', consumer: undefined });
    assert.equal(hasPrivateDetails(original.refs), false);
    assert.equal((await invoke(first, 0)).receipt.outcome.status, 'succeeded');
    const failures = [];
    for (let index = 1; index < first.calls.length; index++) {
        const receipt = (await invoke(first, index)).receipt;
        assert.equal(receipt.executionPhase, 'not-dispatched');
        assert.equal(receipt.outcome.code, 'REF_NOT_VISIBLE');
        failures.push(receipt.outcome);
    }
    assert.ok(failures.every(issue => issue.message === failures[0].message));
    assert.equal(hasPrivateDetails(failures), false);
    assert.equal(facts.permission.length, 1);
    assert.deepEqual({ ...facts.permission[0].effectiveInput }, { to: firstEmail });
    assert.equal(facts.permission[0].refSources[0].snapshotId, original.source.snapshotId);
    assert.equal(hasPrivateDetails(facts.permission), false);
    release(first);

    const originalMount = consumer.viewInstanceId;
    await writeFile(join(folder, 'replace-draft'), '');
    const replaced = await waitForView(mail.client, 'Revision 2');
    assert.equal(replaced.views[0].id, consumer.viewId);
    assert.notEqual(replaced.views[0].viewInstanceId, originalMount);
    const wrongMount = await send('wrong mount', [call('wrong-mount')]);
    assert.ok(!provider.requests.at(-1).body.messages.some(message => message.content.includes(expectedHint)));
    const denied = (await invoke(wrongMount, 0)).receipt;
    assert.equal(denied.executionPhase, 'not-dispatched');
    assert.equal(denied.outcome.code, 'REF_NOT_VISIBLE');
    release(wrongMount);
    assert.equal(facts.permission.length, 1);

    consumer = undefined;
    const pending = await send('tighten', [call('tighten')]);
    const work = invoke(pending, 0);
    await Promise.race([entered.promise, work.then(() => { throw new Error('Expected a pending authorization'); })]);
    allowedPaths = [];
    const tightened = await observe(contacts.client, true);
    assert.deepEqual(tightened.refs, []);
    allow.resolve(true);
    const refused = (await work).receipt;
    assert.equal(refused.executionPhase, 'not-dispatched');
    assert.equal(refused.outcome.code, 'REF_VIEW_UNAVAILABLE');
    contacts.client.releaseObservation(tightened.observationId);
    release(pending);
    facts.writes = await journal(folder, 'draft-writes');
    facts.handlers = await journal(folder, 'draft-handler');
    assert.deepEqual(facts.writes, facts.handlers);
    assert.deepEqual(facts.writes.map(entry => entry.to), [firstEmail]);
    facts.draft = JSON.parse(await readFile(join(folder, 'draft.json'), 'utf8'));
    assert.deepEqual(facts.draft, { to: firstEmail });

    await mkdir(secondaryFolder);
    const secondary = await installFixture(runtime, desktop, 'mail', 'secondary_install', mailModule, secondaryFolder, mailPolicy);
    secondaryConsumer = await getDraftConsumer(secondary.client);
    assert.equal(secondaryConsumer?.appId, 'mail_1');
    allowedPaths = undefined;
    await setPeople(folder, 'shared');
    await waitForView(contacts.client, 'Directory version shared');
    const sendMixed = async (script, recipients, pageCount) => {
        const turn = await send(script.label, script.calls, undefined, recipients);
        const wire = provider.requests.at(-1).body;
        assert.equal(viewMessages(wire).length, pageCount);
        assert.deepEqual(contactHints(wire), script.hints);
        return turn;
    };
    const both = await sendMixed(mixedTurns.both, [mail, secondary], 3);
    const publisher = both.selection[0].observation;
    const list = publisher.views[0];
    const unindexedMarkup = buildViewMessageMarkup({ appId: publisher.source.appId, appName: contacts.app.name,
        viewId: list.id, viewType: list.type, markup: list.content.value, refs: publisher.refs });
    assert.deepEqual(referenceHints(unindexedMarkup), [unscopedHint]);
    assert.equal((await invoke(both, 0)).receipt.outcome.status, 'succeeded');
    release(both);
    const counts = async () => [await journal(folder, 'draft-writes'), await journal(secondaryFolder, 'draft-writes')];
    const beforeDenied = await counts();
    assert.deepEqual(beforeDenied.map(entries => entries.map(entry => entry.to)), [[firstEmail], [secondDraftValue]]);

    const reject = async turn => {
        const receipt = (await invoke(turn, 0)).receipt;
        assert.equal(receipt.executionPhase, 'not-dispatched');
        assert.equal(receipt.outcome.code, 'REF_NOT_VISIBLE');
        assert.deepEqual(await counts(), beforeDenied);
    };
    const missing = await sendMixed(mixedTurns.missing, [mail], 2);
    await reject(missing);
    release(missing);
    await writeFile(join(secondaryFolder, 'replace-draft'), '');
    await waitForView(secondary.client, 'Revision 2');
    const replacement = await getDraftConsumer(secondary.client);
    assert.equal(replacement?.viewId, secondaryConsumer.viewId);
    assert.notEqual(replacement?.viewInstanceId, secondaryConsumer.viewInstanceId);
    const replacedTurn = await sendMixed(mixedTurns.replaced, [mail, secondary], 3);
    await reject(replacedTurn);
    assert.equal((await invoke(replacedTurn, 1)).receipt.outcome.status, 'succeeded');
    release(replacedTurn);

    const [primaryWrites, secondaryWrites] = await counts();
    assert.deepEqual(primaryWrites.map(({ to, generation }) => ({ to, generation })), [
        { to: firstEmail, generation: 1 }, { to: firstEmail, generation: 2 },
    ]);
    assert.deepEqual(secondaryWrites, beforeDenied[1]);
    assert.deepEqual(primaryWrites, await journal(folder, 'draft-handler'));
    assert.deepEqual(secondaryWrites, await journal(secondaryFolder, 'draft-handler'));
    assert.deepEqual(facts.permission.slice(-2).map(item => [item.invocationId, item.source.instanceId, item.refSources[0].consumerViewInstanceId]), [
        ['allowed-secondary', secondaryConsumer.instanceId, secondaryConsumer.viewInstanceId],
        ['still-valid-primary', consumer.instanceId, consumer.viewInstanceId],
    ]);
    facts.mixed = { consumer, secondaryConsumer, replacement, unindexedMarkup, primaryWrites, secondaryWrites };
    assert.deepEqual(provider.failures, []);
    facts.passed = true;
} finally {
    allow.resolve(true);
    facts.shutdown = await runtime.beginShutdown().completion;
    await provider.close();
    facts.workers = { contacts: await journal(folder, 'contacts-lifecycle'), mail: await journal(folder, 'mail-lifecycle'),
        secondary: await journal(secondaryFolder, 'mail-lifecycle') };
    await writeFile(join(folder, 'independent-fields.json'), JSON.stringify(facts, null, 2));
}
assert.equal(facts.shutdown.ok, true);
assert.equal(facts.shutdown.resourcesReleased, true);
assert.equal(facts.shutdown.interactions.retainedOperations, 0);
assert.equal(facts.shutdown.interactions.retainedBytes, 0);
assert.notEqual(facts.workers.contacts[0].threadId, facts.workers.mail[0].threadId);
