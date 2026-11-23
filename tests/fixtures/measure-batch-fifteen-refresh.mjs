import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { appClient, fixtureAppPath, observe } from './batch-two-support.mjs';

const [mode, directory, trials = '3'] = process.argv.slice(2);
assert.ok(['baseline', 'confirmation'].includes(mode) && directory, 'Pass baseline or confirmation and an evidence directory.');
const folder = resolve(directory);
await mkdir(folder, { recursive: true });
process.env.AOTUI_DATA_DIR = join(folder, 'runtime');
delete process.env.AOTUI_SYSTEM_INSTRUCTION_PATH;
const { createRuntime } = await import('@aotui/runtime');
const localPath = await fixtureAppPath(new URL('./batch-fifteen-load-app.mjs', import.meta.url).href, 'bench_files', folder);
const runtime = createRuntime();
const events = [], runs = [], tracked = new WeakSet();
const { postMessage, emit } = Worker.prototype;
let awaitingPush, withholdNextPush = false;
Worker.prototype.postMessage = function (message, ...rest) {
    if (message.type === 'INIT' && message.appName === 'bench_files') {
        tracked.add(this);
        const threadId = this.threadId;
        events.push({ threadId, kind: 'start' });
        this.once('exit', code => events.push({ threadId, kind: 'exit', code }));
    }
    if (tracked.has(this) && message.type === 'FLUSH_PROJECTION')
        events.push({ threadId: this.threadId, kind: 'request', id: message.requestId, known: message.known });
    return postMessage.call(this, message, ...rest);
};
Worker.prototype.emit = function (name, message, ...rest) {
    if (name !== 'message' || !tracked.has(this) || !['SNAPSHOT_PREPARED', 'PROJECTION_CURRENT'].includes(message?.type))
        return emit.call(this, name, message, ...rest);
    const push = message.type === 'SNAPSHOT_PREPARED' && !message.requestId;
    const kind = push ? 'push' : message.type === 'PROJECTION_CURRENT' ? 'confirmation' : 'full';
    const { sourceEpoch, producerSeq } = message.draft ?? message;
    const bodyBytes = (message.draft?.views ?? []).reduce((total, view) => total + Buffer.byteLength(view.content.value), 0);
    const withheld = push && withholdNextPush;
    const record = { threadId: this.threadId, kind, id: message.requestId, sourceEpoch, producerSeq, bodyBytes, withheld };
    events.push(record);
    const delivered = withheld ? false : emit.call(this, name, message, ...rest);
    if (push && awaitingPush) awaitingPush.resolve(record);
    if (withheld) withholdNextPush = false;
    return delivered;
};

