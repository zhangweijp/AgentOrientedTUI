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
const ALL = ['view-type-parameters-v1'] as const;
const NORMAL_HOST_TIMEOUT_MS = 3000;
const FAULT_HOST_TIMEOUT_MS = 1500;
const closing: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closing.splice(0)) await close(); vi.restoreAllMocks(); });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => resolve = yes); return { promise, resolve }; }
function withBusinessViewId(input: any, viewId: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const copy = Object.create(Object.getPrototypeOf(input));
  const descriptors = Object.getOwnPropertyDescriptors(input);
  Object.defineProperties(copy, descriptors);
  if (!Object.hasOwn(descriptors, 'view_id')) Object.defineProperty(copy, 'view_id', { value: viewId, enumerable: true, writable: true, configurable: true });
  return copy;
}
function project({ source, selection }: any) {
  const ids = new Set(selection.viewIds);
  const selectedViews = source.views.filter((view: any) => ids.has(view.id));
  const toolBindings: any[] = [];
  for (const tool of Object.values(source.tools) as any[]) {
    if (selectedViews.some((view: any) => view.type === tool.viewType)) toolBindings.push({ toolId: tool.id, execution: tool.execution });
  }
  return { views: source.views.filter((v: any) => ids.has(v.id)).map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
    refs: Object.values(source.refs).filter((r: any) => ids.has(r.ownerViewId)).map((r: any) => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
    toolBindings, content: [] };
}
function scope(x: any) {
  const authorized: any[] = [], control = { authorize: (_c: any): any => true, canRead: (_m: any, _s: any): any => true };
  const recorded = { authorizations: [] as any[], invocations: [] as any[], observations: [] as any[] };
  (x.scopeFacts ??= []).push(recorded);
  const opened = x.host.createInteractionScope({ project, authorize(c: any) {
    authorized.push(c); recorded.authorizations.push({ scopeId: c.scopeId, invocationId: c.invocationId, rawInput: c.rawInput, effectiveInput: c.effectiveInput,
      execution: c.source.execution, instanceId: c.source.instanceId }); return control.authorize(c);
  }, canReadReceipt: (m: any, s: any) => control.canRead(m, s) });
  expect(opened.status).toBe('opened'); if (opened.status !== 'opened') throw Error(opened.issue.code);
  const original = opened.client;
  const client = { ...original, async invoke(request: unknown) {
    const invocationId = request && typeof request === 'object' ? Object.getOwnPropertyDescriptor(request, 'invocationId')?.value : null;
    const response = await original.invoke(request); recorded.invocations.push({ invocationId, response }); return response;
  } };
  return { client, control, authorized, async observe(view = 'aa') {
    const r = await client.observe({ viewIds: [view] }); recorded.observations.push(r); expect(r.status).toBe('observed');
    const content = x.snapshot().views.find((item: any) => item.id === view)?.content?.value;
    expect(content).toContain(`Business View ID: ${view}`);
    expect(client.adoptObservation(r.observation.observationId)).toEqual({ status: 'adopted' });
    return r.observation;
  },
    request(o: any, invocationId: string, name = 'find', input: any = {}, view = 'aa') {
      const tool = o.tools.find((t: any) => t.name === name); expect(tool).toBeDefined();
      const binding = o.bindings.find((b: any) => b.toolId === tool.id); expect(binding).toBeDefined();
      return { invocationId, observationId: o.observationId, bindingId: binding.bindingId, input: withBusinessViewId(input, view) };
    } };
}
function receipt(r: any) { expect(r.kind).toBe('receipt'); if (r.kind !== 'receipt') throw Error(r.code); return r.receipt; }
function value(r: any) { const rcp = receipt(r); expect(rcp.outcome.status).toBe('succeeded'); return rcp.outcome.value; }
const isInvoke = (m: any) => m.type === 'VIEW_TOOL_INVOKE_V4';

let temporary: string, Host: any, appFile: string, workerFile: string, legacySdkAppFile: string;
const facts: any[] = []; let tag = 0;
function wait(x: any, predicate: (m: any) => boolean, from = 0): Promise<any> {
  const existing = x.messages.slice(from).find(predicate); if (existing) return Promise.resolve(existing);
  return new Promise((yes, no) => { const timer = setTimeout(() => { x.worker.off('message', receive); no(Error('W07 explicit barrier expired; ' + x.logs.join('').slice(-3000))); }, 5000);
    function receive(m: any) { if (predicate(m)) { clearTimeout(timer); x.worker.off('message', receive); yes(m); } } x.worker.on('message', receive); });
}
async function control(x: any, type: string, data: any = {}) { const id = ++tag, from = x.messages.length;
  const previousTimeout = x.host.timeout;
  if (previousTimeout < NORMAL_HOST_TIMEOUT_MS) x.host.timeout = NORMAL_HOST_TIMEOUT_MS;
  try {
    await x.host.sendExternalEvent('probe', type, { ...data, tag: id });
    return await wait(x, m => m.type === (type === 'state' ? 'TEST_COMMITTED' : 'TEST_CONTROL_ACK') && m.tag === id, from);
  } finally { x.host.timeout = previousTimeout; } }
async function change(x: any, patch: any, predicate: (draft: any) => boolean) {
  const from = x.messages.length; await control(x, 'state', { patch });
  return wait(x, m => m.type === 'SNAPSHOT_PREPARED' && predicate(m.draft), from);
}
const good = { view_id: 'aa', q: '😀', e: '1', items: ['a', 'b'] };
async function start(options: any = {}) {
  const worker = options.existing ?? new Worker(workerFile, { stdout: true, stderr: true,
    env: { ...process.env, AOTUI_DATA_DIR: join(temporary, 'state-' + (++tag)) } });
  const messages: any[] = [], sent: any[] = [], attempted: any[] = [], logs: string[] = [];
  const post = worker.postMessage.bind(worker); let hold: ((m: any) => boolean) | undefined;
  worker.postMessage = (m: any) => { attempted.push(m); if (!hold?.(m)) { sent.push(m); post(m); } };
  worker.stdout?.on('data', (b: any) => logs.push(String(b))); worker.stderr?.on('data', (b: any) => logs.push(String(b)));
  const host = new Host({ appId: 'app', desktopId: 'd', appModulePath: appFile, existingWorker: worker,
    timeout: options.timeout ?? NORMAL_HOST_TIMEOUT_MS, interactionModes: options.modes ?? ALL,
    config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR ?? join(temporary, 'host-state') } });
  worker.on('message', (m: any) => messages.push(m));
  const x = { host, worker, messages, sent, attempted, logs, hold(f: (m: any) => boolean) { hold = f; }, physical(m: any) { sent.push(m); post(m); },
    entries: () => messages.filter(m => m.type === 'TEST_HANDLER_ENTER'), posts: () => sent.filter(isInvoke),
    snapshot: () => host.snapshotReceiver.core.store.readLatest('app').snapshot };
  closing.push(async () => { facts.push({ messages, sent, attempted, scopes: x.scopeFacts ?? [], logs, report: host.getInteractionReport?.() });
    const owned = host.worker === worker; host.terminate();
    if (owned) { await worker.terminate(); await host.waitForResourceRelease(); } });
  await host.start(); await host.open(); await wait(x, m => m.type === 'SNAPSHOT_PREPARED'); return x;
}

