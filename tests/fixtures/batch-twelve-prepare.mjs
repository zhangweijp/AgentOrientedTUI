import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { modelCall } from './batch-two-support.mjs';
import { savedParts } from './batch-ten-delivery.mjs';

const app = 'tasks';
export const installation = 'tasks-installed';
export const todoEntry = folder => ({ name: installation, source: 'local:' + folder, enabled: true, autoStart: false });

export function trackTodo(desktop) {
    const events = [], signals = [], originals = Worker.prototype.postMessage;
    const adoptTurn = desktop.adoptTurn;
    desktop.adoptTurn = function (selection) {
        const result = adoptTurn.call(this, selection);
        const adopted = selection.apps.find(({ candidate }) => candidate.observation.source.appId === app)?.candidate.observation;
        if (result.status === 'adopted' && adopted)
            events.push({ type: 'adopted', observationId: adopted.observationId });
        return result;
    };
    const owners = new WeakSet();
    const listener = signal => signals.push(signal);
    desktop.output.subscribe(listener);
    Worker.prototype.postMessage = function (message, ...rest) {
        if (message?.type === 'INIT' && message.appName === app) {
            owners.add(this);
            events.push({ type: 'init', module: message.appModulePath, threadId: this.threadId });
            this.on('message', value => {
                if (value.type === 'SNAPSHOT_PREPARED') {
                    const page = value.draft.views.find(view => view.id === 'todo');
                    events.push({ type: 'publication', replyTo: value.requestId, sourceEpoch: value.draft.sourceEpoch,
                        producerSeq: value.draft.producerSeq, mount: page?.viewInstanceId, body: page?.content.value });
                } else if (value.type === 'PROJECTION_CURRENT') {
                    events.push({ type: 'confirmation', replyTo: value.requestId, sourceEpoch: value.sourceEpoch,
                        producerSeq: value.producerSeq });
                } else if (value.type === 'VIEW_TOOL_INVOKE_RESPONSE') events.push({ type: 'terminal', message: value });
            });
            this.once('exit', code => events.push({ type: 'exit', code, threadId: this.threadId }));
        } else if (owners.has(this)) {
            if (message.type === 'FLUSH_PROJECTION') events.push({ type: 'refresh', requestId: message.requestId });
            if (message.type === 'VIEW_TOOL_INVOKE') events.push({ type: 'dispatch', message });
        }
        return originals.call(this, message, ...rest);
    };
    return { events, signals, restore() {
        Worker.prototype.postMessage = originals;
        desktop.adoptTurn = adoptTurn;
        desktop.output.unsubscribe(listener);
    } };
}

