#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';

const [corePackage, runtime, sdk, mode = 'all', count = '40'] = process.argv.slice(2);
const samples = Number(count), warmup = 12;
assert.ok(corePackage && runtime && sdk && ['all', 'micro', 'worker', 'digest'].includes(mode) && Number.isSafeInteger(samples) && samples > 0,
    'Usage: node runtime/scripts/snapshot-processing.mjs <Core package dir> <Runtime package dir> <SDK package dir> [all|micro|worker|digest] [samples]');
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

function timeDigestPath(run, verify) {
    const timings = [];
    for (let i = -warmup; i < samples; i++) {
        const start = performance.now();
        const result = run();
        const elapsed = performance.now() - start;
        verify(result);
        if (i >= 0) timings.push(elapsed);
    }

    return summarize(timings);
}

function countDigestWork(run, verify) {
    // The FNV loop calls asUintN once per byte.
    const truncate = BigInt.asUintN, encode = TextEncoder.prototype.encode;
    const canonicalEncodes = [];
    let fnvBytes = 0;
    BigInt.asUintN = (bits, value) => { fnvBytes++; return truncate(bits, value); };
    TextEncoder.prototype.encode = function (value) {
        const result = encode.call(this, value);
        if (value?.startsWith('{"refs":{},"schemaVersion":')) canonicalEncodes.push(result.byteLength);
        return result;
    };
    try { verify(run()); }
    finally { BigInt.asUintN = truncate; TextEncoder.prototype.encode = encode; }
    assert.ok(canonicalEncodes.length > 0);
    const digestCalls = fnvBytes / canonicalEncodes[0];
    assert.ok(Number.isInteger(digestCalls));
    return { canonicalEncodes, fnvBytes, digestCalls };
}

async function digestPaths(measure) {
    const [{ hostedObservationCapacityIssue, createSnapshotCore }, { SemanticProjectionCoordinator }] = await Promise.all([
        import(emitted(corePackage, 'host.js')),
        import(emitted(corePackage, 'producer.js')),
    ]);
    return [64, 512, 2048].map(kib => {
        const bodyBytes = kib * 1024;
        const identity = { appId: 'bench', instanceId: 'one' };
        const projection = new SemanticProjectionCoordinator({ identity: () => identity });
        const core = createSnapshotCore(identity);
        const views = Array.from({ length: Math.ceil(kib / 128) }, (_, index) => ({
            id: 'v' + index, viewInstanceId: 'vi' + index, type: 'Detail', name: 'View', region: 'dynamic', toolBindings: [],
            content: { format: 'markdown-v1', value: 'a'.repeat(Math.min(bodyBytes, 128 * 1024)) },
        }));
        const frame = { views, refs: [], tools: [] };
        try {
            const prepare = measure(() => projection.commit(() => frame), result => {
                assert.equal(result.status, 'prepared');
            });
            const publication = projection.nextPublication();
            assert.ok('draft' in publication);
            const { draft } = publication;
            const alternate = { ...draft, views: [{ ...views[0], content: {
                ...views[0].content, value: 'b' + views[0].content.value.slice(1),
            } }, ...views.slice(1)] };
            const seeded = core.committer.accept(draft);
            assert.equal(seeded.status, 'published');
            let sequence = draft.producerSeq, epoch = draft.sourceEpoch, last = seeded.snapshot, next = draft;
            const publish = () => core.committer.accept({ ...next, producerSeq: ++sequence, sourceEpoch: ++epoch });
            const published = measure(() => {
                next = next === draft ? alternate : draft;
                return publish();
            }, result => {
                assert.equal(result.status, 'published');
                assert.equal(result.snapshot.revision, last.revision + 1);
                assert.notEqual(result.snapshot.contentDigest, last.contentDigest);
                assert.match(result.snapshot.contentDigest, /^fnv1a64:[0-9a-f]{16}$/);
                last = result.snapshot;
            });
            const unchanged = measure(publish, result => {
                assert.equal(result.status, 'unchanged');
                assert.equal(result.snapshot, last);
            });
            const hostedIssue = hostedObservationCapacityIssue(draft);
            return { bodyBytes, views: views.length, defaultHostedProjectionIssue: hostedIssue ?? null, prepare, published, unchanged };
        } finally { projection.close(); core.lifecycle.dispose(); }
    });
}

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
        return { freezes, encodes, encodedBytes, canonical, frameBytes: result.value.bytes };
    } finally { Object.freeze = freeze; TextEncoder.prototype.encode = encode; }
}

