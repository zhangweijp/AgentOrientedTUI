import { describe, it, expect, vi } from 'vitest';
import { invokeOrdinaryInvocationV2 } from './ordinary-invocation-v2.js';
import { compileOrdinaryParams } from '../core/tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../core/tool/ordinary-parameter-profile.js';
import { createViewOwnedTools } from '../core/tool/view-owned-tools.js';
function setup(isMutating = false) {
  const compiled = compileOrdinaryParams({ e: { type: 'enum', options: ['1'], required: true } }, { additionalProperties: false });
  if (!compiled.ok) throw Error('Fixture');
  const registry = createViewOwnedTools('app', 'run'), view = registry.mount('aa', 'File');
  const handler = vi.fn(async () => ({ success: true }));
  const safe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { entered: true } } }));
  const declaration = { name: 'find', description: 'Find', isMutating, inputSchema: ordinaryParameterProfile(compiled.contract) };
  const register = () => registry.registerTool(view.viewInstanceId, declaration, handler,
    { safeOrdinaryParametersInvocationMode: 'ordinary-v2' }, safe);
  let release = register();
  const tool = registry.listTools()[0], target = tool.targets[0], { appId, appInstanceId, ...wireTool } = tool;
  const message = { type: 'VIEW_TOOL_INVOKE_ORDINARY_V2', requestId: 'r', appId: 'app', instanceId: 'run', snapshotId: 's', argumentMode: 'ordinary-v2', tool: wireTool, target, args: { e: '1' } };
  const wrap = (t: any) => ({ ...t, appId: 'app', appInstanceId: 'run' });
  const context = { appId: 'app', instanceId: 'run', negotiated: true,
    validateBinding: (t: any, v: any) => registry.validate(wrap(t), v),
    validateWrapper: (t: any, v: any) => registry.validateOrdinaryParametersBinding(wrap(t), v),
    invokeBinding: (t: any, v: any, args: any) => registry.invokeOrdinaryParameters(wrap(t), v, args) };
  return { registry, view, safe, handler, message, context,
    rebind() { release(); release = register(); } };
}
describe('R15/R16 ordinary-v2 Worker final qualification', () => {
  it('enters synchronously after final checks, without invoking the generic handler', async () => {
    const x = setup(); const pending = invokeOrdinaryInvocationV2(x.message, x.context);
    expect(x.safe).toHaveBeenCalledOnce(); expect(x.handler).not.toHaveBeenCalled();
    expect(await pending).toMatchObject({ terminal: { phase: 'entered-returned', result: { data: { entered: true } } } });
  });
  it.each(['enum', 'extra', 'null', 'instance', 'capability', 'stale', 'marker', 'wrong-private-mode'])('blocks %s before entry', async kind => {
    const x = setup(), m: any = JSON.parse(JSON.stringify(x.message)), c = { ...x.context };
    if (kind === 'enum') m.args.e = 1;
    if (kind === 'extra') m.args.extra = true;
    if (kind === 'null') m.args.e = null;
    if (kind === 'instance') m.instanceId = 'other';
    if (kind === 'capability') c.negotiated = false;
    if (kind === 'stale') x.rebind();
    if (kind === 'marker') m.tool.inputSchema['x-aotui-parameter-contract'] = 'future';
    if (kind === 'wrong-private-mode') c.validateWrapper = (t, v) => x.registry.validateSnapshotValueParametersBinding({ ...t, appId: 'app', appInstanceId: 'run' }, v);
    expect(await invokeOrdinaryInvocationV2(m, c)).toMatchObject({ terminal: { phase: 'not-entered' } });
    expect(x.safe).not.toHaveBeenCalled(); expect(x.handler).not.toHaveBeenCalled();
  });
  it('rechecks live Registry identity immediately at the actual helper entry', async () => {
    const x = setup(), original = x.context.invokeBinding;
    x.context.invokeBinding = (t, v, args) => { x.rebind(); return original(t, v, args); };
    expect(await invokeOrdinaryInvocationV2(x.message, x.context)).toMatchObject({ terminal: { phase: 'not-entered' } });
    expect(x.safe).not.toHaveBeenCalled();
  });
  it('never invents not-entered for a throwing or unencodable entered callable', async () => {
    const x = setup(); x.context.invokeBinding = () => { throw Error('PRIVATE'); };
    expect(await invokeOrdinaryInvocationV2(x.message, x.context)).toBeNull();
    const y = setup(); y.safe.mockResolvedValue({ phase: 'entered-returned', result: { success: true, data: { huge: 'x'.repeat(512 * 1024) } } } as any);
    expect(await invokeOrdinaryInvocationV2(y.message, y.context)).toBeNull();
  });
  it('invokes a mutating ordinary Tool and preserves an application failure declaration', async () => {
    const x = setup(true);
    x.safe.mockResolvedValue({ phase: 'entered-returned', result: { success: false, error: { code: 'PARTIAL', message: 'Application reports a partial result' } }, failureEffects: 'partial' } as any);
    expect(await invokeOrdinaryInvocationV2(x.message, x.context)).toMatchObject({ terminal: {
      phase: 'entered-returned', result: { success: false, error: { code: 'PARTIAL' } }, failureEffects: 'partial',
    } });
    expect(x.message.tool.isMutating).toBe(true); expect(x.safe).toHaveBeenCalledOnce();
    expect(x.handler).not.toHaveBeenCalled();
  });

});