export async function exerciseTodo(turn, runtime, desktop, folder, tracked) {
    const results = {}, receipts = {}, turns = {};
    const call = (id, name, input = {}) => modelCall(id, `${app}-${name}`, input);
    const page = request => request.messages.filter(message => message.role === 'user' &&
        message.content.startsWith('<view ') && message.content.includes(`app_id="${app}"`));
    const run = async (label, calls, bodyPattern) => {
        const start = tracked.events.length;
        const { body, message } = await turn(label, calls);
        const pages = page(body);
        assert.equal(pages.length, bodyPattern ? 1 : 0);
        if (bodyPattern) assert.match(pages[0].content, bodyPattern);
        const resultsForTurn = results[label] = savedParts(message, calls);
        const events = tracked.events.slice(start);
        const unsolicited = events.filter(event => event.type === 'publication' && event.replyTo === undefined);
        const refresh = events.filter(event => ['publication', 'confirmation'].includes(event.type) && event.replyTo !== undefined);
        assert.ok(refresh.every(reply => events.some(event => event.type === 'refresh' && event.requestId === reply.replyTo)));
        turns[label] = { unsolicited, refresh };
        const observationId = events.find(event => event.type === 'adopted')?.observationId;
        if (calls.some(operation => operation.function.name.startsWith(app + '-'))) {
            assert.ok(observationId, label + ' has an adopted observation');
            const current = desktop.listApps().find(record => record.appId === app);
            const access = desktop.getRunningApp(app, current.appInstanceId);
            assert.equal(access.status, 'ready');
            for (const [index, operation] of calls.entries()) {
                const receipt = await access.app.readReceipt({ observationId, invocationId: operation.id });
                assert.equal(receipt.kind, 'receipt', JSON.stringify(receipt));
                assert.equal(receipt.receipt.outcome.status, resultsForTurn[index].output.type === 'json' ? 'succeeded' : 'rejected');
                receipts[operation.id] = receipt.receipt;
            }
        }
        return body;
    };
    const output = (label, index = 0) => {
        const { output } = results[label][index];
        assert.equal(output.type, 'json', JSON.stringify(output));
        return JSON.parse(JSON.stringify(output.value));
    };
    const wireResult = (request, id, expected) => {
        const parts = request.messages.filter(message => message.role === 'tool' && message.tool_call_id === id);
        assert.equal(parts.length, 1, id);
        assert.deepEqual(JSON.parse(parts[0].content), expected);
    };

    await run('launch', [modelCall('launch', 'system-open_app', { installation_id: installation })]);
    await run('finish-first', [call('first', 'mark_done')], /\bPending\b/);
    const second = await run('finish-second', [call('second', 'mark_done')], /\bDone\b/);
    const check = await run('check', [call('checked', 'check')], /\bDone\b/);
    const exported = await run('export', [call('exported', 'export_todos')], /\bDone\b/);
    const firstVersion = output('finish-first').prepared;
    assert.deepEqual(firstVersion, { status: 'prepared' });
    assert.deepEqual(output('finish-first'), { prepared: firstVersion, attempt: 1 });
    assert.deepEqual(output('finish-second'), { prepared: firstVersion, attempt: 2 });
    assert.deepEqual(output('check'), { done: true, attempts: 2, commits: 2 });
    const finished = [...turns['finish-first'].refresh, ...turns['finish-second'].refresh]
        .filter(reply => reply.type === 'publication' && reply.sourceEpoch === 2);
    assert.equal(finished.length, 1);
    for (const label of ['finish-first', 'finish-second', 'check', 'export']) {
        assert.equal(turns[label].unsolicited.length, 0, label);
    }
    for (const label of ['check', 'export']) {
        assert.ok(turns[label].refresh.length > 0, label);
        assert.ok(turns[label].refresh.every(reply => reply.type === 'confirmation' &&
            reply.sourceEpoch === finished[0].sourceEpoch && reply.producerSeq === finished[0].producerSeq));
    }
    assert.deepEqual(['first', 'second', 'checked', 'exported'].map(id => receipts[id].source.revision), [1, 2, 2, 2]);
    assert.notEqual(receipts.first.observationId, receipts.second.observationId);
    for (const id of ['first', 'second', 'checked', 'exported']) assert.equal(receipts[id].executionPhase, 'entered-returned');
    wireResult(second, 'first', output('finish-first'));
    wireResult(check, 'second', output('finish-second'));
    wireResult(exported, 'checked', output('check'));

    const address = { value: '$ref.tasks.todo.priority' };
    const changing = await run('priority', [call('change', 'set_priority', { value: 2 }), call('original', 'inspect_priority', address)], /\bDone\b/);
    wireResult(changing, 'exported', { path: 'todos.csv', count: 1 });
    assert.deepEqual(output('priority', 1), { observed: 1, current: 2 });
    assert.deepEqual(output('priority').prepared, { status: 'prepared' });
    const updated = await run('disable', [call('updated', 'inspect_priority', address),
        call('revoke', 'set_priority', { value: 0 }), call('denied', 'inspect_priority', address)], /\bDone\b/);
    assert.deepEqual(output('disable'), { observed: 2, current: 2 });
    assert.deepEqual(output('disable', 1).prepared, { status: 'prepared' });
    assert.equal(results.disable[2].output.type, 'error-json');
    assert.equal(results.disable[2].output.value.code, 'TOOL_SOURCE_STALE');
    assert.equal(receipts.denied.executionPhase, 'not-dispatched');
    assert.equal(page(updated)[0].content, page(changing)[0].content);
    const priorityFrame = turns.priority.refresh.find(reply => reply.type === 'publication' && reply.sourceEpoch === 3);
    assert.equal(priorityFrame.body, finished[0].body);
    assert.equal(priorityFrame.mount, finished[0].mount);

    const close = await run('close', [modelCall('close', 'system-close_app', { app_id: app })], /\bDone\b/);
    assert.equal(close.tools.some(tool => tool.function.name === `${app}-inspect_priority`), false);
    assert.deepEqual(output('close'), { success: true, app_id: app });
    assert.deepEqual(tracked.events.filter(event => event.type === 'exit').map(event => event.threadId), [-1]);
    const csv = await readFile(join(folder, 'todos.csv'), 'utf8');
    assert.equal(csv, 'task,done\n');
    return { results, receipts, turns, csv };
}
