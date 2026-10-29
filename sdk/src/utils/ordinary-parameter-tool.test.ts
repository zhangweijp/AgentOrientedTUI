import { describe, expect, it, vi } from 'vitest';
import { compileOrdinaryParams } from '../../../runtime/src/core/tool/ordinary-parameter-contract.js';
import { invokeOrdinaryParameterTool } from './ordinary-parameter-tool.js';
const compiled = () => {
  const c = compileOrdinaryParams({ e: { type: 'enum', options: ['1'], required: true }, n: { type: 'number', default: 7 } }, { additionalProperties: false });
  if (!c.ok) throw Error('Fixture'); return c.contract;
};
describe('R16/R17 SDK single-contract helper', () => {
  it('rejects before handler with bounded diagnostics and no input echo', async () => {
    const handler = vi.fn();
    const result = await invokeOrdinaryParameterTool(compiled(), { e: 'PRIVATE_INPUT', UNKNOWN_SECRET: 1 }, handler);
    expect(result).toMatchObject({ phase: 'not-entered', result: { success: false, error: { code: 'E_INVALID_ARGS' } } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_INPUT|UNKNOWN_SECRET/);
    expect(handler).not.toHaveBeenCalled();
    expect((await invokeOrdinaryParameterTool(compiled(), { e: 1 }, handler)).phase).toBe('not-entered');
  });
  it('preserves values, missing default and business status with deeply frozen args', async () => {
    const handler = vi.fn(async args => {
      expect(Object.isFrozen(args)).toBe(true);
      expect(Object.hasOwn(args, 'n')).toBe(false);
      return { success: false, error: { code: 'BUSINESS', message: 'Unavailable' } };
    });
    expect(await invokeOrdinaryParameterTool(compiled(), { e: '1' }, handler)).toEqual({ phase: 'entered-returned', result: { success: false, error: { code: 'BUSINESS', message: 'Unavailable' } } });
    expect(handler).toHaveBeenCalledOnce();
  });
  it('sanitizes thrown handler exceptions without losing entered phase', async () => {
    const r = await invokeOrdinaryParameterTool(compiled(), { e: '1' }, () => { throw Error('PRIVATE_EXCEPTION'); });
    expect(r).toMatchObject({ phase: 'entered-returned', result: { error: { code: 'E_HANDLER_ERROR' } } });
    expect(JSON.stringify(r)).not.toContain('PRIVATE_EXCEPTION');
  });
  it.each(['none', 'partial'] as const)('forwards only application-declared %s effects', async effects => {
    const error = { code: 'APP_FAILED', message: 'Application failure' };
    const result = { success: false, error, effects };
    expect(await invokeOrdinaryParameterTool(compiled(), { e: '1' }, async () => result)).toEqual({
      phase: 'entered-returned', result: { success: false, error }, failureEffects: effects,
    });
    expect(result.effects).toBe(effects);
  });
  it.each(['success', 'invalid', 'getter'] as const)('does not trust an invalid effect declaration: %s', async kind => {
    let reads = 0;
    const result: any = { success: kind === 'success', effects: kind === 'invalid' ? 'all' : 'none' };
    if (kind === 'getter') Object.defineProperty(result, 'effects', { enumerable: true, get() { reads++; return 'none'; } });
    const terminal = await invokeOrdinaryParameterTool(compiled(), { e: '1' }, async () => result);
    expect(terminal).toMatchObject({ phase: 'entered-returned', result: { success: false, error: { code: 'E_HANDLER_ERROR' } } });
    expect(terminal).not.toHaveProperty('failureEffects'); expect(reads).toBe(0);
  });
  it('awaits an actual asynchronous handler before returning success', async () => {
    let finish!: () => void, settled = false;
    const operation = new Promise<void>(resolve => { finish = resolve; });
    const pending = invokeOrdinaryParameterTool(compiled(), { e: '1' }, async () => {
      await operation; return { success: true, data: { finished: true } };
    });
    void pending.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    finish(); expect(await pending).toMatchObject({ phase: 'entered-returned', result: { success: true, data: { finished: true } } });
  });

});
