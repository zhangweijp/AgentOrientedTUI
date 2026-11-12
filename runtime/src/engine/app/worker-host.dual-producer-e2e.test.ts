import { afterAll, beforeAll, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createSnapshotCore, createViewOwnedTools, createAppInteraction, compileOrdinarySchema,
    type SemanticProjectionCoordinator } from '../../core/index.js';
import { initialBusiness, applyBusiness, businessResult, ordinaryInputSchema, referenceInputSchema, tools as businessTools, fileRef, privateRef, fileLabel, filePayload, selectedBusinessSession,
    expectedRead, businessSequence } from '../../../tests/fixtures/dual-producer-business.mjs';

const defer = () => { let resolve!: (value?: any) => void;const promise = new Promise<any>(yes => { resolve = yes; });return { promise, resolve }; };
let consumer: string, Host: any, actorCount = 0;
let Projection: typeof SemanticProjectionCoordinator;
const evidence: any[] = [];
const grant = ({ source, selection }: any) => {
    const views = source.views.filter((v: any) => selection.viewIds.includes(v.id));
    return {
        views: views.map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
        refs: Object.values(source.refs).filter((r: any) => selection.viewIds.includes(r.ownerViewId))
            .map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        toolBindings: Object.values(source.tools).flatMap((tool: any) => tool.execution.kind === 'view-type' &&
            views.some((view: any) => view.type === tool.viewType) ? [{ toolId: tool.id, execution: tool.execution }] : []),
        content: [],
    };
};
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
    const repo = resolve(process.cwd(), '..');consumer = await mkdtemp(join(process.env.AOTUI_MIGRATION_TEMP_DIR ?? tmpdir(), 'aotui-c-dual-'));const modules = join(consumer, 'node_modules');await mkdir(join(modules, '@aotui'), { recursive: true });
    const artifacts = process.env.AOTUI_C_PRODUCER_ARTIFACTS;
    for (const pkg of ['runtime', 'sdk']) {
        const target = join(modules, '@aotui', pkg);await mkdir(target);await cp(join(repo, pkg, 'package.json'), join(target, 'package.json'));
        await cp(join(artifacts || repo, pkg, 'dist'), join(target, 'dist'), { recursive: true });
    }
    const copiedInputs: any[] = [];
    async function inventory(folder: string) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) await inventory(path);
            else if (entry.isFile()) copiedInputs.push({ path: path.slice(consumer.length + 1), sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
            else throw Error('Copied package input must be a regular file or directory: ' + path);
        }
    }
    await inventory(join(modules, '@aotui/runtime')); await inventory(join(modules, '@aotui/sdk'));
    evidence.push({ kind: 'package copies captured before project import', consumer, copiedInputs });
    for (const pkg of ['runtime', 'sdk']) for (const entry of await readdir(join(repo, pkg, 'node_modules'))) {
        if (entry.startsWith('.') || entry === '@aotui') continue;
        try { await symlink(join(repo, pkg, 'node_modules', entry), join(modules, entry), 'dir'); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    }
    for (const file of ['dual-producer-app.mjs', 'dual-producer-business.mjs']) await capture(join(consumer, file), await readFile(join(repo, 'runtime/tests/fixtures', file), 'utf8'));
    await capture(join(consumer, 'plain-producer.mjs'), "export { SemanticProjectionCoordinator } from '@aotui/runtime/core';\n");
    Projection = (await import(pathToFileURL(join(consumer, 'plain-producer.mjs')).href)).SemanticProjectionCoordinator;
    Host = (await import(pathToFileURL(join(modules, '@aotui/runtime/dist/engine/app/worker-host.js')).href)).AppWorkerHost;
    evidence.push({ internalProducerTest: true, actualDistCopies: true, actualSdkApp: true, completePackageInstallClaimed: false, artifacts: artifacts || repo });
}, 20000);
afterAll(async () => { const root = process.env.AOTUI_W08_C1_FACTS_DIR;if (root) { await mkdir(root, { recursive: true });await writeFile(join(root, 'c-dual-producer.json'), JSON.stringify(evidence, null, 2)); }if (consumer) await rm(consumer, { recursive: true, force: true }); });

