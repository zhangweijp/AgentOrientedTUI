import { describe, it, expect } from 'vitest';
import { createSnapshotCore, refKey } from '../snapshot/index.js';
import { createViewOwnedTools } from '../tool/view-owned-tools.js';
import { createScopedInteraction } from './scoped-interaction.js';
const schema = {
  type: 'object',
  properties: { relativePath: { type: 'string' }, content: { type: 'string' } },
  required: ['relativePath', 'content'],
  additionalProperties: false,
};
function deferred() {
  let resolve!: (v: any) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}
function receipt(r: any) {
  expect(r.kind).toBe('receipt');
  return r.receipt;
}
function fixture(mode = 'create-if-absent', mutating = true) {
  let time = 0,
    seq = 0,
    calls = 0;
  const core = createSnapshotCore({ now: () => time });
  core.lifecycle.startApp('app', 'run');
  const tools = createViewOwnedTools('app', 'run'),
    view = tools.mount('view', 'Workspace');
  tools.registerTool(
    view.viewInstanceId,
    { name: 'create', description: 'Create', inputSchema: schema, isMutating: mutating },
    async () => ({ success: false })
  );
  const listed = tools.listTools()[0]!;
  const { appId, appInstanceId, ...tool } = listed;
  const publish = () =>
    core.committer.accept({
      schemaVersion: 2,
      appId: 'app',
      instanceId: 'run',
      producerSeq: ++seq,
      sourceEpoch: seq,
      capturedAt: time,
      views: [
        {
          id: 'view',
          viewInstanceId: view.viewInstanceId,
          type: 'Workspace',
          name: 'Workspace',
          kind: 'state',
          content: { format: 'markdown-v1', value: 'Workspace' },
        },
      ],
      refs: {
        [refKey('view', view.viewInstanceId, 'entity')]: {
          id: 'entity',
          ownerViewId: 'view',
          ownerViewInstanceId: view.viewInstanceId,
          refType: 'File',
          target: { kind: 'entity', entityType: 'File', entityId: 'f', entityVersion: '1' },
        },
      },
      tools: { [tool.id]: tool },
    } as any);
  expect(publish().status).toBe('published');
  const controls: any = {
    validate: (_s: any, v: any) => ({ ok: true, value: v }),
    authorize: () => true,
    read: () => true,
    execute: () => ({
      kind: 'action',
      phase: 'entered-returned',
      outcome: { status: 'succeeded', value: { done: true } },
    }),
  };
  let current: any = {
    identity: {},
    mode,
    validateInput: (...a: any[]) => controls.validate(...a),
    isLive: () => ({ ok: true }),
    execute: (c: any) => {
      calls++;
      return controls.execute(c);
    },
  };
  const authority = createScopedInteraction(core.store, {
    namespace: 'create-test',
    now: () => time,
    limits: { maxReceiptsPerScope: 2, receiptTtlMs: 10 },
  });
  const input: any = {
    appId: 'app',
    instanceId: 'run',
    policy: {
      project: () => ({
        views: [{ viewId: 'view', viewInstanceId: view.viewInstanceId }],
        refs: [{ viewId: 'view', viewInstanceId: view.viewInstanceId, refId: 'entity' }],
        targets: [{ toolId: tool.id, target: tool.targets[0] }],
        content: [],
      }),
      authorize: (c: any) => controls.authorize(c),
      canReadReceipt: (...a: any[]) => controls.read(...a),
    },
    execution: { resolve: () => current },
  };
  const open = () => {
    const r = authority.createScope(input);
    expect(r.status).toBe('opened');
    if (r.status !== 'opened') throw Error(r.issue.code);
    return r.client;
  };
  const observe = async (c: any) => {
    const r = await c.observe({ viewIds: ['view'] });
    expect(r.status).toBe('observed');
    return r.observation;
  };
  return {
    core,
    authority,
    controls,
    open,
    observe,
    publish,
    get calls() {
      return calls;
    },
    set binding(b: any) {
      current = b;
    },
    get binding() {
      return current;
    },
    time: (n: number) => (time = n),
    request: (o: any, id = 'call', value: any = { relativePath: 'file', content: 'x' }) => ({
      invocationId: id,
      observationId: o.observationId,
      bindingId: o.bindings[0].bindingId,
      input: value,
    }),
    zero: () => {
      authority.close();
      expect(authority.inspect().combinedBytes).toBe(0);
      expect(core.store.inspect().activeLeases).toBe(0);
    },
  };
}
describe('W06 same Core create mode', () => {
  it('deduplicates exact requests across active/completed work, separates Scopes, rechecks reads and retains expired IDs', async () => {
    const f = fixture(),
      a = f.open(),
      b = f.open(),
      o = await f.observe(a),
      other = await f.observe(b),
      gate = deferred();
    f.controls.execute = () => gate.promise;
    const req = f.request(o),
      first = a.invoke(req),
      duplicate = a.invoke(req);
    gate.resolve({
      kind: 'action',
      phase: 'entered-returned',
      outcome: { status: 'succeeded', value: 0 },
    });
    const r = await first;
    expect(await duplicate).toEqual(r);
    expect(await a.invoke(req)).toEqual(r);
    expect(f.calls).toBe(1);
    expect(
      await a.invoke(f.request(o, 'call', { relativePath: 'other', content: 'x' }))
    ).toMatchObject({ kind: 'refused', code: 'INVOCATION_ID_CONFLICT' });
    expect(receipt(await b.invoke(f.request(other))).outcome.status).toBe('succeeded');
    expect(f.calls).toBe(2);
    f.controls.read = () => false;
    expect(await a.invoke(req)).toMatchObject({ code: 'RECEIPT_PERMISSION_DENIED' });
    f.controls.read = () => true;
    f.time(10);
    f.authority.sweepExpired();
    expect(await a.invoke(req)).toMatchObject({ code: 'RESULT_EXPIRED' });
    expect(f.calls).toBe(2);
    f.zero();
  });
  it('keeps create IDs at full capacity and after expiry without evicting them to replay effects', async () => {
    const f = fixture(),
      c = f.open(),
      o = await f.observe(c);
    const one = f.request(o, 'one'),
      two = f.request(o, 'two');
    expect(receipt(await c.invoke(one)).outcome.status).toBe('succeeded');
    expect(receipt(await c.invoke(two)).outcome.status).toBe('succeeded');
    expect(await c.invoke(f.request(o, 'three'))).toMatchObject({
      kind: 'refused',
      code: 'INVOCATION_CAPACITY',
    });
    expect(receipt(await c.invoke(one)).outcome.status).toBe('succeeded');
    expect(f.calls).toBe(2);
    f.time(10);
    f.authority.sweepExpired();
    expect(await c.invoke(one)).toMatchObject({ code: 'RESULT_EXPIRED' });
    expect(await c.invoke(f.request(o, 'three'))).toMatchObject({
      kind: 'refused',
      code: 'INVOCATION_CAPACITY',
    });
    expect(f.calls).toBe(2);
    f.zero();
  });
  it('executes an ordinary mutation without requiring an entity Ref or create-if-absent mode', async () => {
    const f = fixture('ordinary', true), c = f.open(), o = await f.observe(c);
    expect(o.tools[0].isMutating).toBe(true);
    expect(receipt(await c.invoke(f.request(o))).outcome).toEqual({ status: 'succeeded', value: { done: true } });
    expect(f.calls).toBe(1);
    f.zero();
  });
  it.each([
    'readonly-create',
    'entity-without-version',
    'create-with-ref',
    'provider',
    'caller-mode',
    'caller-condition',
    'caller-root',
    'argument-changed',
    'invalid-input',
  ])('rejects unsupported %s without execution', async (kind) => {
    const f = fixture(
        kind === 'entity-without-version' ? 'versioned-entity' : 'create-if-absent',
        kind !== 'readonly-create'
      ),
      c = f.open(),
      o = await f.observe(c);
    const req: any = f.request(o);
    if (kind === 'create-with-ref') req.refId = 'entity';
    if (kind === 'provider')
      f.binding = {
        ...f.binding,
        operations: { owns: () => true, query: () => ({ status: 'pending' }) },
      };
    if (kind === 'caller-mode') req.mode = 'create-if-absent';
    if (kind === 'caller-condition') req.condition = 'absent';
    if (kind === 'caller-root') req.input = { ...req.input, root: '/other' };
    if (kind === 'argument-changed')
      f.controls.validate = (_s: any, v: any) => ({
        ok: true,
        value: { ...v, content: 'changed' },
      });
    if (kind === 'invalid-input') req.input.content = 0;
    const result = await c.invoke(req);
    if (kind === 'caller-mode' || kind === 'caller-condition') {
      expect(result).toMatchObject({ kind: 'refused' });
      expect(f.calls).toBe(0);
      f.zero();
      return;
    }
    const r = receipt(result);
    expect(r.outcome.status).toBe('rejected');
    if (kind === 'argument-changed') expect(r.outcome.code).toBe('CREATE_ARGUMENT_CHANGED');
    expect(f.calls).toBe(0);
    f.zero();
  });
  it.each(['validate', 'authorize'])('rechecks changed binding after %s', async (stage) => {
    const f = fixture(),
      c = f.open(),
      o = await f.observe(c),
      gate = deferred(),
      entered = deferred();
    f.controls[stage] = () => {
      entered.resolve(true);
      return gate.promise;
    };
    const p = c.invoke(f.request(o));
    await entered.promise;
    f.binding = { ...f.binding, identity: {} };
    gate.resolve(
      stage === 'validate' ? { ok: true, value: { relativePath: 'file', content: 'x' } } : true
    );
    expect(receipt(await p).outcome.code).toBe('TOOL_SOURCE_STALE');
    expect(f.calls).toBe(0);
    f.zero();
  });
  it.each(['stop-start', 'close'])(
    'revokes %s during authorization and retains local responsibility until settlement',
    async (kind) => {
      const f = fixture(),
        c = f.open(),
        o = await f.observe(c),
        gate = deferred(),
        entered = deferred();
      f.controls.authorize = () => {
        entered.resolve(true);
        return gate.promise;
      };
      const p = c.invoke(f.request(o));
      await entered.promise;
      if (kind === 'close') c.close();
      else {
        f.core.lifecycle.stopApp('app', 'run');
        f.core.lifecycle.startApp('app', 'new-unready');
      }
      f.authority.inspect();
      expect(f.authority.inspect().activeInvocations).toBe(1);
      gate.resolve(true);
      expect(await p).toMatchObject({ kind: 'unavailable' });
      expect(f.calls).toBe(0);
      f.zero();
    }
  );
  it('cannot acquire an accepted operation provider and preserves explicit failed/partial and business unknown', async () => {
    for (const outcome of [
      { status: 'accepted', operationId: 'x' },
      { status: 'failed', code: 'WRITE', message: 'Partial', effects: 'partial' },
      { status: 'unknown', code: 'UNKNOWN', message: 'Unknown' },
    ]) {
      const f = fixture(),
        c = f.open(),
        o = await f.observe(c);
      f.controls.execute = () => ({ kind: 'action', phase: 'entered-returned', outcome });
      const r = receipt(await c.invoke(f.request(o)));
      expect(r.outcome.status).toBe(outcome.status === 'accepted' ? 'unknown' : outcome.status);
      expect(f.authority.inspect().acceptedOperations).toBe(0);
      f.zero();
    }
  });
});
