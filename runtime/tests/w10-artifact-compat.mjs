import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile), [consumer, archivedPack, factsFile] = process.argv.slice(2);
assert.ok(consumer && archivedPack && factsFile);
const facts = { consumer, archivedPack, startedAt: new Date().toISOString(), cases: [], artifacts: [], passed: false }, running = [];
const compatibility = path.join(consumer, 'compat-' + path.basename(factsFile, '.json')), oldModules = path.join(compatibility, 'd5/node_modules');
await fs.mkdir(path.join(oldModules, '@aotui'), { recursive: true });
const newRuntime = path.join(consumer, 'node_modules/@aotui/runtime'), oldRuntime = path.join(oldModules, '@aotui/runtime');
const expected = { runtime: 'd32af6d42dc390543beb4b8d1fc89abdc5048e48826d9285d77371f231b1dc5a', sdk: 'bdb410d22a2c3553418c60c447f3438959d51733287c33abdd634abdd0f0915d' };
async function eventually(read, label) { const end = Date.now() + 15000; for (;;) { const value = read(); if (value) return value; if (Date.now() > end) throw Error('Barrier: ' + label); await new Promise(r => setTimeout(r, 20)); } }
async function start(name, workerRoot, app, modes = ['ordinary-v1', 'ordinary-v2'], readOnly = true) {
    const worker = new Worker(path.join(workerRoot, 'dist/worker-runtime/index.js'), { stdout: true, stderr: true });
    const messages = [], sent = [], logs = [];
    worker.on('message', message => messages.push(message));
    for (const stream of [worker.stdout, worker.stderr]) stream.on('data', chunk => { logs.push(String(chunk)); if (logs.length > 40) logs.shift(); });
    const post = worker.postMessage.bind(worker); worker.postMessage = (message, ...rest) => { sent.push(message); return post(message, ...rest); };
    const Host = (await import(pathToFileURL(path.join(newRuntime, 'dist/engine/app/worker-host.js')))).AppWorkerHost;
    const host = new Host({ appId: name, desktopId: 'compat', appModulePath: pathToFileURL(app).href, existingWorker: worker,
        snapshotShadow: true, experimentalReadOnlyViewTools: readOnly, experimentalInteractionModes: modes, timeout: 10000,
        config: { AOTUI_DATA_DIR: path.join(compatibility, 'data', name) } });
    const x = { name, worker, host, messages, sent, logs, closed: false }; running.push(x);
    await host.start(); assert.equal(messages.find(m => m.type === 'INIT_RESPONSE')?.success, true, 'Record real INIT before start');
    return x;
}
function scope(x) {
    const opened = x.host.createInteractionScope({ project: ({ source, selection }) => {
        const ids = new Set(selection.viewIds); return {
            views: source.views.filter(v => ids.has(v.id)).map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
            refs: Object.values(source.refs).filter(r => ids.has(r.ownerViewId)).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
            targets: Object.values(source.tools).flatMap(t => t.targets.filter(v => ids.has(v.viewId)).map(target => ({ toolId: t.id, target }))), content: [] };
    }, authorize: () => true, canReadReceipt: () => true });
    assert.equal(opened.status, 'opened', JSON.stringify(opened)); return opened.client;
}
let invocation = 0;
async function call(client, observation, name, input = {}) {
    const tool = observation.tools.find(t => t.name === name), binding = observation.bindings.find(b => b.toolId === tool?.id);
    assert.ok(binding); return client.invoke({ invocationId: 'compat-' + ++invocation, observationId: observation.observationId,
        bindingId: binding.bindingId, input });
}
async function counts(x, tag = x.name) {
    x.worker.postMessage({ type: 'COMPAT_INSPECT', tag });
    return eventually(() => x.messages.find(m => m.type === 'COMPAT_COUNTS' && m.tag === tag), 'actual handler counters');
}
async function stop(x) {
    try { await x.host.close(); } catch (error) { x.closeError = { code: error.code, message: error.message }; }
    x.host.terminate(); const report = await x.host.waitForResourceRelease(); assert.equal(x.worker.threadId, -1); x.closed = true;
    return { report, closeError: x.closeError, physicalWorkerExited: true };
}
try {
    for (const name of ['runtime', 'sdk']) {
        const archive = path.join(archivedPack, `aotui-${name}-${name === 'runtime' ? '2.0.0' : '0.2.0'}.tgz`), bytes = await fs.readFile(archive);
        const hash = createHash('sha256').update(bytes).digest('hex'); assert.equal(hash, expected[name]);
        const destination = path.join(oldModules, '@aotui', name); await fs.mkdir(destination);
        await execute('tar', ['-xzf', archive, '--strip-components', '1', '-C', destination]);
        const metadata = JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8'));
        facts.artifacts.push({ name: metadata.name, version: metadata.version, archive, sha256: hash, destination, originalMetadata: true });
    }
    const oldFixture = path.join(compatibility, 'd5/old-app.mjs');
    await fs.writeFile(oldFixture, `import {h} from 'preact';import {parentPort} from 'node:worker_threads';
import {createTUIApp,View,useViewTypeTool,useEntityRef} from '@aotui/sdk';let reads=0,writes=0;
parentPort.on('message',m=>{if(m.type==='COMPAT_INSPECT')parentPort.postMessage({type:'COMPAT_COUNTS',tag:m.tag,reads,writes});});
function Detail(){const entity=useEntityRef('state',{entityType:'Counter',entityId:'one',entityVersion:'1'});
useViewTypeTool('read',{description:'Read old SDK control',params:{},isMutating:false},async()=>{reads++;parentPort.postMessage({type:'OLD_READ_ENTERED',reads});return {success:true,data:{value:'old-ok'}};});
useViewTypeTool('legacy_write',{description:'Legacy mutating tool',params:{},isMutating:true},async()=>{writes++;parentPort.postMessage({type:'OLD_WRITE_ENTERED',writes});return {success:true};});
return h('p',{},entity('Counter'));}export default createTUIApp({app_name:'old_compat',component:()=>h(View,{id:'detail',type:'Detail'},h(Detail,{}))});
`);
    const newFixture = path.join(compatibility, 'new-app.mjs');
    await fs.writeFile(newFixture, `import {h} from 'preact';import {parentPort} from 'node:worker_threads';
import {createTUIApp,View,experimental_useAppLifecycle} from '@aotui/sdk';
function Root(){parentPort.postMessage({type:'NEW_ROOT_ENTERED'});experimental_useAppLifecycle({stop(){parentPort.postMessage({type:'NEW_STOP'});},close(){parentPort.postMessage({type:'NEW_CLOSE'});}});return h(View,{id:'root',type:'Root'},h('p',{},'Managed compatibility control'));}
const factory=createTUIApp({app_name:'new_compat',experimentalAppLifecycle:true,component:Root}),initialize=factory.initializeComponent;
factory.initializeComponent=async(...args)=>{parentPort.postMessage({type:'COMPAT_PORT',missing:args[1].appLifecycle===undefined});try{return await initialize(...args);}catch(error){parentPort.postMessage({type:'COMPAT_INIT_ERROR',message:error.message});throw error;}};export default factory;
`);
    const mutationFixture = path.join(compatibility, 'new-mutation-app.mjs');
    await fs.writeFile(mutationFixture, `import {h} from 'preact';import {parentPort} from 'node:worker_threads';
import {createTUIApp,View,useViewTypeTool} from '@aotui/sdk';let writes=0,value=0;
parentPort.on('message',m=>{if(m.type==='COMPAT_INSPECT')parentPort.postMessage({type:'COMPAT_COUNTS',tag:m.tag,writes,value});});
function Detail(){const [Tool]=useViewTypeTool('increment',{description:'Generic asynchronous mutation',params:{amount:{type:'number',required:true}}},async args=>{writes++;await Promise.resolve();value+=args.amount;parentPort.postMessage({type:'NEW_WRITE_ENTERED',writes,value});return {success:true,data:{value}};});return h(Tool,{},'Increment');}
const factory=createTUIApp({app_name:'mutation_compat',component:()=>h(View,{id:'detail',type:'Detail'},h(Detail,{}))}),initialize=factory.initializeComponent;
factory.initializeComponent=async(container,context)=>{const port=context.viewTools;try{return await initialize(container,{...context,viewTools:{...port,registerTool(...args){parentPort.postMessage({type:'NEW_MUTATION_REGISTRATION',isMutating:args[2].isMutating,mode:args[3]?.safeOrdinaryParametersInvocationMode});try{return port.registerTool(...args);}catch(error){parentPort.postMessage({type:'NEW_MUTATION_REGISTRATION_FAILED',message:error.message});throw error;}}}});}catch(error){parentPort.postMessage({type:'COMPAT_INIT_ERROR',message:error.message});throw error;}};export default factory;
`);
    const OldHost = (await import(pathToFileURL(path.join(oldRuntime, 'dist/engine/app/worker-host.js')))).AppWorkerHost;
    assert.throws(() => new OldHost({ appId: 'oldhost', desktopId: 'compat', appModulePath: pathToFileURL(oldFixture).href,
        snapshotShadow: true, experimentalInteractionModes: ['versioned-entity-v1'] }), { code: 'INTERACTION_MODES_INVALID' });
    facts.cases.push({ name: 'Original D5 Host rejects the removed entity-only configuration before Worker start', errorCode: 'INTERACTION_MODES_INVALID', workersStarted: 0, passed: true });
    const oldCore = await import(pathToFileURL(path.join(oldRuntime, 'dist/core/index.js')));
    const registry = oldCore.createViewOwnedTools('registry-control', 'd5'), view = registry.mount('detail', 'Detail');
    const compiled = oldCore.compileOrdinaryParams({ amount: { type: 'number', required: true } }, { additionalProperties: false }); assert.equal(compiled.ok, true);
    const spec = { name: 'increment', description: 'Generic mutation', inputSchema: oldCore.ordinaryParameterProfile(compiled.contract), isMutating: true };
    let genericEntries = 0, safeEntries = 0;
    const generic = async () => { genericEntries++; return { success: true }; }, safe = async () => { safeEntries++; return { phase: 'entered-returned', result: { success: true } }; };
    assert.throws(() => registry.registerTool(view.viewInstanceId, spec, generic, true, { safeOrdinaryParametersInvocationMode: 'ordinary-v2' }, safe), { code: 'TOOL_INVALID' });
    assert.deepEqual([genericEntries, safeEntries, registry.listTools().length], [0, 0, 0]);
    registry.registerTool(view.viewInstanceId, { ...spec, isMutating: false }, generic, true, { safeOrdinaryParametersInvocationMode: 'ordinary-v2' }, safe);
    const oldTool = registry.listTools()[0]; assert.equal((await registry.invokeOrdinaryParameters(oldTool, oldTool.targets[0], { amount: 1 })).result.success, true);
    assert.deepEqual([genericEntries, safeEntries], [0, 1]); registry.dispose();
    facts.cases.push({ name: 'Actual D5 registry refuses ordinary mutation before handler entry and still executes a read-only control', passed: true, mutationEntries: 0, readonlyEntries: safeEntries, errorCode: 'TOOL_INVALID' });
    for (const [name, workerRoot] of [['new-host-old-worker-old-sdk', oldRuntime], ['new-host-new-worker-old-sdk', newRuntime]]) {
        const x = await start(name, workerRoot, oldFixture); await x.host.open();
        await eventually(() => x.messages.some(m => m.type === 'SNAPSHOT_PREPARED' && Object.values(m.draft.tools).some(t => t.name === 'read')), 'old fixture ready');
        const ack = x.messages.find(m => m.type === 'INIT_RESPONSE'); assert.ok(ack.acceptedCapabilities.includes('view-tool-ordinary-invoke/v1'));
        assert.ok(ack.acceptedCapabilities.includes('view-tool-ordinary-invoke/v2'));
        assert.equal(ack.acceptedCapabilities.includes('view-tool-entity-invoke/v1'), false);
        const client = scope(x), observed = await client.observe({ viewIds: ['detail'] }); assert.equal(observed.status, 'observed');
        const read = await call(client, observed.observation, 'read'); assert.equal(read.kind, 'receipt'); assert.equal(read.receipt.outcome.status, 'succeeded');
        await eventually(() => x.messages.some(m => m.type === 'OLD_READ_ENTERED'), 'real old read handler');
        const write = await call(client, observed.observation, 'legacy_write'); assert.equal(write.kind, 'receipt'); assert.equal(write.receipt.outcome.status, 'rejected');
        assert.equal(x.sent.filter(m => m.type === 'VIEW_TOOL_INVOKE_ORDINARY_V2').length, 0, 'An old unqualified mutator must not be upgraded to the ordinary channel');
        assert.equal(x.sent.filter(m => m.type === 'VIEW_TOOL_INVOKE_ENTITY_V1').length, 0);
        const actualCounts = await counts(x); assert.deepEqual([actualCounts.reads, actualCounts.writes], [1, 0]);
        client.close(); const cleanup = await stop(x); assert.equal(cleanup.report.appCleanup?.support, 'legacy-unverified');
        facts.cases.push({ name, passed: true, init: ack, read, write, counts: actualCounts, refusalLayer: 'Host execution binding; no mutation IPC and no claim about Worker private guard', cleanup });
    }
    const oldMutation = await start('new-sdk-mutation-old-worker', oldRuntime, mutationFixture, ['ordinary-v2'], false);
    await assert.rejects(oldMutation.host.open());
    const declaration = await eventually(() => oldMutation.messages.find(m => m.type === 'NEW_MUTATION_REGISTRATION'), 'new Hook registration');
    assert.deepEqual({ isMutating: declaration.isMutating, mode: declaration.mode }, { isMutating: true, mode: 'ordinary-v2' });
    const rejectedDeclaration = await eventually(() => oldMutation.messages.find(m => m.type === 'NEW_MUTATION_REGISTRATION_FAILED'), 'D5 registration refusal');
    assert.match(rejectedDeclaration.message, /ordinary-v2/);
    const rejectedCounts = await counts(oldMutation); assert.deepEqual([rejectedCounts.writes, rejectedCounts.value], [0, 0]);
    assert.equal(oldMutation.messages.filter(m => m.type === 'NEW_WRITE_ENTERED').length, 0);
    facts.cases.push({ name: 'New SDK generic mutation is explicitly refused by the actual D5 Worker registry before handler entry', passed: true,
        init: oldMutation.messages.find(m => m.type === 'INIT_RESPONSE'), declaration, refusal: rejectedDeclaration, counts: rejectedCounts, cleanup: await stop(oldMutation) });
    const newMutation = await start('new-sdk-mutation-new-worker', newRuntime, mutationFixture, ['ordinary-v2'], false); await newMutation.host.open();
    await eventually(() => newMutation.messages.some(m => m.type === 'SNAPSHOT_PREPARED' && Object.values(m.draft.tools).some(t => t.name === 'increment')), 'ordinary mutation snapshot');
    const mutationClient = scope(newMutation), mutationObserved = await mutationClient.observe({ viewIds: ['detail'] }); assert.equal(mutationObserved.status, 'observed');
    assert.equal(mutationObserved.observation.tools.find(t => t.name === 'increment')?.isMutating, true);
    const changed = await call(mutationClient, mutationObserved.observation, 'increment', { amount: 2 }); assert.equal(changed.kind, 'receipt');
    assert.equal(changed.receipt.outcome.status, 'succeeded', JSON.stringify(changed)); assert.equal(changed.receipt.outcome.value.data.value, 2);
    const changedCounts = await counts(newMutation); assert.deepEqual([changedCounts.writes, changedCounts.value], [1, 2]);
    const mutationMessages = newMutation.sent.filter(m => m.type === 'VIEW_TOOL_INVOKE_ORDINARY_V2'); assert.equal(mutationMessages.length, 1);
    assert.equal(mutationMessages[0].tool.isMutating, true); assert.equal(Object.hasOwn(mutationMessages[0], 'resource'), false);
    mutationClient.close();
    facts.cases.push({ name: 'New SDK generic mutation uses the actual existing ordinary-v2 Worker channel without a read-only flag or entity Ref', passed: true,
        changed, counts: changedCounts, sent: mutationMessages, cleanup: await stop(newMutation) });
    const refused = await start('new-sdk-old-worker', oldRuntime, newFixture, []);
    await assert.rejects(refused.host.open());
    assert.equal((await eventually(() => refused.messages.find(m => m.type === 'COMPAT_PORT'), 'factory port')).missing, true);
    assert.equal((await eventually(() => refused.messages.find(m => m.type === 'COMPAT_INIT_ERROR'), 'factory failure')).message, 'APP_LIFECYCLE_UNSUPPORTED');
    assert.equal(refused.messages.filter(m => m.type === 'NEW_ROOT_ENTERED').length, 0);
    facts.cases.push({ name: 'new SDK opt-in factory refuses old Worker before component render', passed: true,
        evidence: refused.messages.filter(m => m.type.startsWith('COMPAT_')), cleanup: await stop(refused) });
    const accepted = await start('new-sdk-new-worker', newRuntime, newFixture, []); await accepted.host.open();
    await eventually(() => accepted.messages.some(m => m.type === 'NEW_ROOT_ENTERED'), 'new fixture positive control');
    const cleanup = await stop(accepted); assert.equal(cleanup.report.appCleanup?.support, 'managed'); assert.equal(cleanup.report.appCleanup?.report.protocol, 'app-lifecycle-v2');assert.equal(cleanup.report.appCleanup?.report.state, 'completed');
    assert.ok(accepted.messages.some(m => m.type === 'NEW_STOP')); assert.ok(accepted.messages.some(m => m.type === 'NEW_CLOSE'));
    facts.cases.push({ name: 'new SDK factory positive control with new Worker and actual lifecycle owner', passed: true, cleanup });
    facts.passed = true;
} catch (error) { facts.failure = { message: String(error), stack: error.stack }; console.error(error); process.exitCode = 1; }
finally {
    for (const x of running) if (!x.closed) await stop(x).catch(error => { facts.cleanupFailure = String(error); });
    facts.protocolTraces = running.map(x => ({ name: x.name, sent: x.sent, received: x.messages, logs: x.logs }));
    facts.finishedAt = new Date().toISOString(); await fs.writeFile(factsFile, JSON.stringify(facts, null, 2));
    console.log('ARTIFACT_COMPAT_FACTS', JSON.stringify({ passed: facts.passed, cases: facts.cases.length, factsFile }));
}
