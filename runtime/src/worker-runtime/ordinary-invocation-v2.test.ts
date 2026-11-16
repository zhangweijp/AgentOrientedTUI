import { describe, it, expect, vi } from 'vitest';
import { invokeTypeParameters } from './ordinary-invocation-v2.js';
import { compileOrdinarySchema } from '../core/tool/ordinary-parameter-contract.js';
import { createViewOwnedTools } from '../core/tool/view-owned-tools.js';
import { viewToolReceiver } from '../core/tool/source-binding.js';

function setup() {
  const compiled = compileOrdinarySchema({ type: 'object', properties: { e: { type: 'string', enum: ['1'] } }, required: ['e'], additionalProperties: false });
  if (!compiled.ok) throw Error('Fixture');
  const registry = createViewOwnedTools('app', 'run');
  const handler = vi.fn(async (args: Readonly<Record<string, unknown>>) => ({ success: true, data: { value: args.e } }));
  registry.defineTools([{ viewType: 'File', name: 'find', description: 'Find', inputSchema: compiled.contract.schema }]);
  const mount = () => {
    const plan = registry.prepareFrame([{ id: 'aa', type: 'File', owner: {},
      bindings: [{ name: 'find', execute: handler, enabled: true }] }]);
    plan.accept();
    return plan;
  };
  const plan = mount();
  const { nameSharedAcrossViewTypes: _sharedName, ...tool } = plan.tools[0]!;
  const receiver = viewToolReceiver({ id: 'aa', toolBindings: plan.instances[0]!.toolBindings,
    viewInstanceId: plan.instances[0]!.viewInstanceId } as any, tool.id)!;
  const message = { type: 'VIEW_TOOL_INVOKE_V6', requestId: 'r', appId: 'app', instanceId: 'run', snapshotId: 's',
    argumentMode: 'view-type-parameters-v1' as const, tool, receiver, rawArgs: { e: '1' }, effectiveArgs: { e: '1' }, refSources: [] };
  const context = { appId: 'app', instanceId: 'run', negotiated: true,
    validateBinding: (t: any, execution: any) => registry.validateTypeToolBinding(t, execution),
    getParameterContract: (t: any, execution: any) => registry.getTypeToolContract(t, execution),
            isRefViewLive: () => true,
    invokeBinding: (t: any, execution: any, args: any) => registry.invokeTypeTool(t, execution, args) };
  return { registry, handler, message, context, rebind: mount };
}

describe('ordinary parameters over the V6 View receiver message', () => {
  it('enters only through the committed instance binding after final checks', async () => {
    const x = setup(), pending = invokeTypeParameters(x.message, x.context);
    expect(x.handler).toHaveBeenCalledOnce();
    expect(await pending).toMatchObject({ type: 'VIEW_TOOL_INVOKE_V6_RESPONSE', argumentMode: 'view-type-parameters-v1',
      terminal: { phase: 'entered-returned', result: { data: { value: '1' } } } });
  });
  it.each(['enum', 'extra', 'null', 'instance', 'capability', 'stale', 'marker', 'snapshot-metadata', 'wrong-activation', 'wrong-receiver'])('blocks %s before entry', async kind => {
    const x = setup(), m: any = JSON.parse(JSON.stringify(x.message)), c = { ...x.context };
    if (kind === 'enum') m.rawArgs.e = 1;
    if (kind === 'extra') m.rawArgs.extra = true;
    if (kind === 'null') m.rawArgs.e = null;
    if (kind === 'instance') m.instanceId = 'other';
    if (kind === 'capability') c.negotiated = false;
    if (kind === 'stale') x.rebind();
    if (kind === 'marker') m.tool.inputSchema['x-aotui-parameter-contract'] = 'future';
    if (kind === 'snapshot-metadata') m.tool.nameSharedAcrossViewTypes = false;
    if (kind === 'wrong-activation') m.receiver.activationId = 'stale';
    if (kind === 'wrong-receiver') m.receiver.viewInstanceId = 'other';
    expect(await invokeTypeParameters(m, c)).toMatchObject({ terminal: { phase: 'not-entered' } });
    expect(x.handler).not.toHaveBeenCalled();
  });
  it('rechecks live Registry identity immediately at trusted helper entry', async () => {
    const x = setup(), original = x.context.invokeBinding;
    x.context.invokeBinding = (t, execution, args) => { x.rebind(); return original(t, execution, args); };
    expect(await invokeTypeParameters(x.message, x.context)).toMatchObject({ terminal: { phase: 'not-entered' } });
    expect(x.handler).not.toHaveBeenCalled();
  });
  it('never invents not-entered after the trusted callable throws or returns an unencodable result', async () => {
    const x = setup(); x.handler.mockImplementation(async () => { throw Error('PRIVATE'); });
    const thrown = await invokeTypeParameters(x.message, x.context);
    expect(thrown).toEqual({
      type: 'VIEW_TOOL_INVOKE_V6_RESPONSE', requestId: x.message.requestId,
      appId: x.message.appId, instanceId: x.message.instanceId,
      argumentMode: x.message.argumentMode, success: true,
      terminal: { phase: 'finished-unknown' },
    });
    expect(x.handler).toHaveBeenCalledOnce();
    const y = setup(); y.handler.mockResolvedValue({ success: true, data: { huge: 'x'.repeat(512 * 1024) } } as any);
    const oversized = await invokeTypeParameters(y.message, y.context);
    expect(oversized).toEqual({
      type: 'VIEW_TOOL_INVOKE_V6_RESPONSE', requestId: y.message.requestId,
      appId: y.message.appId, instanceId: y.message.instanceId,
      argumentMode: y.message.argumentMode, success: true,
      terminal: { phase: 'finished-unknown' },
    });
    expect(y.handler).toHaveBeenCalledOnce();
  });
  it('preserves a normal business failure even with the former SDK error code', async () => {
    const x = setup();
    const terminal = { phase: 'entered-returned', result: { success: false, error: { code: 'E_HANDLER_ERROR', message: 'Application failure' },
      data: { refreshed: false } } } as const;
    x.handler.mockResolvedValue(terminal.result as any);
    expect((await invokeTypeParameters(x.message, x.context))?.terminal).toEqual(terminal);
    expect(x.message.tool).not.toHaveProperty('isMutating'); expect(x.handler).toHaveBeenCalledOnce();
  });
});
