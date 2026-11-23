import { fixtureAppPath } from './batch-two-support.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '@aotui/runtime';
import { buildPublicToolName, buildViewMessageMarkup, DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from '@aotui/runtime/adapters';

const folder = process.argv[2];
const appURL = new URL('./dist/batch-one-files.js', import.meta.url).href;
const appName = 'batch_files';
await mkdir(folder);
await writeFile(join(folder, 'A.txt'), 'original A');
await writeFile(join(folder, 'B.txt'), 'original B');
const runtime = createRuntime();
const facts = { calls: [], observations: [], requests: [], adoptions: [] };
let scripted;
const provider = createServer(async (incoming, reply) => {
    try {
        assert.equal(incoming.method, 'POST');
        assert.equal(incoming.url, '/v1/chat/completions');
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const request = JSON.parse(body);
        const { label, calls } = scripted;
        scripted = undefined;
        for (const call of calls) assert.ok(request.tools.some(tool => tool.function.name === call.function.name));
        const response = { choices: [{ message: { role: 'assistant', tool_calls: calls } }] };
        facts.requests.push({ label, bytes: body.length, request, response });
        reply.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
    } catch (error) {
        reply.writeHead(500).end(String(error));
    }
});
await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
});
const endpoint = 'http://127.0.0.1:' + provider.address().port + '/v1/chat/completions';
try {
    const desktopId = await runtime.createDesktop();
    const desktop = runtime.getDesktop(desktopId);
    const localPath = await fixtureAppPath(appURL, appName, folder);
    const register = installationId => desktop.registerPendingApp({
        installationId, localPath, config: { folder },
    });
    const first = await register('first_installation'), second = await register('Second');
    assert.deepEqual(desktop.getInstalledApps().map(app => [app.installationId, app.appId]), [[first, undefined], [second, undefined]]);
    const collisionURL = new URL('./collision.mjs', import.meta.url);
    await writeFile(collisionURL, `import { createApp } from '@aotui/sdk/app';
export default createApp({ app_name: 'batch_files_1', viewTypes: [], initialize({ prepareProjection }) { prepareProjection({ views: [] }); } });`);
    const collision = await runtime.installDynamicWorkerApp(desktopId, collisionURL.href, { name: 'batch_files_1' });
    const appId = await desktop.openApp(second);
    const otherId = await desktop.openApp(first);
    assert.deepEqual([collision, appId, otherId], ['batch_files_1', 'batch_files', 'batch_files_2']);
    const installed = desktop.getInstalledApps().find(app => app.appId === appId);
    const parked = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const access = runtime.getAppInteraction(desktopId, appId, installed.appInstanceId, {
        project: ({ source }) => ({
            refs: Object.values(source.refs).map(ref => ({
                viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id,
            })),
            toolIds: Object.keys(source.tools),
        }),
        authorize: ({ invocationId }) => {
            if (invocationId !== 'held-edit') return true;
            entered.resolve();
            return parked.promise;
        },
        canReadReceipt: () => true,
    });
    assert.equal(access.status, 'ready');
    const client = access.interaction;
    async function observe() {
        const result = await client.observe({ all: true });
        assert.equal(result.status, 'observed', JSON.stringify(result));
        return result.observation;
    }
    const modelCall = (id, name, input) => ({
        id, type: 'function', function: { name: buildPublicToolName(appId, name), arguments: JSON.stringify(input) },
    });
    async function send(label, current, calls = [], maxInputBytes = Infinity) {
        const pages = ['static', 'dynamic'].flatMap(region => current.views.filter(view => view.region === region)
            .map(view => buildViewMessageMarkup({
                appId: current.source.appId, appName, viewId: view.id, viewType: view.type, markup: view.content.value,
            })));
        const routes = new Map();
        const tools = current.tools.map(tool => {
            const parts = tool.nameSharedAcrossViewTypes ? [appId, tool.viewType, tool.name] : [appId, tool.name];
            const name = buildPublicToolName(...parts);
            assert.ok(!routes.has(name));
            routes.set(name, { observationId: current.observationId, toolId: tool.id });
            return { type: 'function', function: { name, parameters: tool.inputSchema,
                description: `${tool.description}\nApp ID ${appId}, view_type ${tool.viewType} (${tool.multiplicity}).` } };
        });
        const body = JSON.stringify({
            model: 'fixture',
            messages: [
                { role: 'user', content: DEFAULT_AOTUI_SYSTEM_INSTRUCTION },
                ...pages.map(content => ({ role: 'user', content })),
                { role: 'user', content: `<desktop>\n- installation_id: ${installed.installationId}\n- app_id: ${appId}\n</desktop>` },
            ],
            tools,
        });
        const bytes = Buffer.byteLength(body);
        if (bytes > maxInputBytes) {
            client.releaseObservation(current.observationId);
            return { status: 'budget-rejected', bytes, maxInputBytes };
        }
        assert.equal(client.adoptObservation(current.observationId).status, 'adopted');
        facts.adoptions.push({ label, observationId: current.observationId });
        facts.observations.push({ label, views: pages, tools: current.tools });
        scripted = { label, calls };
        const wire = await fetch(endpoint, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000),
        });
        assert.equal(wire.status, 200, wire.ok ? undefined : await wire.text());
        const response = await wire.json();
        return { status: 'sent', label, routes, calls: response.choices[0].message.tool_calls };
    }
    async function call(turn) {
        assert.equal(turn.status, 'sent');
        const reply = turn.calls.shift();
        assert.ok(reply?.id && reply.type === 'function', 'Expected a ToolCall from the Provider');
        const route = turn.routes.get(reply.function.name);
        assert.ok(route, 'The ToolCall must use a tool advertised in its request');
        const request = { ...route, invocationId: reply.id, input: JSON.parse(reply.function.arguments) };
        const result = await client.invoke(request);
        assert.equal(result.receipt?.invocationId, reply.id);
        assert.equal(result.receipt?.observationId, route.observationId);
        facts.calls.push({ turn: turn.label, toolName: reply.function.name, request, result });
        return result;
    }
    async function success(turn) {
        const result = await call(turn);
        assert.equal(result.receipt?.outcome.status, 'succeeded', JSON.stringify(result));
        return result.receipt.outcome.value;
    }
    async function refused(turn, code) {
        const result = await call(turn);
        assert.equal(result.receipt?.outcome.code, code, JSON.stringify(result));
        assert.equal(result.receipt.executionPhase, 'not-dispatched');
        return result.receipt;
    }
    const home = await observe();
    assert.equal(home.tools.some(tool => tool.name === 'edit'), false);
    assert.deepEqual(home.views.map(view => [view.id, view.region]), [
        ['guide', 'static'], ['main', 'static'], ['2note_1', 'static'], ['marker_1', 'dynamic'], ['status', 'dynamic'],
    ]);
    assert.deepEqual(home.tools.find(tool => tool.name === 'open_file').inputSchema.required, ['name']);
    const homeTurn = await send('directory', home, [
        modelCall('invalid-single-target', 'open_file', { view_id: 'main', name: 'A.txt' }),
        modelCall('open-a', 'open_file', { name: 'A.txt' }),
    ]);
    await refused(homeTurn, 'TOOL_INVALID_ARGS');
    await success(homeTurn);
    const oneFile = await observe();
    assert.equal(oneFile.tools.filter(tool => tool.name === 'edit').length, 1);
    const oneFileTurn = await send('one-file', oneFile, [
        modelCall('open-b', 'open_file', { name: 'B.txt' }),
        modelCall('read-a-after-refusal', 'inspect', { view_id: 'doc_A', texts: [] }),
    ]);
    await success(oneFileTurn);
    const address = '$batch_files.doc_A.content';
    const oversized = await observe();
    const counts = () => ({ adoptions: facts.adoptions.length, sent: facts.requests.length, calls: facts.calls.length });
    const beforeBudget = counts();
    const refusedCandidate = await send('over-budget', oversized, [
        modelCall('over-budget-edit', 'edit', { view_id: 'doc_B', text: 'must not write' }),
    ], facts.requests.at(-1).bytes);
    assert.equal(refusedCandidate.status, 'budget-rejected');
    assert.ok(refusedCandidate.bytes > refusedCandidate.maxInputBytes);
    assert.deepEqual(counts(), beforeBudget);
    await assert.rejects(readFile(join(folder, 'writes.jsonl'), 'utf8'), { code: 'ENOENT' });
    assert.equal(await readFile(join(folder, 'A.txt'), 'utf8'), 'original A');
    assert.equal(await readFile(join(folder, 'B.txt'), 'utf8'), 'original B');
    facts.budget = { ...refusedCandidate, before: beforeBudget, after: counts(), newWrites: 0 };
    await success(oneFileTurn);
    const open = await observe();
    assert.equal(open.tools.filter(tool => tool.name === 'edit').length, 1);
    const edit = open.tools.find(tool => tool.name === 'edit');
    assert.deepEqual(edit.inputSchema.required, ['view_id', 'text']);
    assert.equal(edit.inputSchema.properties.view_id.enum, undefined);
    assert.equal(open.refs.filter(ref => ref.viewId === 'doc_A' && ref.array).length, 1);
    assert.equal(open.refs.filter(ref => ref.viewId === 'doc_A' && /^lines/.test(ref.refId)).length, 2);
    await success(await send('two-files', open, [modelCall('literal-edit', 'edit', { view_id: 'doc_B', text: '$' + address })]));
    assert.equal(await readFile(join(folder, 'B.txt'), 'utf8'), address);
    const mixedArgs = {
        view_id: 'doc_B',
        texts: ['first', '$batch_files.doc_A.lines[2]', '$batch_files.doc_A.lines[2]', '$$$varStr', '$batch_files.doc_A["lines[0]"]'],
        selected: '$batch_files.doc_A.lines[0]', exact: '$$a', count: '$batch_files.doc_A.count',
        options: { $ref: '$opaque' },
    };
    const referenceEdit = modelCall('ref-edit', 'edit', { view_id: 'doc_B', text: address });
    const afterLiteral = await send('after-literal', await observe(), [
        modelCall('reload', 'reload_source', {}), referenceEdit, referenceEdit,
        modelCall('missing-target', 'edit', { text: 'missing route' }),
        modelCall('private-ref', 'edit', { view_id: 'doc_B', text: '$batch_files.doc_A.hidden' }),
        modelCall('wrong-type', 'edit', { view_id: 'doc_B', text: '$batch_files.doc_A.count' }),
        modelCall('other-app-ref', 'edit', { view_id: 'doc_B', text: '$batch_files_2.doc_A.content' }),
        modelCall('incomplete-ref', 'edit', { view_id: 'doc_B', text: '$varStr' }),
        modelCall('mixed-array', 'inspect', mixedArgs),
        modelCall('whole-array', 'inspect', { view_id: 'doc_B', texts: '$batch_files.doc_A.lines' }),
        modelCall('legacy-ref', 'inspect', { view_id: 'doc_B', texts: [], selected: 'doc_A.lines[0]' }),
        modelCall('disable-a', 'mark_a_readonly', {}),
    ]);
    await writeFile(join(folder, 'A.txt'), 'new A outside the app');
    await success(afterLiteral);
    const old = await success(afterLiteral);
    assert.equal(await readFile(join(folder, 'B.txt'), 'utf8'), 'original A');
    assert.deepEqual(await success(afterLiteral), old);
    for (const code of ['TOOL_INVALID_ARGS', 'TOOL_PERMISSION_DENIED', 'REF_VALUE_UNSUPPORTED', 'REF_NOT_VISIBLE', 'TOOL_INVALID_ARGS']) {
        await refused(afterLiteral, code);
    }
    const mixed = await success(afterLiteral);
    assert.equal(JSON.stringify(mixed.data.texts), JSON.stringify(['first', 'line 2', 'line 2', '$$varStr', 'literal bracket name']));
    assert.equal(mixed.data.selected, 'line 0');
    assert.equal(mixed.data.exact, '$a');
    assert.equal(mixed.data.count, 7);
    assert.equal(mixed.data.options.$ref, '$opaque');
    const wholeList = await success(afterLiteral);
    assert.equal(wholeList.data.texts.length, 100);
    await refused(afterLiteral, 'TOOL_INVALID_ARGS');
    await success(afterLiteral);
    let after = await observe();
    assert.deepEqual(after.tools.find(tool => tool.name === 'edit').inputSchema, edit.inputSchema);
    const auth = await send('authorization', after, [
        modelCall('disabled-a', 'edit', { view_id: 'doc_A', text: 'must be rejected' }),
        modelCall('arm-replacement', 'replace_b_on_signal', {}),
        modelCall('held-edit', 'edit', { view_id: 'doc_B', text: 'must not write' }),
    ]);
    const disabled = await refused(auth, 'TOOL_UNAVAILABLE');
    assert.equal(disabled.outcome.path, '$.view_id');
    const originalB = after.views.find(view => view.id === 'doc_B').viewInstanceId;
    await success(auth);
    const held = call(auth);
    try {
        await Promise.race([entered.promise, delay(3000).then(() => { throw Error('Authorization was never called'); })]);
        await writeFile(join(folder, 'replace-b'), 'replace');
        for (let i = 0; ; i++) {
            const preview = await client.preview();
            if (preview.status === 'previewed' && preview.views.find(view => view.id === 'doc_B').viewInstanceId !== originalB) break;
            if (i === 100) throw Error('B was not replaced');
            await delay(20);
        }
    } finally { parked.resolve(true); }
    assert.equal((await held).receipt.outcome.code, 'VIEW_INSTANCE_REVOKED');
    after = await observe();
    assert.match(after.views.find(view => view.id === 'doc_A').content.value, /new A outside the app/);
    await success(await send('close-a', after, [modelCall('close-a', 'close', { view_id: 'doc_A' })]));
    after = await observe();
    assert.equal(after.views.some(view => view.id === 'doc_A'), false);
    assert.equal(after.tools.filter(tool => tool.name === 'edit').length, 1);
    facts.writes = (await readFile(join(folder, 'writes.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(facts.writes, [{ name: 'B.txt', text: address }, { name: 'B.txt', text: 'original A' }]);
    assert.equal(await readFile(join(folder, 'A.txt'), 'utf8'), 'new A outside the app');
    assert.equal(await readFile(join(folder, 'B.txt'), 'utf8'), 'original A');
    const last = await send('one-remaining', after, [
        modelCall('read-b', 'inspect', { view_id: 'doc_B', texts: [] }),
        modelCall('close-b', 'close', { view_id: 'doc_B' }),
    ]);
    await success(last);
    await success(last);
    after = await observe();
    assert.equal(after.tools.some(tool => tool.name === 'edit'), false);
    await send('directory-again', after);
    client.releaseObservation(after.observationId);
    await desktop.closeApp(appId, installed.appInstanceId);
    assert.equal((await desktop.openApp(second)), 'batch_files_3');
    await desktop.closeApp(otherId);
    await desktop.closeApp('batch_files_3');
    assert.equal((await desktop.openApp(second)), 'batch_files');
} finally {
    await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    const close = await runtime.beginShutdown().completion;
    assert.ok(close.ok && close.resourcesReleased, JSON.stringify(close));
    facts.shutdown = { ok: close.ok, resourcesReleased: close.resourcesReleased };
}
await writeFile(join(folder, 'independent-host.json'), JSON.stringify(facts, null, 2));
