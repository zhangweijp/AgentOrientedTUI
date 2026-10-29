import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { SnapshotShadowReceiver } from '../../adapters/snapshot/shadow-receiver.js';
import { refKey } from '../../core/snapshot/index.js';
import { ORDINARY_V1_CAPABILITY } from '../../adapters/ordinary-invocation-v1.js';
import { REF_V1_CAPABILITY } from '../../adapters/ref-invocation-v1.js';
import type { ScopePolicy } from '../../core/invocation/scoped-interaction.js';

const hosts: AppWorkerHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.terminate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Transport extends EventEmitter {
  messages: any[] = [];
  caps: any = [ORDINARY_V1_CAPABILITY, REF_V1_CAPABILITY];
  hold = new Set<string>();
  ref: (m: any) => void = (m) =>
    this.answer(m, {
      phase: 'entered-returned',
      result: { success: true, data: { args: m.effectiveArgs ?? m.args } },
    });
  postMessage = vi.fn((m: any) => {
    this.messages.push(m);
    if (this.hold.has(m.type)) return;
    if (m.type === 'VIEW_TOOL_INVOKE_REF_V1' || m.type === 'VIEW_TOOL_INVOKE_ORDINARY_V1')
      this.ref(m);
    else this.answer(m);
  });
  answer(m: any, terminal?: any) {
    this.emit(
      'message',
      terminal
        ? {
            type: m.type + '_RESPONSE',
            requestId: m.requestId,
            appId: m.appId,
            instanceId: m.instanceId,
            argumentMode: m.argumentMode,
            success: true,
            terminal,
          }
        : {
            type: m.type === 'INIT' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE',
            requestId: m.requestId,
            success: true,
            ...(m.type === 'INIT'
              ? { appInstanceId: m.appInstanceId, acceptedCapabilities: this.caps }
              : {}),
          }
    );
  }
  terminate = vi.fn(async () => 0);
}
async function fixture(config: any = {}, caps: any = [ORDINARY_V1_CAPABILITY, REF_V1_CAPABILITY]) {
  const worker = new Transport();
  worker.caps = caps;
  const host = new AppWorkerHost({
    appId: 'app' as any,
    desktopId: 'd' as any,
    appModulePath: 'unused',
    existingWorker: worker as any,
    timeout: 30,
    snapshotShadow: true,
    experimentalReadOnlyViewTools: true,
    experimentalSnapshotValueRefExecution: true,
    experimentalInteractionModes: ['ordinary-v1', 'snapshot-value-v1'],
    ...config,
  });
  hosts.push(host);
  await host.start();
  await host.open();
  const receiver = (host as any).shadowReceiver;
  const toolId = JSON.stringify(['app', 'File', 'read']);
  let sequence = 0;
  const views = ['aa', 'bb'].map((id) => ({
    id,
    viewInstanceId: 'vi-' + id,
    type: 'File',
    name: id,
    kind: 'state',
    content: { format: 'markdown-v1', value: id },
  }));
  const tool = {
    id: toolId,
    name: 'read',
    description: 'Read',
    viewType: 'File',
    isMutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          'x-aotui-ref': { version: 1, kind: 'snapshot-value', owner: 'tool-target' },
        },
      },
      required: ['file'],
    },
    targets: views.map((v) => ({
      viewId: v.id,
      viewInstanceId: v.viewInstanceId,
      bindingVersion: 1,
    })),
  };
  const ordinary = {
    ...tool,
    id: JSON.stringify(['app', 'File', 'query']),
    name: 'query',
    description: 'Query',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  };
  const refs = (payload: any = { text: 'A' }) =>
    Object.fromEntries(
      views.map((v) => [
        refKey(v.id, v.viewInstanceId, 'file'),
        {
          id: 'file',
          ownerViewId: v.id,
          ownerViewInstanceId: v.viewInstanceId,
          refType: 'unknown',
          target: { kind: 'snapshot-value', payload },
        },
      ])
    );
  function publish(patch: any = {}) {
    sequence++;
    worker.emit('message', {
      type: 'SNAPSHOT_PREPARED',
      draft: {
        schemaVersion: 2,
        appId: 'app',
        instanceId: host.appInstanceId,
        producerSeq: sequence,
        sourceEpoch: sequence,
        capturedAt: sequence,
        views,
        refs: refs(),
        tools: { [toolId]: tool, [ordinary.id]: ordinary },
        ...patch,
      },
    });
    return receiver?.core.store.readLatest('app');
  }
  publish();
  const controls = {
    project: (ctx: any): any => ({
      views: ctx.source.views
        .filter((v: any) => ctx.selection.viewIds.includes(v.id))
        .map((v: any) => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
      refs: Object.values(ctx.source.refs)
        .filter((r: any) => ctx.selection.viewIds.includes(r.ownerViewId))
        .map((r: any) => ({
          viewId: r.ownerViewId,
          viewInstanceId: r.ownerViewInstanceId,
          refId: r.id,
        })),
      targets: Object.values(ctx.source.tools).flatMap((t: any) =>
        t.targets
          .filter((v: any) => ctx.selection.viewIds.includes(v.viewId))
          .map((target: any) => ({ toolId: t.id, target }))
      ),
      content: [],
    }),
    authorize: (_ctx: any): any => true,
    read: (_metadata: any, _signal: any): any => true,
  };
  const policy: ScopePolicy = {
    project: (ctx) => controls.project(ctx),
    authorize: (ctx) => controls.authorize(ctx),
    canReadReceipt: (m, s) => controls.read(m, s),
  };
  function open() {
    const result = host.createInteractionScope(policy);
    expect(result.status).toBe('opened');
    if (result.status !== 'opened') throw Error(result.issue.code);
    return result.client;
  }
  async function observe(client: any, viewId = 'aa') {
    const r = await client.observe({ viewIds: [viewId] });
    expect(r.status).toBe('observed');
    return r.observation;
  }
  const request = (o: any, id = 'call', input: any = {}, name = 'query') => ({
    invocationId: id,
    observationId: o.observationId,
    bindingId: o.bindings.find(
      (b: any) => b.toolId === o.tools.find((t: any) => t.name === name).id
    ).bindingId,
    input,
  });
  const sent = () =>
    worker.messages.filter(
      (m) => m.type === 'VIEW_TOOL_INVOKE_REF_V1' || m.type === 'VIEW_TOOL_INVOKE_ORDINARY_V1'
    );
  return {
    host,
    worker,
    receiver,
    views,
    tool,
    toolId,
    refs,
    publish,
    controls,
    policy,
    open,
    observe,
    request,
    sent,
  };
}
function receipt(r: any) {
  expect(r.kind).toBe('receipt');
  if (r.kind !== 'receipt') throw Error(r.code);
  return r.receipt;
}

