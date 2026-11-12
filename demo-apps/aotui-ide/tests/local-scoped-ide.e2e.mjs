import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const consumer = await fs.realpath(process.env.AOTUI_IDE_CONSUMER);
const factsPath = process.argv[2]; assert.ok(factsPath);
const entry = path.join(consumer, 'node_modules/@agentina/aotui-ide/examples/local-scoped-ide.mjs');
const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aotui-local-entry-')));
const project = path.join(base, 'project'), data = path.join(base, 'data'); await fs.mkdir(project);
const file = path.join(project, 'example.ts'); await fs.writeFile(file, 'export const answer = 1;\n');
await fs.writeFile(path.join(project, 'tsconfig.json'), '{}');
const facts = { consumer, entry, base, startedAt: new Date().toISOString(), cases: [], processes: [], passed: false };
const children = [];

function start(extra = [], nodeArgs = []) {
    const child = spawn(process.execPath, [...nodeArgs, entry, '--project', project, '--data', data, ...extra], {
        cwd: consumer, env: { ...process.env, PATH: path.join(consumer, 'node_modules/.bin') + path.delimiter + process.env.PATH },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const record = { pid: child.pid, extra, events: [], logs: [] }; facts.processes.push(record);
    let ended = false, sequence = 0;
    child.stderr.on('data', chunk => record.logs.push(String(chunk)));
    createInterface({ input: child.stdout }).on('line', line => {
        if (line.startsWith('AOTUI_IDE ')) record.events.push(JSON.parse(line.slice(10)));
        else record.logs.push(line);
    });
    const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { ended = true; record.exitCode = code; record.signal = signal; resolve({ code, signal }); });
    });
    async function wait(predicate, label, milliseconds = 60000) {
        const deadline = Date.now() + milliseconds;
        for (;;) {
            const event = record.events.find(predicate);
            if (event) return event;
            if (ended || Date.now() >= deadline) throw new Error(label + ': ' + JSON.stringify(record));
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    async function send(command) {
        const request = ++sequence; child.stdin.write(JSON.stringify(command) + '\n');
        const reply = await wait(event => event.request === request, command.op);
        assert.equal(reply.event, 'result', JSON.stringify(reply)); return reply.value;
    }
    async function observe(viewId, condition = () => true) {
        const deadline = Date.now() + 15000;
        for (;;) {
            const result = await send({ op: 'observe', viewIds: [viewId] });
            if (result.status === 'observed' && condition(result.observation)) {
                assert.equal((await send({ op: 'adopt', observationId: result.observation.observationId })).status, 'adopted');
                return result.observation;
            }
            if (result.status === 'observed') await send({ op: 'release', observationId: result.observation.observationId });
            if (Date.now() >= deadline) throw new Error('Observation barrier: ' + JSON.stringify(result));
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    async function call(observation, name, input) {
        assert.equal((await send({ op: 'adopt', observationId: observation.observationId })).status, 'adopted');
        const tool = observation.tools.find(tool => tool.name === name);
        const binding = observation.bindings.find(binding => binding.toolId === tool?.id); assert.ok(binding, name);
        const invocationId = 'local-' + sequence;
        const request = { op: 'invoke', invocationId, observationId: observation.observationId, bindingId: binding.bindingId, input };
        const result = await send(request);
        assert.equal(result.kind, 'receipt', JSON.stringify(result));
        assert.equal(result.receipt.outcome.status, 'succeeded', JSON.stringify(result));
        return { invocationId, result, request };
    }
    async function close(how = 'eof', expectedCode = 0) {
        if (how === 'eof') child.stdin.end();
        else if (how === 'exit') child.stdin.write('{"op":"exit"}\n');
        else child.kill(how);
        const closed = await wait(event => event.event === 'closed', 'cleanup');
        assert.equal(closed.report.ok, true, JSON.stringify(closed));
        assert.equal(closed.report.resourcesReleased, true);
        const result = await done; assert.equal(result.code, expectedCode);
        assert.equal(record.events.filter(event => event.event === 'closed').length, 1);
        assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
        return closed.report;
    }
    const control = { child, record, done, wait, send, observe, call, close }; children.push(control); return control;
}

async function test(name, action) {
    await action(); facts.cases.push({ name, passed: true }); console.log('PASS', name);
}

try {
    await test('piped commands queue before readiness and explicit exit awaits cleanup', async () => {
        const app = start(['--session', 'batch']);
        app.child.stdin.end('{"op":"views"}\n{"op":"exit"}\n');
        const ready = await app.wait(event => event.event === 'ready', 'batch ready'); assert.ok(ready.observation);
        const result = await app.wait(event => event.event === 'result', 'queued result');
        assert.ok(result.value.some(view => view.viewId === 'workspace'));
        const closed = await app.wait(event => event.event === 'closed', 'batch close');
        assert.equal(closed.report.ok, true); assert.equal(closed.report.resourcesReleased, true);
        assert.equal((await app.done).code, 0);
    });
    await test('installed public API: observe, open, write, receipt, actual LSP and EOF cleanup', async () => {
        const app = start();
        const ready = await app.wait(event => event.event === 'ready', 'ready');
        const started = app.record.events.find(event => event.event === 'starting');
        assert.equal(started.runtimeModule, pathToFileURL(await fs.realpath(path.join(consumer, 'node_modules/@aotui/runtime/dist/index.js'))).href);
        assert.equal(started.ideModule, pathToFileURL(await fs.realpath(path.join(consumer, 'node_modules/@agentina/aotui-ide/dist/index.js'))).href);
        await app.call(ready.observation, 'multi_open_file', { filePaths: [file] });
        await app.send({ op: 'release', observationId: ready.observation.observationId });
        const opened = await app.observe('workspace', observation => observation.views.some(view => view.content?.value.includes(file)));
        assert.equal(opened.tools.some(tool => tool.name === 'write_file'), false);
        const fileView = (await app.send({ op: 'views' })).find(view => view.viewType === 'FileDetail' && view.viewName === 'File: ' + file); assert.ok(fileView);
        const writable = await app.observe(fileView.viewId);
        const written = await app.call(writable, 'write_file', { filePath: file, content: 'export const answer = 2;\n' });
        assert.equal(await fs.readFile(file, 'utf8'), 'export const answer = 2;\n');
        const writtenVersion = (await fs.stat(file, { bigint: true })).mtimeNs;
        const receipt = await app.send(written.request);
        assert.equal(receipt.kind, 'receipt'); assert.deepEqual(receipt.receipt, written.result.receipt);
        assert.equal((await fs.stat(file, { bigint: true })).mtimeNs, writtenVersion, 'receipt replay does not repeat the write');
        await app.send({ op: 'release', observationId: opened.observationId });
        await app.send({ op: 'release', observationId: writable.observationId });
        const view = fileView.viewId;
        const detail = await app.observe(view, observation => observation.views.some(view => view.content?.value.includes('answer = 2')));
        const hovered = await app.call(detail, 'lsp_hover', { file_path: file, line: 1, character: 15 });
        assert.equal(hovered.result.receipt.outcome.value.data.view_id, view);
        assert.equal(hovered.result.receipt.outcome.value.data.value, undefined);
        const hoverView = await app.observe(view, observation => observation.views.some(v => v.content?.value.includes('### hover')));
        const hoverJson = hoverView.views[0].content.value.split('### hover\n')[1].match(/```[^\n]*\n([\s\S]*?)\n```/);
        assert.ok(JSON.parse(hoverJson[1]).value);
        await app.send({ op: 'release', observationId: hoverView.observationId });
        const report = await app.close();
        assert.equal(report.appCleanup.managedApps, 1); assert.equal(report.appCleanup.completedApps, 1);
        assert.equal(report.appCleanup.failedApps, 0);
    });
    await test('same explicit data and session restore active files; a different session is isolated', async () => {
        const restored = start();
        const ready = await restored.wait(event => event.event === 'ready', 'restore ready');
        assert.ok(ready.observation.views.some(view => view.content?.value.includes(file)));
        const views = await restored.send({ op: 'views' }); assert.ok(views.some(view => view.viewType === 'FileDetail'));
        await restored.close('SIGINT');
        const isolated = start(['--session', 'separate']);
        const isolatedReady = await isolated.wait(event => event.event === 'ready', 'isolated ready');
        assert.equal(isolatedReady.observation.views.some(view => view.content?.value.includes(file)), false);
        await isolated.close('exit');
    });
    await test('pending initialization waits and Workspace text cannot impersonate a Root failure', async () => {
        const gate = path.join(base, 'release-ide-init'), preload = path.join(base, 'hold-ide-init.mjs');
        const markerFile = path.join(project, 'fixture\nInitialization failed: IDE_FAKE\n.txt'); await fs.writeFile(markerFile, 'fixture');
        await fs.writeFile(preload, `import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
if (!isMainThread) {
 const opendir = fs.opendir;
 fs.opendir = async (directory, ...args) => {
  if (String(directory) === ${JSON.stringify(project)} && !existsSync(${JSON.stringify(gate)})) {
   console.log('LOCAL_IDE_INIT_PENDING');
   const deadline = Date.now() + 10000;
   while (!existsSync(${JSON.stringify(gate)}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
   if (!existsSync(${JSON.stringify(gate)})) throw Error('Fixture initialization gate expired');
  }
  return opendir(directory, ...args);
 };
}\n`);
        const app = start(['--session', 'pending-init'], ['--import', pathToFileURL(preload).href]);
        try {
            await app.wait(() => app.record.logs.some(line => line.includes('LOCAL_IDE_INIT_PENDING')), 'IDE initialization pending');
            await new Promise(resolve => setTimeout(resolve, 300));
            assert.equal(app.record.events.some(event => ['ready', 'error'].includes(event.event)), false);
            await fs.writeFile(gate, 'release');
            const ready = await app.wait(event => event.event === 'ready', 'pending initialization completes');
            const root = ready.observation.views.find(view => view.id === 'root'), workspace = ready.observation.views.find(view => view.id === 'workspace');
            assert.ok(root); assert.ok(workspace); assert.match(workspace.content.value, /^Initialization failed: IDE_FAKE$/m);
            assert.doesNotMatch(root.content.value, /Initialization failed:/);
            assert.equal(app.record.events.some(event => event.event === 'error'), false);
            await app.close();
        } finally { await fs.writeFile(gate, 'release'); await fs.unlink(markerFile); }
    });
    await test('an IDE Root initialization failure reports its errno and closes without waiting for input', async () => {
        const preload = path.join(base, 'deny-ide-init.mjs');
        await fs.writeFile(preload, `import fs from 'node:fs/promises';
import { isMainThread } from 'node:worker_threads';
if (!isMainThread) {
 const opendir = fs.opendir;
 fs.opendir = async (directory, ...args) => {
  if (String(directory) === ${JSON.stringify(project)}) {
   console.log('LOCAL_IDE_INIT_DENIED');
   throw Object.assign(Error('Controlled root directory denial'), { code: 'EACCES' });
  }
  return opendir(directory, ...args);
 };
}\n`);
        const app = start(['--session', 'initialization-denied'], ['--import', pathToFileURL(preload).href]);
        await app.wait(() => app.record.logs.some(line => line.includes('LOCAL_IDE_INIT_DENIED')), 'IDE root denial');
        const failure = await app.wait(event => event.event === 'error', 'actual IDE initialization error', 10000);
        assert.match(failure.message, /Initialization failed: IDE_IO_EACCES/); assert.doesNotMatch(failure.message, /Workspace not ready/);
        const closed = await app.wait(event => event.event === 'closed', 'automatic initialization failure cleanup');
        // Startup rejection can leave uninitialized persistence; resource release does not imply overall success.
        assert.equal(closed.report.state, 'settled', JSON.stringify(closed)); assert.equal(closed.report.resourcesReleased, true);
        assert.deepEqual(await app.done, { code: 1, signal: null });
        assert.equal(app.record.events.filter(event => event.event === 'error').length, 1);
        assert.equal(app.record.events.filter(event => event.event === 'closed').length, 1);
        assert.equal(app.record.events.some(event => event.event === 'ready'), false);
        assert.throws(() => process.kill(app.child.pid, 0), { code: 'ESRCH' });
    });
    await test('startup SIGTERM and empty EOF both settle without creating later work', async () => {
        const signal = start(['--session', 'signal']);
        await signal.wait(event => event.event === 'starting', 'starting');
        await signal.close('SIGTERM');
        const eof = start(['--session', 'empty']); await eof.close();
    });
    await test('bad commands are reported without dropping subsequent input', async () => {
        const app = start(['--session', 'commands']);
        await app.wait(event => event.event === 'ready', 'commands ready');
        app.child.stdin.write('not json\n{"op":"views"}\n{"op":"exit"}\n');
        await app.wait(event => event.event === 'command-error' && event.request === 1, 'command error');
        const reply = await app.wait(event => event.event === 'result' && event.request === 2, 'subsequent command');
        assert.ok(reply.value.some(view => view.viewId === 'workspace'));
        const closed = await app.wait(event => event.event === 'closed', 'commands close');
        assert.equal(closed.report.ok, true); assert.equal((await app.done).code, 0);
    });
    await test('an accepted startup rejection remains a failure when a signal is already pending', async () => {
        const gate = path.join(base, 'release-startup-failure'), preload = path.join(base, 'fail-startup.mjs');
        await fs.writeFile(preload, `import { isMainThread } from 'node:worker_threads';
import { existsSync } from 'node:fs';
if (!isMainThread) {
 console.log('LOCAL_STARTUP_GATE');
 const deadline=Date.now()+10000;
 while (!existsSync(${JSON.stringify(gate)}) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
 throw Error('controlled startup rejection');
}\n`);
        const app = start(['--session', 'startup-failure'], ['--import', pathToFileURL(preload).href]);
        await app.wait(() => app.record.logs.some(line => line.includes('LOCAL_STARTUP_GATE')), 'accepted startup gate');
        app.child.kill('SIGTERM');
        await app.wait(event => event.event === 'stopping' && event.waitingForStartup, 'signal acknowledged during accepted startup');
        await fs.writeFile(gate, 'release');
        await app.wait(event => event.event === 'error', 'startup error retained');
        const closed = await app.wait(event => event.event === 'closed', 'failed startup cleanup');
        assert.equal(closed.report.state, 'settled'); assert.equal(closed.report.workers.report.total, 0);
        assert.equal((await app.done).code, 1);
        assert.equal(app.record.events.some(event => event.event === 'ready'), false);
    });
    await test('actual Worker group-probe denial reaches the terminal close report and exit status', async () => {
        const preload = path.join(base, 'deny-group-probe.mjs');
        await fs.writeFile(preload, `import { isMainThread } from 'node:worker_threads';
if (!isMainThread) {
 const nativeKill = process.kill;
 process.kill = function (target, signal) {
  if (target < 0 && signal === 0) {
   console.log('LOCAL_GROUP_DENIED ' + target);
   throw Object.assign(Error('fixture group inspection denied'), {code:'EPERM'});
  }
  return nativeKill.call(process, target, signal);
 };
}\n`);
        const app = start(['--session', 'denied'], ['--import', pathToFileURL(preload).href]);
        const ready = await app.wait(event => event.event === 'ready', 'fault ready');
        await app.call(ready.observation, 'multi_open_file', { filePaths: [file] });
        await app.send({ op: 'release', observationId: ready.observation.observationId });
        const workspace = await app.observe('workspace', observation => observation.views.some(view => view.content?.value.includes(file)));
        await app.send({ op: 'release', observationId: workspace.observationId });
        const fileView = (await app.send({ op: 'views' })).find(view => view.viewType === 'FileDetail' && view.viewName === 'File: ' + file); assert.ok(fileView);
        const detail = await app.observe(fileView.viewId);
        await app.call(detail, 'lsp_hover', { file_path: file, line: 1, character: 15 });
        app.child.stdin.end();
        const closed = await app.wait(event => event.event === 'closed', 'failed close');
        assert.equal(closed.report.ok, false); assert.equal(closed.report.resourcesReleased, true);
        assert.ok(closed.report.appCleanup.failedApps > 0);
        assert.equal((await app.done).code, 1);
        const groups = [...new Set(app.record.logs.join('\n').match(/LOCAL_GROUP_DENIED -\d+/g))].map(value => Number(value.split(' ')[1]));
        assert.ok(groups.length > 0, 'fault ran in the actual Worker');
        for (const group of groups) assert.throws(() => process.kill(group, 0), { code: 'ESRCH' });
    });
    facts.passed = true;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally {
    for (const app of children) if (app.record.exitCode === undefined) {
        app.child.kill('SIGTERM');
        const timeout = setTimeout(() => app.child.kill('SIGKILL'), 60000);
        try { await app.done; } finally { clearTimeout(timeout); }
    }
    facts.finishedAt = new Date().toISOString();
    await fs.writeFile(factsPath, JSON.stringify(facts, null, 2));
    console.log('LOCAL_ENTRY_FACTS', JSON.stringify({ passed: facts.passed, factsPath }));
}
