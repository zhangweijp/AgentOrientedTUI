import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '@aotui/runtime';
import { buildViewMessageMarkup } from '@aotui/runtime/adapters';

const [reference, probe, vectorPath, tsApp, evidence, attention, python = 'python3'] = process.argv.slice(2);
assert.ok(reference && probe && vectorPath && tsApp && evidence && ['with-attention', 'baseline'].includes(attention));
const vectors = JSON.parse(await readFile(resolve(vectorPath), 'utf8'));
const out = resolve(evidence);
await mkdir(out);
const facts = { passed: false, cases: {} };
const name = 'delivered_files';
const installationId = 'external';
const releases = new Set();
let sequence = 0;
const jsonValue = value => JSON.parse(JSON.stringify(value));

const jsonl = async (folder, log) => {
    try { return (await readFile(join(folder, log + '.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const read = (folder, file) => readFile(join(folder, file), 'utf8');
async function eventually(condition, detail) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const result = await condition();
        if (result) return result;
        await delay(15);
    }
    throw new Error('Timed out waiting for ' + detail);
}
function causeChain(error) {
    const causes = [];
    for (let current = error; current && causes.length < 8; current = current.cause) {
        causes.push({ code: current.code, message: current.message, diagnostic: current.diagnostic });
    }
    return causes;
}
function assertCause(error, code, message) {
    const cause = causeChain(error).find(item => item.code === code || item.diagnostic?.code === code);
    assert.ok(cause, JSON.stringify(causeChain(error)));
    if (message) assert.match(JSON.stringify(cause), message);
    return true;
}
function ownedProcess(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function run(label, scenario, exercise, { maxWorkers, text = 'Original A', args } = {}) {
    const folder = join(out, label);
    await mkdir(folder);
    await writeFile(join(folder, 'A.txt'), text);
    await writeFile(join(folder, 'B.txt'), 'Original B');
    const runtime = createRuntime({ worker: { ...(maxWorkers === undefined ? {} : { maxWorkers }), timeoutMs: 3_000 } });
    const desktop = await runtime.createDesktop();
    const command = [python, '-B', '-u', ...(args ?? [resolve(probe), resolve(reference), resolve(vectorPath), scenario])];
    const before = command.slice();
    const activities = [];
    desktop.output.subscribe(signal => activities.push(signal));
    try {
        await desktop.registerPendingApp({ installationId, name, command, config: { folder } });
        assert.deepEqual(await jsonl(folder, 'launches'), []);
        command[3] = 'This misleading script must never run.';
        const result = await exercise({ runtime, desktop, folder, before, activities });
        facts.cases[label] = { result, activities };
    } catch (error) {
        facts.cases[label] = { failure: String(error), causes: causeChain(error), stack: error.stack, activities };
        throw error;
    } finally {
        for (const turn of releases) turn.release();
        releases.clear();
        await writeFile(join(folder, 'release'), 'release test-owned App');
        const close = await runtime.beginClose().completion;
        facts.cases[label].close = close;
        facts.cases[label].launches = await jsonl(folder, 'launches');
        facts.cases[label].dispatches = await jsonl(folder, 'dispatches');
        facts.cases[label].writes = await jsonl(folder, 'writes');
        facts.cases[label].entries = await jsonl(folder, 'entries');
        assert.equal(close.resourcesReleased, true, JSON.stringify(close));
        assert.equal(close.workers.report.total, 0);
    }
}

async function observe(app, desktop) {
    const prepared = await app.observe();
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
    const { candidate } = prepared;
    const adopted = desktop.adoptTurn({ apps: [{ candidate }] });
    assert.equal(adopted.status, 'adopted', JSON.stringify(adopted));
    releases.add(adopted.turn);
    return { turn: adopted.turn, observation: candidate.observation };
}
const page = (ctx, file) => ctx.observation.views.find(view => view.name === file);
function invocation(ctx, toolName, input, viewId) {
    const tool = ctx.observation.tools.find(item => item.name === toolName);
    assert.ok(tool, toolName);
    return { invocationId: 'operation-' + ++sequence, observationId: ctx.observation.observationId,
        toolId: tool.id, input, ...(viewId && { viewId }) };
}
function receipt(result, executionPhase, status, code) {
    assert.equal(result.kind, 'receipt', JSON.stringify(result));
    const record = result.receipt;
    assert.equal(record.executionPhase, executionPhase, JSON.stringify(record));
    assert.equal(record.outcome.status, status, JSON.stringify(record));
    if (code && executionPhase === 'not-entered') {
        assert.equal(record.outcome.code, code === vectors.decisions.scopeChanged ? code : 'TOOL_REJECTED');
        assert.equal(record.outcome.details.result.error.code, code, JSON.stringify(record));
    } else if (code) assert.equal(record.outcome.code, code, JSON.stringify(record));
    return record;
}
const call = (app, ctx, name, input, viewId) => ctx.turn.invoke(app.appId, invocation(ctx, name, input, viewId));
async function openBoth(app, desktop) {
    for (const file of ['A.txt', 'B.txt']) {
        const current = await observe(app, desktop);
        receipt(await call(app, current, 'open_file', { name: file }), 'entered-returned', 'succeeded');
    }
    return observe(app, desktop);
}
const address = (app, ctx) => `$ref.${app.appId}.${page(ctx, 'A.txt').id}.content`;

try {
    await run('framing-and-frozen-schema', 'optional-attention', async ({ desktop, folder, before, activities }) => {
        const [app, duplicate] = await Promise.all([desktop.openApp(installationId), desktop.openApp(installationId)]);
        assert.equal(app.instanceId, duplicate.instanceId);
        const [started, ...others] = await jsonl(folder, 'launches');
        assert.deepEqual(others, []);
        assert.deepEqual(started.argv, before.slice(3));
        assert.ok(started.argv.some(item => item.includes(' ')), 'The frozen source path must exercise a fixed argument with spaces.');
        assert.deepEqual(started.capabilities, attention === 'with-attention' ? ['attention'] : []);
        const ctx = await openBoth(app, desktop);
        const tool = ctx.observation.tools.find(tool => tool.name === 'edit');
        assert.deepEqual(JSON.parse(tool.id), [app.appId, vectors.tool.viewType, vectors.tool.name]);
        const { viewType, multiplicity, inputSchema } = tool;
        assert.deepEqual(jsonValue({ viewType, name: tool.name, multiplicity, inputSchema }), vectors.tool);
        const source = page(ctx, 'A.txt');
        const ref = ctx.observation.refs.find(ref => ref.viewId === source.id && ref.refId === 'content');
        const xml = buildViewMessageMarkup({ appId: app.appId, appName: name, viewId: source.id, viewType: source.type,
            region: source.region, markup: source.content.value, refs: [ref] });
        assert.ok(xml.includes(vectors.xmlText), xml);
        assert.ok(xml.includes(address(app, ctx)), xml);
        assert.deepEqual(jsonValue({ id: ref.refId, scope: ref.scope, schema: ref.valueSchema }), vectors.ref);
        assert.deepEqual(await ctx.turn.inspectRef(address(app, ctx), 'value'), { status: 'ready', value: vectors.text });
        const edit = receipt(await call(app, ctx, 'edit', { text: address(app, ctx) }, page(ctx, 'B.txt').id), 'entered-returned', 'succeeded');
        assert.equal(await read(folder, 'A.txt'), vectors.text);
        assert.equal(await read(folder, 'B.txt'), vectors.text);
        await writeFile(join(folder, 'attention'), 'now');
        if (attention === 'with-attention') await eventually(() => activities.some(item => item.reason === 'attention_requested'), 'attention');
        assert.equal(activities.filter(item => item.reason === 'attention_requested').length, attention === 'with-attention' ? 1 : 0);
        return { receipt: edit, xml, inputSchema, ref, started };
    }, { text: vectors.text });

    const withoutCapabilities = [
        '-c', `import json, runpy, sys
module = runpy.run_path(sys.argv[1])
class BaselineConnection(module['Connection']):
    def send(self, message):
        if message.get('type') == 'hello':
            del message['capabilities'], message['requires']
        super().send(message)
class BaselineApp(module['FilesApp']):
    def __init__(self, connection, request):
        super().__init__(connection, request)
        (self.folder / 'capabilities.json').write_text(json.dumps(self.capabilities))
module['run'](BaselineApp, BaselineConnection(), capabilities=())`, resolve(reference),
    ];
    await run('baseline-peer-without-capabilities', '', async ({ desktop, folder, activities }) => {
        const app = await desktop.openApp(installationId);
        assert.deepEqual(JSON.parse(await read(folder, 'capabilities.json')), []);
        const current = await openBoth(app, desktop);
        const result = receipt(await call(app, current, 'edit', { text: address(app, current) }, page(current, 'B.txt').id),
            'entered-returned', 'succeeded');
        assert.equal(await read(folder, 'A.txt'), 'Original A');
        assert.equal(await read(folder, 'B.txt'), 'Original A');
        assert.equal(activities.filter(item => item.reason === 'attention_requested').length, 0);
        return result;
    }, { args: withoutCapabilities });

    for (const [scenario, code, message] of [
        ['wrong-major', 'PROTOCOL_UNSUPPORTED', /major 99/],
        ['wrong-identity', 'PROTOCOL_UNSUPPORTED', /aotui-stdio/],
        ['missing-capability', 'CAPABILITY_REQUIRED', /example\.mandatory-feature/],
    ]) {
        await run(scenario, scenario, async ({ desktop, folder }) => {
            let causes;
            await assert.rejects(desktop.openApp(installationId), error => {
                causes = causeChain(error);
                return assertCause(error, code, message);
            });
            assert.deepEqual(await jsonl(folder, 'launches'), []);
            assert.equal(await read(folder, 'B.txt'), 'Original B');
            return { causes };
        });
    }

    for (const [label, trigger, change, code] of [
        ['before-refresh-remount', 'change-at-refresh', 'mount', vectors.decisions.closeOrRemount],
        ['before-refresh-scope', 'change-at-refresh', 'scope', vectors.decisions.scopeChanged],
        ['execution-remount', 'change-at-invoke', 'mount', vectors.decisions.closeOrRemount],
        ['execution-scope', 'change-at-invoke', 'scope', vectors.decisions.scopeChanged],
        ['execution-activation', 'change-at-invoke', 'activation', vectors.decisions.activationChanged],
        ['execution-final-input', undefined, undefined, vectors.decisions.badFinalInput],
    ]) {
        await run(label, trigger ? 'changes' : 'bad-final-input', async ({ desktop, folder }) => {
            const app = await desktop.openApp(installationId);
            const ctx = await openBoth(app, desktop);
            const b = page(ctx, 'B.txt');
            const request = invocation(ctx, 'edit', { text: address(app, ctx) }, b.id);
            if (trigger) await writeFile(join(folder, trigger), change);
            const dispatched = trigger !== 'change-at-refresh';
            const stale = receipt(await ctx.turn.invoke(app.appId, request), dispatched ? 'not-entered' : 'not-dispatched', 'rejected', code);
            assert.equal((await jsonl(folder, 'dispatches')).length, dispatched ? 1 : 0);
            assert.deepEqual(await jsonl(folder, 'entries'), []);
            assert.deepEqual(await jsonl(folder, 'writes'), []);
            assert.equal(await read(folder, 'A.txt'), 'Original A');
            assert.equal(await read(folder, 'B.txt'), 'Original B');
            const current = await observe(app, desktop);
            assert.equal(page(current, 'B.txt').id, b.id);
            if (change === 'mount') assert.notEqual(page(current, 'B.txt').viewInstanceId, b.viewInstanceId);
            else assert.equal(page(current, 'B.txt').viewInstanceId, b.viewInstanceId);
            return { receipt: stale, prior: b.viewInstanceId, current: page(current, 'B.txt').viewInstanceId };
        });
    }

    for (const scenario of ['prewrite-exit', 'postwrite-exit', 'hold-receipt', 'exit-tail', 'stdout-ended-live']) {
        await run(scenario, scenario, async ({ desktop, folder }) => {
            const app = await desktop.openApp(installationId);
            const ctx = await openBoth(app, desktop);
            const request = invocation(ctx, 'edit', { text: vectors.text }, page(ctx, 'B.txt').id);
            const locator = { observationId: request.observationId, invocationId: request.invocationId };
            const pending = ctx.turn.invoke(app.appId, request, scenario === 'hold-receipt' ? 200 : 3_000);
            const closeOnly = scenario === 'stdout-ended-live';
            let result, retry;
            if (scenario === 'hold-receipt') {
                await eventually(async () => (await jsonl(folder, 'writes')).length === 1, 'business write');
                assert.equal(await read(folder, 'B.txt'), vectors.text);
                const timeout = await pending;
                assert.deepEqual([timeout.kind, timeout.code], ['unavailable', vectors.decisions.wait]);
                const queried = await app.readReceipt(locator, 30);
                assert.deepEqual([queried.kind, queried.code], ['unavailable', vectors.decisions.wait]);
                await writeFile(join(folder, 'release'), 'accept original receipt');
                result = receipt(await app.readReceipt(locator, 2000), 'entered-returned', 'succeeded');
                retry = receipt(await ctx.turn.invoke(app.appId, request), 'entered-returned', 'succeeded');
                assert.deepEqual(retry, result);
            } else if (scenario === 'exit-tail') {
                result = receipt(await pending, 'entered-returned', 'succeeded');
                assert.equal(result.outcome.value.data.text, vectors.text.repeat(1000));
            } else {
                result = receipt(await pending, 'unknown', 'unknown', vectors.decisions.noTerminal);
                assert.deepEqual((await app.readReceipt(locator)).receipt, result);
            }
            const [entry] = await jsonl(folder, 'launches');
            let capacity, processHeld;
            if (closeOnly) {
                processHeld = ownedProcess(entry.pid);
                assert.ok(processHeld, 'EOF must settle the receipt before the process exits.');
                await desktop.registerPendingApp({ installationId: 'native', localPath: resolve(tsApp), config: { folder } });
                await assert.rejects(desktop.openApp('native'), error => {
                    capacity = causeChain(error);
                    return assertCause(error, 'WORKER_CAPACITY_EXCEEDED');
                });
                assert.ok(ownedProcess(entry.pid));
                await writeFile(join(folder, 'release'), 'now permit true exit');
            }
            let released;
            if (scenario !== 'hold-receipt') {
                await eventually(() => !ownedProcess(entry.pid), 'actual child exit');
                released = await app.beginClose().completion;
                assert.equal(released.resourcesReleased, true, JSON.stringify(released));
            }
            if (closeOnly) {
                const native = await desktop.openApp('native');
                assert.ok((await observe(native, desktop)).observation.tools.some(tool => tool.name === 'open_file'));
                assert.equal((await native.beginClose().completion).resourcesReleased, true);
            }
            assert.equal(await read(folder, 'A.txt'), 'Original A');
            assert.equal(await read(folder, 'B.txt'), scenario === 'prewrite-exit' ? 'Original B' : vectors.text);
            assert.equal((await jsonl(folder, 'dispatches')).length, 1);
            assert.deepEqual(await jsonl(folder, 'entries'), [{ name: 'B.txt' }]);
            assert.deepEqual(await jsonl(folder, 'writes'), scenario === 'prewrite-exit' ? [] : [{ name: 'B.txt', text: vectors.text }]);
            return { result, retry, processHeld, capacity, released };
        }, { maxWorkers: scenario === 'stdout-ended-live' ? 1 : undefined });
    }
    facts.passed = true;
} finally {
    await writeFile(join(out, 'evidence.json'), JSON.stringify(facts, null, 2));
}
