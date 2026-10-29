import { describe, it, expect, vi } from 'vitest';
import { invokeOrdinaryInvocationV1 } from './ordinary-invocation-v1.js';
import { createViewOwnedTools } from '../core/tool/view-owned-tools.js';
const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
function setup(options: any = { safeOrdinaryInvocationMode: 'ordinary-v1' }, safe = true) {
  const registry = createViewOwnedTools('app', 'instance');
  const v = registry.mount('aa', 'File');
  let calls = 0;
  const invoke = vi.fn(async () => {
    calls++;
    return { phase: 'entered-returned' as const, result: { success: true, data: { calls } } };
  });
  registry.registerTool(
    v.viewInstanceId,
    { name: 'read', description: 'Read', isMutating: false, inputSchema: schema },
    async () => ({ success: true }),
    true,
    options,
    safe ? invoke : undefined
  );
  const tool = registry.listTools()[0]!,
    target = tool.targets[0]!;
  const message = {
    type: 'VIEW_TOOL_INVOKE_ORDINARY_V1',
    requestId: 'request',
    appId: 'app',
    instanceId: 'instance',
    snapshotId: 'snapshot',
    tool: (() => {
      const { appId, appInstanceId, ...t } = tool;
      return t;
    })(),
    target,
    argumentMode: 'ordinary-v1',
    args: {},
  };
  const wrap = (t: any) => ({ ...t, appId: 'app', appInstanceId: 'instance' });
  const context = {
    appId: 'app',
    instanceId: 'instance',
    negotiated: true,
    validateBinding: (t: any, v: any) => registry.validate(wrap(t), v),
    validateWrapper: (t: any, v: any) => registry.validateOrdinaryBinding(wrap(t), v),
    invokeBinding: (t: any, v: any, args: any) => registry.invokeOrdinary(wrap(t), v, args),
  };
  return { registry, v, tool, target, message, context, invoke };
}
describe('ordinary final qualification and synchronous entry', () => {
  it('enters one current safe callable and never the legacy handler', async () => {
    const x = setup();
    expect(await invokeOrdinaryInvocationV1(x.message, x.context)).toMatchObject({
      terminal: { phase: 'entered-returned', result: { data: { calls: 1 } } },
    });
    expect(x.invoke).toHaveBeenCalledOnce();
  });
  it.each([0, 1, 2, 3, 4, 5])('rejects invalid arguments case %s', async (index) => {
    const args = [
      null,
      [],
      { extra: 1 },
      Object.defineProperty({}, 'secret', { value: 1 }),
      {
        get x() {
          throw Error('private');
        },
      },
      Object.assign({}, { [Symbol('private')]: 1 }),
    ][index];
    const x = setup();
    expect(await invokeOrdinaryInvocationV1({ ...x.message, args }, x.context)).toMatchObject({
      terminal: { phase: 'not-entered' },
    });
    expect(x.invoke).not.toHaveBeenCalled();
  });
  it.each(['readonly', 'schema', 'instance', 'capability', 'stale', 'marker'])(
    'rejects %s before entry',
    async (kind) => {
      const x = setup(undefined, kind !== 'marker');
      const m: any = { ...x.message };
      const c = { ...x.context };
      if (kind === 'readonly') m.tool = { ...m.tool, isMutating: true };
      if (kind === 'schema')
        m.tool = { ...m.tool, inputSchema: { type: 'object', properties: {}, required: [] } };
      if (kind === 'instance') m.instanceId = 'other';
      if (kind === 'capability') c.negotiated = false;
      if (kind === 'stale') x.registry.setEnabled(x.v.viewInstanceId, 'read', false);
      expect(await invokeOrdinaryInvocationV1(m, c)).toMatchObject({
        terminal: { phase: 'not-entered' },
      });
      expect(x.invoke).not.toHaveBeenCalled();
    }
  );
  it('cannot infer non-entry after calling a throwing safe callable', async () => {
    const x = setup();
    x.context.invokeBinding = () => {
      throw {
        get message() {
          throw Error('sentinel');
        },
      };
    };
    expect(await invokeOrdinaryInvocationV1(x.message, x.context)).toBeNull();
  });
  it.each([
    { safeOrdinaryInvocationMode: 'future' },
    { safeOrdinaryInvocationMode: 'ordinary-v1', safeRefInvocationMode: 'snapshot-value-v1' },
    {
      get safeOrdinaryInvocationMode() {
        throw Error('getter');
      },
    },
  ])('rejects unsafe metadata', (options) => {
    expect(() => setup(options)).toThrow();
  });
  it('unmount and same public id do not revive original binding', async () => {
    const x = setup();
    x.registry.unmount(x.v.viewInstanceId);
    const n = x.registry.mount('aa', 'File');
    expect(n.viewInstanceId).not.toBe(x.v.viewInstanceId);
    expect(await invokeOrdinaryInvocationV1(x.message, x.context)).toMatchObject({
      terminal: { phase: 'not-entered', result: { error: { code: 'VIEW_INSTANCE_REVOKED' } } },
    });
    expect(x.invoke).not.toHaveBeenCalled();
  });
});
