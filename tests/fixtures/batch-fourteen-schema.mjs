import assert from 'node:assert/strict';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { projectNativeToolSchema } from '@aotui/runtime/adapters';
import { consoleBindings, consoleDeclaration, journal, modelCall, watchUntil } from './batch-two-support.mjs';
import { savedParts } from './batch-ten-delivery.mjs';

export const address = '$ref.cinema.hall.seat';
export const original = ['A', 12];
export const changed = ['B', 9];
export const cinemaLog = manifest => journal(dirname(manifest.modulePath), 'cinema-effects');
export const healthyLog = manifest => journal(dirname(manifest.modulePath), 'healthy-effects');
export const functions = body => Object.fromEntries(body.tools.map(({ function: fn }) => [fn.name, fn]));
export const views = body => body.messages.filter(item => item.role === 'user' && item.content.startsWith('<view ')).map(item => item.content);

export async function publishSeat(manifest, seat, withdrawn = false) {
    const state = { seat, withdrawn };
    const path = join(dirname(manifest.modulePath), 'seat.json');
    await writeFile(path + '.next', JSON.stringify(state));
    await rename(path + '.next', path);
    return state;
}

// Keep the issued candidates and the active Runtime turn at the adoption boundary.
// Count public adoption calls and inject the two test mutations only on the Worker wire.
export function captureAdmission() {
    const events = [], workers = [], mutations = [], receipts = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...other) {
        if (message?.type === 'INIT') {
            workers.push({ event: 'start', threadId: this.threadId, appId: message.appId });
            const threadId = this.threadId;
            this.once('exit', code => workers.push({ event: 'exit', threadId, code }));
        }
        if (message?.type === 'VIEW_TOOL_INVOKE') {
            const original = message;
            let mutation;
            if (message.appId === 'cinema' && message.tool.name === 'lookup' && message.localRefs.some(ref => ref.param === 'seat')) {
                mutation = mutations.shift();
                if (mutation) {
                    message = structuredClone(message);
                    if (mutation === 'mount') message.localRefs.find(ref => ref.param === 'seat').viewInstanceId = 'retired-hall';
                    else message.effectiveArgs.seat[1] = '12';
                }
            }
            workers.push({ event: 'tool', original, dispatched: message, ...(mutation ? { mutation } : {}) });
        }
        return post.call(this, message, ...other);
    };
    const restores = [];
    return { events, workers, mutations, receipts, attach(desktop) {
        const adopt = desktop.adoptTurn;
        const revoke = desktop.revokeWindowAccess, close = desktop.closeView;
        const originalTurns = new WeakMap();
        desktop.adoptTurn = function (selection) {
            const result = adopt.call(this, selection);
            for (const { candidate } of selection.apps) events.push({ appId: candidate.observation.source.appId,
                observationId: candidate.observation.observationId, status: result.status });
            if (result.status === 'rejected') return result;
            const { turn } = result;
            const instrumented = { ...turn, get isCurrent() { return turn.isCurrent; }, async invoke(appId, request, ...options) {
                const invoked = await turn.invoke(appId, request, ...options);
                receipts.push({ appId, invocationId: request.invocationId, result: invoked });
                return invoked;
            } };
            originalTurns.set(instrumented, turn);
            return { ...result, turn: instrumented };
        };
        desktop.revokeWindowAccess = function (turn, target) { return revoke.call(this, originalTurns.get(turn) ?? turn, target); };
        desktop.closeView = function (target, turn) { return close.call(this, target, originalTurns.get(turn) ?? turn); };
        restores.push(() => { desktop.adoptTurn = adopt; desktop.revokeWindowAccess = revoke; desktop.closeView = close; });
    }, restore() {
        Worker.prototype.postMessage = post;
        for (const restore of restores) restore();
    } };
}