function plainActor() {
    const ordinary = compileOrdinarySchema(ordinaryInputSchema, 'view-type-parameters-v1');
    const reference = compileOrdinarySchema(referenceInputSchema, 'view-type-parameters-v1');
    if (!ordinary.ok || !reference.ok) throw Error('business declaration: ' + JSON.stringify({ ordinary, reference }));
    const instance = 'plain-' + ++actorCount, core = createSnapshotCore(), registry = createViewOwnedTools('app', instance);
    core.lifecycle.startApp('app', instance);
    let state = initialBusiness();
    const mounted = new Map<string, any>(), calls: any[] = [], entries: any[] = [], guards: any[] = [], facts: any[] = [], p = policy();
    let lost: ReturnType<typeof defer> | undefined, entered: ReturnType<typeof defer> | undefined;
    const releases = new Map<string, () => void>();
    const refBindings = new Map<string, Map<string, ReturnType<SemanticProjectionCoordinator['registerRef']>>>();
    const projection = new Projection({
        identity: () => ({ appId: 'app', instanceId: instance }),
        readFrame: () => ({
            views: state.order.map(id => ({ id, viewInstanceId: mounted.get(id).viewInstanceId, type: 'File', name: id, kind: 'state',
                content: { format: 'markdown-v1', value: `File View session ID: ${id}@${state.mounts[id]}. Stable File value.` } })),
            tools: registry.listTools(),
        }),
    });
    function syncTools() {
        if (!state.order.some(id => state.enabled[id])) { for (const release of releases.values()) release(); releases.clear(); return; }
        for (const definition of Object.values(businessTools)) {
            const { name, viewType, description, inputSchema } = definition;
            if (releases.has(name)) continue;
            releases.set(name, registry.registerTypeTool({ name, viewType, description, inputSchema }, {
                safeOrdinaryParametersInvocationMode: 'ordinary-v2',
                createSafeOrdinaryParametersInvoker: contract => async args => {
                    const checked = (contract.validateResolvedInput ?? contract.validate)(args);
                    if (!checked.ok) return { phase: 'not-entered' as const, result: { success: false, error: { code: 'E_INVALID_ARGS', message: 'Input invalid' } } };
                    // This is the App handler boundary, after the framework contract wrapper and before every business guard.
                    entries.push({ name });
                    const stateBefore = JSON.stringify(state), id = selectedBusinessSession(state, name, checked.value);
                    if (!id) {
                        const sessionId = name === 'read_ref' ? `${(checked.value.file as any).view}@${(checked.value.file as any).session}` : checked.value.view_id;
                        guards.push({ name, sessionId, stateBefore, stateAfter: JSON.stringify(state) });
                        facts.push({ kind: 'business-rejected', sessionId });
                        return { phase: 'entered-returned' as const, result: { success: false,
                            error: { code: 'VIEW_NOT_OPEN', message: 'The requested business session is not open and enabled.' } } };
                    }
                    calls.push({ name, viewId: id, args: checked.value });
                    return { phase: 'entered-returned' as const, result: await businessResult(id, checked.value) };
                },
            }));
        }
    }
    const snapshot = () => { const result = core.store.readLatest('app'); if (result.status !== 'ready') throw Error(result.status); return result.snapshot; };
    function publish() {
        expect(projection.commit(() => {
            for (const [id, view] of mounted) if (!state.order.includes(id)) {
                projection.releaseView(view.viewInstanceId);
                registry.unmount(view.viewInstanceId);
                mounted.delete(id); refBindings.delete(id);
            }
            for (const id of state.order) {
                if (!mounted.has(id)) mounted.set(id, registry.mount(id, 'File'));
                const wanted = new Map([[state.ambiguous ? 'shared' : fileLabel(id), state.values[id]],
                    ['private_' + fileLabel(id), 'private-' + id]]);
                let bound = refBindings.get(id);
                if (!bound) refBindings.set(id, bound = new Map());
                for (const [name, binding] of bound) if (!wanted.has(name)) { binding.release(); bound.delete(name); }
                for (const [name, value] of wanted) {
                    const payload = filePayload(state, id, value);
                    const binding = bound.get(name);
                    if (binding) binding.update(payload);
                    else bound.set(name, projection.registerRef(mounted.get(id), name, payload, 'File'));
                }
            }
            syncTools();
        })).toBe('prepared');
        const result = projection.publishTo(core.committer);
        expect(['published', 'unchanged']).toContain(result.status); return snapshot();
    }
    const bindings = new WeakMap<object, any>();
    const authority = createAppInteraction(core.store, { namespace: instance, now: Date.now, appId: 'app', instanceId: instance, policy: p.policy, execution: { resolve(source: any) {
        let binding = bindings.get(source); if (binding) return binding;
        const tool = source.tool, execution = source.execution;
        const contract = tool.name === 'read_ref' ? reference.contract : ordinary.contract;
        binding = { identity: {}, mode: 'view-type-parameters-v1',
            validateInput: (_source: any, args: any) => { const r = (contract.validateResolvedInput ?? contract.validate)(args); return r.ok ? { ok: true, value: r.value } : { ok: false }; },
            isLive: () => ({ ok: registry.validateTypeToolBinding(tool, execution).success }),
            execute: async (context: any) => {
                const terminal = await registry.invokeTypeTool(tool, execution, context.effectiveInput);
                if (lost) { entered!.resolve(); await lost.promise; const fact = { kind: 'unknown' }; facts.push(fact); return fact; }
                const fact = { kind: 'tool-result', phase: terminal.phase, result: terminal.result }; facts.push(fact); return fact;
            } };
        bindings.set(source, binding); return binding;
    } } });
    publish();
    return { kind: 'plain', client: authority, ...p, policyCalls: p.calls, calls, entries, guards, dispatches: null, facts, snapshot,
        stats: () => authority.inspect(),
        async change(command: any) {
            state = applyBusiness(state, command);
            return publish();
        },
        loseTerminal() { lost = defer(); entered = defer(); return { entered: entered.promise, disconnect() { authority.close(); lost!.resolve(); } }; },
        reinitialize() { authority.close(); projection.close(); registry.dispose(); core.lifecycle.startApp('app', instance + '-next'); return Promise.resolve(); },
        close() { authority.close(); projection.close(); registry.dispose(); core.lifecycle.dispose(); return authority.whenClosed(); },
        businessIdFor(id: string) { return `${id}@${state.mounts[id]}`; },
        async finish() { authority.close(); lost?.resolve(); await authority.whenClosed(); projection.close(); registry.dispose(); core.lifecycle.dispose();
            expect(authority.inspect().combinedBytes).toBe(0); expect(core.store.inspect().activeLeases).toBe(0);
            evidence.push({ producer: 'plain', cleanupKind: 'explicit Core close/dispose', interactions: authority.inspect(), store: core.store.inspect() }); },
    };
}

