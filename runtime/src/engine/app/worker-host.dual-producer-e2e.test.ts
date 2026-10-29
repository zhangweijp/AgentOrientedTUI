import { afterAll, beforeAll, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createSnapshotCore, createViewOwnedTools, createScopedInteraction, compileOrdinaryParams,
    ordinaryParameterProfile, compileSnapshotValueParams, refKey } from '../../core/index.js';
import { initialBusiness, applyBusiness, businessResult, ordinaryParams, refParams, description,
    expectedRead, businessSequence } from '../../../tests/fixtures/dual-producer-business.mjs';

const defer = () => { let resolve!: (value?: any) => void;const promise = new Promise<any>(yes => { resolve = yes; });return { promise, resolve }; };
let consumer: string, Host: any, actorCount = 0;
const evidence: any[] = [];
const grant = ({ source, selection }: any) => ({
    views: source.views.filter((v: any) => selection.viewIds.includes(v.id)).map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
    refs: Object.values(source.refs).filter((r: any) => selection.viewIds.includes(r.ownerViewId)).map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
    targets: Object.values(source.tools).flatMap((t: any) => t.targets.filter((target: any) => selection.viewIds.includes(target.viewId)).map((target: any) => ({ toolId: t.id, target }))), content: [] });
function policy() {
    const calls = { project: 0, authorize: 0, read: 0 };
    const control = { project: (ctx: any): any => grant(ctx), authorize: (_ctx: any): any => true };
    return { calls, control, policy: { project: (ctx: any) => { calls.project++;return control.project(ctx); },
        authorize: (ctx: any) => { calls.authorize++;return control.authorize(ctx); }, canReadReceipt: () => { calls.read++;return true; } } };
}
async function capture(path: string, body: string) {
    await writeFile(path, body);const root = process.env.AOTUI_W08_C1_FACTS_DIR;
    if (root) { const hash = createHash('sha256').update(body).digest('hex');await mkdir(join(root, 'c-inputs'), { recursive: true });
        await writeFile(join(root, 'c-inputs', hash), body);await writeFile(join(root, 'c-inputs', hash + '.json'), JSON.stringify({ path, sha256: hash, capturedBeforeExecution: true })); }
}
beforeAll(async () => {
    const repo = resolve(process.cwd(), '..');consumer = await mkdtemp(join(tmpdir(), 'aotui-c-dual-'));const modules = join(consumer, 'node_modules');await mkdir(join(modules, '@aotui'), { recursive: true });
    const artifacts = process.env.AOTUI_C_PRODUCER_ARTIFACTS;
    for (const pkg of ['runtime', 'sdk']) {
        const target = join(modules, '@aotui', pkg);await mkdir(target);await cp(join(repo, pkg, 'package.json'), join(target, 'package.json'));
        await cp(join(artifacts || repo, pkg, 'dist'), join(target, 'dist'), { recursive: true });
    }
    for (const pkg of ['runtime', 'sdk']) for (const entry of await readdir(join(repo, pkg, 'node_modules'))) {
        if (entry.startsWith('.') || entry === '@aotui') continue;
        try { await symlink(join(repo, pkg, 'node_modules', entry), join(modules, entry), 'dir'); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    }
    for (const entry of await readdir(join(repo, 'runtime/node_modules/@aotui'))) if (!['runtime', 'sdk'].includes(entry))
        await symlink(join(repo, 'runtime/node_modules/@aotui', entry), join(modules, '@aotui', entry), 'dir');
    for (const file of ['dual-producer-app.mjs', 'dual-producer-business.mjs']) await capture(join(consumer, file), await readFile(join(repo, 'runtime/tests/fixtures', file), 'utf8'));
    Host = (await import(pathToFileURL(join(modules, '@aotui/runtime/dist/engine/app/worker-host.js')).href)).AppWorkerHost;
    evidence.push({ internalProducerTest: true, actualDistCopies: true, actualSdkApp: true, completePackageInstallClaimed: false, artifacts: artifacts || repo });
}, 20000);
afterAll(async () => { const root = process.env.AOTUI_W08_C1_FACTS_DIR;if (root) { await mkdir(root, { recursive: true });await writeFile(join(root, 'c-dual-producer.json'), JSON.stringify(evidence, null, 2)); }if (consumer) await rm(consumer, { recursive: true, force: true }); });

function plainActor() {
    const instance = 'plain-' + ++actorCount, core = createSnapshotCore(), registry = createViewOwnedTools('app', instance);
    core.lifecycle.startApp('app', instance);const authority = createScopedInteraction(core.store, { namespace: instance, now: Date.now });
    let state = initialBusiness(), seq = 0;const mounted = new Map<string, any>(), calls: any[] = [], facts: any[] = [], p = policy();
    let lost: ReturnType<typeof defer> | undefined, entered: ReturnType<typeof defer> | undefined;
    const ordinary = compileOrdinaryParams(ordinaryParams, { additionalProperties: false }), reference = compileSnapshotValueParams(refParams, { additionalProperties: false });
    if (!ordinary.ok || !reference.ok) throw Error('business declaration');
    function register(id: string, view: any) {
        view.releases = [];
        for (const [name, contract, inputSchema, options] of [
            ['read', ordinary.contract, ordinaryParameterProfile(ordinary.contract), { safeOrdinaryParametersInvocationMode: 'ordinary-v2' }],
            ['read_ref', reference.contract, reference.contract.schema, { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' }],
        ] as const) {
            const handler = async (args: any) => { calls.push({ viewId: id, args });return businessResult(id, args); };
            const invoker = async (args: any) => { const valid = name === 'read' ? ordinary.contract.validate(args) : reference.contract.validateEffective(args);
                return valid.ok ? { phase: 'entered-returned' as const, result: await handler(valid.value) } : { phase: 'not-entered' as const, result: { success: false, error: { code: 'E_INVALID_ARGS', message: 'Input invalid' } } }; };
            view.releases.push(registry.registerTool(view.viewInstanceId, { name, description, inputSchema, isMutating: false }, handler, state.enabled[id], options, invoker));
        }
    }
    function publish() {
        const refs: any = {};
        for (const id of state.order) { const view = mounted.get(id);for (const [name, text] of [['file', state.values[id]], ['private-' + id, 'private-' + id]]) refs[refKey(id, view.viewInstanceId, name)] = {
            id: name, ownerViewId: id, ownerViewInstanceId: view.viewInstanceId, refType: 'unknown', target: { kind: 'snapshot-value', payload: { text } } }; }
        const tools = Object.fromEntries(registry.listTools().map(tool => [tool.id, { id: tool.id, name: tool.name, viewType: tool.viewType, description: tool.description,
            inputSchema: tool.inputSchema, isMutating: tool.isMutating, targets: tool.targets }]));
        const n = ++seq, result = core.committer.accept({ schemaVersion: 2, appId: 'app', instanceId: instance, producerSeq: n, sourceEpoch: n, capturedAt: Date.now(),
            views: state.order.map(id => ({ id, viewInstanceId: mounted.get(id).viewInstanceId, type: 'File', name: id, kind: 'state', content: { format: 'markdown-v1', value: id + ' stable File value' } })), refs, tools });
        expect(['published', 'unchanged']).toContain(result.status);return snapshot();
    }
    const snapshot = () => { const result = core.store.readLatest('app');if (result.status !== 'ready') throw Error(result.status);return result.snapshot; };
    const bindings = new WeakMap<object, any>();
    const opened = authority.createScope({ appId: 'app', instanceId: instance, policy: p.policy, execution: { resolve(source: any) {
        let binding = bindings.get(source);if (binding) return binding;
        const tool = { ...source.tool, appId: source.appId, appInstanceId: source.instanceId };
        const isRef = source.tool.name === 'read_ref';binding = { identity: {}, mode: isRef ? 'snapshot-value-v1' : 'ordinary',
            validateInput: (_source: any, args: any) => { const r = isRef ? reference.contract.validateEffective(args) : ordinary.contract.validate(args);return r.ok ? { ok: true, value: r.value } : { ok: false }; },
            isLive: () => ({ ok: registry.validate(tool, source.target).success }), execute: async (context: any) => {
                const terminal = await (isRef ? registry.invokeSnapshotValueParameters(tool, source.target, context.effectiveInput) : registry.invokeOrdinaryParameters(tool, source.target, context.effectiveInput));
                if (lost) { entered!.resolve();await lost.promise;const fact = { kind: 'unknown' };facts.push(fact);return fact; }
                const fact = { kind: 'operation-result', phase: terminal.phase, result: terminal.result };facts.push(fact);return fact;
            } };bindings.set(source, binding);return binding;
    } } });if (opened.status !== 'opened') throw Error(opened.issue.code);publish();
    return { kind: 'plain', client: opened.client, ...p, policyCalls: p.calls, calls, facts, snapshot, stats: () => authority.inspect(),
        async change(command: any) {
            const previous = state;state = applyBusiness(state, command);
            for (const [id, view] of mounted) if (!state.order.includes(id)) { registry.unmount(view.viewInstanceId);mounted.delete(id); }
            for (const id of state.order) { let view = mounted.get(id);
                if (!view) { view = { ...registry.mount(id, 'File') };mounted.set(id, view);register(id, view); }
                else if (state.registrations[id] !== previous.registrations[id] || state.enabled[id] !== previous.enabled[id]) { for (const release of view.releases) release();register(id, view); }
            }
            return publish();
        },
        loseTerminal() { lost = defer();entered = defer();return { entered: entered.promise, disconnect() { authority.close();lost!.resolve(); } }; },
        reinitialize() { authority.close();registry.dispose();core.lifecycle.startApp('app', instance + '-next');return Promise.resolve(); },
        close() { authority.close();registry.dispose();core.lifecycle.dispose();return authority.whenClosed(); },
        async finish() { authority.close();lost?.resolve();await authority.whenClosed();registry.dispose();core.lifecycle.dispose();expect(authority.inspect().combinedBytes).toBe(0);expect(core.store.inspect().activeLeases).toBe(0); },
    };
}

async function workerActor() {
    const worker = new Worker(join(consumer, 'node_modules/@aotui/runtime/dist/worker-runtime/index.js'), { stdout: true, stderr: true });
    const messages: any[] = [], calls: any[] = [], facts: any[] = [], logs: string[] = [], p = policy();
    worker.stdout!.on('data', b => logs.push(String(b)));worker.stderr!.on('data', b => logs.push(String(b)));
    worker.on('error', error => logs.push(String(error.stack)));
    worker.on('message', m => { messages.push(m);if (m.type === 'DUAL_HANDLER_ENTER') calls.push(m); });
    function wait(predicate: (m: any) => boolean, from = 0): Promise<any> {
        const existing = messages.slice(from).find(predicate);if (existing) return Promise.resolve(existing);
        return new Promise((yes, no) => { const timer = setTimeout(() => { worker.off('message', receive);no(Error('Worker barrier deadline: ' + logs.join(''))); }, 8000);
            const receive = (m: any) => { if (predicate(m)) { clearTimeout(timer);worker.off('message', receive);yes(m); } };worker.on('message', receive); });
    }
    const host = new Host({ appId: 'app', desktopId: 'd', appModulePath: join(consumer, 'dual-producer-app.mjs'), existingWorker: worker,
        timeout: 2000, snapshotShadow: true, experimentalReadOnlyViewTools: true, experimentalInteractionModes: ['ordinary-v2', 'snapshot-value-v2'],
        config: { AOTUI_DATA_DIR: join(consumer, 'data-' + ++actorCount) } });
    const unknown = host.unknownRef.bind(host);host.unknownRef = (...args: any[]) => { const fact = unknown(...args);facts.push(fact);return fact; };
    let opened: any;
    try {
        await host.start();await host.open();const first = await wait(m => m.type === 'SNAPSHOT_PREPARED' || m.type === 'SNAPSHOT_PREPARE_FAILED');
        expect(first.type).toBe('SNAPSHOT_PREPARED');expect(first.draft.schemaVersion).toBe(2);
        opened = host.createInteractionScope(p.policy);expect(opened.status).toBe('opened');if (opened.status !== 'opened') throw Error(opened.issue.code);
    } catch (error) { evidence.push({ initializationFailed: true, logs, messages });host.terminate();await host.waitForResourceRelease();throw error; }
    let state = initialBusiness(), lastEpoch = -1;
    const snapshot = () => { const result = host.shadowReceiver.core.store.readLatest('app');if (result.status !== 'ready') throw Error(result.status);return result.snapshot; };
    return { kind: 'sdk-worker', client: opened.client, ...p, policyCalls: p.calls, calls, facts, snapshot, stats: () => host.getInteractionReport().core,
        async change(command: any) {
            const from = messages.length;state = applyBusiness(state, command);worker.postMessage({ type: 'DUAL_CONTROL', command });
            const commit = await wait(m => m.type === 'DUAL_COMMITTED' && m.sequence === state.sequence, from);
            expect(commit.projectionEpoch).toBeGreaterThan(lastEpoch);lastEpoch = commit.projectionEpoch;
            const frame = await wait(m => (m.type === 'SNAPSHOT_PREPARED' && m.draft.sourceEpoch >= commit.projectionEpoch) ||
                (m.type === 'SNAPSHOT_PREPARE_FAILED' && m.sourceEpoch >= commit.projectionEpoch), from);
            expect(frame.type).toBe('SNAPSHOT_PREPARED');expect(frame.draft.schemaVersion).toBe(2);
            return snapshot();
        },
        loseTerminal() { const from = messages.length;return { entered: wait(m => m.type === 'DUAL_HANDLER_ENTER', from), disconnect() { host.terminate(); } }; },
        reinitialize() { return host.reinitialize('C11 late authorization'); },
        close() { const closing = host.close();return closing.then(() => { host.terminate();return host.waitForResourceRelease(); }); },
        async finish() { try { await host.close(); } finally { host.terminate();await host.waitForResourceRelease();expect(host.getResourceReport().interactions).toEqual({ closed: true, retainedScopes: 0, retainedBytes: 0 }); } },
    };
}
function request(observation: any, view: string, name: string, input: any, id: string) {
    const tool = observation.tools.find((t: any) => t.name === name), binding = observation.bindings.find((b: any) => b.toolId === tool?.id && b.target.viewId === view);
    if (!binding) throw Error('Missing observed binding');return { invocationId: id, observationId: observation.observationId, bindingId: binding.bindingId, input };
}
async function observe(actor: any, view = 'aa') { const result = await actor.client.observe({ viewIds: [view] });expect(result.status).toBe('observed');return result.observation; }
const factories = [['plain Core', async () => plainActor()], ['SDK/DOM/Node Worker', workerActor]] as const;

it.each(factories)('C03–07/12 shared business sequence via %s', async (name, factory) => {
    const actor = await factory();try {
        for (const step of businessSequence) {
            if (step.kind === 'empty') { expect(actor.snapshot()).toMatchObject({ schemaVersion: 2, views: [], refs: {}, tools: {} });expect(await actor.client.observe({ viewIds: [] })).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_INVALID' } });continue; }
            if (step.kind === 'change') { await actor.change(step.command);expect(actor.snapshot().views.map((v: any) => v.id).sort()).toEqual([...step.views].sort());continue; }
            const observation = await observe(actor, step.view), count = actor.calls.length, authorized = actor.policyCalls.authorize;
            const result = await actor.client.invoke(request(observation, step.view, step.tool, step.input, step.name));expect(result.kind).toBe('receipt');
            expect(actor.calls.length - count).toBe(step.handlers);
            if (step.name === 'ordinary-defaults') { expect(Object.hasOwn(actor.calls.at(-1).args, 'n')).toBe(false);expect(Object.hasOwn(actor.calls.at(-1).args, 'choice')).toBe(false); }
            if (step.name === 'explicit-values') expect(actor.calls.at(-1).args).toEqual(step.input);
            if (step.kind === 'refuse') { expect(result.receipt.outcome.status).toBe('rejected');expect(actor.policyCalls.authorize).toBe(authorized); }
            else if (step.kind === 'business-failed') { expect(result.receipt.outcome).toMatchObject({ status: 'unknown', details: { kind: 'operation-result', result: step.result } }); }
            else expect(result.receipt.outcome).toEqual({ status: 'succeeded', value: step.result });
            evidence.push({ producer: name, step: step.name, result, handlers: actor.calls.length - count });actor.client.releaseObservation(observation.observationId);
        }
    } finally { await actor.finish(); }
}, 25000);

it.each(factories)('C08/09/13 Ref source, identity changes and exact common size inputs via %s', async (name, factory) => {
    const actor = await factory();try {
        await actor.change({ op: 'mount', ids: ['aa', 'bb'] });const before = actor.snapshot(), old = await observe(actor);
        await actor.change({ op: 'value', id: 'aa', value: 'new' });const next = actor.snapshot();
        expect(next.revision).toBeGreaterThan(before.revision);expect(next.views.find((v: any) => v.id === 'aa').content).toEqual(before.views.find((v: any) => v.id === 'aa').content);
        for (const [observation, text, id] of [[old, 'A', 'old'], [await observe(actor), 'new', 'new']]) { expect((await actor.client.invoke(request(observation, 'aa', 'read_ref', { q: 'ref', file: 'file' }, id))).receipt.outcome).toEqual({ status: 'succeeded', value: expectedRead('aa', 'ref', text) });actor.client.releaseObservation(observation.observationId); }
        const identities = actor.snapshot().views.map((v: any) => [v.id, v.viewInstanceId]).sort(), targets = Object.values(actor.snapshot().tools).map((t: any) => t.targets);
        await actor.change({ op: 'order', ids: ['bb', 'aa'] });expect(actor.snapshot().views.map((v: any) => [v.id, v.viewInstanceId]).sort()).toEqual(identities);expect(Object.values(actor.snapshot().tools).map((t: any) => t.targets)).toEqual(targets);
        for (const command of [{ op: 'enabled', id: 'aa', value: false }, { op: 'register', id: 'aa' }, { op: 'remove', ids: ['aa'] }]) {
            const stale = await observe(actor), count = actor.calls.length, originalView = actor.snapshot().views.find((v: any) => v.id === 'aa').viewInstanceId;
            const originalTarget = Object.values(actor.snapshot().tools).find((t: any) => t.name === 'read') as any;
            await actor.change(command);
            if (command.op === 'enabled') await actor.change({ op: 'enabled', id: 'aa', value: true });
            if (command.op === 'remove') await actor.change({ op: 'mount', ids: ['aa'] });
            expect((await actor.client.invoke(request(stale, 'aa', 'read', { q: 'stale' }, 'stale-' + command.op))).receipt.outcome.status).toBe('rejected');expect(actor.calls.length).toBe(count);actor.client.releaseObservation(stale.observationId);
            if (command.op === 'register') { expect(actor.snapshot().views.find((v: any) => v.id === 'aa').viewInstanceId).toBe(originalView);
                const target = Object.values(actor.snapshot().tools).find((t: any) => t.name === 'read') as any;expect(target.targets.find((t: any) => t.viewId === 'aa').bindingVersion).not.toBe(originalTarget.targets.find((t: any) => t.viewId === 'aa').bindingVersion); }
            const current = await observe(actor);expect((await actor.client.invoke(request(current, 'aa', 'read', { q: 'current' }, 'current-' + command.op))).receipt.outcome.status).toBe('succeeded');actor.client.releaseObservation(current.observationId);
        }
        await actor.change({ op: 'remove', ids: ['aa', 'bb'] });expect(actor.snapshot()).toMatchObject({ schemaVersion: 2, views: [], refs: {}, tools: {} });
        await actor.change({ op: 'mount', ids: ['aa', 'bb'] });expect(actor.snapshot().views.find((v: any) => v.id === 'aa').viewInstanceId).not.toBe(identities.find((v: any) => v[0] === 'aa')[1]);
        const large = 'x'.repeat(32 * 1024);await actor.change({ op: 'value', id: 'aa', value: large });
        for (const [tool, input, text] of [['read', { q: large }, null], ['read_ref', { q: 'ref', file: 'file' }, large], ['read_ref', { q: large, file: 'file' }, large]]) {
            const observation = await observe(actor), result = await actor.client.invoke(request(observation, 'aa', tool, input, 'large-' + tool + String(input.q.length)));expect(result.receipt.outcome).toEqual({ status: 'succeeded', value: expectedRead('aa', input.q, text) });actor.client.releaseObservation(observation.observationId);
        }
        const count = actor.calls.length, authorized = actor.policyCalls.authorize;
        const oversized = await actor.client.invoke(request(await observe(actor), 'aa', 'read', { q: 'x'.repeat(128 * 1024 + 1) }, 'too-large'));
        expect(oversized).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'rejected' } } });
        expect(actor.calls.length).toBe(count);expect(actor.policyCalls.authorize).toBe(authorized);
        evidence.push({ producer: name, identities, finalViews: actor.snapshot().views.map((v: any) => ({ id: v.id, viewInstanceId: v.viewInstanceId })), handlers: actor.calls.length });
    } finally { await actor.finish(); }
}, 30000);

