import type { OrdinaryParameterContract, ViewToolInvocationTerminal } from '@aotui/runtime/core';
import type { ToolResult } from '@aotui/runtime/spi';
import type { ToolResultData } from '@aotui/runtime/core';

/** Runtime-captured ordinary validation or the same Ref contract's effective validation, supplied by its trusted factory. */
export async function invokeOrdinaryParameterTool(
  contract: Pick<OrdinaryParameterContract, 'validate' | 'validateResolvedInput'>,
  input: unknown,
  handler: (args: Readonly<Record<string, unknown>>) => ToolResult | Promise<ToolResult>,
  canEnter?: () => boolean,
): Promise<ViewToolInvocationTerminal> {
  let validated;
  try { validated = (contract.validateResolvedInput ?? contract.validate)(input); }
  catch { return { phase: 'not-entered', result: { success: false, error: {
    code: 'E_INVALID_ARGS', message: 'Tool arguments could not be validated',
  } } }; }
  if (!validated.ok) return { phase: 'not-entered', result: { success: false, error: {
    code: 'E_INVALID_ARGS', message: 'Tool arguments do not match the committed contract',
    context: { diagnostics: validated.diagnostics },
  } } };
  if (canEnter && !canEnter()) return { phase: 'not-entered', result: { success: false, error: {
    code: 'TOOL_UNAVAILABLE', message: 'Tool binding is not currently available',
  } } };
  try {
    const result = await handler(validated.value);
    if (!Object.hasOwn(result, 'effects')) return { phase: 'entered-returned', result: result as ToolResultData };
    const { effects, ...fields } = Object.getOwnPropertyDescriptors(result);
    if (!effects?.enumerable || !('value' in effects) ||
      (effects.value !== 'none' && effects.value !== 'partial') || fields.success?.value !== false)
      throw new TypeError('Invalid application failure effects');
    return { phase: 'entered-returned', result: Object.defineProperties({}, fields) as ToolResultData,
      failureEffects: effects.value };
  }
  catch { return { phase: 'entered-returned', result: { success: false, error: {
    code: 'E_HANDLER_ERROR', message: 'Tool handler failed',
  } } }; }
}
