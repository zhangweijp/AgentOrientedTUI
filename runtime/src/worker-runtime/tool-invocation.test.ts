import { describe, it, expect, vi } from 'vitest';
import { invokeViewTool } from './tool-invocation.js';
import { compileToolParameters, type ToolRoute, type ViewToolReceiver, type ViewToolInvocationTerminal } from '@aotui/core';
import type { ViewToolInvokeResponse } from '../spi/worker-protocol/messages.js';
import { createViewOwnedTools, viewToolReceiver } from '@aotui/core/producer';

function setup() {
  const compiled = compileToolParameters({ type: 'object', properties: { e: { type: 'string', enum: ['1'] } }, required: ['e'], additionalProperties: false });
  if (!compiled.ok) throw Error('Fixture');
  const registry = createViewOwnedTools('app', 'run');
  const handler = vi.fn(async (args: Readonly<Record<string, unknown>>) => ({ success: true, data: { value: args.e } }));
  registry.defineViewTypes([{ name: "File", multiplicity: 'multiple', tools: [{ name: 'find', description: 'Find', inputSchema: compiled.contract.schema }] }]);
  const mount = () => {
    const plan = registry.prepareFrame([{ idPrefix: 'aa', type: 'File', owner: {},
      bindings: [{ name: 'find', execute: handler, enabled: true }] }]);
    plan.accept();
    return plan;
  };
  const plan = mount();
  const { id, viewType, name } = plan.tools[0]!;
  const tool = { id, viewType, name };
  const receiver = viewToolReceiver({ id: plan.instances[0]!.viewId, toolBindings: plan.instances[0]!.toolBindings,
    viewInstanceId: plan.instances[0]!.viewInstanceId } as any, tool.id)!;
  const message = { type: 'VIEW_TOOL_INVOKE', requestId: 'r', appId: 'app', instanceId: 'run',
    tool, receiver, effectiveArgs: { e: '1' }, localRefs: [] };
  const context = { appId: 'app', instanceId: 'run', toolsEnabled: true,
    validateBinding: (t: any, execution: any) => registry.validateTypeToolBinding(t, execution),
    isRefViewLive: (_id: string, mount: string) => mount === receiver.viewInstanceId,
    refDescriptor: (_id: string, _mount: string, _refId: string): { scope: import('@aotui/core').RefScope; continuity: readonly [number, number, number] } | undefined => ({ scope: 'private', continuity: [1, 0, 0] }),
    invokeBinding: async (t: ToolRoute, execution: ViewToolReceiver, args: Readonly<Record<string, unknown>>,
        capture: (terminal: ViewToolInvocationTerminal) => ViewToolInvokeResponse | null) =>
        capture(await registry.invokeTypeTool(t, execution, args)) };
  return { registry, handler, message, context, rebind: mount };
}

