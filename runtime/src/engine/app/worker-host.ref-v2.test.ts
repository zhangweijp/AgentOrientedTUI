import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, readFile, writeFile, symlink, cp, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { compileSnapshotValueParams } from '../../core/tool/snapshot-value-parameter-contract.js';
import { compileOrdinaryParams } from '../../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../../core/tool/ordinary-parameter-profile.js';
import { REF_V2_CAPABILITY } from '../../adapters/ref-invocation-v2.js';
import { REF_V1_CAPABILITY } from '../../adapters/ref-invocation-v1.js';
import { ORDINARY_V1_CAPABILITY } from '../../adapters/ordinary-invocation-v1.js';
import { ORDINARY_V2_CAPABILITY } from '../../adapters/ordinary-invocation-v2.js';
import { CREATE_IF_ABSENT_V1_CAPABILITY } from '../../adapters/create-if-absent-invocation-v1.js';
const ALL = ['ordinary-v1', 'ordinary-v2', 'snapshot-value-v1', 'snapshot-value-v2', 'create-if-absent-v1'];
const CAPS = [ORDINARY_V1_CAPABILITY, ORDINARY_V2_CAPABILITY, REF_V1_CAPABILITY, REF_V2_CAPABILITY, CREATE_IF_ABSENT_V1_CAPABILITY];
const invokes = (m: any) => /^VIEW_TOOL_INVOKE_(REF_V[12]|ORDINARY_V[12]|CREATE_IF_ABSENT_V1)$/.test(m.type);
const viewInvokes = (m: any) => invokes(m) || m.type === 'VIEW_TOOL_INVOKE';
const closing: Array<() => Promise<void> | void> = [], facts: any[] = [];
let tag = 0;
afterEach(async () => { for (const close of closing.splice(0)) await close();vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void;const promise = new Promise<void>(yes => { resolve = yes; });return { promise, resolve }; }
function project({ source, selection }: any) {
    const ids = new Set(selection.viewIds);return { views: source.views.filter((v: any) => ids.has(v.id)).map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
        refs: Object.values(source.refs).filter((r: any) => ids.has(r.ownerViewId)).map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
        targets: Object.values(source.tools).flatMap((t: any) => t.targets.filter((t: any) => ids.has(t.viewId)).map((target: any) => ({ toolId: t.id, target }))), content: [] };
}
function scope(x: any, visible = ['aa', 'bb', 'legacy']) {
    const authorizations: any[] = [], invocations: any[] = [], observations: any[] = [], control = { authorize: (_c: any): any => true };
    const opened = x.host.createInteractionScope({ project: (ctx: any) => project(ctx), authorize: (c: any) => { authorizations.push({ source: c.source, rawInput: c.rawInput, effectiveInput: c.effectiveInput, refSources: c.refSources });return control.authorize(c); }, canReadReceipt: () => true });
    expect(opened.status).toBe('opened');if (opened.status !== 'opened') throw Error(opened.issue.code);
    const client = opened.client;x.scopes ??= [];x.scopes.push({ authorizations, invocations, observations });closing.push(() => client.close());
    return { client, control, authorizations, async observe(ids = visible) { const r = await client.observe({ viewIds: ids });observations.push(r);expect(r.status).toBe('observed');return r.observation; },
        request(o: any, name = 'inspect', input: any = { file: 'file', choice: 'ok' }, view = 'aa') { const tool = o.tools.find((t: any) => t.name === name);expect(tool).toBeDefined();const binding = o.bindings.find((b: any) => b.toolId === tool.id && b.target.viewId === view);expect(binding).toBeDefined();return { invocationId: 'i-' + (++tag), observationId: o.observationId, bindingId: binding.bindingId, input }; },
        async invoke(request: any) { const id = Object.getOwnPropertyDescriptor(request, 'invocationId')?.value;const result = await client.invoke(request);invocations.push({ invocationId: id, result });return result; } };
}
function receipt(r: any) { expect(r.kind).toBe('receipt');return r.receipt; }
function value(r: any) { const result = receipt(r);expect(result.outcome.status).toBe('succeeded');return result.outcome.value; }
class Transport extends EventEmitter {
    sent: any[] = [];hold = false;ack: any = CAPS;toolFault?: 'post' | 'error' | 'exit';
    postMessage = vi.fn((m: any) => { this.sent.push(m);this.emit('test-posted', m);if (viewInvokes(m)) {
        if (this.toolFault === 'post') throw Error('controlled postMessage failure');
        if (this.toolFault) { this.emit(this.toolFault, this.toolFault === 'error' ? Error('controlled Worker error') : 1);return; }
        if (!this.hold) this.answer(m);
    }
        else this.emit('message', { type: m.type === 'INIT' ? 'INIT_RESPONSE' : m.type === 'RESET' ? 'RESET_RESPONSE' : 'LIFECYCLE_RESPONSE', requestId: m.requestId, success: true,
            ...(m.type === 'INIT' ? { appInstanceId: m.appInstanceId, acceptedCapabilities: this.ack } : {}) }); });
    answer(m: any, patch = {}) { this.emit('message', { type: m.type === 'VIEW_TOOL_INVOKE' ? 'OPERATION_RESPONSE' : m.type + '_RESPONSE', requestId: m.requestId, appId: m.appId, instanceId: m.instanceId, argumentMode: m.argumentMode, success: true,
        ...(m.type === 'VIEW_TOOL_INVOKE' ? { result: { success: true, data: { controlled: true } } } : {}),
        terminal: m.argumentMode === 'create-if-absent-v1' ? { phase: 'entered-returned', outcome: { status: 'succeeded', value: { controlled: true } } } : { phase: 'entered-returned', result: { success: true, data: { controlled: true } } }, ...patch }); }
    terminate = vi.fn(async () => 0);
}
async function controlled(modes = ALL, ack: any = CAPS) {
    const worker = new Transport();worker.ack = arguments.length > 1 ? arguments[1] : ack;const host = new AppWorkerHost({ appId: 'app' as any, desktopId: 'd' as any, appModulePath: '/unused', existingWorker: worker as any, timeout: 150, snapshotShadow: true, experimentalReadOnlyViewTools: true, experimentalInteractionModes: modes as any });
    closing.push(() => host.terminate());await host.start();await host.open();
    const c = compileSnapshotValueParams({ file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } });const ordinary = compileOrdinaryParams({});if (!c.ok || !ordinary.ok) throw Error('fixture');
    const target = { viewId: 'aa', viewInstanceId: 'mount', bindingVersion: 1 };
    const tool = (name: string, inputSchema: any, isMutating = false) => ({ id: JSON.stringify(['app', 'File', name]), viewType: 'File', name, description: name, inputSchema, isMutating, targets: [target] });
    const tools = [tool('inspect', c.contract.schema), tool('old_read', { type: 'object', properties: { file: { type: 'string', 'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target' } } }, required: ['file'] }),
        tool('plain', ordinaryParameterProfile(ordinary.contract)), tool('zero', { type: 'object', properties: {}, required: [], additionalProperties: false }),
        tool('create', { type: 'object', properties: { relativePath: { type: 'string' }, content: { type: 'string' } }, required: ['relativePath', 'content'], additionalProperties: false }, true)];
    worker.emit('message', { type: 'SNAPSHOT_PREPARED', draft: { schemaVersion: 2, appId: 'app', instanceId: host.appInstanceId, producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
        views: [{ id: 'aa', viewInstanceId: 'mount', type: 'File', name: 'File', kind: 'state', content: { format: 'markdown-v1', value: 'File' } }],
        refs: { '["aa","mount","file"]': { id: 'file', ownerViewId: 'aa', ownerViewInstanceId: 'mount', refType: 'unknown', target: { kind: 'snapshot-value', payload: { label: 'A' } } } }, tools: Object.fromEntries(tools.map(t => [t.id, t])) } });
    const x: any = { host, worker, posts: () => worker.sent.filter(invokes), entries: () => [] };
    const caseId = expect.getState().currentTestName;
    closing.push(() => { facts.push({ kind: 'controlled five-mode transport', caseId, instanceId: host.appInstanceId, modes, ack: worker.ack, sent: worker.sent, scopes: x.scopes, report: host.getInteractionReport() }); });return x;
}
const calls = [['inspect', { file: 'file' }], ['old_read', { file: 'file' }], ['plain', {}], ['zero', {}], ['create', { relativePath: 'a', content: 'v' }]] as const;
function legacy(x: any, o: any, kind: 'ref' | 'generic', authorize: any) {
    const tool = o.tools.find((t: any) => t.name === (kind === 'ref' ? 'old_read' : 'zero'));
    return x.host[kind === 'ref' ? 'executeSnapshotValueRefTool' : 'executeReadOnlyViewTool']({
        snapshotId: o.source.snapshotId, toolId: tool.id, viewId: 'aa', args: kind === 'ref' ? { file: 'file' } : {},
    }, authorize);
}
describe('R03/R18/R19 exact negotiation and shared pending across five Wire modes', () => {
    it('requires explicit new capability and refuses the old compatibility entry before policy, releasing its lease', async () => {
        const x = await controlled(), s = scope(x, ['aa']), o = await s.observe();expect(x.host.hasSnapshotValueParametersCapability()).toBe(true);
        const t = o.tools.find((t: any) => t.name === 'inspect'), authorize = vi.fn(() => true);
        const r = await x.host.executeSnapshotValueRefTool({ snapshotId: o.source.snapshotId, toolId: t.id, viewId: 'aa', args: { file: 'file' } }, authorize);
        expect(r).toMatchObject({ success: false, error: { code: 'REF_CONTRACT_UNSUPPORTED' } });expect(authorize).not.toHaveBeenCalled();expect(x.posts()).toHaveLength(0);
        s.client.close();expect((x.host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
    });
    it.each([undefined, [], [REF_V1_CAPABILITY], ['unknown'], [REF_V2_CAPABILITY, REF_V2_CAPABILITY]])('does not infer Ref V2 from ACK %j', async ack => {
        const x = await controlled(['snapshot-value-v2'], ack);expect(x.host.hasSnapshotValueParametersCapability()).toBe(false);expect(x.host.createInteractionScope({ project, authorize: () => true, canReadReceipt: () => true }).status).toBe('rejected');
    });
    it.each(calls.map(([name, input]) => ({ name, input })))('a lost $name terminal stops new dispatch for every mode', async ({ name, input }) => {
        const x = await controlled(), s = scope(x, ['aa']), o = await s.observe();x.worker.hold = true;
        expect(receipt(await s.invoke(s.request(o, name, input))).outcome.status).toBe('unknown');expect(x.host.getInteractionReport().transportUncertain).toBe(true);const count = x.posts().length;
        for (const [next, args] of calls) await s.invoke(s.request(o, next, args));expect(x.posts()).toHaveLength(count);
        const authorize = vi.fn(() => true), all = x.worker.sent.filter(viewInvokes).length;
        for (const kind of ['ref', 'generic'] as const) expect((await legacy(x, o, kind, authorize)).success).toBe(false);
        expect(authorize).not.toHaveBeenCalled();expect(x.worker.sent.filter(viewInvokes)).toHaveLength(all);
        s.client.close();expect((x.host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);expect(await x.host.releaseWorker()).toBe(null);
    });
    it('R18 uncertainty fences the pre-Scope Ref V1 compatibility entry before policy', async () => {
        const x = await controlled(), s = scope(x, ['aa']), o = await s.observe();x.worker.hold = true;
        expect(receipt(await s.invoke(s.request(o, 'inspect', { file: 'file' }))).outcome.status).toBe('unknown');const count = x.posts().length;
        const tool = o.tools.find((t: any) => t.name === 'old_read'), authorize = vi.fn(() => true);
        const result = await x.host.executeSnapshotValueRefTool({ snapshotId: o.source.snapshotId, toolId: tool.id, viewId: 'aa', args: { file: 'file' } }, authorize);
        expect(result.success).toBe(false);expect(authorize).not.toHaveBeenCalled();expect(x.posts()).toHaveLength(count);
    });
    it.each(['timeout', 'invalid-terminal'])('R18 legacy-first %s must fence a following Ref V2 Scope', async kind => {
        const x = await controlled(), s = scope(x, ['aa']), o = await s.observe(), posted = deferred();x.worker.hold = true;
        x.worker.on('test-posted', (m: any) => { if (m.type === 'VIEW_TOOL_INVOKE_REF_V1') posted.resolve(); });const tool = o.tools.find((t: any) => t.name === 'old_read');
        const running = x.host.executeSnapshotValueRefTool({ snapshotId: o.source.snapshotId, toolId: tool.id, viewId: 'aa', args: { file: 'file' } }, () => true);await posted.promise;
        if (kind === 'invalid-terminal') x.worker.answer(x.posts().find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V1'), { argumentMode: 'other' });
        expect(await running).toMatchObject({ success: false, error: { code: 'TOOL_OUTCOME_UNKNOWN' } });const count = x.posts().length;x.worker.hold = false;
        for (const [name, args] of calls) await s.invoke(s.request(o, name, args));
        const authorize = vi.fn(() => true);for (const next of ['ref', 'generic'] as const) expect((await legacy(x, o, next, authorize)).success).toBe(false);
        expect(authorize).not.toHaveBeenCalled();expect(x.worker.sent.filter(viewInvokes)).toHaveLength(count);expect(s.authorizations).toHaveLength(0);expect(x.host.getInteractionReport().transportUncertain).toBe(true);
        s.client.close();expect((x.host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);expect(await x.host.releaseWorker()).toBe(null);
    });
    it('R18 a held legacy authorization cannot post after another mode becomes uncertain and releases its prepared lease', async () => {
        const x = await controlled(), s = scope(x, ['aa']), o = await s.observe(), entered = deferred(), release = deferred();const tool = o.tools.find((t: any) => t.name === 'old_read');
        const legacy = x.host.executeSnapshotValueRefTool({ snapshotId: o.source.snapshotId, toolId: tool.id, viewId: 'aa', args: { file: 'file' } }, () => { entered.resolve();return release.promise.then(() => true); });
        await entered.promise;x.worker.hold = true;expect(receipt(await s.invoke(s.request(o, 'inspect', { file: 'file' }))).outcome.status).toBe('unknown');const count = x.posts().length;
        release.resolve();expect((await legacy).success).toBe(false);expect(x.posts()).toHaveLength(count);expect(x.posts().some((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V1')).toBe(false);
        s.client.close();expect((x.host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
    });
    it.each(['ref', 'generic'] as const)('F01 %s compatibility held authorization cannot cross later uncertainty', async kind => {
        const x = await controlled(), s = scope(x, ['aa']), o = await s.observe(), entered = deferred(), release = deferred();
        const pending = legacy(x, o, kind, () => { entered.resolve();return release.promise.then(() => true); });await entered.promise;
        x.worker.hold = true;expect(receipt(await s.invoke(s.request(o, 'inspect', { file: 'file' }))).outcome.status).toBe('unknown');
        const count = x.worker.sent.filter(viewInvokes).length;release.resolve();expect((await pending).success).toBe(false);
        expect(x.worker.sent.filter(viewInvokes)).toHaveLength(count);s.client.close();expect((x.host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
    });
    it.each((['ref', 'generic'] as const).flatMap(kind => (['timeout', 'post', 'error', 'exit'] as const).map(fault => ({ kind, fault }))))('F01 first $kind $fault fences all seven View Tool entries and cannot pool', async ({ kind, fault }) => {
        const x = await controlled(), s = scope(x, ['aa']), o = await s.observe();x.worker.hold = true;
        if (fault !== 'timeout') x.worker.toolFault = fault;
        expect((await legacy(x, o, kind, () => true)).success).toBe(false);expect(x.host.getInteractionReport().transportUncertain).toBe(true);
        const count = x.worker.sent.filter(viewInvokes).length, authorize = vi.fn(() => true);x.worker.hold = false;x.worker.toolFault = undefined;
        for (const [name, args] of calls) await s.invoke(s.request(o, name, args));
        for (const next of ['ref', 'generic'] as const) expect((await legacy(x, o, next, authorize)).success).toBe(false);
        expect(s.authorizations).toHaveLength(0);expect(authorize).not.toHaveBeenCalled();expect(x.worker.sent.filter(viewInvokes)).toHaveLength(count);
        // A late successful response cannot unlock this Host.
        x.worker.answer(x.worker.sent.filter(viewInvokes)[0]);expect(x.host.getInteractionReport().transportUncertain).toBe(true);
        s.client.close();expect((x.host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);expect(await x.host.releaseWorker()).toBe(null);
    });
    it.each(['ref', 'generic'] as const)('F01 trustworthy %s business failure preserves transport and subsequent dispatch', async kind => {
        const x = await controlled(), s = scope(x, ['aa']), o = await s.observe(), posted = deferred();x.worker.hold = true;
        x.worker.on('test-posted', (m: any) => { if (viewInvokes(m)) posted.resolve(); });const pending = legacy(x, o, kind, () => true);await posted.promise;
        const failure = { success: false, error: { code: 'BUSINESS_EXCEPTION', message: 'unknown timeout from business data' } };
        x.worker.answer(x.worker.sent.filter(viewInvokes)[0], kind === 'ref' ? { terminal: { phase: 'entered-returned', result: failure } } : { result: failure });
        expect(await pending).toEqual(failure);expect(x.host.getInteractionReport().transportUncertain).toBe(false);x.worker.hold = false;
        value(await s.invoke(s.request(o, 'inspect', { file: 'file' })));expect(x.worker.sent.filter(viewInvokes)).toHaveLength(2);
    });
    it('F01 lifecycle/control request post failure does not mark a View Tool uncertain', async () => {
        const x = await controlled(), s = scope(x, ['aa']);await s.observe();x.worker.postMessage.mockImplementationOnce(() => { throw Error('control failure'); });
        await expect(x.host.sendExternalEvent('probe', 'control', {})).rejects.toThrow();expect(x.host.getInteractionReport().transportUncertain).toBe(false);
    });
    it('F01 an unfinished generic View Tool cannot return the Worker to the pool', async () => {
        const x = await controlled(), s = scope(x, ['aa']), o = await s.observe(), posted = deferred();x.worker.hold = true;
        x.worker.on('test-posted', (m: any) => { if (m.type === 'VIEW_TOOL_INVOKE') posted.resolve(); });
        const pending = legacy(x, o, 'generic', () => true);await posted.promise;
        expect(await x.host.releaseWorker()).toBe(null);expect((await pending).success).toBe(false);
        expect(x.host.getInteractionReport().transportUncertain).toBe(true);expect(x.worker.sent.some((m: any) => m.type === 'RESET')).toBe(false);
        s.client.close();expect((x.host as any).shadowReceiver.core.store.inspect().activeLeases).toBe(0);
    });
});

let temporary: string, Host: any, OldHost: any, appFile: string, oldSdkApp: string, workerFile: string, oldWorkerFile: string;
function wait(x: any, predicate: (m: any) => boolean, from = 0): Promise<any> {
    const existing = x.messages.slice(from).find(predicate);if (existing) return Promise.resolve(existing);
    return new Promise((yes, no) => { const timer = setTimeout(() => { x.worker.off('message', receive);no(Error('Ref V2 barrier expired; ' + x.logs.join('').slice(-2000))); }, 5000);
        function receive(m: any) { if (predicate(m)) { clearTimeout(timer);x.worker.off('message', receive);yes(m); } }x.worker.on('message', receive); });
}
async function control(x: any, type: string, data: any = {}) { const id = ++tag, from = x.messages.length;await x.host.sendExternalEvent('ref-v2-probe', type, { ...data, tag: id });return wait(x, m => m.type === (type === 'state' ? 'REF_V2_COMMITTED' : 'REF_V2_CONTROL_ACK') && m.tag === id, from); }
async function change(x: any, patch: any, predicate: (draft: any) => boolean) { const from = x.messages.length;await control(x, 'state', { patch });return wait(x, m => m.type === 'SNAPSHOT_PREPARED' && predicate(m.draft), from); }
async function start(options: any = {}) {
    const caseId = options.caseId ?? expect.getState().currentTestName;
    const worker = options.existing ?? new Worker(options.worker ?? workerFile, { stdout: true, stderr: true, env: { ...process.env, AOTUI_DATA_DIR: join(temporary, 'data-' + (++tag)) } });
    const messages: any[] = [], rawMessages: any[] = [], sent: any[] = [], attempted: any[] = [], logs: string[] = [];let transform: ((m: any) => any) | undefined;
    const emit = worker.emit.bind(worker);worker.emit = (event: string, ...args: any[]) => { if (event === 'message') { rawMessages.push(args[0]);const changed = transform ? transform(args[0]) : args[0];if (changed === null) return false;args[0] = changed; }return emit(event, ...args); };
    const post = worker.postMessage.bind(worker);worker.postMessage = (m: any) => { attempted.push(m);sent.push(m);post(m); };
    worker.stdout?.on('data', (b: any) => logs.push(String(b)));worker.stderr?.on('data', (b: any) => logs.push(String(b)));
    const host = new (options.Host ?? Host)({ appId: 'app', desktopId: 'd', appModulePath: options.app ?? appFile, existingWorker: worker, timeout: 600,
        snapshotShadow: true, experimentalReadOnlyViewTools: true, experimentalInteractionModes: options.modes ?? ALL });
    worker.on('message', (m: any) => messages.push(m));
    const x: any = { host, worker, messages, rawMessages, sent, attempted, logs, transform(fn: any) { transform = fn; },
        entries: () => rawMessages.filter(m => m.type === 'REF_V2_HANDLER_ENTER'), posts: () => sent.filter(invokes), snapshot: () => host.shadowReceiver.core.store.readLatest('app').snapshot };
    closing.push(async () => { facts.push({ kind: 'actual Node Worker Ref V2 run', caseId, workerFile: options.worker ?? workerFile, hostKind: options.Host ? 'saved B3B Host' : 'current Host', appModulePath: options.app ?? appFile,
        instanceId: host.appInstanceId, threadId: worker.threadId, rawMessages, deliveredMessages: messages, sent, attempted, scopes: x.scopes, logs, report: host.getInteractionReport?.() });
        const owned = host.worker === worker;host.terminate();if (owned) await worker.terminate(); });
    await host.start();await host.open();await wait(x, m => m.type === 'SNAPSHOT_PREPARED');return x;
}
describe('R07–R24 actual SDK / emitted Host / Node Worker Ref V2', () => {
    beforeAll(async () => {
        const runtime = resolve(process.cwd()), sdk = resolve(runtime, '../sdk');temporary = await mkdtemp(join(tmpdir(), 'aotui-w07-b3c-'));
        workerFile = join(runtime, 'dist/worker-runtime/index.js');Host = (await import(pathToFileURL(join(runtime, 'dist/engine/app/worker-host.js')).href)).AppWorkerHost;
        const baseline = process.env.AOTUI_W07_B3B_BASELINE ?? resolve(process.env.AOTUI_REF_COMPAT_BASELINE ?? resolve(runtime, '../rfcs/sdk-runtime-delivery/w00-20261024T090930Z'), '../w07-b3b-20261025T194310Z');
        await mkdir(join(temporary, 'node_modules/@aotui'), { recursive: true });await mkdir(join(temporary, 'node_modules/@preact'));
        for (const [name, base] of [['preact', runtime], ['linkedom', runtime], ['@preact/signals', runtime]]) await symlink(join(base, 'node_modules', name), join(temporary, 'node_modules', name), 'dir');
        await symlink(runtime, join(temporary, 'node_modules/@aotui/runtime'), 'dir');
        for (const [name, selected] of [['app', sdk], ['old-sdk-app', join(baseline, 'artifacts/sdk')]]) {
            const outfile = join(temporary, name + '.mjs');const result = await build({ entryPoints: [join(runtime, 'tests/fixtures/ref-v2-slice.mjs')], outfile,
                alias: { '@aotui/sdk': join(selected, 'dist/index.js'), '@fixture/old-sdk': join(baseline, 'artifacts/sdk/dist/index.js') }, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', metafile: true, logLevel: 'silent' });
            await writeFile(outfile + '.metafile.json', JSON.stringify(result.metafile, null, 2));if (name === 'app') appFile = outfile;else oldSdkApp = outfile;
        }
        const old = join(temporary, 'old-runtime');await mkdir(old);await cp(join(baseline, 'artifacts/runtime/dist'), join(old, 'dist'), { recursive: true });await writeFile(join(old, 'package.json'), await readFile(join(runtime, 'package.json')));await symlink(join(runtime, 'node_modules'), join(old, 'node_modules'), 'dir');
        oldWorkerFile = join(old, 'dist/worker-runtime/index.js');OldHost = (await import(pathToFileURL(join(old, 'dist/engine/app/worker-host.js')).href)).AppWorkerHost;
        const modules = [appFile, oldSdkApp, workerFile, oldWorkerFile, join(runtime, 'dist/engine/app/worker-host.js'), join(old, 'dist/engine/app/worker-host.js'), join(sdk, 'dist/index.js'), join(sdk, 'dist/hooks/useReadOnlyTool.js'), join(baseline, 'artifacts/sdk/dist/hooks/useReadOnlyTool.js'), join(baseline, 'artifacts/sdk/dist/index.js'), join(baseline, 'artifacts/sdk/dist/utils/snapshot-value-tool.js')];
        const bodies = join(temporary, 'product-inputs');await mkdir(bodies);
        const inputs = [];
        for (const p of [...modules, appFile + '.metafile.json', oldSdkApp + '.metafile.json']) {
            const body = await readFile(p), sha256 = createHash('sha256').update(body).digest('hex'), capturedBody = join(bodies, sha256);
            await writeFile(capturedBody, body);inputs.push({ path: p, sha256, mode: (await stat(p)).mode & 0o777, capturedBody });
        }
        const accepted = JSON.parse(await readFile(join(baseline, 'artifact-manifest.json'), 'utf8')), savedProducts = [];
        async function files(folder: string, prefix = ''): Promise<string[]> { const rows = await readdir(folder, { withFileTypes: true });return (await Promise.all(rows.map(async row => row.isDirectory() ? files(join(folder, row.name), prefix + row.name + '/') : [prefix + row.name]))).flat(); }
        for (const [pkg, folder] of [['runtime', join(old, 'dist')], ['sdk', join(baseline, 'artifacts/sdk/dist')]]) {
            const expected = accepted.packages[pkg].files;expect((await files(folder)).sort()).toEqual(expected.map((r: any) => r.path).sort());
            for (const row of expected) { const p = join(folder, row.path);expect(createHash('sha256').update(await readFile(p)).digest('hex')).toBe(row.sha256);expect((await stat(p)).mode & 0o777).toBe(row.mode); }
            savedProducts.push({ package: pkg, folder, matchedFiles: expected.length, contentAndModeMatched: true });
        }
        facts.push({ kind: 'actual Ref V2 product inputs', baseline, runtime, sdk, node: process.version, inputs, savedProducts, capturedBeforeWorkerExecution: true });
    }, 30000);
    afterAll(async () => { if (process.env.AOTUI_W07_REF_V2_FACTS_FILE) await writeFile(process.env.AOTUI_W07_REF_V2_FACTS_FILE, JSON.stringify({ kind: 'Ref V2 controlled/actual evidence with explicit provenance', facts, afterAllReached: true }, null, 2)); });
    it('R08/R09/R12 really enters only the original target with one substituted slot and no default fill', async () => {
        const x = await start(), s = scope(x), o = await s.observe(), input = { file: 'file', choice: 'ok', text: '😀', tags: ['a', 'b'] };
        const a = value(await s.invoke(s.request(o, 'inspect', input, 'aa'))), b = value(await s.invoke(s.request(o, 'inspect', input, 'bb')));
        expect(a.data.view).toBe('aa');expect(b.data.view).toBe('bb');expect(a.data.args.file).toMatchObject({ label: 'A', view: 'aa' });expect(Object.hasOwn(a.data.args, 'n')).toBe(false);
        const post = x.posts().find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2' && m.target.viewId === 'aa');expect(post.rawArgs).toEqual(input);expect(post.effectiveArgs).toEqual(a.data.args);expect(post.tool.inputSchema['x-aotui-parameter-contract']).toBe('snapshot-value-params-v1');
        expect(post.refSources[0]).toMatchObject({ refId: 'file', snapshotId: post.snapshotId, viewId: 'aa' });expect(s.authorizations.find(a => a.source.target.viewId === 'aa').effectiveInput).toEqual(a.data.args);
        expect(x.entries().filter((e: any) => e.name === 'inspect')).toHaveLength(2);
    });
    it.each(['enum', 'array', 'range', 'required', 'extra', 'null', 'getter'])('R08/R21 invalid %s never authorizes/posts/enters', async kind => {
        const x = await start(), s = scope(x), o = await s.observe();let reads = 0;const input: any = { file: 'file', choice: 'ok' };
        if (kind === 'enum') input.choice = 7;if (kind === 'array') input.tags = ['a'];if (kind === 'range') input.n = 5;
        if (kind === 'required') delete input.choice;if (kind === 'extra') input.private = 'REF_V2_PRIVATE_INPUT';if (kind === 'null') input.meta = null;
        if (kind === 'getter') Object.defineProperty(input, 'n', { enumerable: true, get() { reads++;return 2; } });
        const result = await s.invoke(s.request(o, 'inspect', input));expect(result.kind === 'receipt' ? result.receipt.outcome.status : result.code).not.toBe('succeeded');
        expect(s.authorizations).toHaveLength(0);expect(x.posts()).toHaveLength(0);expect(x.entries()).toHaveLength(0);expect(reads).toBe(0);expect(JSON.stringify([x.sent, x.logs])).not.toContain('REF_V2_PRIVATE_INPUT');
    });
    it('R09/R13 uses historical A while the current committed handler observes revision2 without rebind', async () => {
        const x = await start(), s = scope(x), o = await s.observe();const request = s.request(o);const binding = o.bindings.find((b: any) => b.bindingId === request.bindingId);
        await change(x, { text: 'B', revision: 2 }, d => Object.values(d.refs).some((r: any) => r.ownerViewId === 'aa' && r.id === 'file' && r.target.payload.label === 'B'));
        const output = value(await s.invoke(request));expect(output.data.args.file.label).toBe('A');expect(output.data.revision).toBe(2);
        expect(x.posts().find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2').target.bindingVersion).toBe(binding.target.bindingVersion);
    });
    it('R21 preserves open ordinary literals and whitespace without treating data as Schema markers', async () => {
        const x = await start(), s = scope(x), o = await s.observe();const extra = { 'x-aotui-ref': { kind: 'DATA' }, 'x-aotui-parameter-contract': 'DATA', refSource: 'DATA', text: '  unchanged  ' };
        const output = value(await s.invoke(s.request(o, 'open_ref', { file: 'file', extra })));expect(output.data.args.extra).toEqual(extra);expect(output.data.args.file.literal).toEqual({ 'x-aotui-ref': { kind: 'DATA' }, 'x-aotui-parameter-contract': 'DATA', refSource: 'DATA' });
        expect(x.entries()).toHaveLength(1);expect(x.entries()[0].frozen).toBe(true);expect(x.entries()[0].refFrozen).toBe(true);
    });
    it('R21 preserves special own Ref parameter names through real Core/codec/SDK execution', async () => {
        const x = await start(), s = scope(x), o = await s.observe();const names = ['', '__proto__', 'constructor', 'x-aotui-ref', 'x-aotui-parameter-contract', 'line\nname'];
        for (const [index, param] of names.entries()) {
            const result = value(await s.invoke(s.request(o, 'special_' + index, Object.fromEntries([[param, 'file']]))));expect(Object.hasOwn(result.data.args, param)).toBe(true);expect(result.data.args[param]).toMatchObject({ label: 'A', view: 'aa' });
            const request = x.posts().find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2' && m.tool.name === 'special_' + index);expect(request.refSources[0].param).toBe(param);
        }
        expect(x.entries()).toHaveLength(names.length);expect(x.entries().every((e: any) => e.frozen && e.refFrozen)).toBe(true);
    });
    it.each(['foreign', 'type'])('R10 refuses %s Ref before policy', async kind => {
        const x = await start(), s = scope(x, ['aa']), o = await s.observe();const result = receipt(await s.invoke(s.request(o, kind === 'type' ? 'typed' : 'inspect', { file: kind === 'foreign' ? 'foreign-bb' : 'file', ...(kind === 'foreign' ? { choice: 'ok' } : {}) })));
        expect(result.outcome.code).toBe(kind === 'type' ? 'REF_TYPE_MISMATCH' : 'REF_NOT_VISIBLE');expect(s.authorizations).toHaveLength(0);expect(x.posts()).toHaveLength(0);expect(x.entries()).toHaveLength(0);
    });
    it.each(['default', 'ref-metadata', 'unmount', 'scope'])('R11 revokes %s during awaited policy before dispatch', async kind => {
        const x = await start();await change(x, { showSecond: false }, d => !d.views.some((v: any) => v.id === 'bb'));
        const s = scope(x, ['aa']), o = await s.observe(), entered = deferred(), release = deferred();s.control.authorize = () => { entered.resolve();return release.promise.then(() => true); };
        const running = s.invoke(s.request(o));await entered.promise;
        if (kind === 'default') await change(x, { defaultValue: 3 }, d => Object.values(d.tools).some((t: any) => t.name === 'inspect' && t.inputSchema.properties.n.default === 3));
        if (kind === 'ref-metadata') await change(x, { refType: 'File' }, d => Object.values(d.tools).some((t: any) => t.name === 'inspect' && t.inputSchema.properties.file['x-aotui-ref'].refType === 'File'));
        if (kind === 'unmount') await change(x, { show: false }, d => !d.views.some((v: any) => v.id === 'aa'));if (kind === 'scope') s.client.close();release.resolve();
        const result = await running;expect(result.code ?? result.receipt.outcome.code).toBe(kind === 'default' || kind === 'ref-metadata' ? 'TOOL_SOURCE_STALE' : kind === 'unmount' ? 'VIEW_INSTANCE_REVOKED' : 'SCOPE_UNAVAILABLE');expect(x.posts()).toHaveLength(0);expect(x.entries()).toHaveLength(0);
    });
    it.each([5001, 10000, 10001])('R20 full effective %i-node real Worker boundary', async nodes => {
        const x = await start();await change(x, { capacityNodes: nodes }, d => Object.values(d.refs).some((r: any) => r.ownerViewId === 'aa' && r.id === 'big' && r.target.payload.list.length === nodes - 3));
        const s = scope(x, ['aa']), o = await s.observe(), result = await s.invoke(s.request(o, 'capacity', { file: 'big' }));
        if (nodes <= 10000) { expect(value(result).data.nodes).toBe(nodes);expect(s.authorizations).toHaveLength(1);expect(x.posts()).toHaveLength(1);expect(x.entries()).toHaveLength(1);expect(x.entries()[0].nestedFrozen).toBe(true); }
        else { expect(receipt(result).outcome.code).toBe('REF_ARGUMENT_BUDGET_EXCEEDED');expect(s.authorizations).toHaveLength(0);expect(x.posts()).toHaveLength(0);expect(x.entries()).toHaveLength(0); }
    });
    it('R20 oversized raw input is refused before policy and Worker dispatch', async () => {
        const x = await start(), s = scope(x), o = await s.observe(), result = await s.invoke(s.request(o, 'open_ref', { file: 'file', extra: { value: 'x'.repeat(150000) } }));
        expect(result.kind === 'receipt' ? result.receipt.outcome.status : result.code).not.toBe('succeeded');expect(s.authorizations).toHaveLength(0);expect(x.posts()).toHaveLength(0);expect(x.entries()).toHaveLength(0);
    });
    it('R14 unmount/re-mount revokes old target and disabled Tools never enter', async () => {
        const x = await start(), s = scope(x), o = await s.observe(), old = s.request(o);
        await change(x, { enabled: false }, d => !Object.values(d.tools).some((t: any) => t.name === 'inspect'));
        expect(receipt(await s.invoke(old)).outcome.status).toBe('rejected');expect(x.entries()).toHaveLength(0);
        await change(x, { enabled: true }, d => Object.values(d.tools).some((t: any) => t.name === 'inspect'));value(await s.invoke(s.request(await s.observe())));
        const before = await s.observe(), stale = s.request(before);await change(x, { show: false }, d => !d.views.some((v: any) => v.id === 'aa'));
        await change(x, { show: true }, d => d.views.some((v: any) => v.id === 'aa'));expect(receipt(await s.invoke(stale)).outcome.status).toBe('rejected');value(await s.invoke(s.request(await s.observe())));
    });
    it('R10 actual Worker rejects a foreign App instance before entering its callable', async () => {
        const x = await start(), s = scope(x), o = await s.observe();value(await s.invoke(s.request(o)));const source = x.posts().find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2');
        const requestId = 'foreign-' + (++tag), from = x.messages.length, count = x.entries().length;
        x.worker.postMessage({ ...source, requestId, instanceId: 'other' });
        const response = await wait(x, m => m.type === 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE' && m.requestId === requestId, from);expect(response.terminal).toMatchObject({ phase: 'not-entered', result: { error: { code: 'APP_INSTANCE_MISMATCH' } } });expect(x.entries()).toHaveLength(count);
    });
    it.each(['disable', 'replace'])('R15 Worker refuses the old binding after a queued request is %s', async kind => {
        const x = await start();await change(x, { showSecond: false }, d => !d.views.some((v: any) => v.id === 'bb'));const s = scope(x, ['aa']), o = await s.observe(), queued: any[] = [], held = deferred();
        const physical = x.worker.postMessage.bind(x.worker);x.worker.postMessage = (m: any) => { if (m.type === 'VIEW_TOOL_INVOKE_REF_V2') { queued.push(m);held.resolve(); }else physical(m); };
        const running = s.invoke(s.request(o));await held.promise;
        if (kind === 'disable') await change(x, { enabled: false }, d => !Object.values(d.tools).some((t: any) => t.name === 'inspect'));
        else await change(x, { defaultValue: 3 }, d => Object.values(d.tools).some((t: any) => t.name === 'inspect' && t.inputSchema.properties.n.default === 3));
        expect(queued).toHaveLength(1);expect(queued[0].tool.inputSchema['x-aotui-parameter-contract']).toBe('snapshot-value-params-v1');physical(queued[0]);
        const result = receipt(await running);expect(result.outcome.status).toBe('rejected');expect(x.entries()).toHaveLength(0);expect(x.host.getInteractionReport().transportUncertain).toBe(false);
        const terminal = x.rawMessages.find((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE' && m.requestId === queued[0].requestId);expect(terminal.terminal.phase).toBe('not-entered');
    });
    it.each(['business', 'throw'])('R16 keeps %s failure details and healthy transport', async mode => {
        const x = await start();await control(x, 'mode', { mode });const s = scope(x), o = await s.observe(), result = receipt(await s.invoke(s.request(o)));
        expect(result.executionPhase).toBe('entered-returned');expect(result.outcome.details.result.error.code).toBe(mode === 'business' ? 'BUSINESS' : 'E_HANDLER_ERROR');
        expect(x.host.getInteractionReport().transportUncertain).toBe(false);expect(JSON.stringify(x.messages)).not.toContain('REF_V2_PRIVATE_EXCEPTION');
    });
    it.each(['drop', 'type', 'mode', 'instance', 'request', 'huge'])('R17 %s terminal cannot be trusted or recycled', async kind => {
        const x = await start();if (kind === 'huge') await control(x, 'mode', { mode: 'huge' });
        x.transform((m: any) => m.type !== 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE' ? m : kind === 'drop' ? null : kind === 'type' ? { ...m, type: 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE' } : kind === 'mode' ? { ...m, argumentMode: 'snapshot-value-v1' } : kind === 'instance' ? { ...m, instanceId: 'other' } : kind === 'request' ? { ...m, requestId: 'other' } : m);
        const s = scope(x), o = await s.observe(), result = receipt(await s.invoke(s.request(o)));expect(result.outcome.status).toBe('unknown');expect(x.host.getInteractionReport().transportUncertain).toBe(true);expect(x.entries()).toHaveLength(1);
        const count = x.posts().length;await s.invoke(s.request(o));expect(x.posts()).toHaveLength(count);expect(await x.host.releaseWorker()).toBe(null);
    });
    it('R17 a Worker exit while the handler is held is unknown with no automatic retry', async () => {
        const x = await start();await control(x, 'mode', { mode: 'hold' });const s = scope(x), o = await s.observe(), request = s.request(o), running = s.invoke(request);await wait(x, m => m.type === 'REF_V2_HANDLER_ENTER');await x.worker.terminate();
        expect(await running).toMatchObject({ kind: 'unavailable', code: 'SCOPE_UNAVAILABLE' });expect(x.host.getInteractionReport().transportUncertain).toBe(true);expect(x.posts()).toHaveLength(1);expect(x.entries()).toHaveLength(1);expect(await x.host.releaseWorker()).toBe(null);
    });
    it.each(['inspect', 'old_read', 'plain', 'zero', 'create'])('R18 actual %s response loss closes new dispatch across five modes', async name => {
        const x = await start(), s = scope(x), o = await s.observe();x.transform((m: any) => /^VIEW_TOOL_INVOKE_.*_RESPONSE$/.test(m.type) ? null : m);
        const request = name === 'inspect' ? s.request(o) : name === 'old_read' ? s.request(o, name, { file: 'file', choice: 'ok' }, 'legacy') : name === 'create' ? s.request(o, name, { relativePath: 'a', content: 'v' }, 'legacy') : s.request(o, name, {}, name === 'zero' ? 'legacy' : 'aa');
        expect(receipt(await s.invoke(request)).outcome.status).toBe('unknown');expect(x.entries()).toHaveLength(1);expect(x.host.getInteractionReport().transportUncertain).toBe(true);const count = x.posts().length;
        for (const [next, args] of calls) await s.invoke(s.request(o, next, next === 'inspect' ? { file: 'file', choice: 'ok' } : args, next === 'old_read' || next === 'zero' || next === 'create' ? 'legacy' : 'aa'));
        expect(x.posts()).toHaveLength(count);expect(x.entries()).toHaveLength(1);expect(await x.host.releaseWorker()).toBe(null);
    });
    it('R18 healthy RESET reuses the actual Worker under a new App identity', async () => {
        const x = await start(), s = scope(x), o = await s.observe();value(await s.invoke(s.request(o)));s.client.close();const id = x.host.appInstanceId, thread = x.worker.threadId, pooled = await x.host.releaseWorker();expect(pooled).toBe(x.worker);
        const next = await start({ existing: pooled, caseId: 'healthy reused worker' });expect(next.worker.threadId).toBe(thread);expect(next.host.appInstanceId).not.toBe(id);const n = scope(next), observed = await n.observe();value(await n.invoke(n.request(observed)));
    }, 10000);
    it.each(['healthy', 'uncertain'])('R19 old generic View-owned compatibility keeps its %s boundary', async state => {
        const x = await start(), s = scope(x), o = await s.observe();
        if (state === 'uncertain') { x.transform((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE' ? null : m);expect(receipt(await s.invoke(s.request(o))).outcome.status).toBe('unknown'); }
        const tool = o.tools.find((t: any) => t.name === 'zero'), authorize = vi.fn(() => true), before = x.entries().length, posts = x.sent.filter((m: any) => m.type === 'VIEW_TOOL_INVOKE').length;
        const result = await x.host.executeReadOnlyViewTool({ snapshotId: o.source.snapshotId, toolId: tool.id, viewId: 'legacy', args: {} }, authorize);
        expect(result.success).toBe(state === 'healthy');expect(authorize).toHaveBeenCalledTimes(state === 'healthy' ? 1 : 0);expect(x.entries()).toHaveLength(before + (state === 'healthy' ? 1 : 0));
        expect(x.sent.filter((m: any) => m.type === 'VIEW_TOOL_INVOKE')).toHaveLength(posts + (state === 'healthy' ? 1 : 0));
    });
    it('R23 same new Worker keeps saved old SDK Ref helper and new SDK Hook rules distinct', async () => {
        const x = await start(), s = scope(x), o = await s.observe();
        expect(value(await s.invoke(s.request(o, 'old_read', { file: 'file', choice: 7 }, 'legacy'))).data.args.choice).toBe(7);
        const before = s.authorizations.length;expect(receipt(await s.invoke(s.request(o, 'inspect', { file: 'file', choice: 7 }))).outcome.status).toBe('rejected');expect(s.authorizations).toHaveLength(before);
        expect(receipt(await s.invoke(s.request(o, 'old_read', { file: 'file', text: '😀' }, 'legacy'))).outcome.status).toBe('rejected');
        expect(value(await s.invoke(s.request(o, 'inspect', { file: 'file', choice: 'ok', text: '😀' }))).data.args.text).toBe('😀');
        expect(x.posts().some((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V1')).toBe(true);expect(x.posts().some((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2')).toBe(true);
    });
    it.each(['off', 'old-worker', 'old-sdk', 'old-host'])('R22 uses actual saved product combination %s', async kind => {
        const x = await start({ caseId: kind, ...(kind === 'off' ? { modes: ALL.filter(m => m !== 'snapshot-value-v2') } : {}), ...(kind === 'old-worker' ? { worker: oldWorkerFile } : {}), ...(kind === 'old-sdk' ? { app: oldSdkApp } : {}), ...(kind === 'old-host' ? { Host: OldHost, modes: ALL.filter(m => m !== 'snapshot-value-v2') } : {}) });
        if (kind === 'old-host') { const authorize = vi.fn(() => true);const r = await x.host.executeSnapshotValueRefTool({ snapshotId: 'unavailable-new-profile', toolId: JSON.stringify(['app', 'File', 'inspect']), viewId: 'aa', args: { file: 'file', choice: 'ok' } }, authorize);expect(r.success).toBe(false);expect(authorize).not.toHaveBeenCalled();expect(x.posts()).toHaveLength(0);expect(x.rawMessages.some((m: any) => m.type === 'SNAPSHOT_PREPARED' && Object.values(m.draft.tools).some((t: any) => t.inputSchema['x-aotui-parameter-contract'] === 'snapshot-value-params-v1'))).toBe(true); }
        else { const s = scope(x), o = await s.observe();if (kind === 'old-sdk' || kind === 'old-worker') { expect(o.tools.some((t: any) => t.name === 'inspect')).toBe(false);await wait(x, m => m.type === 'REF_V2_UNSUPPORTED');value(await s.invoke(s.request(o, 'old_read', { file: 'file', choice: 7 }, 'legacy'))); }
            else { expect(x.host.hasSnapshotValueParametersCapability()).toBe(false);expect(receipt(await s.invoke(s.request(o))).outcome.status).toBe('rejected'); }
            expect(x.posts().some((m: any) => m.type === 'VIEW_TOOL_INVOKE_REF_V2')).toBe(false); }
    });
});
