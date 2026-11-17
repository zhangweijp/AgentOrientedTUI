#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';

const [runtime, sdk, mode = 'all', count = '40'] = process.argv.slice(2);
const samples = Number(count), warmup = 12;
assert.ok(runtime && sdk && ['all', 'micro', 'worker'].includes(mode) && Number.isSafeInteger(samples) && samples > 0,
    'Usage: node runtime/scripts/snapshot-processing.mjs <Runtime package dir> <SDK package dir> [all|micro|worker] [samples]');
const emitted = (dir, file) => pathToFileURL(resolve(dir, 'dist', file)).href;
const appId = 'snapshot_probe', type = 'File', toolName = 'advance';
const profiles = [
    { name: 'small', views: 2, refsPerView: 3, rows: 0 },
    { name: 'many_views', views: 32, refsPerView: 4, rows: 0 },
    { name: 'array_ref', views: 1, refsPerView: 0, rows: 240 },
];
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

function data({ views, refsPerView, rows }) {
    return {
        views: Array.from({ length: views }, (_, index) => ({
            id: 'file_' + index,
            refs: Array.from({ length: refsPerView }, (_, i) => ({
                id: 'ref_' + i, value: { n: i, labels: ['甲', '🙂'], details: { path: 'file_' + index + '.txt', note: 'escaped\n"\\' } },
            })),
        })),
        rows: Array.from({ length: rows }, (_, n) => ({ n, title: 'item ' + n, body: 'alpha-甲🙂'.repeat(143) })),
    };
}
const body = (id, version) => id + ' rev:' + version + '\n' + 'text-甲\n'.repeat(20);
const summarize = values => {
    const sorted = values.slice().sort((a, b) => a - b);
    const percentile = p => +sorted[Math.ceil(values.length * p) - 1].toFixed(3);
    return { p50: percentile(0.5), p95: percentile(0.95), samples: values.map(value => +value.toFixed(3)) };
};

// Count work separately from timed calls so the wrappers do not affect timings.
function validationWork(validate, draft) {
    const freeze = Object.freeze, encode = TextEncoder.prototype.encode;
    let freezes = 0, encodes = 0, encodedBytes = 0;
    const canonical = { frameOrEnvelope: [], content: [] };
    Object.freeze = value => { freezes++; return freeze(value); };
    TextEncoder.prototype.encode = function (value) {
        const result = encode.call(this, value);
        encodes++;
        encodedBytes += result.byteLength;
        if (value?.startsWith('{"appId":')) canonical.frameOrEnvelope.push(result.byteLength);
        if (value?.startsWith('{"refs":')) canonical.content.push(result.byteLength);
        return result;
    };
    try {
        const result = validate(draft);
        assert.equal(result.ok, true);
        return { freezes, encodes, encodedBytes, canonical, frameBytes: result.value.bytes, digest: result.value.contentDigest };
    } finally { Object.freeze = freeze; TextEncoder.prototype.encode = encode; }
}