for (const stage of ['project', 'authorize'] as const) for (const action of ['close', 'reinitialize'] as const)
    it.each(factories)(`C10/11 ${stage} holds real ownership across ${action} via %s`, async (name, factory) => {
        const actor = await factory(), gate = defer(), entered = defer();let closing: Promise<any> | undefined;
        try {
            await actor.change({ op: 'mount', ids: ['aa', 'bb'] });
            const observation = stage === 'authorize' ? await observe(actor) : undefined;
            actor.control[stage] = (context: any) => { entered.resolve();return gate.promise.then(() => stage === 'project' ? grant(context) : true); };
            const work = stage === 'project' ? actor.client.observe({ viewIds: ['aa'] }) : actor.client.invoke(request(observation, 'aa', 'read', { q: 'late' }, 'late'));
            await entered.promise;
            if (action === 'reinitialize') await actor.reinitialize();
            let completed = false;closing = actor.close();void closing.then(() => { completed = true; });
            for (let i = 0; i < 30; i++) await Promise.resolve();
            expect(completed).toBe(false);expect(actor.stats().scopes).toBe(1);expect(actor.calls.length).toBe(0);
            const replacement = await factory();try { await replacement.change({ op: 'mount', ids: ['aa'] });expect(replacement.calls.length).toBe(0);
                gate.resolve();const result = await work;expect(actor.calls.length).toBe(0);expect(replacement.calls.length).toBe(0);
                if (stage === 'project') expect(result).toMatchObject({ status: 'rejected', issue: { code: 'RESERVATION_UNAVAILABLE' } });
                else expect(result).toMatchObject({ kind: 'unavailable', code: 'SCOPE_UNAVAILABLE' });
                await closing;expect(actor.stats()).toMatchObject({ closed: true, scopes: 0, combinedBytes: 0 });
                evidence.push({ producer: name, stage, action, retainedUntilActualCallback: true, oldHandlers: actor.calls.length, newHandlers: replacement.calls.length, result });
            } finally { await replacement.finish(); }
        } finally { gate.resolve();if (closing) await closing;await actor.finish(); }
    }, 20000);

