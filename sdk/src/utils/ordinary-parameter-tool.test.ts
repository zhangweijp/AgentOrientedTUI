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
  it('passes a normal E_HANDLER_ERROR receipt to Runtime with its business data', async () => {
    const result = { success: false as const, error: { code: 'E_HANDLER_ERROR', message: 'Application failure' }, data: { refreshed: false } };
    expect(await invokeOrdinaryParameterTool(compiled(), { e: '1' }, async () => result)).toEqual({
      phase: 'entered-returned', result,
    });
  });
  it.each([false, true])('leaves actual handler errors rejected for Runtime to finish, asynchronous=%s', async asynchronous => {
    const error = new Error('PRIVATE_EXCEPTION');
    const handler = asynchronous ? () => Promise.reject(error) : () => { throw error; };
    await expect(invokeOrdinaryParameterTool(compiled(), { e: '1' }, handler)).rejects.toBe(error);
  });
  it('awaits an actual asynchronous handler before returning success', async () => {
    let finish!: () => void, settled = false;
    const pendingTask = new Promise<void>(resolve => { finish = resolve; });
    const pending = invokeOrdinaryParameterTool(compiled(), { e: '1' }, async () => {
      await pendingTask; return { success: true, data: { finished: true } };
    });
    void pending.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    finish(); expect(await pending).toMatchObject({ phase: 'entered-returned', result: { success: true, data: { finished: true } } });
  });

});