async function micro() {
    const { validatePreparedSnapshot } = await import(emitted(runtime, 'core/snapshot/validate-snapshot.js'));
    const { compileToolParameters } = await import(emitted(runtime, 'core/tool/tool-parameters.js'));
    const { refKey } = await import(emitted(runtime, 'core/snapshot/snapshot-support.js'));
    const { contract } = compileToolParameters({ type: 'object', properties: {}, additionalProperties: false });
    const toolId = JSON.stringify([appId, type, toolName]);
    const results = [];
    for (const profile of profiles) {
        const fixture = data(profile), refs = {};
        const views = fixture.views.map(({ id, refs: small }, index) => {
            const viewInstanceId = 'mount_' + index;
            const add = (refId, payload) => {
                refs[refKey(id, viewInstanceId, refId)] = {
                    id: refId, ownerViewId: id, ownerViewInstanceId: viewInstanceId, refType: 'Data',
                    target: { kind: 'snapshot-value', payload },
                };
            };
            for (const ref of small) add(ref.id, ref.value);
            if (fixture.rows.length) {
                add('rows', fixture.rows);
                fixture.rows.forEach((row, i) => add('rows[' + i + ']', row));
            }
            return { id, viewInstanceId, type, name: id, kind: 'state', content: { format: 'markdown-v1', value: body(id, 0) },
                toolBindings: [{ toolId, activationId: 'activation_' + index }] };
        });
        const draft = { schemaVersion: 6, appId, instanceId: 'bench-instance', producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
            views, refs, tools: { [toolId]: { id: toolId, name: toolName, viewType: type, nameSharedAcrossViewTypes: false,
                description: 'Change the fixture', inputSchema: contract.schema } } };
        const containers = value => value && typeof value === 'object'
            ? 1 + Object.values(value).reduce((sum, child) => sum + containers(child), 0) : 0;
        const logicalRefContainers = Object.values(refs).reduce((sum, ref) => sum + containers(ref.target.payload), 0);
        const times = [];
        for (let i = -warmup; i < samples; i++) {
            const start = performance.now();
            const result = validatePreparedSnapshot(draft);
            const elapsed = performance.now() - start;
            assert.equal(result.ok, true, JSON.stringify(result.issue));
            if (i >= 0) times.push(elapsed);
        }
        results.push({ ...profile, draft, refs: Object.keys(refs).length, largestRefBytes: Math.max(...Object.values(refs).map(r => jsonBytes(r.target.payload))),
            logicalRefContainers, validateMs: summarize(times) });
    }
    return results.map(({ draft, ...result }) => ({ ...result, work: validationWork(validatePreparedSnapshot, draft) }));
}