async function micro() {
    const { validatePreparedSnapshot } = await import(emitted(corePackage, 'snapshot/validate-snapshot.js'));
    const { compileToolParameters, refKey, SNAPSHOT_SCHEMA_VERSION } = await import(emitted(corePackage, 'index.js'));
    const { contract } = compileToolParameters({ type: 'object', properties: {}, additionalProperties: false });
    const toolId = JSON.stringify([appId, type, toolName]);
    const results = [];
    for (const profile of profiles) {
        const fixture = data(profile), refs = {};
        const views = fixture.views.map(({ id, refs: small }, index) => {
            const viewInstanceId = 'mount_' + index;
            const add = (refId, payload, array = false) => {
                refs[refKey(id, viewInstanceId, refId)] = { scope: 'protected',
                    id: refId, ownerViewId: id, ownerViewInstanceId: viewInstanceId, refType: 'Data',
                    target: { kind: 'snapshot-value', payload }, ...(array ? { array: true } : {}),
                };
            };
            for (const ref of small) add(ref.id, ref.value);
            if (fixture.rows.length) add('rows', fixture.rows, true);
            return { id, viewInstanceId, type, name: id, region: 'dynamic', content: { format: 'markdown-v1', value: body(id, 0) },
                toolBindings: [{ toolId, activationId: 'activation_' + index }] };
        });
        const draft = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, appId, instanceId: 'bench-instance', producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
            views, refs, tools: { [toolId]: { multiplicity: 'multiple', id: toolId, name: toolName, viewType: type,
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
    const { createTurnCoordinator } = await import(emitted(corePackage, 'host.js'));
    const directory = await mkdtemp(join(tmpdir(), 'aotui-snapshot-processing-'));
    const modulePath = join(directory, 'app.mjs');
    const source = `
import { createApp, createView, defineViewType, ref, arrayRef } from ${JSON.stringify(emitted(sdk, 'app.js'))};
const data = ${data.toString()};
const body = ${body.toString()};
const File = defineViewType()({ name: 'File', region: 'dynamic', multiplicity: 'multiple', tools: { advance: {
    description: 'Change the fixture', execute({ context }) { return context.advance(); },
} } });
export default createApp({ app_name: 'snapshot_probe', viewTypes: [File], initialize(context) {
    const fixture = data(context.launchConfig);
    let revision = 0;
    const views = fixture.views.map(({ id, refs }) => createView(File, { idPrefix: id, render: () => ({
        body: body(id, revision),
        refs: fixture.rows.length ? [arrayRef('rows', fixture.rows, { itemType: 'Data', scope: 'protected', schema: { type: 'array', items: { type: 'object' } } })] :
            refs.map(item => ref(item.id, item.value, { refType: 'Data', scope: 'protected', schema: { type: 'object' } })),
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
            let lastMessage, updatedFrames, unchangedFrames, observationBytes, current, closed;
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
                const turns = createTurnCoordinator();
                const observe = async () => {
                    const start = performance.now();
                    const result = await turns.prepareObservation(client, () => host.getAppInteraction().status === 'ready');
                    const elapsed = performance.now() - start;
                    assert.equal(result.status, 'prepared', JSON.stringify(result.issue));
                    const adopted = turns.adoptTurn({ apps: [{ candidate: result.candidate }] });
                    assert.equal(adopted.status, 'adopted', JSON.stringify(adopted.issue));
                    return { observation: result.candidate.observation, turn: adopted.turn, elapsed };
                };
                let { observation, turn } = await observe();
                const viewId = observation.views[0].id;
                let priorFrames;
                for (let i = 0; i < warmup + samples; i++) {
                    if (i === warmup) priorFrames = frames;
                    const start = performance.now();
                    const receipt = await turn.invoke(appId, { observationId: observation.observationId, toolId: observation.tools[0].id,
                        invocationId: 'update_' + i, viewId, input: {} });
                    const invokeMs = performance.now() - start;
                    assert.equal(receipt.receipt?.outcome.status, 'succeeded', JSON.stringify(receipt));
                    const next = await observe();
                    const updateToObservationMs = performance.now() - start;
                    assert.notEqual(next.observation.source.snapshotId, observation.source.snapshotId);
                    ({ observation, turn } = next);
                    assert.match(observation.views[0].content.value, new RegExp('rev:' + (i + 1) + '\\b'));
                    const payload = Object.values(lastMessage.draft.refs)
                        .find(ref => ref.ownerViewId === viewId && ref.id === (profile.rows ? 'rows' : 'ref_0')).target.payload;
                    assert.equal((profile.rows ? payload[0] : payload).n, i + 1);
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
                    ({ observation, turn } = next);
                    if (i >= warmup) timings.unchangedObserveMs.push(next.elapsed);
                }
                unchangedFrames = frames - priorFrames;
                observationBytes = jsonBytes(observation);
                current = { snapshot: host.snapshotReceiver.core.store.inspect(), report: host.getSemanticSnapshotReport() };
                assert.equal(current.snapshot.heldSnapshots, 0);
                assert.equal(current.snapshot.heldSnapshotBytes, 0);
                turn.release();
            } finally {
                await host.close().catch(() => {});
                closed = await host.waitForResourceRelease();
            }
            assert.equal(closed.resourcesReleased, true);
            assert.equal(closed.appCleanup?.report?.state, 'completed', JSON.stringify(closed));
            assert.equal(closed.interactions.retainedOperations, 0);
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
if (mode === 'digest') {
    // Both versions start timing with the same number of actual FNV calls.
    const { diagnosticDigest } = await import(emitted(corePackage, 'snapshot/json.js'));
    const seed = new Uint8Array(4096).fill(97);
    results.digestWarmup = { calls: 384, bytesPerCall: seed.byteLength };
    for (let i = 0; i < results.digestWarmup.calls; i++) diagnosticDigest(seed);
    const timings = await digestPaths(timeDigestPath);
    // Patching an intrinsic can change V8's optimization of later samples.
    const work = await digestPaths(countDigestWork);
    results.digest = timings.map(({ prepare, published, unchanged, ...profile }, index) => ({
        ...profile,
        prepare: { ms: prepare, work: work[index].prepare },
        published: { ms: published, work: work[index].published },
        unchanged: { ms: unchanged, work: work[index].unchanged },
    }));
} else {
    if (mode !== 'micro') results.worker = await workers();
    if (mode !== 'worker') results.micro = await micro();
}
console.log(JSON.stringify(results, null, 2));
