import { describe, it, expect, vi } from 'vitest';
import { invokeTypeParameters } from './ordinary-invocation-v2.js';
import { compileOrdinaryParams } from '../core/tool/ordinary-parameter-contract.js';
import { createViewOwnedTools } from '../core/tool/view-owned-tools.js';
import type { SafeOrdinaryInvoker } from '../core/tool/invocation-terminal.js';

function setup() {
  const compiled = compileOrdinaryParams({ e: { type: 'enum', options: ['1'], required: true } }, { additionalProperties: false });
  if (!compiled.ok) throw Error('Fixture');
  const registry = createViewOwnedTools('app', 'run');
  const handler = vi.fn(async (args: Readonly<Record<string, unknown>>) => ({ success: true, data: { value: args.e } }));
  const safe: SafeOrdinaryInvoker = vi.fn(async args => ({ phase: 'entered-returned', result: await handler(args) }));
  const declaration = { viewType: 'File', name: 'find', description: 'Find', 
    inputSchema: compiled.contract.schema };
  let release = () => {};
  const register = () => { release = registry.registerTypeTool(declaration, {
    safeOrdinaryParametersInvocationMode: 'ordinary-invoker/v3', createSafeOrdinaryParametersInvoker: () => safe,
  }); };
  register();
  registry.mount('aa', 'File');
  const tool = registry.listTools()[0]!;
  if (tool.execution.kind !== 'view-type') throw Error('Fixture execution must be type-scoped');
  const message = { type: 'VIEW_TOOL_INVOKE_V5', requestId: 'r', appId: 'app', instanceId: 'run', snapshotId: 's',
    argumentMode: 'view-type-parameters-v1' as const, tool, execution: tool.execution, rawArgs: { e: '1' }, effectiveArgs: { e: '1' }, refSources: [] };
  const context = { appId: 'app', instanceId: 'run', negotiated: true,
    validateBinding: (t: any, execution: any) => registry.validateTypeToolBinding(t, execution),
    getParameterContract: (t: any, execution: any) => registry.getTypeToolContract(t, execution),
            isRefViewLive: () => true,
    invokeBinding: (t: any, execution: any, args: any) => registry.invokeTypeTool(t, execution, args) };
  return { registry, safe, handler, message, context,
    rebind() { release(); register(); } };
}

describe('ordinary parameters over the V5 type execution message', () => {
  it('enters only through the trusted type-level invoker after final checks', async () => {
    const x = setup(), pending = invokeTypeParameters(x.message, x.context);
    expect(x.safe).toHaveBeenCalledOnce(); expect(x.handler).toHaveBeenCalledOnce();
    expect(await pending).toMatchObject({ type: 'VIEW_TOOL_INVOKE_V5_RESPONSE', argumentMode: 'view-type-parameters-v1',
      terminal: { phase: 'entered-returned', result: { data: { value: '1' } } } });
  });
  it.each(['enum', 'extra', 'null', 'instance', 'capability', 'stale', 'marker', 'wrong-activation', 'wrong-execution-kind'])('blocks %s before entry', async kind => {
    const x = setup(), m: any = JSON.parse(JSON.stringify(x.message)), c = { ...x.context };
    if (kind === 'enum') m.rawArgs.e = 1;
    if (kind === 'extra') m.rawArgs.extra = true;
    if (kind === 'null') m.rawArgs.e = null;
    if (kind === 'instance') m.instanceId = 'other';
    if (kind === 'capability') c.negotiated = false;
    if (kind === 'stale') x.rebind();
    if (kind === 'marker') m.tool.inputSchema['x-aotui-parameter-contract'] = 'future';
    if (kind === 'wrong-activation') m.execution.activationId = 'stale';
    if (kind === 'wrong-execution-kind') m.execution = { kind: 'view-instance', target: { viewId: 'aa', viewInstanceId: 'instance', bindingVersion: 1 } };
    expect(await invokeTypeParameters(m, c)).toMatchObject({ terminal: { phase: 'not-entered' } });
    expect(x.safe).not.toHaveBeenCalled(); expect(x.handler).not.toHaveBeenCalled();
  });
  it('rechecks live Registry identity immediately at trusted helper entry', async () => {
    const x = setup(), original = x.context.invokeBinding;
    x.context.invokeBinding = (t, execution, args) => { x.rebind(); return original(t, execution, args); };
    expect(await invokeTypeParameters(x.message, x.context)).toMatchObject({ terminal: { phase: 'not-entered' } });
    expect(x.safe).not.toHaveBeenCalled();
  });
  it('never invents not-entered after the trusted callable throws or returns an unencodable result', async () => {
    const x = setup(); x.safe.mockImplementation(async () => { throw Error('PRIVATE'); });
    const thrown = await invokeTypeParameters(x.message, x.context);
    expect(thrown).toEqual({
      type: 'VIEW_TOOL_INVOKE_V5_RESPONSE', requestId: x.message.requestId,
      appId: x.message.appId, instanceId: x.message.instanceId,
      argumentMode: x.message.argumentMode, success: true,
      terminal: { phase: 'finished-unknown' },
    });
    expect(x.safe).toHaveBeenCalledOnce();
    const y = setup(); y.safe.mockResolvedValue({ phase: 'entered-returned', result: { success: true, data: { huge: 'x'.repeat(512 * 1024) } } } as any);
    const oversized = await invokeTypeParameters(y.message, y.context);
    expect(oversized).toEqual({
      type: 'VIEW_TOOL_INVOKE_V5_RESPONSE', requestId: y.message.requestId,
      appId: y.message.appId, instanceId: y.message.instanceId,
      argumentMode: y.message.argumentMode, success: true,
      terminal: { phase: 'finished-unknown' },
    });
    expect(y.safe).toHaveBeenCalledOnce();
  });
  it('preserves a normal business failure even with the former SDK error code', async () => {
    const x = setup();
    const terminal = { phase: 'entered-returned', result: { success: false, error: { code: 'E_HANDLER_ERROR', message: 'Application failure' },
      data: { refreshed: false } } } as const;
    vi.mocked(x.safe).mockResolvedValue(terminal);
    expect((await invokeTypeParameters(x.message, x.context))?.terminal).toEqual(terminal);
    expect(x.message.tool).not.toHaveProperty('isMutating'); expect(x.safe).toHaveBeenCalledOnce();
  });
});