async function workerActor() {
    const dataDir = join(consumer, 'data-' + ++actorCount);
    const worker = new Worker(join(consumer, 'node_modules/@aotui/runtime/dist/worker-runtime/index.js'), { stdout: true, stderr: true, env: { ...process.env, AOTUI_DATA_DIR: dataDir } });
    const messages: any[] = [], calls: any[] = [], entries: any[] = [], guards: any[] = [], dispatches: any[] = [], facts: any[] = [], logs: string[] = [], p = policy();
    const post = worker.postMessage.bind(worker); worker.postMessage = (message: any) => { if (message.type === 'VIEW_TOOL_INVOKE_V4') dispatches.push(message); post(message); };
    worker.stdout!.on('data', b => logs.push(String(b)));worker.stderr!.on('data', b => logs.push(String(b)));
    worker.on('error', error => logs.push(String(error.stack)));
    worker.on('message', m => {
        messages.push(m);
        if (m.type === 'DUAL_HANDLER_ENTRY') entries.push(m);
        if (m.type === 'DUAL_HANDLER_ENTER') calls.push(m);
        if (m.type === 'DUAL_BUSINESS_REJECTED') guards.push(m);
        if (m.type === 'DUAL_BUSINESS_REJECTED') facts.push({ kind: 'business-rejected', sessionId: m.sessionId });
    });
    function wait(predicate: (m: any) => boolean, from = 0): Promise<any> {
        const existing = messages.slice(from).find(predicate);if (existing) return Promise.resolve(existing);
        return new Promise((yes, no) => { const timer = setTimeout(() => { worker.off('message', receive);no(Error('Worker barrier deadline: ' + logs.join(''))); }, 8000);
            const receive = (m: any) => { if (predicate(m)) { clearTimeout(timer);worker.off('message', receive);yes(m); } };worker.on('message', receive); });
    }
    const host = new Host({ appId: 'app', desktopId: 'd', appModulePath: join(consumer, 'dual-producer-app.mjs'), existingWorker: worker,
        timeout: 2000, interactionModes: ['view-type-parameters-v1'],
        config: { AOTUI_DATA_DIR: dataDir } });
    const dispatch = host.dispatchTool.bind(host);
    host.dispatchTool = async (...args: any[]) => { const fact = await dispatch(...args);facts.push(fact);return fact; };
    let opened: any;
    try {
        await host.start();await host.open();const first = await wait(m => m.type === 'SNAPSHOT_PREPARED' || m.type === 'SNAPSHOT_PREPARE_FAILED');
        expect(first.type).toBe('SNAPSHOT_PREPARED');expect(first.draft.schemaVersion).toBe(3);
        opened = host.getAppInteraction(p.policy);expect(opened.status).toBe('ready');if (opened.status !== 'ready') throw Error(opened.issue.code);
    } catch (error) { evidence.push({ initializationFailed: true, logs, messages });host.terminate();await host.waitForResourceRelease();throw error; }
    let state = initialBusiness(), lastEpoch = -1;
    const snapshot = () => { const result = host.snapshotReceiver.core.store.readLatest('app');if (result.status !== 'ready') throw Error(result.status);return result.snapshot; };
    return { kind: 'sdk-worker', client: opened.interaction, ...p, policyCalls: p.calls, calls, entries, guards, dispatches, facts, snapshot,
        businessIdFor(id: string) { return `${id}@${state.mounts[id]}`; }, stats: () => host.getInteractionReport().core,
        async change(command: any) {
            const from = messages.length;state = applyBusiness(state, command);worker.postMessage({ type: 'DUAL_CONTROL', command });
            const commit = await wait(m => m.type === 'DUAL_COMMITTED' && m.sequence === state.sequence, from);
            expect(commit.projectionEpoch).toBeGreaterThan(lastEpoch);lastEpoch = commit.projectionEpoch;
            const frame = await wait(m => (m.type === 'SNAPSHOT_PREPARED' && m.draft.sourceEpoch >= commit.projectionEpoch) ||
                (m.type === 'SNAPSHOT_PREPARE_FAILED' && m.sourceEpoch >= commit.projectionEpoch), from);
            expect(frame.type).toBe('SNAPSHOT_PREPARED');expect(frame.draft.schemaVersion).toBe(3);
            return snapshot();
        },
        loseTerminal() { const from = messages.length;return { entered: wait(m => m.type === 'DUAL_HANDLER_ENTER', from), disconnect() { host.terminate(); } }; },
        reinitialize() { return host.reinitialize('C11 late authorization'); },
        close() { return host.close().then(() => host.waitForResourceRelease()); },
        async finish() { try { await host.close(); } finally { host.terminate();await host.waitForResourceRelease();expect(host.getResourceReport().interactions).toEqual({ closed: true, retainedOperations: 0, retainedBytes: 0 }); evidence.push({ producer: 'sdk-worker', cleanupKind: 'AppWorkerHost close and actual exit', resourceReport: host.getResourceReport(), interactions: host.getInteractionReport(), gracefulRuntimeShutdownClaimed: false }); } },
    };
}
function request(observation: any, view: string, name: string, input: any, id: string) {
    const tool = observation.tools.find((t: any) => t.name === name);
    const binding = observation.bindings.find((b: any) => b.toolId === tool?.id && b.execution.kind === 'view-type');
    if (!binding) throw Error('Missing observed binding');
    const args = name === 'read' && !Object.hasOwn(input, 'view_id') ? { ...input, view_id: observation.businessViewId } : input;
    return { invocationId: id, observationId: observation.observationId, bindingId: binding.bindingId, input: args };
}
async function observe(actor: any, view = 'aa') {
    const result = await actor.client.observe({ viewIds: [view] });expect(result.status).toBe('observed');
    if (result.status === 'observed') expect(actor.client.adoptObservation(result.observation.observationId)).toEqual({ status: 'adopted' });
    const businessViewId = actor.businessIdFor(view), rendered = actor.snapshot().views.find((item: any) => item.id === view)?.content?.value;
    expect(rendered).toContain(`File View session ID: ${businessViewId}`);
    return { ...result.observation, businessViewId };
}
const factories = [['plain TS via packaged Core', async () => plainActor()], ['SDK/DOM/Node Worker', workerActor]] as const;
function counts(actor: any) { return { dispatches: actor.dispatches === null ? null : actor.dispatches.length,
    entries: actor.entries.length, guards: actor.guards.length, business: actor.calls.length }; }