describe('Worker invocation with business parameters', () => {
  it('enters only through the committed instance binding after final checks', async () => {
    const x = setup(), pending = invokeViewTool(x.message, x.context);
    expect(x.handler).toHaveBeenCalledOnce();
    expect(x.handler.mock.calls[0]![0]).toBe(x.message.effectiveArgs);
    expect(Object.isFrozen(x.message.effectiveArgs)).toBe(true);
    expect(await pending).toMatchObject({ type: 'VIEW_TOOL_INVOKE_RESPONSE',
      terminal: { phase: 'entered-returned', result: { data: { value: '1' } } } });
  });
  it.each(['enum', 'extra', 'null', 'instance', 'read-only', 'stale', 'marker', 'snapshot-metadata', 'wrong-activation', 'wrong-receiver'])('blocks %s before entry', async kind => {
    const x = setup(), m: any = JSON.parse(JSON.stringify(x.message)), c = { ...x.context };
    if (kind === 'enum') m.effectiveArgs.e = 1;
    if (kind === 'extra') m.effectiveArgs.extra = true;
    if (kind === 'null') m.effectiveArgs.e = null;
    if (kind === 'instance') m.instanceId = 'other';
    if (kind === 'read-only') c.toolsEnabled = false;
    if (kind === 'stale') x.rebind();
    if (kind === 'marker') m.tool.inputSchema = {};
    if (kind === 'snapshot-metadata') m.snapshotId = 'forged';
    if (kind === 'wrong-activation') m.receiver.activationId = 'stale';
    if (kind === 'wrong-receiver') m.receiver.viewInstanceId = 'other';
    expect(await invokeViewTool(m, c)).toMatchObject({ terminal: { phase: 'not-entered' } });
    expect(x.handler).not.toHaveBeenCalled();
  });
  it.each(['private-owner', 'stale-source', 'withdrawn-ref', 'stale-witness', 'missing-slot', 'duplicate-record'] as const)(
    'checks the local publication immediately before executing an already resolved value: %s', async mode => {
      const x = setup(), record = { param: 'e', refId: 'selected', viewId: x.message.receiver.viewId,
        viewInstanceId: x.message.receiver.viewInstanceId, since: 1 };
      const m = { ...x.message, localRefs: [record] };
      if (mode === 'stale-source') record.viewInstanceId = 'closed';
      if (mode === 'withdrawn-ref') x.context.refDescriptor = () => undefined;
      if (mode === 'stale-witness') record.since = 2;
      if (mode === 'missing-slot') record.param = 'missing';
      if (mode === 'duplicate-record') m.localRefs.push({ ...record });
      const result = await invokeViewTool(m, x.context);
      expect(result?.terminal.phase).toBe(mode === 'private-owner' ? 'entered-returned' : 'not-entered');
      expect(x.handler).toHaveBeenCalledTimes(mode === 'private-owner' ? 1 : 0);
    });
  it('rechecks live Registry identity immediately at trusted helper entry', async () => {
    const x = setup(), original = x.context.invokeBinding;
    x.context.invokeBinding = (t, execution, args, capture) => { x.rebind(); return original(t, execution, args, capture); };
    expect(await invokeViewTool(x.message, x.context)).toMatchObject({ terminal: { phase: 'not-entered' } });
    expect(x.handler).not.toHaveBeenCalled();
  });
  it('never invents not-entered after the trusted callable throws or returns an unencodable result', async () => {
    const x = setup(); x.handler.mockImplementation(async () => { throw Error('PRIVATE'); });
    const thrown = await invokeViewTool(x.message, x.context);
    expect(thrown).toEqual({
      type: 'VIEW_TOOL_INVOKE_RESPONSE', requestId: x.message.requestId,
      appId: x.message.appId, instanceId: x.message.instanceId,
      success: true,
      terminal: { phase: 'finished-unknown' },
    });
    expect(x.handler).toHaveBeenCalledOnce();
    const y = setup(); y.handler.mockResolvedValue({ success: true, data: { huge: 'x'.repeat(512 * 1024) } } as any);
    const oversized = await invokeViewTool(y.message, y.context);
    expect(oversized).toEqual({
      type: 'VIEW_TOOL_INVOKE_RESPONSE', requestId: y.message.requestId,
      appId: y.message.appId, instanceId: y.message.instanceId,
      success: true,
      terminal: { phase: 'finished-unknown' },
    });
    expect(y.handler).toHaveBeenCalledOnce();
  });
  it('preserves a normal business failure even with the former SDK error code', async () => {
    const x = setup();
    const terminal = { phase: 'entered-returned', result: { success: false, error: { code: 'E_HANDLER_ERROR', message: 'Application failure' },
      data: { refreshed: false } } } as const;
    x.handler.mockResolvedValue(terminal.result as any);
    expect((await invokeViewTool(x.message, x.context))?.terminal).toEqual(terminal);
    expect(x.message.tool).not.toHaveProperty('isMutating'); expect(x.handler).toHaveBeenCalledOnce();
  });
});