describe('W05 mode configuration and one exact ACK', () => {
  it.each([0, 1, 2, 3])('honors explicit precedence and frozen ordering case %s', async (index) => {
    const modes = [
      [],
      ['ordinary-v1'],
      ['snapshot-value-v1'],
      ['snapshot-value-v1', 'ordinary-v1'],
    ][index]!;
    const caps = modes.map((m) =>
      m === 'ordinary-v1' ? ORDINARY_V1_CAPABILITY : REF_V1_CAPABILITY
    );
    const f = await fixture({ experimentalInteractionModes: modes }, caps);
    const init = f.worker.messages.find((m) => m.type === 'INIT');
    expect(init.requestedCapabilities ?? []).toEqual(
      ['ordinary-v1', 'snapshot-value-v1']
        .filter((m) => modes.includes(m))
        .map((m) => (m === 'ordinary-v1' ? ORDINARY_V1_CAPABILITY : REF_V1_CAPABILITY))
    );
    const opened = f.host.createInteractionScope(f.policy);
    if (modes.length) {
      expect(opened.status).toBe('opened');
      if (opened.status === 'opened') opened.client.close();
      expect(f.host.getInteractionReport()?.negotiatedModes).toEqual(
        ['ordinary-v1', 'snapshot-value-v1'].filter((m) => modes.includes(m))
      );
    } else expect(opened.status).toBe('rejected');
  });
  it.each([0, 1, 2, 3, 4, 5])('rejects invalid config before Worker case %s', (index) => {
    const modes = [
      null,
      'ordinary-v1',
      ['future'],
      ['ordinary-v1', 'ordinary-v1'],
      ['ordinary-v1', 'snapshot-value-v1', 'ordinary-v1'],
      Object.defineProperty([], '0', {
        enumerable: true,
        get() {
          throw Error('private');
        },
      }),
    ][index];
    const worker = new Transport();
    expect(
      () =>
        new AppWorkerHost({
          appId: 'a' as any,
          desktopId: 'd' as any,
          appModulePath: 'unused',
          existingWorker: worker as any,
          snapshotShadow: true,
          experimentalReadOnlyViewTools: true,
          experimentalInteractionModes: modes as any,
        })
    ).toThrow('Invalid experimental interaction modes');
    expect(worker.postMessage).not.toHaveBeenCalled();
  });
  it('rejects getter config without reading and validates prerequisites', () => {
    let reads = 0;
    const config: any = {
      appId: 'a',
      desktopId: 'd',
      appModulePath: 'unused',
      get experimentalInteractionModes() {
        reads++;
        return [];
      },
    };
    expect(() => new AppWorkerHost(config)).toThrow('Invalid experimental interaction modes');
    expect(reads).toBe(0);
    expect(
      () =>
        new AppWorkerHost({
          appId: 'a' as any,
          desktopId: 'd' as any,
          appModulePath: 'unused',
          experimentalInteractionModes: ['ordinary-v1'],
        })
    ).toThrow();
  });
  it.each([
    'absent',
    [],
    ['future'],
    [ORDINARY_V1_CAPABILITY, ORDINARY_V1_CAPABILITY],
    [REF_V1_CAPABILITY, ORDINARY_V1_CAPABILITY, 'future'],
    {},
    Array(18).fill('x'),
  ])('rejects malformed/empty ACK without legacy fallback %s', async (caps) => {
    const f = await fixture({}, caps === 'absent' ? null : caps);
    expect(f.host.createInteractionScope(f.policy).status).toBe('rejected');
    expect(f.sent()).toHaveLength(0);
  });
  it('accepts only requested subset from an old Ref-only Worker', async () => {
    const f = await fixture({}, [REF_V1_CAPABILITY]),
      c = f.open(),
      o = await f.observe(c);
    expect(o.tools.map((tool: any) => tool.name)).toEqual(['read']);
    expect(o.bindings.every((binding: any) => binding.toolId === f.toolId)).toBe(true);
    expect(receipt(await c.invoke({ invocationId: 'ordinary', observationId: o.observationId,
      bindingId: 'unobserved-ordinary-binding', input: {} }))).toMatchObject({
      executionPhase: 'not-dispatched', outcome: { status: 'rejected' },
    });
    expect(f.sent()).toHaveLength(0);
    expect(
      receipt(await c.invoke(f.request(o, 'ref', { file: 'file' }, 'read'))).outcome.status
    ).toBe('succeeded');
    expect(f.sent().map(message => message.type)).toEqual(['VIEW_TOOL_INVOKE_REF_V1']);
    expect(f.host.getInteractionReport()?.negotiatedModes).toEqual(['snapshot-value-v1']);
    c.close();
  });
});
describe('W05 common Core and cross-mode transport state', () => {
  it('deduplicates, rechecks read permission and keeps completed false outside transport uncertainty', async () => {
    const f = await fixture(),
      c = f.open(),
      o = await f.observe(c);
    const req = f.request(o);
    let reads = 0;
    f.controls.read = () => ++reads < 2;
    expect(receipt(await c.invoke(req)).outcome.status).toBe('succeeded');
    expect(await c.invoke(req)).toMatchObject({ code: 'RECEIPT_PERMISSION_DENIED' });
    expect(f.sent()).toHaveLength(1);
    f.controls.read = () => true;
    f.worker.ref = (m) =>
      f.worker.answer(m, {
        phase: 'entered-returned',
        result: { success: false, error: { code: 'E_INVALID_ARGS', message: '' } },
      });
    expect(receipt(await c.invoke(f.request(o, 'false'))).outcome.status).toBe('unknown');
    expect(f.host.getInteractionReport()?.transportUncertain).toBe(false);
    c.close();
  });
  it.each(['ordinary-first', 'ref-first'])(
    'one unknown blocks both new dispatches, posted peer settles after unknown %s',
    async (order) => {
      const f = await fixture(),
        c = f.open(),
        o = await f.observe(c),
        first = deferred(),
        second = deferred();
      vi.useFakeTimers();
      const posted: any[] = [];
      f.worker.ref = (m) => {
        posted.push(m);
        (posted.length === 1 ? first : second).resolve(m);
      };
      const ordinary = f.request(o, 'ordinary');
      const ref = f.request(o, 'ref', { file: 'file' }, 'read');
      const lost = c.invoke(order === 'ordinary-first' ? ordinary : ref);
      await first.promise;
      await vi.advanceTimersByTimeAsync(10);
      const peer = c.invoke(order === 'ordinary-first' ? ref : ordinary);
      await second.promise;
      await vi.advanceTimersByTimeAsync(20);
      expect(receipt(await lost).outcome.status).toBe('unknown');
      expect(f.host.getInteractionReport()?.transportUncertain).toBe(true);
      const pending = posted[1];
      f.worker.answer(pending, {
        phase: 'entered-returned',
        result: { success: true, data: { ok: true } },
      });
      expect(receipt(await peer).outcome.status).toBe('succeeded');
      const before = f.sent().length;
      expect(
        receipt(
          await c.invoke(
            f.request(
              o,
              'after',
              order === 'ordinary-first' ? { file: 'file' } : {},
              order === 'ordinary-first' ? 'read' : 'query'
            )
          )
        ).outcome.status
      ).toBe('rejected');
      expect(f.sent()).toHaveLength(before);
      expect(await f.host.releaseWorker()).toBeNull();
      c.close();
    }
  );
  it.each(['wrong-mode', 'wrong-type', 'wrong-instance'])(
    'correlated %s terminal is unknown and not reusable',
    async (kind) => {
      const f = await fixture(),
        c = f.open(),
        o = await f.observe(c);
      f.worker.ref = (m) =>
        f.worker.emit('message', {
          type: kind === 'wrong-type' ? 'VIEW_TOOL_INVOKE_REF_V1_RESPONSE' : m.type + '_RESPONSE',
          requestId: m.requestId,
          appId: m.appId,
          instanceId: kind === 'wrong-instance' ? 'other' : m.instanceId,
          argumentMode: kind === 'wrong-mode' ? 'snapshot-value-v1' : m.argumentMode,
          success: true,
          terminal: { phase: 'entered-returned', result: { success: true } },
        });
      expect(receipt(await c.invoke(f.request(o))).outcome.status).toBe('unknown');
      expect(f.host.getInteractionReport()?.transportUncertain).toBe(true);
      c.close();
    }
  );
  it('normal release gives one Worker ownership and new Host can negotiate it', async () => {
    const f = await fixture(),
      c = f.open(),
      o = await f.observe(c);
    expect(receipt(await c.invoke(f.request(o))).outcome.status).toBe('succeeded');
    c.close();
    expect(await f.host.releaseWorker()).toBe(f.worker);
    expect(await f.host.releaseWorker()).toBeNull();
    const n = new AppWorkerHost({
      appId: 'new' as any,
      desktopId: 'd' as any,
      appModulePath: 'unused',
      existingWorker: f.worker as any,
      snapshotShadow: true,
      experimentalReadOnlyViewTools: true,
      experimentalInteractionModes: ['ordinary-v1', 'snapshot-value-v1'],
    });
    hosts.push(n);
    await n.start();
    await n.open();
    expect(n.hasOrdinaryCapability()).toBe(true);
  });
  it('pending authorization cannot revive after close and remains charged until settlement', async () => {
    const f = await fixture(),
      c = f.open(),
      o = await f.observe(c),
      gate = deferred(),
      entered = deferred();
    f.controls.authorize = () => {
      entered.resolve(undefined);
      return gate.promise;
    };
    const result = c.invoke(f.request(o));
    await entered.promise;
    c.close();
    expect(f.host.getInteractionReport()?.core.closingScopes).toBe(1);
    gate.resolve(true);
    expect(await result).toMatchObject({ kind: 'unavailable' });
    expect(f.sent()).toHaveLength(0);
    expect(f.host.getInteractionReport()?.core.closingScopes).toBe(0);
  });
});