async function workers() {
    const { AppWorkerHost } = await import(emitted(runtime, 'engine/app/worker-host.js'));
    const directory = await mkdtemp(join(tmpdir(), 'aotui-snapshot-processing-'));
    const modulePath = join(directory, 'app.mjs');
    const source = `
import { createApp, createView, defineViewType, ref, arrayRef } from ${JSON.stringify(emitted(sdk, 'app.js'))};
const data = ${data.toString()};
const body = ${body.toString()};
const File = defineViewType()({ name: 'File', tools: { advance: {
    description: 'Change the fixture', execute({ context }) { return context.advance(); },
} } });
export default createApp({ app_name: 'snapshot_probe', viewTypes: [File], initialize(context) {
    const fixture = data(context.launchConfig);
    let revision = 0;
    const views = fixture.views.map(({ id, refs }) => createView(File, { id, kind: 'state', render: () => ({
        body: body(id, revision),
        refs: fixture.rows.length ? [arrayRef('rows', fixture.rows, { itemType: 'Data' })] :
            refs.map(item => ref(item.id, item.value, { refType: 'Data' })),
        context: { advance() {
            revision++;
            const mutable = fixture.rows[0] ?? fixture.views[0].refs[0].value;
            mutable.n = revision;
            const start = performance.now();
            const prepared = context.prepareProjection({ views });
            const prepareMs = performance.now() - start;
            if (prepared.status !== 'prepared') throw Error('Failed to prepare');
            return { success: true, data: { prepareMs } };
        } },
    }) }));
    context.prepareProjection({ views });
} });`;
    await writeFile(modulePath, source);
    try {
        const output = [];
        for (const profile of profiles) {
            const worker = new Worker(new URL(emitted(runtime, 'worker-runtime/index.js')));
            const host = new AppWorkerHost({ appId, desktopId: 'bench', appModulePath: pathToFileURL(modulePath).href,
                existingWorker: worker, timeout: 10000, config: { ...profile, AOTUI_DATA_DIR: directory } });
            let lastMessage, updatedFrames, unchangedFrames, observationBytes, current;
            let frames = 0;
            worker.on('message', message => {
                if (message.type === 'SNAPSHOT_PREPARED') { lastMessage = message; frames++; }
            });
            const timings = { prepareMs: [], invokeMs: [], updatedObserveMs: [], updateToObservationMs: [], unchangedObserveMs: [] };
            try {
                await host.start();
                await host.open();
                const ready = host.getAppInteraction();
                assert.equal(ready.status, 'ready');
                const client = ready.interaction;
                const observe = async () => {
                    const start = performance.now();
                    const result = await client.observe({ all: true });
                    const elapsed = performance.now() - start;
                    assert.equal(result.status, 'observed', JSON.stringify(result.issue));
                    const observation = result.observation;
                    assert.equal(client.adoptObservation(observation.observationId).status, 'adopted');
                    return { observation, elapsed };
                };
                let { observation } = await observe();
                let priorFrames;
                for (let i = 0; i < warmup + samples; i++) {
                    if (i === warmup) priorFrames = frames;
                    const start = performance.now();
                    const receipt = await client.invoke({ observationId: observation.observationId, toolId: observation.tools[0].id,
                        invocationId: 'update_' + i, input: { view_id: 'file_0' } });
                    const invokeMs = performance.now() - start;
                    assert.equal(receipt.receipt?.outcome.status, 'succeeded', JSON.stringify(receipt));
                    const next = await observe();
                    const updateToObservationMs = performance.now() - start;
                    assert.notEqual(next.observation.source.snapshotId, observation.source.snapshotId);
                    observation = next.observation;
                    assert.match(observation.views[0].content.value, new RegExp('rev:' + (i + 1) + '\\b'));
                    const payload = Object.values(lastMessage.draft.refs)
                        .find(ref => ref.ownerViewId === 'file_0' && ref.id === (profile.rows ? 'rows[0]' : 'ref_0')).target.payload;
                    assert.equal(payload.n, i + 1);
                    if (i >= warmup) {
                        timings.prepareMs.push(receipt.receipt.outcome.value.data.prepareMs);
                        timings.invokeMs.push(invokeMs);
                        timings.updatedObserveMs.push(next.elapsed);
                        timings.updateToObservationMs.push(updateToObservationMs);
                    }
                }
                updatedFrames = frames - priorFrames;
                for (let i = 0; i < warmup + samples; i++) {
                    if (i === warmup) priorFrames = frames;
                    const next = await observe();
                    assert.equal(next.observation.source.snapshotId, observation.source.snapshotId);
                    observation = next.observation;
                    if (i >= warmup) timings.unchangedObserveMs.push(next.elapsed);
                }
                unchangedFrames = frames - priorFrames;
                observationBytes = jsonBytes(observation);
                current = { snapshot: host.snapshotReceiver.core.store.inspect(), report: host.getSemanticSnapshotReport() };
                assert.equal(current.snapshot.heldSnapshots, 0);
                assert.equal(current.snapshot.heldSnapshotBytes, 0);
                client.releaseObservation(observation.observationId);
            } finally { await host.close(); }
            const closed = await host.waitForResourceRelease();
            assert.equal(closed.resourcesReleased, true);
            assert.equal(closed.interactions.retainedBytes, 0);
            const released = host.snapshotReceiver.core.store.inspect();
            assert.equal(released.currentBytes, 0);
            assert.equal(released.activeHolds, 0);
            output.push({ ...profile, frames: { updated: updatedFrames, unchanged: unchangedFrames },
                bytes: { draftJson: jsonBytes(lastMessage.draft), lastMessageJson: jsonBytes(lastMessage),
                    lastMessageV8: serialize(lastMessage).byteLength, observationJson: observationBytes },
                current, closed: { worker: closed.worker, resourcesReleased: closed.resourcesReleased, interactions: closed.interactions, snapshot: released },
                ...Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, summarize(values)])) });
        }
        return output;
    } finally { await rm(directory, { recursive: true, force: true }); }
}

const results = { node: process.version, platform: process.platform, arch: process.arch, samples, warmup };
if (mode !== 'micro') results.worker = await workers();
if (mode !== 'worker') results.micro = await micro();
console.log(JSON.stringify(results, null, 2));
