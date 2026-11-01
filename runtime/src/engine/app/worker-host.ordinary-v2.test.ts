import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { compileOrdinaryParams } from '../../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../../core/tool/ordinary-parameter-profile.js';
const ALL = ['ordinary-v2', 'snapshot-value-v2'] as const;
const closing: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close(); vi.restoreAllMocks(); });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => resolve = yes); return { promise, resolve }; }
function project({ source, selection }: any) {
  const ids = new Set(selection.viewIds);
  return { views: source.views.filter((v: any) => ids.has(v.id)).map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
    refs: Object.values(source.refs).filter((r: any) => ids.has(r.ownerViewId)).map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
    targets: Object.values(source.tools).flatMap((t: any) => t.targets.filter((v: any) => ids.has(v.viewId)).map((target: any) => ({ toolId: t.id, target }))), content: [] };
}
function scope(x: any) {
  const authorized: any[] = [], control = { authorize: (_c: any): any => true, canRead: (_m: any, _s: any): any => true };
  const recorded = { authorizations: [] as any[], invocations: [] as any[], observations: [] as any[] };
  (x.scopeFacts ??= []).push(recorded);
  const opened = x.host.createInteractionScope({ project, authorize(c: any) {
    authorized.push(c); recorded.authorizations.push({ scopeId: c.scopeId, invocationId: c.invocationId, rawInput: c.rawInput, effectiveInput: c.effectiveInput,
      target: c.source.target, instanceId: c.source.instanceId }); return control.authorize(c);
  }, canReadReceipt: (m: any, s: any) => control.canRead(m, s) });
  expect(opened.status).toBe('opened'); if (opened.status !== 'opened') throw Error(opened.issue.code);
  const original = opened.client;
  const client = { ...original, async invoke(request: unknown) {
    const invocationId = request && typeof request === 'object' ? Object.getOwnPropertyDescriptor(request, 'invocationId')?.value : null;
    const response = await original.invoke(request); recorded.invocations.push({ invocationId, response }); return response;
  } };
  return { client, control, authorized, async observe(view = 'aa') { const r = await client.observe({ viewIds: [view] }); recorded.observations.push(r); expect(r.status).toBe('observed'); return r.observation; },
    request(o: any, invocationId: string, name = 'find', input: any = {}, view = 'aa') {
      const tool = o.tools.find((t: any) => t.name === name); expect(tool).toBeDefined();
      const target = o.bindings.find((b: any) => b.toolId === tool.id && b.target.viewId === view); expect(target).toBeDefined();
      return { invocationId, observationId: o.observationId, bindingId: target.bindingId, input };
    } };
}
function receipt(r: any) { expect(r.kind).toBe('receipt'); if (r.kind !== 'receipt') throw Error(r.code); return r.receipt; }
function value(r: any) { const rcp = receipt(r); expect(rcp.outcome.status).toBe('succeeded'); return rcp.outcome.value; }
const isInvoke = (m: any) => /^VIEW_TOOL_INVOKE_(ORDINARY_V2|REF_V2)$/.test(m.type);

let temporary: string, Host: any, appFile: string, workerFile: string;
const facts: any[] = []; let tag = 0;
function wait(x: any, predicate: (m: any) => boolean, from = 0): Promise<any> {
  const existing = x.messages.slice(from).find(predicate); if (existing) return Promise.resolve(existing);
  return new Promise((yes, no) => { const timer = setTimeout(() => { x.worker.off('message', receive); no(Error('W07 explicit barrier expired; ' + x.logs.join('').slice(-3000))); }, 5000);
    function receive(m: any) { if (predicate(m)) { clearTimeout(timer); x.worker.off('message', receive); yes(m); } } x.worker.on('message', receive); });
}
async function control(x: any, type: string, data: any = {}) { const id = ++tag, from = x.messages.length;
  await x.host.sendExternalEvent('probe', type, { ...data, tag: id });
  return wait(x, m => m.type === (type === 'state' ? 'TEST_COMMITTED' : 'TEST_CONTROL_ACK') && m.tag === id, from); }
