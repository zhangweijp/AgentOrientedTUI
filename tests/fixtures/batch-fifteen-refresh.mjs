import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { appClient, modelCall, watchUntil } from './batch-two-support.mjs';
import { savedParts } from './batch-ten-delivery.mjs';

const app = 'refresh_files';
const neighbor = app + '_1';
export const installations = ['refresh-primary', 'refresh-neighbor'];
export const refreshEntries = folder => installations.map(name => ({ name, source: 'local:' + folder, enabled: true, autoStart: false }));

export function watchProjectionWorkers() {
    const events = [], post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
        if (message.type === 'INIT' && message.appName === app) {
            const { appId, appInstanceId: instance } = message;
            const identify = { appId, instance, threadId: this.threadId };
            events.push({ ...identify, event: 'start' });
            this.on('message', reply => {
                if (reply.type === 'SNAPSHOT_PREPARED') {
                    const { sourceEpoch, producerSeq } = reply.draft;
                    events.push({ ...identify, event: reply.type, requestId: reply.requestId, sourceEpoch, producerSeq });
                } else if (reply.type === 'SNAPSHOT_PREPARE_FAILED' || reply.type === 'PROJECTION_CURRENT') {
                    events.push({ ...identify, event: reply.type, requestId: reply.requestId,
                        sourceEpoch: reply.sourceEpoch, producerSeq: reply.producerSeq, error: reply.error });
                } else if (reply.type === 'APP_EVENT' && reply.reason === 'projection_recovered') {
                    events.push({ ...identify, event: reply.reason });
                } else if (reply.type === 'VIEW_TOOL_INVOKE_RESPONSE')
                    events.push({ ...identify, event: 'terminal', requestId: reply.requestId, terminal: reply.terminal });
            });
            this.once('exit', code => events.push({ ...identify, event: 'exit', code }));
        }
        if (message.type === 'VIEW_TOOL_INVOKE') events.push({ event: 'dispatch', message });
        return post.call(this, message, ...rest);
    };
    return { events, restore: () => { Worker.prototype.postMessage = post; } };
}