function expectDelta(actor: any, before: any, expected: { entries: number; guards: number; business: number; dispatches: number }) {
    const after = counts(actor);
    for (const key of ['entries', 'guards', 'business'] as const) expect(after[key] - before[key]).toBe(expected[key]);
    if (after.dispatches === null) expect(before.dispatches).toBe(null);
    else expect(after.dispatches - before.dispatches).toBe(expected.dispatches);
}
it.each(factories)('D1 selects granted same-name Refs by View and rejects unqualified names via %s', async (name, factory) => {
    const actor = await factory(); try {
        await actor.change({ op: 'mount', ids: ['aa', 'bb'] });
        const all = await actor.client.observe({ viewIds: ['aa', 'bb'] }); expect(all.status).toBe('observed');
        if (all.status === 'observed') expect(actor.client.adoptObservation(all.observation.observationId)).toEqual({ status: 'adopted' });
        const before = counts(actor), result = await actor.client.invoke(request(all.observation, 'aa', 'read_ref', { q: 'cross-view', file: fileRef('bb') }, 'cross-view'));
        expect(result.receipt.outcome).toEqual({ status: 'succeeded', value: expectedRead('bb', 'cross-view', 'B') });
        expectDelta(actor, before, { entries: 1, guards: 0, business: 1, dispatches: 1 });
        actor.client.releaseObservation(all.observation.observationId);
        await actor.change({ op: 'ambiguity', value: true });
        const ambiguous = await actor.client.observe({ viewIds: ['aa', 'bb'] }); expect(ambiguous.status).toBe('observed');
        if (ambiguous.status === 'observed') expect(actor.client.adoptObservation(ambiguous.observation.observationId)).toEqual({ status: 'adopted' });
        const beforeAmbiguous = counts(actor), refused = await actor.client.invoke(request(ambiguous.observation, 'aa', 'read_ref', { q: 'ambiguous', file: 'shared' }, 'unqualified'));
        expect(refused.receipt.outcome).toMatchObject({ status: 'rejected', code: 'REF_NOT_VISIBLE' });
        expectDelta(actor, beforeAmbiguous, { entries: 0, guards: 0, business: 0, dispatches: 0 });
        evidence.push({ producer: name, D1: { grantedCrossView: result, ambiguous: refused }, counts: counts(actor) });
        for (const [view, text] of [['aa', 'A'], ['bb', 'B']]) {
            const selected = await actor.client.invoke(request(ambiguous.observation, 'aa', 'read_ref',
                { q: 'same-name', file: fileRef(view, true) }, 'same-name-' + view));
            expect(selected.receipt.outcome).toEqual({ status: 'succeeded', value: expectedRead(view, 'same-name', text) });
        }
        actor.client.releaseObservation(ambiguous.observation.observationId);
    } finally { await actor.finish(); }
});


