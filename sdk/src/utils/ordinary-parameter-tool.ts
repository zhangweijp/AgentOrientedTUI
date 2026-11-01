import type { OrdinaryParameterContract, ViewToolInvocationTerminal } from '@aotui/runtime/core';
import type { OperationResult } from '@aotui/runtime/spi';

/** Runtime-captured ordinary validation or the same Ref contract's effective validation, supplied by its trusted factory. */
export async function invokeOrdinaryParameterTool(
  contract: Pick<OrdinaryParameterContract, 'validate'>,
  input: unknown,
  handler: (args: Readonly<Record<string, unknown>>) => OperationResult | Promise<OperationResult>,
): Promise<ViewToolInvocationTerminal> {
  let validated;
  try { validated = contract.validate(input); }
  catch { return { phase: 'not-entered', result: { success: false, error: {
    code: 'E_INVALID_ARGS', message: 'Tool arguments could not be validated',
  } } }; }
  if (!validated.ok) return { phase: 'not-entered', result: { success: false, error: {
    code: 'E_INVALID_ARGS', message: 'Tool arguments do not match the committed contract',
    context: { diagnostics: validated.diagnostics },
  } } };
  try {
    const result = await handler(validated.value);
    if (!Object.hasOwn(result, 'effects')) return { phase: 'entered-returned', result };
    const fields = Object.getOwnPropertyDescriptors(result), effects = fields.effects;
    if (!effects?.enumerable || !('value' in effects) ||
      (effects.value !== 'none' && effects.value !== 'partial') || fields.success?.value !== false)
      throw new TypeError('Invalid application failure effects');
    delete fields.effects;
    return { phase: 'entered-returned', result: Object.defineProperties({}, fields) as OperationResult,
      failureEffects: effects.value };
  }
  catch { return { phase: 'entered-returned', result: { success: false, error: {
    code: 'E_HANDLER_ERROR', message: 'Tool handler failed',
  } } }; }
}
