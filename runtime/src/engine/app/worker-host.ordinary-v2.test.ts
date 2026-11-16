import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { compileOrdinarySchema } from '../../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../../core/tool/ordinary-parameter-profile.js';
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
function project({source}:any) {return {refs:[],toolIds:Object.keys(source.tools)};}
function receiver(snapshot:any,tool:any,id='aa') {
    const view=snapshot.views.find((view:any)=>view.id===id);
    return {viewId:id,viewInstanceId:view.viewInstanceId,activationId:view.toolBindings.find((ref:any)=>ref.toolId===tool.id).activationId};
}
function scope(x: any) {
  const authorized: any[] = [], control = { authorize: (_c: any): any => true, canRead: (_m: any, _s: any): any => true };
  const recorded = { authorizations: [] as any[], invocations: [] as any[], observations: [] as any[] };
  (x.scopeFacts ??= []).push(recorded);
  const opened = x.host.getAppInteraction({ project, authorize(c: any) {
    authorized.push(c); recorded.authorizations.push({ invocationId: c.invocationId, rawInput: c.rawInput, effectiveInput: c.effectiveInput,
      receiver: c.source.receiver, instanceId: c.source.instanceId }); return control.authorize(c);
  }, canReadReceipt: (m: any, s: any) => control.canRead(m, s) });
  expect(opened.status).toBe('ready'); if (opened.status !== 'ready') throw Error(opened.issue.code);
  const original = opened.interaction;
  const client = { ...original, async invoke(request: unknown) {
    const invocationId = request && typeof request === 'object' ? Object.getOwnPropertyDescriptor(request, 'invocationId')?.value : null;
    const response = await original.invoke(request); recorded.invocations.push({ invocationId, response }); return response;
  } };
  return { client, control, authorized, async observe(view = 'aa') {
    const r = await client.observe({ all: true }); recorded.observations.push(r); expect(r.status).toBe('observed');
    const content = x.snapshot().views.find((item: any) => item.id === view)?.content?.value;
    expect(content).toContain(`Business View ID: ${view}`);
    expect(client.adoptObservation(r.observation.observationId)).toEqual({ status: 'adopted' });
    return r.observation;
  },
    request(o: any, invocationId: string, name = 'find', input: any = {}, view = 'aa') {
      const type = o.views.find((item: any) => item.id === view)?.type;
      const tool = o.tools.find((t: any) => t.name === name && t.viewType === type); expect(tool).toBeDefined();
      return { invocationId, observationId: o.observationId, toolId: tool.id, input: withBusinessViewId(input, view) };
    } };
}
function receipt(r: any) { expect(r.kind).toBe('receipt'); if (r.kind !== 'receipt') throw Error(r.code); return r.receipt; }
function value(r: any) { const rcp = receipt(r); expect(rcp.outcome.status).toBe('succeeded'); return rcp.outcome.value; }
const isInvoke = (m: any) => m.type === 'VIEW_TOOL_INVOKE_V6';

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
    x.worker.postMessage({ type: 'TEST_COMMAND', command: type, data: { ...data, tag: id } });
    return await wait(x, m => m.type === (type === 'state' ? 'TEST_COMMITTED' : 'TEST_CONTROL_ACK') && m.tag === id, from);
  } finally { x.host.timeout = previousTimeout; } }
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
    timeout: options.timeout ?? NORMAL_HOST_TIMEOUT_MS, toolsEnabled: options.toolsEnabled,
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
      kernelConfig: { appName: 'legacy_sdk' },
      persistenceSupport: 'state-session-v1',
      appLifecycleSupport: 'app-lifecycle-v2',
      initialize() { throw new Error('UNSUPPORTED_FACTORY_EXECUTED'); }
    };\n`);
    facts.push({ kind: 'current emitted inputs', runtime, sdk, node: process.version, appFile, workerFile });
  });
  afterAll(async () => { if (process.env.AOTUI_W07_FACTS_FILE) await writeFile(process.env.AOTUI_W07_FACTS_FILE, JSON.stringify({ facts, afterAllReached: true }, null, 2)); });

  it.each(['view-tool-ordinary-invoke/v2', 'view-tool-parameters-invoke/v4'])('rejects retired Host capability %s before importing the App module', async capability => {
    const legacyWorker = new Worker(workerFile, { stdout: true, stderr: true });
    try {
      const responsePromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Capability rejection did not arrive')), 3000);
        legacyWorker.once('message', (message: any) => { clearTimeout(timeout); resolve(message); });
        legacyWorker.once('error', error => { clearTimeout(timeout); reject(error); });
      });
      legacyWorker.postMessage({ type: 'INIT', requestId: 'legacy-host-init', appId: 'app', desktopId: 'd',
        appModulePath: 'file:///this-module-must-not-be-imported.mjs', appInstanceId: 'legacy-host-instance',
        requestedCapabilities: ['app-snapshot/v5', capability] });
      await expect(responsePromise).resolves.toMatchObject({ type: 'ERROR_RESPONSE', requestId: 'legacy-host-init',
        success: false, error: { code: 'WORKER_CAPABILITY_UNSUPPORTED' } });
    } finally {
      await legacyWorker.terminate();
    }
  });

  it('new Runtime rejects a factory with the old authoring protocol before AppKernel construction', async () => {
    const host = new Host({ appId: 'legacy_sdk', desktopId: 'd', appModulePath: legacySdkAppFile,
      timeout: NORMAL_HOST_TIMEOUT_MS, config: { AOTUI_DATA_DIR: process.env.AOTUI_DATA_DIR ?? join(temporary, 'host-state') } });
    try {
      await expect(host.start()).rejects.toThrow('APP_AUTHORING_PROTOCOL_UNSUPPORTED');
      expect(host.getStatus()).toBe('closed');
      expect((host as any).worker).toBeNull();
    } finally {
      host.terminate();
      await host.waitForResourceRelease();
    }
  });

  it('R11/R13 really enters the target handler with matching policy/post/handler values and no defaults', async () => {
    const x = await start(), s = scope(x), o = await s.observe(), request = s.request(o, 'normal', 'find', good);
    const output = value(await s.client.invoke(request));
    expect(output.data.view).toBe('aa'); expect(output.data.args).toEqual(good);
    expect(s.authorized[0].rawInput).toEqual(good); expect(s.authorized[0].effectiveInput).toEqual(good);
    expect(x.posts()[0].effectiveArgs).toEqual(good); expect(x.entries()[0]).toMatchObject({ view: 'aa', name: 'find', args: good, frozen: true, nestedFrozen: true });
    expect(Object.hasOwn(output.data.args, 'n')).toBe(false); expect(Object.hasOwn(output.data.args, 'payload')).toBe(false);
    expect(x.host.getInteractionReport().toolsEnabled).toBe(true);
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
    const contract = compileOrdinarySchema({ type: 'object', properties: { flags: { type: 'array', items: { type: 'boolean' } } }, required: ['flags'], additionalProperties: false });
    expect(contract.ok && contract.contract.validateModelInput({ flags: Array(4999).fill(true) }).ok).toBe(true);
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
    const expected = input;
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
      else {
        const mount = x.snapshot().views.find((view: any) => view.id === 'aa')?.viewInstanceId;
        await change(x, kind === 'disable' ? { enabled: false } : kind === 'rebind' ? { rule: true } : { show: false }, d => kind === 'unmount'
        ? !d.views.some((v: any) => v.id === 'aa') : kind === 'disable' ? !Object.values(d.tools).some((t: any) => t.name === 'find' && t.viewType === 'File')
          : d.views.some((view: any) => view.id === 'aa' && view.viewInstanceId !== mount));
      }
      gate.resolve(true); const r = await pending; expect(r.kind === 'receipt' ? r.receipt.outcome.status : r.kind).not.toBe('succeeded');
      expect(x.posts()).toHaveLength(0); expect(x.entries()).toHaveLength(0);
    } finally { gate.resolve(true); await pending.catch(() => undefined); }
  });
  it('R15 invalidation while transport holds a dispatched message fails Worker final checks', async () => {
    const x = await start(), s = scope(x), o = await s.observe(), queued: any[] = [], reached = deferred();
    x.hold((m: any) => { if (m.type !== 'VIEW_TOOL_INVOKE_V6') return false; queued.push(m); reached.resolve(); return true; });
    const pending = s.client.invoke(s.request(o, 'held-dispatch', 'find', good));
    try {
      await reached.promise;
      await change(x, { enabled: false }, d => !Object.values(d.tools).some((t: any) => t.name === 'find' && t.viewType === 'File'));
      x.physical(queued[0]); const r = receipt(await pending);
      expect(r.outcome.status).toBe('rejected'); expect(x.entries()).toHaveLength(0);
      expect(x.messages.find((m: any) => m.requestId === queued[0].requestId && m.type === 'VIEW_TOOL_INVOKE_V6_RESPONSE').terminal.phase).toBe('not-entered');
    } finally { x.host.terminate(); await pending.catch(() => undefined); }
  });
  it('R16 direct invalid V6 requests remain not-entered without trusting Host validation', async () => {
    const x = await start(), snapshot = x.snapshot();
    const { nameSharedAcrossViewTypes: _sharedName, ...tool } = Object.values(snapshot.tools).find((t: any) => t.name === 'find' && t.viewType === 'File') as any;
    const from = x.messages.length;
    x.physical({ type: 'VIEW_TOOL_INVOKE_V6', requestId: 'direct-invalid', appId: 'app', instanceId: x.host.appInstanceId,
      snapshotId: snapshot.id, tool, receiver: receiver(snapshot,tool), argumentMode: 'view-type-parameters-v1', rawArgs: { ...good, e: 1 }, effectiveArgs: { ...good, e: 1 }, refSources: [] });
    const response = await wait(x, m => m.type === 'VIEW_TOOL_INVOKE_V6_RESPONSE' && m.requestId === 'direct-invalid', from);
    expect(response.terminal).toMatchObject({ phase: 'not-entered', result: { error: { code: 'E_INVALID_ARGS' } } });
    expect(x.entries()).toHaveLength(0); expect(JSON.stringify(response)).not.toContain('PRIVATE');
  });
  it.each(['business', 'throw', 'malformed', 'huge'])('R17 result %s preserves phase and transport health', async mode => {
    const x = await start(); await control(x, 'mode', { mode });
    if (mode === 'malformed' || mode === 'huge') x.host.timeout = FAULT_HOST_TIMEOUT_MS;
    const s = scope(x), o = await s.observe();
    const r = receipt(await s.client.invoke(s.request(o, 'result-' + mode, 'find', good)));
    expect(x.entries()).toHaveLength(1); expect(s.authorized).toHaveLength(1);
    if (mode === 'business') {
      expect(r).toMatchObject({ executionPhase: 'entered-returned', outcome: { status: 'failed', details: { result: {
        success: false, error: { code: 'E_HANDLER_ERROR', message: 'Controlled failure' }, data: { checked: true },
      } } } });
    } else {
      expect(r).toMatchObject({ executionPhase: 'unknown', outcome: { status: 'unknown' } });
      expect(r.outcome).not.toHaveProperty('details');
      expect(x.messages.find((message: any) => message.type === 'VIEW_TOOL_INVOKE_V6_RESPONSE')?.terminal.phase).toBe('finished-unknown');
      expect(JSON.stringify(r)).not.toContain('W07_PRIVATE_EXCEPTION');
    }
    expect(x.host.getInteractionReport()).toMatchObject({ workerToolPending: false, core: { activeInvocations: 0 } });
  });
  it('R18 deduplicates within the instance and authorizes reads from the original observation', async () => {
    const x = await start(), s = scope(x), oa = await s.observe();
    const request = s.request(oa, 'same-id', 'find', good), first = receipt(await s.client.invoke(request));
    expect(receipt(await s.client.invoke(request))).toEqual(first); expect(x.entries()).toHaveLength(1);
    expect(await s.client.invoke({ ...request, input: { ...good, n: 3 } })).toMatchObject({ kind: 'refused', code: 'INVOCATION_ID_CONFLICT' });
    const ob = await s.observe('bb');
    expect(await s.client.invoke(s.request(ob, 'same-id', 'find', good, 'bb')))
      .toMatchObject({ kind: 'refused', code: 'INVOCATION_ID_CONFLICT' });
    const second = value(await s.client.invoke(s.request(ob, 'next-id', 'find', { ...good, view_id: 'bb' }, 'bb')));
    expect(second.data.view).toBe('bb'); expect(x.entries()).toHaveLength(2);
    const query = { observationId: request.observationId, invocationId: request.invocationId };
    expect(receipt(await s.client.readReceipt(query))).toEqual(first);
    s.control.canRead = () => false;
    expect(await s.client.readReceipt(query)).toMatchObject({ kind: 'unavailable', code: 'RECEIPT_PERMISSION_DENIED' });
  });
  it('R19 an invalid terminal preserves the one App-wide execution across observations and tool types', async () => {
    const x = await start(); await control(x, 'mode', { mode: 'hold' });
    const s = scope(x), original = await s.observe();
    const running = s.client.invoke(s.request(original, 'mix-find', 'find', good), FAULT_HOST_TIMEOUT_MS);
    await wait(x, m => m.type === 'TEST_HANDLER_ENTER');
    expect(await s.client.invoke(s.request(original, 'mix-zero', 'zero', {}))).toMatchObject({ code: 'INVOCATION_CAPACITY' });
    const current = await s.observe();
    expect(await s.client.invoke(s.request(current, 'other-observation', 'find', good))).toMatchObject({ code: 'INVOCATION_CAPACITY' });
    const originalEmit = x.worker.emit.bind(x.worker);
    x.worker.emit = (event: string, ...args: any[]) => {
      if (event === 'message' && args[0]?.type === 'VIEW_TOOL_INVOKE_V6_RESPONSE') {
        args[0] = { ...args[0], argumentMode: 'snapshot-value-v2' };
      }
      return originalEmit(event, ...args);
    };
    await control(x, 'release', { id: x.entries()[0].id });
    expect(await running).toMatchObject({ kind: 'unavailable', code: 'INVOCATION_WAIT_TIMEOUT' });
    expect(x.posts()).toHaveLength(1);
    expect(x.entries()).toHaveLength(1);
    expect(x.host.getInteractionReport().workerToolPending).toBe(true);
    x.host.terminate();
    expect((await x.host.waitForResourceRelease()).worker).toBe('exited');
    expect(x.host.getInteractionReport().workerToolPending).toBe(false);
  });
  it('R20 settled business failure allows closing and starting an independent instance', async () => {
    const x = await start(); await control(x, 'mode', { mode: 'business' }); const s = scope(x), o = await s.observe();
    expect(receipt(await s.client.invoke(s.request(o, 'healthy-failure', 'find', good))).outcome).toMatchObject({ status: 'failed', details: { result: { success: false, error: { code: 'E_HANDLER_ERROR' } } } });
    expect(x.host.getInteractionReport().workerToolPending).toBe(false);
    await x.host.close();expect(x.worker.threadId).toBe(-1);
    const y = await start();expect(y.worker).not.toBe(x.worker); expect(y.host.appInstanceId).not.toBe(x.host.appInstanceId);
    const other = scope(y), observed = await other.observe(); await control(y, 'mode', { mode: 'normal' });
    expect(value(await other.client.invoke(other.request(observed, 'new-run', 'find', good))).data.view).toBe('aa');
    const oldRead = await s.client.invoke(s.request(o, 'old-run', 'find', good)); expect(oldRead.kind).not.toBe('receipt');
  });
  it('R21 toolsEnabled false still allows View observation without executable bindings', async () => {
    const x = await start({ toolsEnabled: false }), s = scope(x), o = await s.observe();
    expect(o.views).toHaveLength(2);
    expect(o.tools).toEqual([]);
    expect(x.host.getInteractionReport().toolsEnabled).toBe(false);
    const snapshot = x.snapshot();
    const { nameSharedAcrossViewTypes: _sharedName, ...tool } = Object.values(snapshot.tools).find((t: any) => t.name === 'find' && t.viewType === 'File') as any;
    const requestId = 'read-only-probe', from = x.messages.length;
    x.physical({ type: 'VIEW_TOOL_INVOKE_V6', requestId, appId: 'app', instanceId: x.host.appInstanceId,
      snapshotId: snapshot.id, tool, receiver: receiver(snapshot,tool), argumentMode: 'view-type-parameters-v1',
      rawArgs: good, effectiveArgs: good, refSources: [] });
    expect(await wait(x, message => message.requestId === requestId, from)).toMatchObject({
      type: 'VIEW_TOOL_INVOKE_V6_RESPONSE', terminal: { phase: 'not-entered', result: {
        success: false, error: { code: 'TOOL_EXECUTION_UNAVAILABLE' },
      } },
    });
    expect(x.entries()).toHaveLength(0);
  });
  it('R22 the current shared mode includes empty ordinary parameters and reject duplicate initialization', async () => {
    const x = await start(), s = scope(x), o = await s.observe();
    expect(x.host.getInteractionReport().toolsEnabled).toBe(true);
    expect(value(await s.client.invoke(s.request(o, 'zero', 'zero', {}))).data.args).toEqual({});
    const from = x.messages.length, init = x.sent.find((message: any) => message.type === 'INIT');
    x.physical({ ...init, requestId: 'duplicate-init' });
    const error = await wait(x, message => message.requestId === 'duplicate-init', from);
    expect(error.error.code).toBe('APP_INSTANCE_REUSE_UNSUPPORTED');
    expect(x.host.hasOrdinaryParametersCapability()).toBe(true);
  });
});