it.each(factories)('C03–07/12 shared business sequence via %s', async (name, factory) => {
    const actor = await factory();try {
        for (const step of businessSequence) {
            if (step.kind === 'empty') { expect(actor.snapshot()).toMatchObject({ schemaVersion: 3, views: [], refs: {}, tools: {} });expect(await actor.client.observe({ viewIds: [] })).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_INVALID' } });continue; }
            if (step.kind === 'change') { await actor.change(step.command);expect(actor.snapshot().views.map((v: any) => v.id).sort()).toEqual([...step.views].sort());continue; }
            const observation = await observe(actor, step.view), count = actor.calls.length, authorized = actor.policyCalls.authorize, beforeCounts = counts(actor);
            const result = await actor.client.invoke(request(observation, step.view, step.tool, step.input, step.name));expect(result.kind).toBe('receipt');
            expect(actor.calls.length - count).toBe(step.handlers);
            if (step.name === 'ordinary-defaults') { expect(Object.hasOwn(actor.calls.at(-1).args, 'n')).toBe(false);expect(Object.hasOwn(actor.calls.at(-1).args, 'choice')).toBe(false); }
            if (step.name === 'explicit-values') expect(actor.calls.at(-1).args).toEqual(step.input);
            if (step.kind === 'refuse') { expect(result.receipt.outcome.status).toBe('rejected');expect(actor.policyCalls.authorize).toBe(authorized); expectDelta(actor, beforeCounts, { entries: 0, guards: 0, business: 0, dispatches: 0 }); }
            else if (step.kind === 'business-failed') { expect(result.receipt.outcome).toMatchObject({ status: 'unknown', details: { kind: 'tool-result', result: step.result } }); }
            else expect(result.receipt.outcome).toEqual({ status: 'succeeded', value: step.result });
            evidence.push({ producer: name, step: step.name, result, handlers: actor.calls.length - count });actor.client.releaseObservation(observation.observationId);
        }
    } finally { await actor.finish(); }
}, 25000);

it.each(factories)('C08/09/13 records shared Tool versus App-session migration differences via %s', async (name, factory) => {
    const actor = await factory();try {
        await actor.change({ op: 'mount', ids: ['aa', 'bb'] });const before = actor.snapshot(), old = await observe(actor, 'aa');
        await actor.change({ op: 'value', id: 'aa', value: 'new' });const next = actor.snapshot();
        expect(next.revision).toBeGreaterThan(before.revision);expect(next.views.find((v: any) => v.id === 'aa').content).toEqual(before.views.find((v: any) => v.id === 'aa').content);
        for (const [text, id] of [['A', 'old'], ['new', 'new']]) { const observation = id === 'old' ? old : await observe(actor, 'aa'); expect((await actor.client.invoke(request(observation, 'aa', 'read_ref', { q: 'ref', file: fileRef('aa') }, id))).receipt.outcome).toEqual({ status: 'succeeded', value: expectedRead('aa', 'ref', text) });actor.client.releaseObservation(observation.observationId); }
        const identities = actor.snapshot().views.map((v: any) => [v.id, v.viewInstanceId]).sort();
        const executions = Object.values(actor.snapshot().tools).map((t: any) => [t.name, t.execution]).sort((a: any, b: any) => a[0].localeCompare(b[0]));
        await actor.change({ op: 'order', ids: ['bb', 'aa'] });expect(actor.snapshot().views.map((v: any) => [v.id, v.viewInstanceId]).sort()).toEqual(identities);
        expect(Object.values(actor.snapshot().tools).map((t: any) => [t.name, t.execution]).sort((a: any, b: any) => a[0].localeCompare(b[0]))).toEqual(executions);
        for (const command of [{ op: 'enabled', id: 'aa', value: false }, { op: 'remove', ids: ['aa'] }]) {
            const staleRef = await observe(actor, 'aa'), staleOrdinary = staleRef;
            const count = actor.calls.length, originalView = actor.snapshot().views.find((v: any) => v.id === 'aa').viewInstanceId;
            const originalOrdinary = Object.values(actor.snapshot().tools).find((t: any) => t.name === 'read') as any;
            await actor.change(command);
            const oldSession = await actor.client.invoke(request(staleOrdinary, 'aa', 'read', { q: 'closed-session' }, 'old-session-' + command.op));
            if (command.op === 'enabled' || command.op === 'remove') {
                expect(oldSession.receipt.outcome).toMatchObject({ status: 'unknown', details: { result: { error: { code: 'VIEW_NOT_OPEN' } } } });
                expect(actor.calls.length).toBe(count);
            }
            const beforeRefCounts = counts(actor);
            const staleRefResult = await actor.client.invoke(request(staleRef, 'aa', 'read_ref', { q: 'stale-ref', file: fileRef('aa') }, 'stale-ref-' + command.op));
            if (command.op === 'remove') {
                expect(staleRefResult.receipt).toMatchObject({ executionPhase: 'not-dispatched',
                    outcome: { status: 'rejected', code: 'REF_VIEW_UNAVAILABLE', path: '$.file' } });
                expectDelta(actor, beforeRefCounts, { entries: 0, guards: 0, business: 0, dispatches: 0 });
            } else {
                expect(staleRefResult.receipt.executionPhase).toBe('entered-returned');
                expect(staleRefResult.receipt.outcome).toMatchObject({ status: 'unknown', details: { result: { error: { code: 'VIEW_NOT_OPEN' } } } });
                expectDelta(actor, beforeRefCounts, { entries: 1, guards: 1, business: 0, dispatches: 1 });
                const guard = actor.guards.at(-1); expect(guard.stateAfter).toBe(guard.stateBefore);
            }
            evidence.push({ producer: name, command, before: beforeRefCounts, after: counts(actor), receipt: staleRefResult.receipt });
            expect(actor.calls.length).toBe(count);
            if (command.op === 'enabled') await actor.change({ op: 'enabled', id: 'aa', value: true });
            if (command.op === 'remove') await actor.change({ op: 'mount', ids: ['aa'] });
            const currentView = actor.snapshot().views.find((v: any) => v.id === 'aa');
            if (command.op === 'remove') expect(currentView.viewInstanceId).not.toBe(originalView);
            const currentTools = Object.values(actor.snapshot().tools) as any[];
            const currentOrdinary = currentTools.find((t: any) => t.name === 'read');
            expect(currentOrdinary.execution).toEqual(originalOrdinary.execution);
            expect(currentTools.some((t: any) => t.name === 'read_ref')).toBe(true);
            if (command.op === 'remove') {
                const beforeReopenedRef = counts(actor);
                const reopenedOldRef = await actor.client.invoke(request(staleRef, 'aa', 'read_ref', { q: 'old-session-after-reopen', file: fileRef('aa') }, 'old-ref-after-reopen'));
                expect(reopenedOldRef.receipt.outcome).toMatchObject({ status: 'rejected', code: 'REF_VIEW_UNAVAILABLE', path: '$.file' });
                expectDelta(actor, beforeReopenedRef, { entries: 0, guards: 0, business: 0, dispatches: 0 });
                evidence.push({ producer: name, receipt: reopenedOldRef.receipt, before: beforeReopenedRef, after: counts(actor) });
            }
            const current = await observe(actor, 'aa');
            expect((await actor.client.invoke(request(current, 'aa', 'read', { q: 'current' }, 'current-' + command.op))).receipt.outcome.status).toBe('succeeded');
            expect((await actor.client.invoke(request(current, 'aa', 'read_ref', { q: 'current-ref', file: fileRef('aa') }, 'current-ref-' + command.op))).receipt.outcome)
                .toEqual({ status: 'succeeded', value: expectedRead('aa', 'current-ref', 'new') });
            actor.client.releaseObservation(staleRef.observationId);actor.client.releaseObservation(staleOrdinary.observationId);actor.client.releaseObservation(current.observationId);
        }
        const oldB = await observe(actor, 'bb'), liveActivation = (Object.values(actor.snapshot().tools) as any[]).find(t => t.name === 'read').execution;
        const beforeCloseB = actor.calls.length;
        await actor.change({ op: 'remove', ids: ['bb'] });
        expect((Object.values(actor.snapshot().tools) as any[]).find(t => t.name === 'read').execution).toEqual(liveActivation);
        expect((await actor.client.invoke(request(oldB, 'bb', 'read', { q: 'closed-b' }, 'closed-b'))).receipt.outcome)
            .toMatchObject({ status: 'unknown', details: { result: { error: { code: 'VIEW_NOT_OPEN' } } } });
        expect(actor.calls.length).toBe(beforeCloseB);
        await actor.change({ op: 'mount', ids: ['bb'] });
        expect((Object.values(actor.snapshot().tools) as any[]).find(t => t.name === 'read').execution).toEqual(liveActivation);
        expect(actor.businessIdFor('bb')).toBe('bb@2');
        expect((await actor.client.invoke(request(oldB, 'bb', 'read', { q: 'old-b-session' }, 'old-b-session'))).receipt.outcome)
            .toMatchObject({ status: 'unknown', details: { result: { error: { code: 'VIEW_NOT_OPEN' } } } });
        expect(actor.calls.length).toBe(beforeCloseB);
        const newB = await observe(actor, 'bb');
        expect((await actor.client.invoke(request(newB, 'bb', 'read', { q: 'new-b-session' }, 'new-b-session'))).receipt.outcome)
            .toEqual({ status: 'succeeded', value: expectedRead('bb', 'new-b-session') });
        expect(actor.calls.length).toBe(beforeCloseB + 1);
        actor.client.releaseObservation(oldB.observationId);actor.client.releaseObservation(newB.observationId);
        const finalBeforeClose = await observe(actor, 'aa'), oldActivation = (Object.values(actor.snapshot().tools) as any[]).find(t => t.name === 'read').execution;
        const callsBeforeTypeClose = actor.calls.length, countsBeforeTypeClose = counts(actor);
        await actor.change({ op: 'remove', ids: ['aa', 'bb'] });expect(actor.snapshot()).toMatchObject({ schemaVersion: 3, views: [], refs: {}, tools: {} });
        expect((await actor.client.invoke(request(finalBeforeClose, 'aa', 'read', { q: 'retired-type' }, 'retired-type'))).receipt.outcome.status).toBe('rejected');
        expect(actor.calls.length).toBe(callsBeforeTypeClose);expectDelta(actor, countsBeforeTypeClose, { entries: 0, guards: 0, business: 0, dispatches: 0 });
        const beforeRefClose = counts(actor);
        expect((await actor.client.invoke(request(finalBeforeClose, 'aa', 'read_ref', { q: 'closed-type', file: fileRef('aa') }, 'closed-ref-type'))).receipt.outcome.status).toBe('rejected');
        expectDelta(actor, beforeRefClose, { entries: 0, guards: 0, business: 0, dispatches: 0 });
        actor.client.releaseObservation(finalBeforeClose.observationId);
        await actor.change({ op: 'mount', ids: ['aa', 'bb'] });expect(actor.snapshot().views.find((v: any) => v.id === 'aa').viewInstanceId).not.toBe(identities.find((v: any) => v[0] === 'aa')[1]);
        expect((Object.values(actor.snapshot().tools) as any[]).find(t => t.name === 'read').execution).not.toEqual(oldActivation);
        const large = 'x'.repeat(32 * 1024);await actor.change({ op: 'value', id: 'aa', value: large });
        for (const [tool, input, text] of [['read', { q: large }, null], ['read_ref', { q: 'ref', file: fileRef('aa') }, large], ['read_ref', { q: large, file: fileRef('aa') }, large]]) {
            const observation = await observe(actor, 'aa'), result = await actor.client.invoke(request(observation, 'aa', tool, input, 'large-' + tool + String(input.q.length)));expect(result.receipt.outcome).toEqual({ status: 'succeeded', value: expectedRead('aa', input.q, text) });actor.client.releaseObservation(observation.observationId);
        }
        const count = actor.calls.length, authorized = actor.policyCalls.authorize, beforeOversized = counts(actor);
        const oversized = await actor.client.invoke(request(await observe(actor), 'aa', 'read', { q: 'x'.repeat(128 * 1024 + 1) }, 'too-large'));
        expect(oversized).toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'rejected' } } });
        expect(actor.calls.length).toBe(count);expect(actor.policyCalls.authorize).toBe(authorized);expectDelta(actor, beforeOversized, { entries: 0, guards: 0, business: 0, dispatches: 0 });
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
            expect(completed).toBe(false);expect(actor.stats().combinedBytes).toBeGreaterThan(0);expect(actor.calls.length).toBe(0);expect(actor.entries.length).toBe(0);
            const replacement = await factory();try { await replacement.change({ op: 'mount', ids: ['aa'] });expect(replacement.calls.length).toBe(0);expect(replacement.entries.length).toBe(0);
                gate.resolve();const result = await work;expect(actor.calls.length).toBe(0);expect(actor.entries.length).toBe(0);expect(replacement.calls.length).toBe(0);expect(replacement.entries.length).toBe(0);
                if (stage === 'project') expect(result).toMatchObject({ status: 'rejected', issue: { code: 'RESERVATION_UNAVAILABLE' } });
                else expect(result).toMatchObject({ kind: 'unavailable', code: 'APP_INTERACTION_UNAVAILABLE' });
                await closing;expect(actor.stats()).toMatchObject({ closed: true, combinedBytes: 0 });
                evidence.push({ producer: name, stage, action, retainedUntilActualCallback: true, oldHandlers: actor.calls.length, newHandlers: replacement.calls.length, result });
            } finally { await replacement.finish(); }
        } finally { gate.resolve();if (closing) await closing;await actor.finish(); }
    }, 20000);