describe('R11–R24 real public SDK / emitted Host / Node Worker', () => {
  beforeAll(async () => {
    const runtime = resolve(process.cwd()), sdk = resolve(runtime, '../sdk');
    
    temporary = await mkdtemp(join(process.env.AOTUI_MIGRATION_TEMP_DIR ?? tmpdir(), 'aotui-w07-b2-'));
    Host = (await import(pathToFileURL(join(runtime, 'dist/engine/app/worker-host.js')).href)).AppWorkerHost;
    workerFile = join(runtime, 'dist/worker-runtime/index.js');
    await mkdir(join(temporary, 'node_modules/@aotui'), { recursive: true }); await mkdir(join(temporary, 'node_modules/@preact'), { recursive: true });
    for (const name of ['preact', 'linkedom']) await symlink(join(runtime, 'node_modules', name), join(temporary, 'node_modules', name), 'dir');
    await symlink(join(sdk, 'node_modules/typebox'), join(temporary, 'node_modules/typebox'), 'dir');
    await symlink(runtime, join(temporary, 'node_modules/@aotui/runtime'), 'dir');
    appFile = join(temporary, 'app.mjs');
    await build({ entryPoints: [join(runtime, 'tests/fixtures/ordinary-v2-slice.mjs')], outfile: appFile,
      alias: { '@aotui/sdk': join(sdk, 'dist/index.js') }, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent' });
    legacySdkAppFile = join(temporary, 'legacy-sdk-app.mjs');
    await writeFile(legacySdkAppFile, `export default {
      displayName: 'legacy_sdk',
      kernelConfig: { appName: 'legacy_sdk', name: 'legacy_sdk', component: undefined },
      persistenceSupport: 'state-session-v1',
      appLifecycleSupport: 'app-lifecycle-v2',
      initializeComponent() { throw new Error('OLD_SDK_COMPONENT_EXECUTED'); }
    };\n`);
    facts.push({ kind: 'current emitted inputs', runtime, sdk, node: process.version, appFile, workerFile });
  });
  afterAll(async () => { if (process.env.AOTUI_W07_FACTS_FILE) await writeFile(process.env.AOTUI_W07_FACTS_FILE, JSON.stringify({ facts, afterAllReached: true }, null, 2)); });

  it('a V2 Host request is rejected by the V4 Worker before importing the App module', async () => {
    const legacyWorker = new Worker(workerFile, { stdout: true, stderr: true });
    try {
      const responsePromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('V4 capability rejection did not arrive')), 3000);
        legacyWorker.once('message', (message: any) => { clearTimeout(timeout); resolve(message); });
        legacyWorker.once('error', error => { clearTimeout(timeout); reject(error); });
      });
      legacyWorker.postMessage({ type: 'INIT', requestId: 'legacy-host-init', appId: 'app', desktopId: 'd',
        appModulePath: 'file:///this-module-must-not-be-imported.mjs', appInstanceId: 'legacy-host-instance',
        requestedCapabilities: ['view-tool-ordinary-invoke/v2'] });
      await expect(responsePromise).resolves.toMatchObject({ type: 'ERROR_RESPONSE', requestId: 'legacy-host-init',
        success: false, error: { code: 'WORKER_PROTOCOL_V3_REQUIRED' } });
    } finally {
      await legacyWorker.terminate();
    }
  });

  it('new Runtime rejects a legacy createTUIApp factory before AppKernel construction', async () => {
    const host = new Host({ appId: 'legacy_sdk', desktopId: 'd', appModulePath: legacySdkAppFile,
      timeout: NORMAL_HOST_TIMEOUT_MS, interactionModes: ALL, config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR ?? join(temporary, 'host-state') } });
    try {
      await expect(host.start()).rejects.toThrow('APP_AUTHORING_PROTOCOL_UNSUPPORTED');
      expect(host.getStatus()).toBe('closed');
      expect((host as any).worker).toBeNull();
    } finally {
      host.terminate();
      await host.waitForResourceRelease();
    }
  });

  it.each(['VIEW_TOOL_INVOKE_V2', 'VIEW_TOOL_INVOKE_V3'])('a running V4 Worker rejects retired %s with a correlated error and zero handler entries', async type => {
    const x = await start();
    try {
      const tool = Object.values(x.snapshot().tools).find((tool: any) => tool.name === 'find' && tool.viewType === 'File') as any;
      const requestId = 'retired-' + type, from = x.messages.length;
      x.physical({ type, requestId, appId: 'app', instanceId: x.host.appInstanceId,
        snapshotId: x.snapshot().id, tool, execution: tool.execution, argumentMode: 'ordinary-v2', args: good });
      const response = await wait(x, message => message.requestId === requestId, from);
      expect(response).toMatchObject({ type: 'ERROR_RESPONSE', requestId, success: false,
        error: { code: 'WORKER_CAPABILITY_UNSUPPORTED' } });
      expect(x.entries()).toHaveLength(0);
      facts.push({ kind: 'retired invocation explicitly rejected', type, requestId, response, handlerEntries: 0 });
    } finally { x.host.terminate(); await x.host.waitForResourceRelease(); }
  });

  it('R11/R13 really enters the target handler with matching policy/post/handler values and no defaults', async () => {
    const x = await start(), s = scope(x), o = await s.observe(), request = s.request(o, 'normal', 'find', good);
    const output = value(await s.client.invoke(request));
    expect(output.data.view).toBe('aa'); expect(output.data.args).toEqual(good);
    expect(s.authorized[0].rawInput).toEqual(good); expect(s.authorized[0].effectiveInput).toEqual(good);
    expect(x.posts()[0].effectiveArgs).toEqual(good); expect(x.entries()[0]).toMatchObject({ view: 'aa', name: 'find', args: good, frozen: true, nestedFrozen: true });
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
    const accepted = value(await s.client.invoke(s.request(o, 'nodes-5000', 'flags', { flags: Array(4997).fill(true) })));
    expect(accepted.data).toEqual({ count: 4997, allTrue: true });
    expect(s.authorized).toHaveLength(1); expect(x.posts()).toHaveLength(1); expect(x.entries()).toHaveLength(1);
    expect(s.authorized[0].effectiveInput).toEqual(x.posts()[0].effectiveArgs); expect(x.entries()[0].args).toEqual(x.posts()[0].effectiveArgs);
    const denied = receipt(await s.client.invoke(s.request(o, 'nodes-5001', 'flags', { flags: Array(4998).fill(true) })));
    expect(denied).toMatchObject({ executionPhase: 'not-dispatched', outcome: { status: 'rejected', code: 'ACTION_INPUT_INVALID' } });
    expect(s.authorized).toHaveLength(1); expect(x.posts()).toHaveLength(1); expect(x.entries()).toHaveLength(1);
  });
  it('R13 open input retains extras and prototype-like own fields', async () => {
    const x = await start(), s = scope(x), o = await s.observe();
    const input = JSON.parse('{"q":"x","extra":[null,{"kept":false}],"__proto__":{"safe":true},"constructor":0,"toString":false}');
    const output = value(await s.client.invoke(s.request(o, 'open-input', 'open', input)));
    const expected = { ...input, view_id: 'aa' };
    expect(output.data.args).toEqual(expected); expect(s.authorized[0].effectiveInput).toEqual(expected); expect(x.posts()[0].effectiveArgs).toEqual(expected);
    expect(x.entries()[0].args).toEqual(expected); expect(({} as any).safe).toBeUndefined();
  });
  it('R14 explicit policy denial does not dispatch or enter', async () => {
    const x = await start(), s = scope(x), o = await s.observe(); s.control.authorize = () => false;
    expect(receipt(await s.client.invoke(s.request(o, 'deny', 'find', good))).outcome.status).toBe('rejected');
    expect(s.authorized).toHaveLength(1); expect(x.posts()).toHaveLength(0); expect(x.entries()).toHaveLength(0);
  });
  it.each(['disable', 'rebind', 'unmount', 'close'])('R14 async authorization cannot survive %s', async kind => {
    const x = await start(), s = scope(x), o = await s.observe(), gate = deferred<boolean>(), reached = deferred();
    s.control.authorize = () => { reached.resolve(); return gate.promise; };
    const pending = s.client.invoke(s.request(o, 'await-' + kind, 'find', good));
    try {
      await reached.promise;
      if (kind === 'close') x.host.terminate();
      else await change(x, kind === 'disable' ? { enabled: false } : kind === 'rebind' ? { rule: true } : { show: false }, d => kind === 'unmount'
        ? !d.views.some((v: any) => v.id === 'aa') : Object.values(d.tools).filter((t: any) => t.name === 'find' && t.viewType === 'File').every((t: any) => kind === 'disable' ? false : t.inputSchema.properties.q.maxLength === 2));
      gate.resolve(true); const r = await pending; expect(r.kind === 'receipt' ? r.receipt.outcome.status : r.kind).not.toBe('succeeded');
      expect(x.posts()).toHaveLength(0); expect(x.entries()).toHaveLength(0);
    } finally { gate.resolve(true); await pending.catch(() => undefined); }
  });
  it('R15 invalidation while transport holds a dispatched message fails Worker final checks', async () => {
    const x = await start(), s = scope(x), o = await s.observe(), queued: any[] = [], reached = deferred();
    x.hold((m: any) => { if (m.type !== 'VIEW_TOOL_INVOKE_V4') return false; queued.push(m); reached.resolve(); return true; });
    const pending = s.client.invoke(s.request(o, 'held-dispatch', 'find', good));
    try {
      await reached.promise;
      await change(x, { enabled: false }, d => !Object.values(d.tools).some((t: any) => t.name === 'find' && t.viewType === 'File'));
      x.physical(queued[0]); const r = receipt(await pending);
      expect(r.outcome.status).toBe('rejected'); expect(x.entries()).toHaveLength(0);
      expect(x.messages.find((m: any) => m.requestId === queued[0].requestId && m.type === 'VIEW_TOOL_INVOKE_V4_RESPONSE').terminal.phase).toBe('not-entered');
    } finally { x.host.terminate(); await pending.catch(() => undefined); }
  });
  it('R16 direct invalid V4 requests remain not-entered without trusting Host validation', async () => {
    const x = await start(), tool = Object.values(x.snapshot().tools).find((t: any) => t.name === 'find' && t.viewType === 'File') as any;
    const from = x.messages.length;
    x.physical({ type: 'VIEW_TOOL_INVOKE_V4', requestId: 'direct-invalid', appId: 'app', instanceId: x.host.appInstanceId,
      snapshotId: x.snapshot().id, tool, execution: tool.execution, argumentMode: 'view-type-parameters-v1', rawArgs: { ...good, e: 1 }, effectiveArgs: { ...good, e: 1 }, refSources: [] });
    const response = await wait(x, m => m.type === 'VIEW_TOOL_INVOKE_V4_RESPONSE' && m.requestId === 'direct-invalid', from);
    expect(response.terminal).toMatchObject({ phase: 'not-entered', result: { error: { code: 'E_INVALID_ARGS' } } });
    expect(x.entries()).toHaveLength(0); expect(JSON.stringify(response)).not.toContain('PRIVATE');
  });
  it.each(['business', 'throw', 'malformed', 'huge'])('R17 result %s preserves phase and transport health', async mode => {
    const x = await start(); await control(x, 'mode', { mode });
    if (mode === 'malformed' || mode === 'huge') x.host.timeout = FAULT_HOST_TIMEOUT_MS;
    const s = scope(x), o = await s.observe();
    const r = receipt(await s.client.invoke(s.request(o, 'result-' + mode, 'find', good)));
    expect(x.entries()).toHaveLength(1); expect(s.authorized).toHaveLength(1);
    if (mode === 'business' || mode === 'throw') {
      expect(r.outcome).toMatchObject({ status: 'unknown', details: { kind: 'tool-result', phase: 'entered-returned', result: { success: false, error: { code: mode === 'business' ? 'BUSINESS' : 'E_HANDLER_ERROR' } } } });
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
    const second = value(await b.client.invoke(b.request(ob, 'same-id', 'find', { ...good, view_id: 'bb' }, 'bb')));
    expect(second.data.view).toBe('bb'); expect(x.entries()).toHaveLength(2);
    a.control.canRead = () => false;
    expect((await a.client.invoke(request)).kind).toBe('unavailable');
  });
  it('R19 the current qualified ordinary bindings share one Worker and one uncertainty state', async () => {
    const x = await start(); await control(x, 'mode', { mode: 'hold' }); const a = scope(x), b = scope(x), oa = await a.observe(), ob = await b.observe();
    const gate = deferred<boolean>(), reached = deferred(); b.control.authorize = () => { reached.resolve(); return gate.promise; };
    const waiting = b.client.invoke(b.request(ob, 'waiting', 'find', good));
    let promises: Promise<any>[] = [];
    try {
    await reached.promise;
    x.host.timeout = FAULT_HOST_TIMEOUT_MS;
    const requests = [['find', good], ['zero', {}]] as const;
    promises = requests.map(([name, input]) => a.client.invoke(a.request(oa, 'mix-' + name, name, input)));
    await wait(x, m => m.type === 'TEST_HANDLER_ENTER' && x.entries().length === 2);
    const first = x.entries().find((entry: any) => entry.name === 'find'), nativeEmit = x.worker.emit.bind(x.worker);
    x.worker.emit = (event: string, ...args: any[]) => {
      if (event === 'message' && args[0]?.type === 'VIEW_TOOL_INVOKE_V4_RESPONSE' && args[0]?.requestId === x.posts().find((message: any) => message.argumentMode === 'view-type-parameters-v1')?.requestId) {
        args[0] = { ...args[0], argumentMode: 'snapshot-value-v2' };
      }
      return nativeEmit(event, ...args);
    };
    await control(x, 'release', { id: first.id });
    expect(receipt(await promises[0]).outcome.status).toBe('unknown');
    gate.resolve(true); expect(receipt(await waiting).outcome.status).toBe('rejected');
    expect(receipt(await promises[1]).outcome.status).toBe('unknown');
    expect(x.posts()).toHaveLength(2); expect(x.entries()).toHaveLength(2); expect(x.host.getInteractionReport().transportUncertain).toBe(true);
    expect(await x.host.releaseWorker()).toBeNull();
    } finally { gate.resolve(true); x.host.terminate(); await Promise.allSettled([waiting, ...promises]); }
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
  it('R22 the current shared mode includes empty ordinary parameters and reject duplicate initialization', async () => {
    const x = await start(), s = scope(x), o = await s.observe();
    expect(x.host.getInteractionReport().negotiatedModes).toEqual(ALL);
    expect(value(await s.client.invoke(s.request(o, 'zero', 'zero', {}))).data.args).toEqual({ view_id: 'aa' });
    const from = x.messages.length, init = x.sent.find((message: any) => message.type === 'INIT');
    x.physical({ ...init, requestId: 'duplicate-init' });
    const error = await wait(x, message => message.requestId === 'duplicate-init', from);
    expect(error.error.code).toBe('APP_INSTANCE_REUSE_UNSUPPORTED');
    expect(x.host.hasOrdinaryParametersCapability()).toBe(true);
  });
});
