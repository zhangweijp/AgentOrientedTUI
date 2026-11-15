import type { OrdinaryParameterContract, ViewToolInvocationTerminal } from '@aotui/runtime/core';
import type { ToolResult } from '@aotui/runtime/spi';

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
  const result = await handler(validated.value);
  return { phase: 'entered-returned', result };
}