export async function exerciseRefresh(turn, runtime, desktop, folder, events, budget, facts) {
    const current = (index = 0) => desktop.listApps().find(item => item.installationId === installations[index]);
    const mount = () => desktop.getAppWindows(current().appId, current().appInstanceId).views
        .find(view => view.viewId === 'editor')?.viewInstanceId;
    const native = (id, tool, input = {}, owner = app) => modelCall(id, owner + '-' + tool, input);
    const open = (id, index = 0) => modelCall(id, 'system-open_app', { installation_id: installations[index] });
    const close = (id, owner = app) => modelCall(id, 'system-close_app', { app_id: owner });
    const checkText = (id, owner) => native(id, 'read_file', { text: '$ref.' + owner + '.editor.content' }, owner);
    const pages = (body, owner) => body.messages.filter(message => message.role === 'user' &&
        message.content.startsWith('<view ') && message.content.includes('app_id="' + owner + '"'));
    const tools = body => body.tools.map(tool => tool.function.name);
    const diagnostic = body => body.messages.find(message => message.role === 'user' && message.content.startsWith('<desktop>')).content;
    const run = async (label, calls, options) => {
        const { body, message } = await turn(label, calls, options);
        const outputs = savedParts(message, calls).map(part => JSON.parse(JSON.stringify(part.output)));
        facts.results[label] = outputs;
        return { body, outputs };
    };
    const noPage = (body, owner = app) => {
        assert.equal(pages(body, owner).length, 0);
        assert.ok(tools(body).every(name => !name.startsWith(owner + '-')));
    };
    const fault = body => {
        noPage(body);
        assert.match(diagnostic(body), /SNAPSHOT_SERIALIZATION_ERROR:.*Ref editor\.content/);
        assert.ok(tools(body).includes('system-close_app'));
    };
    const file = join(folder, app + '.txt');
    await writeFile(file, 'Original\n');
    await writeFile(join(folder, neighbor + '.txt'), 'Unrelated healthy file\n');
    await writeFile(join(folder, app + '.initial-fault'), '');
    await run('launch', [open('open-primary'), open('open-neighbor', 1)]);
    const initial = current();
    assert.equal(initial.appId, app);
    assert.equal(current(1).appId, neighbor);

    const firstFault = await run('first-frame-failure', [checkText('healthy-at-start', neighbor)], {
        user: 'Check the healthy file. ' + 'Previous conversation. '.repeat(600),
    });
    fault(firstFault.body);
    assert.deepEqual(firstFault.outputs[0].value, { text: 'Unrelated healthy file\n' });
    assert.equal(events.some(event => event.instance === initial.appInstanceId && event.event === 'SNAPSHOT_PREPARED'), false);

    async function repair() {
        const offset = events.length;
        await writeFile(join(folder, app + '.repair'), String(offset));
        const forApp = event => event.instance === initial.appInstanceId;
        await watchUntil(() => events.slice(offset).some(event => forApp(event) && event.event === 'projection_recovered'));
        const observed = await appClient(desktop, initial.appId).running.observe();
        assert.equal(observed.status, 'prepared', JSON.stringify(observed.issue));
        observed.candidate.discard();
        const frame = events.slice(offset).find(event => forApp(event) && event.event === 'SNAPSHOT_PREPARED');
        assert.ok(frame?.requestId, 'A recovered projection is pulled on the next observation.');
        return frame;
    }
    const firstHealthy = await repair();
    const originalMount = mount();
    assert.ok(originalMount);
    const write = await run('write-before-failure', [native('write', 'append_and_fail_projection', { text: 'Saved exactly once' })]);
    assert.match(pages(write.body, app).map(page => page.content).join('\n'),
        /Original[\s\S]+Available references\n- protected \$ref\.refresh_files\.editor\.content \(string\)/);
    const saved = { saved: true, projection: 'SNAPSHOT_SERIALIZATION_ERROR' };
    assert.deepEqual(write.outputs, [{ type: 'json', value: saved }]);
    const writeDispatches = () => events.filter(event => event.event === 'dispatch' &&
        event.message.tool.name === 'append_and_fail_projection');
    assert.equal(writeDispatches().length, 1);
    const [{ message: dispatch }] = writeDispatches();
    const terminal = events.find(event => event.event === 'terminal' && event.requestId === dispatch.requestId)?.terminal;
    assert.equal(terminal?.phase, 'entered-returned');
    assert.equal(terminal.result.success, true);
    assert.deepEqual(terminal.result.data, saved);

    const later = await run('after-write-failure', [checkText('healthy-after-write', neighbor)]);
    fault(later.body);
    assert.match(pages(later.body, neighbor).map(page => page.content).join('\n'), /Unrelated healthy file/);
    assert.deepEqual(later.outputs[0].value, { text: 'Unrelated healthy file\n' });
    const paired = later.body.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'write');
    assert.equal(paired.length, 1);
    assert.deepEqual(JSON.parse(paired[0].content), saved);
    const rejectedFrame = events.find(event => event.instance === initial.appInstanceId && event.event === 'SNAPSHOT_PREPARE_FAILED' &&
        event.producerSeq > firstHealthy.producerSeq);
    assert.equal(rejectedFrame.sourceEpoch, firstHealthy.sourceEpoch);
    assert.match(rejectedFrame.error.path, /Ref editor\.content/);

    const corrected = await repair();
    assert.ok(corrected.sourceEpoch > rejectedFrame.sourceEpoch);
    assert.equal(mount(), originalMount);
    const recovered = await run('app-repair', [checkText('read-after-app-repair', app)]);
    const text = 'Original\nSaved exactly once\n';
    assert.deepEqual(recovered.outputs[0].value, { text });
    assert.match(pages(recovered.body, app).map(page => page.content).join('\n'), /Saved exactly once/);
    assert.doesNotMatch(diagnostic(recovered.body), /SNAPSHOT_SERIALIZATION_ERROR/);

    const pageClosed = await run('close-file', [modelCall('close-file', 'system-close_view', { app_id: app, view_id: 'editor' })]);
    assert.equal(pageClosed.outputs[0].value.closed, true);
    assert.equal(mount(), undefined);
    const removed = await run('reopen-file', [native('new-file', 'open_file')]);
    assert.deepEqual(pages(removed.body, app).map(page => page.content), [
        '<view view_id="workspace" view_type="workspace" app_id="refresh_files" app_name="refresh_files">\nTest file workspace\n</view>',
    ]);
    assert.equal(tools(removed.body).includes(app + '-read_file'), false);
    const reopenedMount = mount();
    assert.ok(reopenedMount && reopenedMount !== originalMount);
    await run('fault-before-management', [close('remove-neighbor', neighbor), native('damage', 'fail_projection')]);

    budget.contextWindow = 7000;
    const management = await run('management-close', [close('recover-by-close')]);
    fault(management.body);
    assert.ok(tools(management.body).every(name => name.startsWith('system-')));
    assert.match(diagnostic(management.body), /Context budget:/);
    assert.equal(management.outputs[0].value.result.success, true);
    assert.equal(management.outputs[0].value.window_budget.mode, 'management');
    assert.equal(current().status, 'closed');
    assert.ok(events.some(event => event.instance === initial.appInstanceId && event.event === 'exit'));
    budget.contextWindow = 160_000;

    // The first-frame fault marker belongs to the initial test run only.
    await unlink(join(folder, app + '.initial-fault'));
    await run('reopen-app', [open('recover-by-open')]);
    const replacement = current();
    assert.equal(replacement.appId, app);
    assert.notEqual(replacement.appInstanceId, initial.appInstanceId);
    assert.notEqual(mount(), originalMount);
    const outdated = await run('stale-close', [close('outdated-close')], { beforeReply: async () => {
        assert.equal((await appClient(desktop, replacement.appId).running.beginClose().completion).ok, true);
        assert.equal((await desktop.openApp(installations[0])).appId, app);
    } });
    assert.equal(outdated.outputs[0].value.code, 'APP_INSTANCE_CHANGED');
    const successor = current();
    assert.notEqual(successor.appInstanceId, replacement.appInstanceId);
    assert.equal(successor.status, 'running');
    const last = await run('final-read-and-close', [checkText('verify-successor', app), close('final-close')]);
    assert.deepEqual(last.outputs[0].value, { text });
    assert.equal(last.outputs[1].value.success, true);
    assert.equal(await readFile(file, 'utf8'), text);
    assert.equal(writeDispatches().length, 1);
    const closed = events.filter(event => event.event === 'exit'), started = events.filter(event => event.event === 'start');
    assert.deepEqual(closed.map(event => event.threadId).sort(), started.map(event => event.threadId).sort());
    facts.appRuns = [initial.appInstanceId, replacement.appInstanceId, successor.appInstanceId];
    facts.mounts = [originalMount, reopenedMount];
    facts.file = text;
}
