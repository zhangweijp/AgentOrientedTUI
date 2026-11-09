import {
  captureTypeParametersRequest,
  typeParametersResponse,
  validateTypeParameters,
} from '../adapters/ordinary-invocation-v2.js';
import type { OrdinaryParameterContract } from '../core/tool/ordinary-parameter-contract.js';
import type { ToolResultData } from '../spi/core/tool-result.js';
import type { ToolDescriptorV3, ObservedToolExecutionV3 } from '../core/snapshot/types.js';
import type { ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';

export async function invokeTypeParameters(
  input: unknown,
  context: Readonly<{
    appId: string;
    instanceId: string;
    negotiated: boolean;
    validateBinding?: (tool: ToolDescriptorV3, execution: Extract<ObservedToolExecutionV3, { kind: 'view-type' }>) => ToolResultData;
    getParameterContract?: (tool: ToolDescriptorV3, execution: Extract<ObservedToolExecutionV3, { kind: 'view-type' }>) => OrdinaryParameterContract | undefined;
    invokeBinding?: (
      tool: ToolDescriptorV3,
      execution: Extract<ObservedToolExecutionV3, { kind: 'view-type' }>,
      args: Readonly<Record<string, unknown>>
    ) => ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal>;
  }>
) {
  let message;
  const failure = (code: string, message: string): ToolResultData => ({
    success: false,
    error: { code, message },
  });
  let result: ToolResultData;
  try {
    message = captureTypeParametersRequest(input);
    if (!context.negotiated)
      result = failure(
        'TOOL_EXECUTION_UNAVAILABLE',
        'Current Worker has no negotiated ordinary capability'
      );
    else if (message.appId !== context.appId || message.instanceId !== context.instanceId)
      result = failure('APP_INSTANCE_MISMATCH', 'Request is from another App instance');
    else if (!context.validateBinding || !context.getParameterContract || !context.invokeBinding)
      result = failure('TOOL_EXECUTION_UNAVAILABLE', 'Current App has no safe ordinary registry');
    else {
      result = context.validateBinding(message.tool, message.execution);
      if (result.success) result = validateTypeParameters(message, context.getParameterContract(message.tool, message.execution));
      if (result.success) {
        // All final checks and callable entry are synchronous. A throw after entry is unknown.
        try {
          return typeParametersResponse(
            message,
            await context.invokeBinding(message.tool, message.execution, message.effectiveArgs)
          );
        } catch {
          return null;
        }
      }
    }
  } catch {
    result = failure('E_INVALID_ARGS', 'Expected a bounded ordinary request');
  }
  return typeParametersResponse(message ?? input, { phase: 'not-entered', result });
}