it.each(factories)('C12 terminal loss after actual entry revokes authority with no retry via %s', async (name, factory) => {
    const actor = await factory();try {
        await actor.change({ op: 'mount', ids: ['aa'] });await actor.change({ op: 'hold', value: true });
        const observation = await observe(actor), loss = actor.loseTerminal();
        const call = request(observation, 'aa', 'read_ref', { q: 'lost', file: fileRef('aa') }, 'lost'), work = actor.client.invoke(call);
        await loss.entered;expect(actor.calls.length).toBe(1);loss.disconnect();
        expect(await work).toMatchObject({ kind: 'unavailable', code: 'APP_INTERACTION_UNAVAILABLE' });
        expect(actor.facts).toContainEqual({ kind: 'unknown' });
        const afterLoss = counts(actor);
        expect(await actor.client.invoke(call)).toMatchObject({ kind: 'refused', code: 'APP_INTERACTION_UNAVAILABLE' });expect(actor.calls.length).toBe(1);
        expectDelta(actor, afterLoss, { entries: 0, guards: 0, business: 0, dispatches: 0 });
        evidence.push({ producer: name, fault: actor.kind === 'plain' ? 'controlled real execution port' : 'actual Node Worker terminated after entry',
            underlying: actor.facts, caller: 'APP_INTERACTION_UNAVAILABLE', handlers: actor.calls.length });
    } finally { await actor.finish(); }
}, 20000);
