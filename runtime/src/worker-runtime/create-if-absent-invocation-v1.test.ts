import { describe, it, expect, vi } from 'vitest';
import { invokeCreateIfAbsentInvocationV1 } from './create-if-absent-invocation-v1.js';
import { createViewOwnedTools } from '../core/tool/view-owned-tools.js';
const schema = {
  type: 'object',
  properties: { relativePath: { type: 'string' }, content: { type: 'string' } },
  required: ['relativePath', 'content'],
  additionalProperties: false,
};
function setup(safe = true) {
  const registry = createViewOwnedTools('app', 'run'),
    view = registry.mount('aa', 'Workspace'),
    legacy = vi.fn(async () => ({ success: false })),
    invoke = vi.fn(async () => ({
      phase: 'entered-returned' as const,
      outcome: { status: 'succeeded' as const, value: { created: true } },
    }));
  registry.registerTool(
    view.viewInstanceId,
    { name: 'create', description: 'Create', inputSchema: schema, isMutating: true },
    legacy,
    true,
    safe ? { safeCreateIfAbsentInvocationMode: 'create-if-absent-v1' } : undefined,
    safe ? invoke : undefined
  );
  const tool = registry.listTools()[0]!,
    { appId, appInstanceId, ...publicTool } = tool,
    target = tool.targets[0]!;
  const m = {
    type: 'VIEW_TOOL_INVOKE_CREATE_IF_ABSENT_V1',
    requestId: 'r',
    appId: 'app',
    instanceId: 'run',
    snapshotId: 's',
    tool: publicTool,
    target,
    argumentMode: 'create-if-absent-v1',
    args: { relativePath: 'file', content: 'data' },
  };
  const bind = (t: any) => ({ ...t, appId: 'app', appInstanceId: 'run' });
  const context = {
    appId: 'app',
    instanceId: 'run',
    negotiated: true,
    validateBinding: (t: any, v: any) => registry.validate(bind(t), v),
    validateWrapper: (t: any, v: any) => registry.validateCreateIfAbsentBinding(bind(t), v),
    invokeBinding: (t: any, v: any, a: any) => registry.invokeCreateIfAbsent(bind(t), v, a),
  };
  return { registry, view, invoke, legacy, m, context };
}
describe('W06 final qualified callable entry', () => {
  it('enters qualified function only after synchronous current-target checks', async () => {
    const x = setup();
    expect(await invokeCreateIfAbsentInvocationV1(x.m, x.context)).toMatchObject({
      terminal: { phase: 'entered-returned', outcome: { status: 'succeeded' } },
    });
    expect(x.invoke).toHaveBeenCalledOnce();
    expect(x.legacy).not.toHaveBeenCalled();
  });
  it.each([
    'plain-mutating',
    'missing-factory',
    'readonly',
    'schema',
    'extra',
    'missing',
    'number',
    'getter',
    'instance',
    'unnegotiated',
    'unmount',
    'rebind',
  ])('refuses %s without handler entry', async (kind) => {
    const x = setup(kind !== 'plain-mutating'),
      m: any = { ...x.m },
      ctx = { ...x.context };
    if (kind === 'missing-factory')
      expect(() =>
        x.registry.registerTool(
          x.view.viewInstanceId,
          { name: 'other', description: 'Other', inputSchema: schema, isMutating: true },
          x.legacy,
          true,
          { safeCreateIfAbsentInvocationMode: 'create-if-absent-v1' }
        )
      ).toThrow();
    if (kind === 'readonly') m.tool = { ...m.tool, isMutating: false };
    if (kind === 'schema')
      m.tool = { ...m.tool, inputSchema: { ...schema, additionalProperties: true } };
    if (kind === 'extra') m.args = { ...m.args, workspaceRoot: '/elsewhere' };
    if (kind === 'missing') m.args = { relativePath: 'file' };
    if (kind === 'number') m.args = { relativePath: 'file', content: 0 };
    if (kind === 'getter')
      m.args = {
        relativePath: 'file',
        get content() {
          throw Error('private');
        },
      };
    if (kind === 'instance') m.instanceId = 'other';
    if (kind === 'unnegotiated') ctx.negotiated = false;
    if (kind === 'unmount') x.registry.unmount(x.view.viewInstanceId);
    if (kind === 'rebind') x.registry.setEnabled(x.view.viewInstanceId, 'create', false);
    if (kind === 'missing-factory') return;
    expect(await invokeCreateIfAbsentInvocationV1(m, ctx)).toMatchObject({
      terminal: { phase: 'not-entered', outcome: { status: 'rejected' } },
    });
    expect(x.invoke).not.toHaveBeenCalled();
    expect(x.legacy).not.toHaveBeenCalled();
  });
  it('an exception after invocation cannot claim non-entry', async () => {
    const x = setup();
    x.context.invokeBinding = () => {
      throw {
        get message() {
          throw Error('private');
        },
      };
    };
    expect(await invokeCreateIfAbsentInvocationV1(x.m, x.context)).toBeNull();
  });
});