async function change(x: any, patch: any, predicate: (draft: any) => boolean) {
  const from = x.messages.length; await control(x, 'state', { patch });
  return wait(x, m => m.type === 'SNAPSHOT_PREPARED' && predicate(m.draft), from);
}
const good = { q: '😀', e: '1', items: ['a', 'b'] };
async function start(options: any = {}) {
  const worker = options.existing ?? new Worker(workerFile, { stdout: true, stderr: true,
    env: { ...process.env, AOTUI_DATA_DIR: join(temporary, 'state-' + (++tag)) } });
  const messages: any[] = [], sent: any[] = [], attempted: any[] = [], logs: string[] = [];
  const post = worker.postMessage.bind(worker); let hold: ((m: any) => boolean) | undefined;
  worker.postMessage = (m: any) => { attempted.push(m); if (!hold?.(m)) { sent.push(m); post(m); } };
  worker.stdout?.on('data', (b: any) => logs.push(String(b))); worker.stderr?.on('data', (b: any) => logs.push(String(b)));
  const host = new Host({ appId: 'app', desktopId: 'd', appModulePath: appFile, existingWorker: worker,
    timeout: 700, interactionModes: options.modes ?? ALL });
  worker.on('message', (m: any) => messages.push(m));
  const x = { host, worker, messages, sent, attempted, logs, hold(f: (m: any) => boolean) { hold = f; }, physical(m: any) { sent.push(m); post(m); },
    entries: () => messages.filter(m => m.type === 'TEST_HANDLER_ENTER'), posts: () => sent.filter(isInvoke),
    snapshot: () => host.snapshotReceiver.core.store.readLatest('app').snapshot };
  closing.push(async () => { facts.push({ messages, sent, attempted, scopes: x.scopeFacts ?? [], logs, report: host.getInteractionReport?.() });
    const owned = host.worker === worker; host.terminate(); if (owned) await worker.terminate(); });
  await host.start(); await host.open(); await wait(x, m => m.type === 'SNAPSHOT_PREPARED'); return x;
}