it.each(factories)('C12 terminal loss after actual entry revokes authority with no retry via %s', async (name, factory) => {
    const actor = await factory();try {
        await actor.change({ op: 'mount', ids: ['aa'] });await actor.change({ op: 'hold', value: true });
        const observation = await observe(actor), loss = actor.loseTerminal();
        const call = request(observation, 'aa', 'read_ref', { q: 'lost', file: 'file' }, 'lost'), work = actor.client.invoke(call);
        await loss.entered;expect(actor.calls.length).toBe(1);loss.disconnect();
        expect(await work).toMatchObject({ kind: 'unavailable', code: 'SCOPE_UNAVAILABLE' });
        expect(actor.facts).toContainEqual({ kind: 'unknown' });
        expect(await actor.client.invoke(call)).toMatchObject({ kind: 'refused', code: 'SCOPE_UNAVAILABLE' });expect(actor.calls.length).toBe(1);
        evidence.push({ producer: name, fault: actor.kind === 'plain' ? 'controlled real execution port' : 'actual Node Worker terminated after entry',
            underlying: actor.facts, caller: 'SCOPE_UNAVAILABLE', handlers: actor.calls.length });
    } finally { await actor.finish(); }
}, 20000);

it.each(['non-AppKernel', 'legacy-empty', 'legacy-mixed', 'legacy-DOM-without-owned'])('C05 retains actual V1 selection for %s', async kind => {
    const app = join(consumer, 'legacy-' + kind + '.mjs');
    const body = kind === 'non-AppKernel' ? `export default {async onOpen(context,container){container.textContent='Legacy empty App';},async onClose(){}};` :
        `import {h} from 'preact';import {parentPort} from 'node:worker_threads';import {createTUIApp,View,useViewTypeTool,experimental_useReadOnlyTool} from '@aotui/sdk';
        const params={},legacy=async()=>{parentPort.postMessage({type:'C_LEGACY_ENTER'});return {success:true,data:{legacy:1}};};function Legacy(){useViewTypeTool('File','legacy',{description:'Legacy ordinary',params},legacy);return h('span',{},'Legacy');}
        function Owned(){experimental_useReadOnlyTool('read',{description:'Owned',params:{}},async()=>({success:true}));return h('p',{},'Owned');}
        function Root(){return ${kind === 'legacy-empty' ? "h('p',{},'Empty legacy inventory')" : kind === 'legacy-mixed' ? "h(View,{id:'aa',type:'File'},[h(Legacy,{}),h(Owned,{})])" : "h('div',{'data-view-id':'legacy','data-view-type':'File'},'Old DOM')"};}
        const app=createTUIApp({app_name:'legacy_fixture',component:Root});
        ${kind === 'legacy-empty' ? "const initialize=app.initializeComponent;app.initializeComponent=(container,context)=>{context.typeTools.registerTypeTool('File','legacy',{description:'Legacy',params,handler:legacy});return initialize.call(app,container,context);};" : ''}
        export default app;`;
    await capture(app, body);const worker = new Worker(join(consumer, 'node_modules/@aotui/runtime/dist/worker-runtime/index.js'));
    const frames: any[] = [];worker.on('message', m => frames.push(m));
    const host = new Host({ appId: 'legacy', desktopId: 'legacy', appModulePath: app, existingWorker: worker, snapshotShadow: true,
        config: { AOTUI_DATA_DIR: join(consumer, 'legacy-data-' + kind) } });
    try { await host.start();await host.open();
        const frame = frames.find(m => m.type === 'SNAPSHOT_PREPARED') || await new Promise<any>((yes, no) => {
            const timer = setTimeout(() => no(Error('Legacy snapshot watchdog')), 5000);const receive = (m: any) => { if (m.type === 'SNAPSHOT_PREPARED' || m.type === 'SNAPSHOT_PREPARE_FAILED') { clearTimeout(timer);worker.off('message', receive);yes(m); } };worker.on('message', receive); });
        expect(frame.type).toBe('SNAPSHOT_PREPARED');expect(frame.draft.schemaVersion).toBe(1);
        if (kind === 'legacy-empty' || kind === 'legacy-mixed') { expect(await host.executeOperation('legacy', {}, 'legacy-source', 'File')).toEqual({ success: true, data: { legacy: 1 } });expect(frames.filter(m => m.type === 'C_LEGACY_ENTER')).toHaveLength(1); }
        evidence.push({ legacyKind: kind, actualWorker: true, schemaVersion: frame.draft.schemaVersion, legacyFragment: host.getSnapshotFragment() });
    } finally { try { await host.close(); } catch (error) { evidence.push({ legacyKind: kind, closeError: String(error), persistence: host.getPersistenceReport(), frames });throw error; }
        finally { host.terminate();await host.waitForResourceRelease();expect(host.getResourceReport().interactions.retainedScopes).toBe(0); } }
}, 15000);
