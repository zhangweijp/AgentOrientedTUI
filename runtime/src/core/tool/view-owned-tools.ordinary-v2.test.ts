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
  it('a declaration without a private callable is not executable', async () => {
    const core = createViewOwnedTools('app', 'run'), a = core.mount('aa', 'File'), handler = vi.fn(async () => ({ success: true }));
    core.registerTool(a.viewInstanceId, spec(), handler);
    const tool = core.listTools()[0], target = tool.targets[0];
    expect(core.validateOrdinaryParametersBinding(tool, target).success).toBe(false);
    expect(await core.invokeOrdinaryParameters(tool, target, { q: 'x' })).toMatchObject({ phase: 'not-entered' });
    expect(handler).not.toHaveBeenCalled();
  });
  it('requires private callable and a correct ordinary parameter profile', () => {
    const core = createViewOwnedTools('app', 'run'), a = core.mount('aa', 'File'), h = async () => ({ success: true });
    expect(() => core.registerTool(a.viewInstanceId, spec(), h, mode)).toThrow();
    expect(() => core.registerTool(a.viewInstanceId, { ...spec(), inputSchema: { type: 'object', properties: {} } }, h, mode, vi.fn())).toThrow();
    expect(core.listTools()).toHaveLength(0);
  });
  it('aggregates identical declarations and synchronously routes by original instance', async () => {
    const core = createViewOwnedTools('app', 'run'), a = core.mount('aa', 'File'), b = core.mount('bb', 'File');
    const generic = vi.fn(async () => ({ success: true }));
    const first = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { view: 'A' } } }));
    const second = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { view: 'B' } } }));
    const release = core.registerTool(a.viewInstanceId, spec(), generic, mode, first);
    core.registerTool(b.viewInstanceId, spec(), generic, mode, second);
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
  it('keeps the original callable when a duplicate registration is rejected', async () => {
    const core = createViewOwnedTools('app', 'run'), view = core.mount('aa', 'File');
    const originalHandler = vi.fn(async () => ({ success: true })), duplicateHandler = vi.fn(async () => ({ success: true }));
    const originalSafe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { binding: 'original' } } }));
    const duplicateSafe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { binding: 'duplicate' } } }));
    const release = core.registerTool(view.viewInstanceId, spec(), originalHandler, mode, originalSafe);

    expect(() => core.registerTool(view.viewInstanceId, spec(), duplicateHandler, mode, duplicateSafe)).toThrow(/TOOL_DUPLICATE/);
    const current = core.listTools()[0];
    expect(await core.invokeOrdinaryParameters(current, current.targets[0], { q: 'x' })).toMatchObject({
      phase: 'entered-returned', result: { success: true, data: { binding: 'original' } },
    });
    expect(originalSafe).toHaveBeenCalledOnce(); expect(duplicateSafe).not.toHaveBeenCalled();
    expect(originalHandler).not.toHaveBeenCalled(); expect(duplicateHandler).not.toHaveBeenCalled();
    release();
  });
  it('lets an old release closure leave a same-viewId remount binding callable', async () => {
    const core = createViewOwnedTools('app', 'run'), oldView = core.mount('aa', 'File');
    const oldHandler = vi.fn(async () => ({ success: true }));
    const oldSafe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { binding: 'old' } } }));
    const oldRelease = core.registerTool(oldView.viewInstanceId, spec(), oldHandler, mode, oldSafe);
    const first = core.listTools()[0];
    expect(await core.invokeOrdinaryParameters(first, first.targets[0], { q: 'x' })).toMatchObject({
      phase: 'entered-returned', result: { success: true, data: { binding: 'old' } },
    });
    core.unmount(oldView.viewInstanceId);

    const newView = core.mount('aa', 'File');
    const newHandler = vi.fn(async () => ({ success: true }));
    const newSafe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { binding: 'new' } } }));
    const newRelease = core.registerTool(newView.viewInstanceId, spec(), newHandler, mode, newSafe);
    oldRelease();

    const current = core.listTools()[0];
    expect(await core.invokeOrdinaryParameters(current, current.targets[0], { q: 'x' })).toMatchObject({
      phase: 'entered-returned', result: { success: true, data: { binding: 'new' } },
    });
    expect(oldHandler).not.toHaveBeenCalled(); expect(oldSafe).toHaveBeenCalledOnce();
    expect(newHandler).not.toHaveBeenCalled(); expect(newSafe).toHaveBeenCalledOnce();
    newRelease();
    expect(core.listTools()).toHaveLength(0);
  });
  it('revokes released/rebuilt bindings and rejects same-type public contract conflicts', () => {
    const core = createViewOwnedTools('app', 'run'), a = core.mount('aa', 'File'), b = core.mount('bb', 'File');
    const h = async () => ({ success: true }), safe = async () => ({ phase: 'entered-returned' as const, result: { success: true } });
    const release = core.registerTool(a.viewInstanceId, spec(), h, mode, safe);
    const tool = core.listTools()[0], target = tool.targets[0];
    expect(() => core.registerTool(b.viewInstanceId, spec('Different'), h, mode, safe)).toThrow(/TOOL_SCHEMA_CONFLICT/);
    expect(() => core.registerTool(b.viewInstanceId, { ...spec(), inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }, h)).toThrow(/TOOL_SCHEMA_CONFLICT/);
    release();
    expect(core.validateOrdinaryParametersBinding(tool, target).success).toBe(false);
    const rebind = core.registerTool(a.viewInstanceId, spec(), h, mode, safe);
    expect(core.validateOrdinaryParametersBinding(tool, target).success).toBe(false);
    rebind();
    core.unmount(a.viewInstanceId);
    const next = core.mount('aa', 'File');
    expect(next.viewInstanceId).not.toBe(a.viewInstanceId);
    expect(core.validateOrdinaryParametersBinding(tool, target).success).toBe(false);
  });
  it('invokes a fresh ordinary-v2 binding after same-View release and re-registration', async () => {
    const core = createViewOwnedTools('app', 'run'), view = core.mount('aa', 'File');
    const generic = vi.fn(async () => ({ success: true }));
    const oldSafe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { binding: 'old' } } }));
    const release = core.registerTool(view.viewInstanceId, spec(), generic, mode, oldSafe);
    const observed = core.listTools()[0], oldTarget = observed.targets[0];
    expect(await core.invokeOrdinaryParameters(observed, oldTarget, { q: 'x' })).toMatchObject({ result: { data: { binding: 'old' } } });
    expect(oldSafe).toHaveBeenCalledOnce();
    release();
    expect(await core.invokeOrdinaryParameters(observed, oldTarget, { q: 'x' })).toMatchObject({
      phase: 'not-entered', result: { error: { code: 'TOOL_UNAVAILABLE' } },
    });
    const newSafe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { binding: 'new' } } }));
    core.registerTool(view.viewInstanceId, spec(), generic, mode, newSafe);

    const current = core.listTools()[0], currentTarget = current.targets[0];
    expect(currentTarget.bindingVersion).not.toBe(oldTarget.bindingVersion);
    expect(core.validateOrdinaryParametersBinding(current, currentTarget)).toEqual({ success: true });
    expect(await core.invokeOrdinaryParameters(current, currentTarget, { q: 'x' })).toEqual({
      phase: 'entered-returned', result: { success: true, data: { binding: 'new' } },
    });
    expect(await core.invokeOrdinaryParameters(observed, oldTarget, { q: 'x' })).toMatchObject({
      phase: 'not-entered', result: { error: { code: 'TOOL_SOURCE_STALE' } },
    });
    expect(oldSafe).toHaveBeenCalledOnce(); expect(newSafe).toHaveBeenCalledOnce(); expect(generic).not.toHaveBeenCalled();
  });
  it('keeps mutation metadata while using the same ordinary private callable', async () => {
    const core = createViewOwnedTools('app', 'run'), view = core.mount('aa', 'File');
    const generic = vi.fn(async () => ({ success: true }));
    const safe = vi.fn(async () => ({ phase: 'entered-returned' as const, result: { success: true, data: { changed: true } } }));
    const release = core.registerTool(view.viewInstanceId, { ...spec(), isMutating: true }, generic, mode, safe);
    const tool = core.listTools()[0], target = tool.targets[0];
    expect(tool.isMutating).toBe(true);
    expect(core.validateOrdinaryParametersBinding(tool, target).success).toBe(true);
    expect(await core.invokeOrdinaryParameters(tool, target, { q: 'change' })).toMatchObject({ result: { success: true, data: { changed: true } } });
    expect(safe).toHaveBeenCalledOnce(); expect(generic).not.toHaveBeenCalled();
    release();
    expect(await core.invokeOrdinaryParameters(tool, target, { q: 'change' })).toMatchObject({ phase: 'not-entered' });
    expect(safe).toHaveBeenCalledOnce();
  });

});
