import {
  captureOrdinaryV1Request,
  ordinaryV1Response,
  validOrdinaryV1Arguments,
} from '../adapters/ordinary-invocation-v1.js';
import type { OperationResult } from '../spi/core/operations.js';
import type { ToolDescriptorV2, ToolTargetV2 } from '../core/snapshot/types.js';
import type { ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';

export async function invokeOrdinaryInvocationV1(
  input: unknown,
  context: Readonly<{
    appId: string;
    instanceId: string;
    negotiated: boolean;
    validateBinding?: (tool: ToolDescriptorV2, target: ToolTargetV2) => OperationResult;
    validateWrapper?: (tool: ToolDescriptorV2, target: ToolTargetV2) => OperationResult;
    invokeBinding?: (
      tool: ToolDescriptorV2,
      target: ToolTargetV2,
      args: Readonly<Record<string, unknown>>
    ) => ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal>;
  }>
) {
  let message;
  const failure = (code: string, message: string): OperationResult => ({
    success: false,
    error: { code, message },
  });
  let result: OperationResult;
  try {
    message = captureOrdinaryV1Request(input);
    if (!context.negotiated)
      result = failure(
        'TOOL_EXECUTION_UNAVAILABLE',
        'Current Worker has no negotiated ordinary capability'
      );
    else if (message.appId !== context.appId || message.instanceId !== context.instanceId)
      result = failure('APP_INSTANCE_MISMATCH', 'Request is from another App instance');
    else if (!context.validateBinding || !context.validateWrapper || !context.invokeBinding)
      result = failure('TOOL_EXECUTION_UNAVAILABLE', 'Current App has no safe ordinary registry');
    else {
      result = context.validateBinding(message.tool, message.target);
      if (result.success && !validOrdinaryV1Arguments(message))
        result = failure(
          'E_INVALID_ARGS',
          'Expected a closed empty read-only Tool and empty arguments'
        );
      if (result.success) result = context.validateWrapper(message.tool, message.target);
      if (result.success) {
        // All final checks and callable entry are synchronous. A throw after entry is unknown.
        try {
          return ordinaryV1Response(
            message,
            await context.invokeBinding(message.tool, message.target, message.args)
          );
        } catch {
          return null;
        }
      }
    }
  } catch {
    result = failure('E_INVALID_ARGS', 'Expected a bounded ordinary request');
  }
  return ordinaryV1Response(message ?? input, { phase: 'not-entered', result });
}
