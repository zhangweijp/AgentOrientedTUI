import { describe, it, expect, vi } from 'vitest';
import { createViewOwnedTools } from './view-owned-tools.js';
import { compileOrdinaryParams } from './ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from './ordinary-parameter-profile.js';
const mode = { safeOrdinaryParametersInvocationMode: 'ordinary-v2' as const };
const spec = (desc = 'Read') => {
  const c = compileOrdinaryParams({ q: { type: 'string', required: true } }, { additionalProperties: false });
  if (!c.ok) throw Error('Fixture');
  return { name: 'find', description: desc, isMutating: false, inputSchema: ordinaryParameterProfile(c.contract) };
};
describe('R07/R08 private ordinary-v2 Registry qualification', () => {
  it('marker and generic handler confer no execution qualification or legacy bypass', async () => {
    const core = createViewOwnedTools('app', 'run'), a = core.mount('aa', 'File'), handler = vi.fn(async () => ({ success: true }));
    core.registerTool(a.viewInstanceId, spec(), handler);
    const tool = core.listTools()[0], target = tool.targets[0];
    expect(core.validateOrdinaryParametersBinding(tool, target).success).toBe(false);
    expect(await core.invokeOrdinaryParameters(tool, target, { q: 'x' })).toMatchObject({ phase: 'not-entered' });
    expect(await core.invoke(tool, target, { q: 'x' })).toMatchObject({ success: false, error: { code: 'TOOL_EXECUTION_UNAVAILABLE' } });
    expect(handler).not.toHaveBeenCalled();
  });
  it('requires private callable and a correct ordinary parameter profile', () => {
    const core = createViewOwnedTools('app', 'run'), a = core.mount('aa', 'File'), h = async () => ({ success: true });
    expect(() => core.registerTool(a.viewInstanceId, spec(), h, true, mode)).toThrow();
    expect(() => core.registerTool(a.viewInstanceId, { ...spec(), inputSchema: { type: 'object', properties: {} } }, h, true, mode, vi.fn())).toThrow();
    expect(core.listTools()).toHaveLength(0);
  });
  it('aggregates identical declarations and synchronously routes by original instance', async () => {
    const core = createViewOwnedTools('app', 'run'), a = core.mount('aa', 'File'), b = core.mount('bb', 'File');
    const generic = vi.fn(async () => ({ success: true }));
    const first = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { view: 'A' } } }));
    const second = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { view: 'B' } } }));
    const release = core.registerTool(a.viewInstanceId, spec(), generic, true, mode, first);
    core.registerTool(b.viewInstanceId, spec(), generic, true, mode, second);
    const tool = core.listTools()[0], [ta, tb] = tool.targets;
    expect(core.listTools()).toHaveLength(1);
    const pending = core.invokeOrdinaryParameters(tool, ta, { q: 'x' });
    expect(first).toHaveBeenCalledOnce(); // Entry happens before any await by this caller.
    expect(await pending).toMatchObject({ result: { data: { view: 'A' } } });
    release();
    expect(await core.invokeOrdinaryParameters(tool, ta, { q: 'x' })).toMatchObject({ phase: 'not-entered' });
    expect(await core.invokeOrdinaryParameters(tool, tb, { q: 'x' })).toMatchObject({ result: { data: { view: 'B' } } });
    expect(generic).not.toHaveBeenCalled();
  });
  it('revokes disabled/rebuilt bindings and rejects same-type public contract conflicts', () => {
    const core = createViewOwnedTools('app', 'run'), a = core.mount('aa', 'File'), b = core.mount('bb', 'File');
    const h = async () => ({ success: true }), safe = async () => ({ phase: 'entered-returned' as const, result: { success: true } });
    core.registerTool(a.viewInstanceId, spec(), h, true, mode, safe);
    const tool = core.listTools()[0], target = tool.targets[0];
    expect(() => core.registerTool(b.viewInstanceId, spec('Different'), h, true, mode, safe)).toThrow(/TOOL_SCHEMA_CONFLICT/);
    expect(() => core.registerTool(b.viewInstanceId, { ...spec(), inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }, h)).toThrow(/TOOL_SCHEMA_CONFLICT/);
    core.setEnabled(a.viewInstanceId, 'find', false);
    expect(core.validateOrdinaryParametersBinding(tool, target).success).toBe(false);
    core.setEnabled(a.viewInstanceId, 'find', true);
    expect(core.validateOrdinaryParametersBinding(tool, target).success).toBe(false);
    core.unmount(a.viewInstanceId);
    const next = core.mount('aa', 'File');
    expect(next.viewInstanceId).not.toBe(a.viewInstanceId);
    expect(core.validateOrdinaryParametersBinding(tool, target).success).toBe(false);
  });
  it('keeps mutation metadata while using the same ordinary private callable', async () => {
    const core = createViewOwnedTools('app', 'run'), view = core.mount('aa', 'File');
    const generic = vi.fn(async () => ({ success: true }));
    const safe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { changed: true } } }));
    core.registerTool(view.viewInstanceId, { ...spec(), isMutating: true }, generic, true, mode, safe);
    const tool = core.listTools()[0], target = tool.targets[0];
    expect(tool.isMutating).toBe(true);
    expect(core.validateOrdinaryParametersBinding(tool, target).success).toBe(true);
    expect(await core.invokeOrdinaryParameters(tool, target, { q: 'change' })).toMatchObject({ result: { success: true, data: { changed: true } } });
    expect(safe).toHaveBeenCalledOnce(); expect(generic).not.toHaveBeenCalled();
    core.setEnabled(view.viewInstanceId, 'find', false);
    expect(await core.invokeOrdinaryParameters(tool, target, { q: 'change' })).toMatchObject({ phase: 'not-entered' });
    expect(safe).toHaveBeenCalledOnce();
  });

});
