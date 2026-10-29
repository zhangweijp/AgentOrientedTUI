import { EventEmitter } from 'node:events';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { AppWorkerHost } from './worker-host.js';
import { CREATE_IF_ABSENT_V1_CAPABILITY as CREATE } from '../../adapters/create-if-absent-invocation-v1.js';
import { ORDINARY_V1_CAPABILITY as ORDINARY } from '../../adapters/ordinary-invocation-v1.js';
import { REF_V1_CAPABILITY as REF } from '../../adapters/ref-invocation-v1.js';
const hosts: AppWorkerHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.terminate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: (v: any) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}
class Transport extends EventEmitter {
  messages: any[] = [];
  caps: any = 'requested';
  execute: (m: any) => void = (m) =>
    this.answer(
      m,
      m.type === 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1'
        ? { phase: 'entered-returned', outcome: { status: 'succeeded', value: { created: true } } }
        : { phase: 'entered-returned', result: { success: true, data: { read: true } } }
    );
  postMessage = vi.fn((m: any) => {
    this.messages.push(m);
    if (m.type.startsWith('VIEW_TOOL_INVOKE_')) this.execute(m);
    else
      this.emit('message', {
        type: m.type === 'INIT' ? 'INIT_RESPONSE' : 'LIFECYCLE_RESPONSE',
        requestId: m.requestId,
        success: true,
        ...(m.type === 'INIT'
          ? {
              appInstanceId: m.appInstanceId,
              acceptedCapabilities: this.caps === 'requested' ? m.requestedCapabilities : this.caps,
            }
          : {}),
      });
  });
  answer(m: any, terminal: any) {
    this.emit('message', {
      type: m.type + '_RESPONSE',
      requestId: m.requestId,
      appId: m.appId,
      instanceId: m.instanceId,
      argumentMode: m.argumentMode,
      success: true,
      terminal,
    });
  }
  terminate = vi.fn(async () => 0);
}
async function setup(config: any = {}, caps: any = 'requested') {
  const worker = new Transport();
  worker.caps = caps;
  const host = new AppWorkerHost({
    appId: 'app' as any,
    desktopId: 'd' as any,
    appModulePath: 'unused',
    existingWorker: worker as any,
    snapshotShadow: true,
    experimentalReadOnlyViewTools: true,
    experimentalInteractionModes: ['ordinary-v1', 'snapshot-value-v1', 'create-if-absent-v1'],
    timeout: 30,
    ...config,
  });
  hosts.push(host);
  await host.start();
  await host.open();
  const target = { viewId: 'aa', viewInstanceId: 'vi-aa', bindingVersion: 1 };
  const tool = {
    id: JSON.stringify(['app', 'Workspace', 'create']),
    name: 'create',
    viewType: 'Workspace',
    description: 'Create',
    isMutating: true,
    inputSchema: {
      type: 'object',
      properties: { relativePath: { type: 'string' }, content: { type: 'string' } },
      required: ['relativePath', 'content'],
      additionalProperties: false,
    },
    targets: [target],
  };
  const read = {
    ...tool,
    id: JSON.stringify(['app', 'Workspace', 'read']),
    name: 'read',
    description: 'Read',
    isMutating: false,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  };
  worker.emit('message', {
    type: 'SNAPSHOT_PREPARED',
    draft: {
      schemaVersion: 2,
      appId: 'app',
      instanceId: host.appInstanceId,
      producerSeq: 1,
      sourceEpoch: 1,
      capturedAt: 0,
      views: [
        {
          id: 'aa',
          viewInstanceId: 'vi-aa',
          type: 'Workspace',
          name: 'Workspace',
          kind: 'state',
          content: { format: 'markdown-v1', value: 'Workspace' },
        },
      ],
      refs: {},
      tools: { [tool.id]: tool, [read.id]: read },
    },
  });
  const controls = { authorize: (_c: any): any => true, read: (_m: any): any => true };
  const policy: any = {
    project: () => ({
      views: [{ viewId: 'aa', viewInstanceId: 'vi-aa' }],
      refs: [],
      targets: [
        { toolId: tool.id, target },
        { toolId: read.id, target },
      ],
      content: [],
    }),
    authorize: (c: any) => controls.authorize(c),
    canReadReceipt: (m: any) => controls.read(m),
  };
  function open() {
    const r = host.createInteractionScope(policy);
    expect(r.status).toBe('opened');
    if (r.status !== 'opened') throw Error(r.issue.code);
    return r.client;
  }
  return {
    host,
    worker,
    controls,
    policy,
    open,
    async observe(c: any) {
      const r = await c.observe({ viewIds: ['aa'] });
      expect(r.status).toBe('observed');
      return r.observation;
    },
    request: (
      o: any,
      id = 'call',
      name = 'create',
      input: any = name === 'create' ? { relativePath: 'file', content: 'x' } : {}
    ) => ({
      invocationId: id,
      observationId: o.observationId,
      bindingId: o.bindings.find(
        (b: any) => b.toolId === o.tools.find((t: any) => t.name === name).id
      ).bindingId,
      input,
    }),
    sent: () => worker.messages.filter((m) => m.type.startsWith('VIEW_TOOL_INVOKE_')),
  };
}
function receipt(r: any) {
  expect(r.kind).toBe('receipt');
  return r.receipt;
}
describe('W06 opt-in, exact capability and shared transport', () => {
  it.each(['create-only', 'all', 'empty', 'missing'])(
    'supports explicit config %s',
    async (kind) => {
      const config: any = {
        experimentalInteractionModes:
          kind === 'create-only'
            ? ['create-if-absent-v1']
            : kind === 'all'
              ? ['snapshot-value-v1', 'create-if-absent-v1', 'ordinary-v1']
              : kind === 'empty'
                ? []
                : undefined,
        experimentalReadOnlyViewTools: kind !== 'create-only',
      };
      const f = await setup(config);
      expect(f.worker.messages.filter((m) => m.type === 'INIT')).toHaveLength(1);
      const requested = f.worker.messages[0].requestedCapabilities ?? [];
      expect(requested).toEqual(
        kind === 'create-only' ? [CREATE] : kind === 'all' ? [ORDINARY, REF, CREATE] : []
      );
      if (kind === 'empty' || kind === 'missing')
        expect(f.host.createInteractionScope(f.policy).status).toBe('rejected');
      else {
        const c = f.open();
        expect(f.host.getInteractionReport()).toMatchObject({
          mode: 'scoped-create-v1',
          negotiatedModes:
            kind === 'create-only'
              ? ['create-if-absent-v1']
              : ['ordinary-v1', 'snapshot-value-v1', 'create-if-absent-v1'],
        });
        c.close();
      }
    }
  );
  it.each(['getter', 'duplicate', 'unknown', 'too-many', 'no-shadow', 'readonly-prereq'])(
    'rejects %s before Worker access',
    (kind) => {
      const worker = new Transport();
      const config: any = {
        appId: 'app',
        desktopId: 'd',
        appModulePath: 'unused',
        existingWorker: worker,
        snapshotShadow: true,
        experimentalInteractionModes: ['create-if-absent-v1'],
      };
      let reads = 0;
      if (kind === 'getter')
        Object.defineProperty(config, 'experimentalInteractionModes', {
          enumerable: true,
          get() {
            reads++;
            return [];
          },
        });
      if (kind === 'duplicate')
        config.experimentalInteractionModes = ['create-if-absent-v1', 'create-if-absent-v1'];
      if (kind === 'unknown') config.experimentalInteractionModes = ['future'];
      if (kind === 'too-many')
        config.experimentalInteractionModes = [
          'ordinary-v1',
          'snapshot-value-v1',
          'create-if-absent-v1',
          'future',
        ];
      if (kind === 'no-shadow') config.snapshotShadow = false;
      if (kind === 'readonly-prereq')
        config.experimentalInteractionModes = ['ordinary-v1', 'create-if-absent-v1'];
      expect(() => new AppWorkerHost(config)).toThrow('Invalid experimental interaction modes');
      expect(reads).toBe(0);
      expect(worker.postMessage).not.toHaveBeenCalled();
    }
  );
  it.each(['none', 'duplicate', 'unknown', 'unrequested', 'oversize'])(
    'does not grant creation for ACK %s',
    async (kind) => {
      const caps: any =
        kind === 'none'
          ? []
          : kind === 'duplicate'
            ? [CREATE, CREATE]
            : kind === 'unknown'
              ? [CREATE, 'future']
              : kind === 'unrequested'
                ? [CREATE, REF]
                : Array(18).fill(CREATE);
      const f = await setup({ experimentalInteractionModes: ['create-if-absent-v1'] }, caps);
      expect(f.host.hasCreateIfAbsentCapability()).toBe(false);
      expect(f.host.createInteractionScope(f.policy).status).toBe('rejected');
      expect(f.sent()).toHaveLength(0);
    }
  );
  it('shares exact dedup and current read permission without re-entering create', async () => {
    const f = await setup(),
      c = f.open(),
      o = await f.observe(c),
      request = f.request(o),
      first = await c.invoke(request);
    expect(receipt(first).outcome).toEqual({ status: 'succeeded', value: { created: true } });
    expect(await c.invoke(request)).toEqual(first);
    f.controls.read = () => false;
    expect(await c.invoke(request)).toMatchObject({ code: 'RECEIPT_PERMISSION_DENIED' });
    expect(f.sent()).toHaveLength(1);
    c.close();
  });
  it.each(['none', 'partial', 'unknown'])(
    'business %s is trusted completion without transport isolation',
    async (kind) => {
      const f = await setup(),
        c = f.open(),
        o = await f.observe(c);
      f.worker.execute = (m) =>
        f.worker.answer(m, {
          phase: 'entered-returned',
          outcome:
            kind === 'unknown'
              ? { status: 'unknown', code: 'UNKNOWN', message: 'Unknown' }
              : { status: 'failed', code: 'FAIL', message: 'Failure', effects: kind },
        });
      expect(receipt(await c.invoke(f.request(o))).outcome.status).toBe(
        kind === 'unknown' ? 'unknown' : 'failed'
      );
      expect(f.host.getInteractionReport()?.transportUncertain).toBe(false);
      c.close();
    }
  );
  it.each(['create-first', 'read-first'])(
    'posted companion settles after shared unknown %s',
    async (order) => {
      const f = await setup(),
        c = f.open(),
        o = await f.observe(c),
        first = deferred(),
        second = deferred(),
        posted: any[] = [];
      vi.useFakeTimers();
      f.worker.execute = (m) => {
        posted.push(m);
        (posted.length === 1 ? first : second).resolve(m);
      };
      const create = f.request(o, 'create'),
        read = f.request(o, 'read', 'read');
      const lost = c.invoke(order === 'create-first' ? create : read);
      await first.promise;
      await vi.advanceTimersByTimeAsync(10);
      const peer = c.invoke(order === 'create-first' ? read : create);
      await second.promise;
      await vi.advanceTimersByTimeAsync(20);
      expect(receipt(await lost).outcome.status).toBe('unknown');
      expect(f.host.getInteractionReport()?.transportUncertain).toBe(true);
      const m = posted[1];
      f.worker.answer(
        m,
        m.type === 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1'
          ? {
              phase: 'entered-returned',
              outcome: { status: 'succeeded', value: { created: true } },
            }
          : { phase: 'entered-returned', result: { success: true } }
      );
      expect(receipt(await peer).outcome.status).toBe('succeeded');
      expect(receipt(await c.invoke(f.request(o, 'new'))).outcome.status).toBe('rejected');
      expect(f.sent()).toHaveLength(2);
      expect(await f.host.releaseWorker()).toBeNull();
      c.close();
    }
  );
});