export async function exerciseCinema(turn, manifest, cinemaClient, captured) {
    const codes = {}, comparison = {}, results = {};
    const before = await cinemaClient.observe();
    assert.equal(before.status, 'observed');
    const observation = before.observation;
    const lookup = observation.tools.find(tool => tool.name === 'lookup');
    assert.ok(lookup);
    cinemaClient.release(observation.observationId);
    const tuple = { type: 'array', minItems: 2, items: false,
        prefixItems: [{ type: 'string', description: 'Row' }, { type: 'integer', minimum: 1, description: 'Seat number' }] };
    const native = (id, seat) => modelCall(id, 'cinema-lookup', { seat });
    const compare = async (label, calls = [], beforeReply) => {
        const { body, message } = await turn(label, calls, beforeReply);
        const tools = functions(body);
        comparison[label] = { pages: views(body), tools: Object.values(tools).filter(tool => tool.name.startsWith('cinema-')) };
        if (calls.length) results[label] = savedParts(message, calls);
        const result = results[label]?.map(({ output }) => ({ success: output.type === 'json', ...output.value }));
        return { body, tools, result };
    };
    const first = await compare('seat-native', [native('valid-seat', original), native('seat-order', [12, 'A']),
        native('seat-number', ['A', '12']), native('seat-zero', ['A', 0])]);
    const observedSchema = JSON.parse(JSON.stringify(lookup.inputSchema));
    assert.deepEqual(observedSchema.properties.seat, tuple);
    const receivers = observation.views.filter(view => view.type === lookup.viewType)
        .map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
    const nativeSchema = projectNativeToolSchema({ ...lookup, inputSchema: observedSchema }, observation.source, receivers,
        observation.refs.map(ref => ({ source: observation.source, ref })));
    assert.deepEqual(first.tools['cinema-lookup'].parameters, nativeSchema);
    const [literal, refInput] = nativeSchema.properties.seat.anyOf;
    assert.deepEqual(literal.prefixItems[0], tuple.prefixItems[0]);
    assert.deepEqual(literal.prefixItems[1].anyOf[0], tuple.prefixItems[1]);
    assert.equal(refInput.type, 'string');
    assert.match(refInput.description, /\$ref\.app_id\.view_id\.ref_id/);
    assert.deepEqual(observedSchema.required, ['seat']);
    assert.equal(first.result[0].success, true);
    for (const [index, path] of ['$.seat[0]', '$.seat[1]', '$.seat[1]'].entries()) {
        const result = first.result[index + 1];
        assert.equal(result.success, false);
        assert.ok(JSON.stringify(result).includes(path), JSON.stringify(result));
    }
    const deskPage = views(first.body).find(view => view.includes('\nDesk west\n'));
    const westId = / view_id="([^"]+)"/.exec(deskPage)?.[1];
    assert.ok(westId);
    assert.equal(first.tools['cinema-lookup_at'].parameters.required[0], 'view_id');
    const declaration = consoleDeclaration(first.body);
    assert.match(declaration, /"cinema-lookup"\(args: .*readonly \[string, number(?: \| AppRefAddress)?\]/);
    assert.match(declaration, /"cinema-lookup_at"\(args: .*\bview_id: string/);
    assert.match(declaration, /"cinema-selection"\(args: .*AppRefAddress/);
    codes.declaration = declaration;

    const snapshot = await compare('seat-original-ref', [native('old-ref', address)], async () => {
        const state = await publishSeat(manifest, changed);
        await watchUntil(async () => (await cinemaLog(manifest)).find(event => event.event === 'published' &&
            JSON.stringify(event.state) === JSON.stringify(state)));
    });
    assert.ok(views(snapshot.body).some(view => view.includes('Reserved seat A 12')));
    assert.deepEqual(snapshot.result[0].parameters.seat, original);
    const program = `await tools["cinema-lookup_at"]({view_id:${JSON.stringify(westId)}, seat:["$sale",7], label:"$$ref.cinema.hall.row", tags:["$ref.cinema.hall.row"]});
await tools["cinema-selection"]({seat:"${address}"});
await tools["cinema-lookup"]({seat:refs.cinema.hall.seat}); inspect(refs.cinema.hall.seat);`;
    const active = await compare('seat-console', [modelCall('program-tuple', 'run_code', { code: program }),
        modelCall('mixed-tags', 'cinema-lookup_at', { view_id: westId, seat: ['$ordinary', 3], label: 'native', tags: ['$ref.cinema.hall.row', 'keep', '$ref.cinema.hall.row'] })]);
    assert.ok(views(active.body).some(view => view.includes('Reserved seat B 9')));
    assert.equal(active.result[0].subcalls.length, 3, JSON.stringify(active.result[0]));
    assert.ok(active.result[0].subcalls.every(receipt => receipt.status === 'succeeded' && receipt.phase === 'entered-returned'));
    assert.equal(active.result[1].success, true);

    const effects = (await cinemaLog(manifest)).filter(event => event.operation);
    assert.deepEqual(effects.map(event => [event.desk, event.operation, event.parameters]), [
        ['hall', 'lookup', { seat: original }], ['hall', 'lookup', { seat: original }],
        ['west', 'lookup_at', { seat: ['$sale', 7], label: '$ref.cinema.hall.row', tags: ['B'] }],
        ['hall', 'selection', { seat: changed }], ['hall', 'lookup', { seat: changed }],
        ['west', 'lookup_at', { seat: ['$ordinary', 3], label: 'native', tags: ['B', 'keep', 'B'] }],
    ]);

    captured.mutations.push('value', 'mount');
    const tampered = await compare('seat-worker-recheck', [native('wrong-worker-type', address), native('wrong-worker-mount', address)]);
    assert.ok(tampered.result.every(result => result.success === false));
    const dispatched = captured.workers.filter(event => event.mutation);
    assert.deepEqual(dispatched.map(event => event.mutation), ['value', 'mount']);
    const workerReceipts = captured.receipts.filter(entry => entry.invocationId.startsWith('wrong-worker-'));
    assert.equal(workerReceipts.length, 2);
    assert.ok(workerReceipts.every(({ result }) => result.receipt?.executionPhase === 'not-entered'));
    assert.deepEqual(workerReceipts.map(({ result }) => result.receipt.outcome.details.result.error.code),
        ['E_INVALID_ARGS', 'REF_VIEW_UNAVAILABLE']);
    const revoked = await compare('seat-withdraw', [native('withdrawn-ref', address)], async () => {
        const state = await publishSeat(manifest, changed, true);
        await watchUntil(async () => (await cinemaLog(manifest)).find(event => JSON.stringify(event.state) === JSON.stringify(state)));
        const current = await cinemaClient.observe();
        assert.equal(current.status, 'observed');
        try { assert.ok(current.observation.refs.every(ref => ref.refId !== 'seat')); }
        finally { cinemaClient.release(current.observation.observationId); }
    });
    assert.equal(revoked.result[0].success, false);
    const final = await compare('seat-latest');
    assert.ok(views(final.body).every(page => !page.includes(address)));
    for (const ids of [['old-ref', 'valid-seat', 'seat-number'], ['wrong-worker-type', 'wrong-worker-mount', 'withdrawn-ref']]) {
        for (const id of ids) assert.equal(final.body.messages.filter(msg => msg.role === 'tool' && msg.tool_call_id === id).length, 1);
    }
    assert.deepEqual((await cinemaLog(manifest)).filter(event => event.operation), effects);
    const withdrawal = captured.receipts.find(entry => entry.invocationId === 'withdrawn-ref').result.receipt;
    assert.ok(['not-dispatched', 'not-entered'].includes(withdrawal.executionPhase));
    assert.equal(captured.workers.filter(event => event.event === 'tool').length,
        effects.length + 2 + Number(withdrawal.executionPhase === 'not-entered'));
    assert.ok(captured.receipts.some(entry => entry.invocationId === 'old-ref' && entry.result.receipt?.outcome.status === 'succeeded'));
    return { codes, comparison, results, effects, observationSchema: observedSchema };
}

export async function exerciseStrict(turn, label, manifest, captured) {
    const count = captured.events.length;
    const start = (await healthyLog(manifest)).length;
    const calls = [modelCall(label + '-confirm', 'healthy-confirm', { text: label })];
    const { body, message } = await turn(label, calls);
    const tools = functions(body);
    const pages = views(body);
    assert.ok(pages.some(page => page.includes('Healthy app is ready')));
    assert.ok(pages.every(page => !page.includes('app_id="cinema"')));
    assert.ok(tools.run_code);
    assert.ok(Object.keys(tools).every(name => !name.startsWith('cinema-')));
    assert.ok(body.tools.every(({ function: fn }) => fn.strict === true));
    assert.ok(tools['system-open_app'] && tools['system-close_app']);
    const issue = body.messages.find(item => item.role === 'user' && item.content.includes('cannot encode cinema-lookup'));
    assert.ok(issue?.content.includes('prefixItems'), JSON.stringify(body.messages));
    assert.deepEqual(tools.run_code.parameters.required, ['code', 'imports', 'reset']);
    assert.ok(!consoleBindings(body).includes('"cinema-lookup"'), 'Console must keep the same App selection');
    assert.deepEqual(tools['system-collapse_view'].parameters.required, ['app_id', 'view_id', 'note']);
    assert.deepEqual(tools['system-collapse_app'].parameters.required, ['app_id', 'note']);
    assert.deepEqual(captured.events.slice(count).map(event => [event.appId, event.status]), [['healthy', 'adopted']]);
    const result = savedParts(message, calls)[0].output;
    assert.equal(result.type, 'json');
    assert.equal(result.value.confirmed, true);
    assert.deepEqual((await healthyLog(manifest)).slice(start), [{ text: label }]);
    const [, view_id] = / view_id="([^"]+)"/.exec(pages.find(page => page.includes('Healthy app')));
    const collapse = [modelCall(label + '-missing-note', 'system-collapse_view', { app_id: 'healthy', view_id }),
        modelCall(label + '-collapse', 'system-collapse_view', { app_id: 'healthy', view_id, note: '' })];
    const collapsed = await turn(label + '-empty-note', collapse);
    const [missing, empty] = savedParts(collapsed.message, collapse);
    assert.equal(missing.output.value.code, 'INVALID_APP_TARGET');
    assert.equal(empty.output.value.success, true);
    const later = await turn(label + '-check-note', []);
    assert.ok(views(later.body).some(page => page.includes('Collapsed') && !page.includes('Healthy app is ready')));
    assert.ok(functions(later.body)['system-expand_view']);
    return { tools: Object.keys(tools), issue: issue.content, admission: captured.events.slice(count) };
}