const median = values => {
    const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(values.length / 2);
    return values.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const stats = (records, observations, elapsed, cpu, wall) => {
    const requests = records.filter(event => event.kind === 'request');
    const replies = records.filter(event => ['full', 'confirmation'].includes(event.kind));
    const pushes = records.filter(event => event.kind === 'push');
    assert.deepEqual(requests.map(event => event.id), replies.map(event => event.id));
    assert.equal(new Set(observations.map(o => o.observationId)).size, requests.length);
    return {
        requests: requests.length, full: replies.filter(event => event.kind === 'full').length,
        confirmations: replies.filter(event => event.kind === 'confirmation').length, pushes: pushes.length,
        responseBodyBytes: replies.reduce((sum, event) => sum + event.bodyBytes, 0),
        pushedBodyBytes: pushes.reduce((sum, event) => sum + event.bodyBytes, 0),
        revisions: observations.map(o => o.source.revision),
        observationIds: observations.map(o => o.observationId),
        processCpuMs: (cpu.user + cpu.system) / 1000, observeAdoptP50Ms: median(elapsed), wallMs: wall,
    };
};
async function run(trial, count, pageBytes) {
    const desktop = runtime.getDesktop(await runtime.createDesktop());
    try {
        await desktop.registerPendingApp({ installationId: 'bench', localPath, config: { count, pageBytes } });
        const appId = await desktop.openApp('bench');
        const { client } = appClient(runtime, desktop, appId);
        const read = () => observe(client, true);
        let latest;
        for (let i = 0; i < 6; i++) latest = await read();
        const edit = async (index, withhold = false) => {
            withholdNextPush = withhold;
            const gate = new AbortController();
            const expired = delay(3000, null, { signal: gate.signal }).then(() => { throw new Error('No proactive publication'); });
            awaitingPush = Promise.withResolvers();
            const push = Promise.race([awaitingPush.promise, expired]);
            try {
                const [result, publication] = await Promise.all([client.invoke({
                    observationId: latest.observationId, invocationId: 'write-' + index,
                    toolId: latest.tools[0].id, input: { view_id: 'file_' + (count - 1) },
                }), push]);
                assert.equal(result.receipt?.outcome.status, 'succeeded');
                assert.equal(result.receipt.outcome.value.data.writes, index);
                assert.equal(publication.withheld, withhold);
                return publication;
            } finally {
                gate.abort();
                awaitingPush = undefined;
            }
        };
        async function sample(editFiles) {
            const start = events.length, cpu = process.cpuUsage(), started = performance.now(), times = [], observations = [];
            for (let i = 1; i <= 10; i++) {
                if (editFiles) await edit(i);
                const before = performance.now();
                latest = await read();
                times.push(performance.now() - before);
                observations.push(latest);
            }
            const used = process.cpuUsage(cpu), wall = performance.now() - started;
            const result = stats(events.slice(start), observations, times, used, wall);
            assert.equal(result.requests, 10);
            assert.equal(result.confirmations, mode === 'confirmation' ? 10 : 0);
            assert.equal(result.full, mode === 'baseline' ? 10 : 0);
            assert.equal(result.responseBodyBytes, mode === 'baseline' ? 10 * count * pageBytes : 0);
            assert.equal(result.pushedBodyBytes, editFiles ? 10 * count * pageBytes : 0);
            assert.deepEqual(result.revisions, editFiles ? Array.from({ length: 10 }, (_, i) => 2 + i) : Array(10).fill(1));
            return result;
        }
        const idle = await sample(false), editing = await sample(true);
        const start = events.length;
        const withheld = await edit(11, true);
        latest = await read();
        assert.equal(latest.source.revision, 12);
        assert.equal(latest.views.at(-1).content.value.at(-1), 'Z');
        await read();
        const missingPush = events.slice(start);
        assert.equal(missingPush.filter(event => event.kind === 'full').length, mode === 'confirmation' ? 1 : 2);
        if (mode === 'confirmation') {
            assert.deepEqual(missingPush.map(event => event.kind), ['push', 'request', 'full', 'request', 'confirmation']);
            const [, request, full, next, reply] = missingPush;
            assert.ok(request.known.producerSeq < withheld.producerSeq);
            assert.ok(full.producerSeq > withheld.producerSeq);
            assert.equal(full.producerSeq, next.known.producerSeq);
            assert.equal(reply.producerSeq, full.producerSeq);
        }
        runs.push({ trial, count, pageBytes, idle, editing, missingPush });
    } finally {
        assert.equal((await desktop.beginClose().completion).resourcesReleased, true);
    }
}
try {
    for (let trial = 0; trial < Number(trials); trial++) {
        await run(trial, 1, 4096);
        await run(trial, 20, 16384);
    }
} finally {
    const shutdown = await runtime.beginShutdown().completion;
    Worker.prototype.postMessage = postMessage;
    Worker.prototype.emit = emit;
    await writeFile(join(folder, 'summary.json'), JSON.stringify({
        mode, process: { node: process.version, platform: process.platform, arch: process.arch }, runs, events, shutdown,
    }, null, 2));
    assert.equal(shutdown.resourcesReleased, true);
}