describe('R11–R24 real public SDK / emitted Host / Node Worker', () => {
  beforeAll(async () => {
    const runtime = resolve(process.cwd()), sdk = resolve(runtime, '../sdk');
    temporary = await mkdtemp(join(tmpdir(), 'aotui-w07-b2-'));
    Host = (await import(pathToFileURL(join(runtime, 'dist/engine/app/worker-host.js')).href)).AppWorkerHost;
    workerFile = join(runtime, 'dist/worker-runtime/index.js');
    await mkdir(join(temporary, 'node_modules/@aotui'), { recursive: true }); await mkdir(join(temporary, 'node_modules/@preact'), { recursive: true });
    for (const name of ['preact', 'linkedom']) await symlink(join(runtime, 'node_modules', name), join(temporary, 'node_modules', name), 'dir');
    await symlink(runtime, join(temporary, 'node_modules/@aotui/runtime'), 'dir');
    appFile = join(temporary, 'app.mjs');
    await build({ entryPoints: [join(runtime, 'tests/fixtures/ordinary-v2-slice.mjs')], outfile: appFile,
      alias: { '@aotui/sdk': join(sdk, 'dist/index.js') }, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
    facts.push({ kind: 'current emitted inputs', runtime, sdk, node: process.version, appFile, workerFile });
  });
  afterAll(async () => { if (process.env.AOTUI_W07_FACTS_FILE) await writeFile(process.env.AOTUI_W07_FACTS_FILE, JSON.stringify({ facts, afterAllReached: true }, null, 2)); });

  it('R11/R13 really enters the target handler with matching policy/post/handler values and no defaults', async () => {
    const x = await start(), s = scope(x), o = await s.observe(), request = s.request(o, 'normal', 'find', good);
    const output = value(await s.client.invoke(request));
    expect(output.data.view).toBe('aa'); expect(output.data.args).toEqual(good);
    expect(s.authorized[0].rawInput).toEqual(good); expect(s.authorized[0].effectiveInput).toEqual(good);
    expect(x.posts()[0].args).toEqual(good); expect(x.entries()[0]).toMatchObject({ view: 'aa', name: 'find', args: good, frozen: true, nestedFrozen: true });
    expect(Object.hasOwn(output.data.args, 'n')).toBe(false); expect(Object.hasOwn(output.data.args, 'payload')).toBe(false);
    expect(x.host.getInteractionReport().negotiatedModes).toEqual(ALL);
  });
  it.each(['enum', 'array', 'type', 'range', 'null', 'missing', 'extra', 'getter', 'bytes'])('R12 invalid %s never authorizes/posts/enters', async kind => {
    const x = await start(), s = scope(x), o = await s.observe(); const input: any = { ...good }; let reads = 0;
    if (kind === 'enum') input.e = 1;
    if (kind === 'array') input.items = ['a'];
    if (kind === 'type') input.items = [1, 'a'];
    if (kind === 'range') input.n = 0;
    if (kind === 'null') input.e = null;
    if (kind === 'missing') delete input.q;
    if (kind === 'extra') input.W07_UNKNOWN_PRIVATE = 'PRIVATE_INPUT';
    if (kind === 'getter') Object.defineProperty(input, 'e', { enumerable: true, get() { reads++; return '1'; } });
    if (kind === 'bytes') input.payload = { text: 'x'.repeat(128 * 1024) };
    const result = await s.client.invoke(s.request(o, 'invalid-' + kind, 'find', input));
    if (kind === 'getter') expect(result.kind).toBe('refused');
    else { const r = receipt(result); expect(r.outcome.status).toBe('rejected'); expect(r.executionPhase).toBe('not-dispatched'); }
    expect(s.authorized).toHaveLength(0); expect(x.posts()).toHaveLength(0); expect(x.entries()).toHaveLength(0); expect(reads).toBe(0);
    facts.push({ kind: 'R12 rejection counters', inputCase: kind, authorize: s.authorized.length, invokePost: x.posts().length, handler: x.entries().length, getterReads: reads, response: result });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_INPUT|W07_UNKNOWN_PRIVATE/);
  });
  it('R12/Q01 accepts exactly 5000 nodes and rejects 5001 before policy and dispatch', async () => {
    const x = await start(), s = scope(x), o = await s.observe();
    const contract = compileOrdinaryParams({ flags: { type: 'array', itemType: 'boolean', required: true } }, { additionalProperties: false });
    expect(contract.ok && contract.contract.validate({ flags: Array(4999).fill(true) }).ok).toBe(true);
    const accepted = value(await s.client.invoke(s.request(o, 'nodes-5000', 'flags', { flags: Array(4998).fill(true) })));
    expect(accepted.data).toEqual({ count: 4998, allTrue: true });
    expect(s.authorized).toHaveLength(1); expect(x.posts()).toHaveLength(1); expect(x.entries()).toHaveLength(1);
    expect(s.authorized[0].effectiveInput).toEqual(x.posts()[0].args); expect(x.entries()[0].args).toEqual(x.posts()[0].args);
    const denied = receipt(await s.client.invoke(s.request(o, 'nodes-5001', 'flags', { flags: Array(4999).fill(true) })));
    expect(denied).toMatchObject({ executionPhase: 'not-dispatched', outcome: { status: 'rejected', code: 'ACTION_INPUT_INVALID' } });
    expect(s.authorized).toHaveLength(1); expect(x.posts()).toHaveLength(1); expect(x.entries()).toHaveLength(1);
  });
  it('R13 open input retains extras and prototype-like own fields', async () => {
    const x = await start(), s = scope(x), o = await s.observe();
    const input = JSON.parse('{"q":"x","extra":[null,{"kept":false}],"__proto__":{"safe":true},"constructor":0,"toString":false}');
    const output = value(await s.client.invoke(s.request(o, 'open-input', 'open', input)));
    expect(output.data.args).toEqual(input); expect(s.authorized[0].effectiveInput).toEqual(input); expect(x.posts()[0].args).toEqual(input);
    expect(x.entries()[0].args).toEqual(input); expect(({} as any).safe).toBeUndefined();
  });
  it('R14 explicit policy denial does not dispatch or enter', async () => {
    const x = await start(), s = scope(x), o = await s.observe(); s.control.authorize = () => false;
    expect(receipt(await s.client.invoke(s.request(o, 'deny', 'find', good))).outcome.status).toBe('rejected');
    expect(s.authorized).toHaveLength(1); expect(x.posts()).toHaveLength(0); expect(x.entries()).toHaveLength(0);
  });
  it.each(['disable', 'rebind', 'unmount', 'close'])('R14 async authorization cannot survive %s', async kind => {
    const x = await start(), s = scope(x), o = await s.observe(), gate = deferred<boolean>(), reached = deferred();
    s.control.authorize = () => { reached.resolve(); return gate.promise; };
    const pending = s.client.invoke(s.request(o, 'await-' + kind, 'find', good)); await reached.promise;
    if (kind === 'close') x.host.terminate();
    else await change(x, kind === 'disable' ? { enabled: false } : kind === 'rebind' ? { rule: true } : { show: false }, d => kind === 'unmount'
      ? !d.views.some((v: any) => v.id === 'aa') : Object.values(d.tools).filter((t: any) => t.name === 'find' && t.targets.some((v: any) => v.viewId === 'aa')).every((t: any) => kind === 'disable' ? false : t.inputSchema.properties.q.maxLength === 2));
    gate.resolve(true); const r = await pending; expect(r.kind === 'receipt' ? r.receipt.outcome.status : r.kind).not.toBe('succeeded');
    expect(x.posts()).toHaveLength(0); expect(x.entries()).toHaveLength(0);
  });
  it('R15 invalidation while transport holds a dispatched message fails Worker final checks', async () => {
    const x = await start(), s = scope(x), o = await s.observe(), queued: any[] = [], reached = deferred();
    x.hold((m: any) => { if (m.type !== 'VIEW_TOOL_INVOKE_ORDINARY_V2') return false; queued.push(m); reached.resolve(); return true; });
    const pending = s.client.invoke(s.request(o, 'held-dispatch', 'find', good)); await reached.promise;
    await change(x, { enabled: false }, d => !Object.values(d.tools).some((t: any) => t.name === 'find' && t.targets.some((v: any) => v.viewId === 'aa')));
    x.physical(queued[0]); const r = receipt(await pending);
    expect(r.outcome.status).toBe('rejected'); expect(x.entries()).toHaveLength(0);
    expect(x.messages.find((m: any) => m.requestId === queued[0].requestId && m.type === 'VIEW_TOOL_INVOKE_ORDINARY_V2_RESPONSE').terminal.phase).toBe('not-entered');
  });
  it('R16 direct invalid V2 requests remain not-entered without trusting Host validation', async () => {
    const x = await start(), tool = Object.values(x.snapshot().tools).find((t: any) => t.name === 'find' && t.targets.some((v: any) => v.viewId === 'aa')) as any;
    const from = x.messages.length;
    x.physical({ type: 'VIEW_TOOL_INVOKE_ORDINARY_V2', requestId: 'direct-invalid', appId: 'app', instanceId: x.host.appInstanceId,
      snapshotId: x.snapshot().id, tool, target: tool.targets[0], argumentMode: 'ordinary-v2', args: { ...good, e: 1 } });
    const response = await wait(x, m => m.type === 'VIEW_TOOL_INVOKE_ORDINARY_V2_RESPONSE' && m.requestId === 'direct-invalid', from);
    expect(response.terminal).toMatchObject({ phase: 'not-entered', result: { error: { code: 'E_INVALID_ARGS' } } });
    expect(x.entries()).toHaveLength(0); expect(JSON.stringify(response)).not.toContain('PRIVATE');
  });
  it.each(['business', 'throw', 'malformed', 'huge'])('R17 result %s preserves phase and transport health', async mode => {
    const x = await start(); await control(x, 'mode', { mode }); const s = scope(x), o = await s.observe();
    const r = receipt(await s.client.invoke(s.request(o, 'result-' + mode, 'find', good)));
    expect(x.entries()).toHaveLength(1); expect(s.authorized).toHaveLength(1);
    if (mode === 'business' || mode === 'throw') {
      expect(r.outcome).toMatchObject({ status: 'unknown', details: { kind: 'operation-result', phase: 'entered-returned', result: { success: false, error: { code: mode === 'business' ? 'BUSINESS' : 'E_HANDLER_ERROR' } } } });
      expect(x.host.getInteractionReport().transportUncertain).toBe(false);
      expect(JSON.stringify(r)).not.toContain('W07_PRIVATE_EXCEPTION');
    } else { expect(r.outcome.status).toBe('unknown'); expect(x.host.getInteractionReport().transportUncertain).toBe(true); expect(await x.host.releaseWorker()).toBeNull(); }
  });
  it('R18 deduplicates within Scope, rejects input reuse, isolates Scope IDs and authorizes receipt reads', async () => {
    const x = await start(), a = scope(x), b = scope(x), oa = await a.observe(), ob = await b.observe('bb');
    const request = a.request(oa, 'same-id', 'find', good), first = receipt(await a.client.invoke(request));
    expect(receipt(await a.client.invoke(request))).toEqual(first); expect(x.entries()).toHaveLength(1);
    const conflict = await a.client.invoke({ ...request, input: { ...good, n: 3 } });
    expect(conflict.kind).not.toBe('receipt'); expect(x.entries()).toHaveLength(1);
    const second = value(await b.client.invoke(b.request(ob, 'same-id', 'find', good, 'bb')));
    expect(second.data.view).toBe('bb'); expect(x.entries()).toHaveLength(2);
    a.control.canRead = () => false;
    expect((await a.client.readReceipt('same-id')).kind).toBe('unavailable');
  });
  it('R19 the current ordinary-v2 bindings share one Worker and one uncertainty state', async () => {
    const x = await start(); await control(x, 'mode', { mode: 'hold' }); const a = scope(x), b = scope(x), oa = await a.observe(), ob = await b.observe();
    const gate = deferred<boolean>(), reached = deferred(); b.control.authorize = () => { reached.resolve(); return gate.promise; };
    const waiting = b.client.invoke(b.request(ob, 'waiting', 'find', good)); await reached.promise;
    const requests = [['find', good], ['zero', {}]] as const;
    const promises = requests.map(([name, input]) => a.client.invoke(a.request(oa, 'mix-' + name, name, input)));
    await wait(x, m => m.type === 'TEST_HANDLER_ENTER' && x.entries().length === 2);
    const first = x.entries().find((entry: any) => entry.name === 'find'), nativeEmit = x.worker.emit.bind(x.worker);
    x.worker.emit = (event: string, ...args: any[]) => {
      if (event === 'message' && args[0]?.type === 'VIEW_TOOL_INVOKE_ORDINARY_V2_RESPONSE' && args[0]?.requestId === x.posts().find((message: any) => message.type === 'VIEW_TOOL_INVOKE_ORDINARY_V2')?.requestId) {
        args[0] = { ...args[0], type: 'VIEW_TOOL_INVOKE_REF_V2_RESPONSE', argumentMode: 'snapshot-value-v2' };
      }
      return nativeEmit(event, ...args);
    };
    await control(x, 'release', { id: first.id });
    expect(receipt(await promises[0]).outcome.status).toBe('unknown');
    gate.resolve(true); expect(receipt(await waiting).outcome.status).toBe('rejected');
    expect(receipt(await promises[1]).outcome.status).toBe('unknown');
    expect(x.posts()).toHaveLength(2); expect(x.entries()).toHaveLength(2); expect(x.host.getInteractionReport().transportUncertain).toBe(true);
    expect(await x.host.releaseWorker()).toBeNull();
  });
  it('R20 healthy business failure permits pool reuse with a new logical instance', async () => {
    const x = await start(); await control(x, 'mode', { mode: 'business' }); const s = scope(x), o = await s.observe();
    expect(receipt(await s.client.invoke(s.request(o, 'healthy-failure', 'find', good))).outcome).toMatchObject({ status: 'unknown', details: { result: { success: false, error: { code: 'BUSINESS' } } } });
    expect(x.host.getInteractionReport().transportUncertain).toBe(false);
    const pooled = await x.host.releaseWorker(); expect(pooled).not.toBeNull();
    const y = await start({ existing: pooled }); expect(y.host.appInstanceId).not.toBe(x.host.appInstanceId);
    const other = scope(y), observed = await other.observe(); await control(y, 'mode', { mode: 'normal' });
    expect(value(await other.client.invoke(other.request(observed, 'new-run', 'find', good))).data.view).toBe('aa');
    const oldRead = await s.client.invoke(s.request(o, 'old-run', 'find', good)); expect(oldRead.kind).not.toBe('receipt');
  });
  it('R21 an explicit empty execution set still allows View observation without executable bindings', async () => {
    const x = await start({ modes: [] }), s = scope(x), o = await s.observe();
    expect(o.views).toHaveLength(1);
    expect(o.tools).toEqual([]);
    expect(o.bindings).toEqual([]);
    expect(x.host.getInteractionReport().negotiatedModes).toEqual([]);
  });
  it('R22 the two current modes include empty ordinary parameters and reject duplicate initialization', async () => {
    const x = await start(), s = scope(x), o = await s.observe();
    expect(x.host.getInteractionReport().negotiatedModes).toEqual(ALL);
    expect(value(await s.client.invoke(s.request(o, 'zero', 'zero', {}))).data.args).toEqual({});
    const from = x.messages.length, init = x.sent.find((message: any) => message.type === 'INIT');
    x.physical({ ...init, requestId: 'duplicate-init' });
    const error = await wait(x, message => message.requestId === 'duplicate-init', from);
    expect(error.error.code).toBe('APP_INSTANCE_REUSE_UNSUPPORTED');
    expect(x.host.hasOrdinaryParametersCapability()).toBe(true);
  });
});
