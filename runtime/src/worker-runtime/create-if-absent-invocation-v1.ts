import {
  captureCreateIfAbsentV1Request,
  createIfAbsentV1Response,
} from '../adapters/create-if-absent-invocation-v1.js';
import {
  matchesCreateIfAbsentInput,
  type CreateIfAbsentTerminal,
} from '../core/tool/create-if-absent-contract.js';
import type { OperationResult } from '../spi/core/operations.js';
import type { ToolDescriptorV2, ToolTargetV2 } from '../core/snapshot/types.js';
export async function invokeCreateIfAbsentInvocationV1(
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
    ) => CreateIfAbsentTerminal | Promise<CreateIfAbsentTerminal>;
  }>
) {
  let message;
  let result: OperationResult;
  const failure = (code: string, message: string): OperationResult => ({
    success: false,
    error: { code, message },
  });
  try {
    message = captureCreateIfAbsentV1Request(input);
    if (!context.negotiated)
      result = failure(
        'TOOL_EXECUTION_UNAVAILABLE',
        'Current Worker has no negotiated creation capability'
      );
    else if (message.appId !== context.appId || message.instanceId !== context.instanceId)
      result = failure('APP_INSTANCE_MISMATCH', 'Request is from another App instance');
    else if (!context.validateBinding || !context.validateWrapper || !context.invokeBinding)
      result = failure('TOOL_EXECUTION_UNAVAILABLE', 'Current App has no safe creation registry');
    else {
      result = context.validateBinding(message.tool, message.target);
      if (
        result.success &&
        (!message.tool.isMutating ||
          !matchesCreateIfAbsentInput(message.tool.inputSchema, message.args))
      )
        result = failure(
          'E_INVALID_ARGS',
          'Expected a closed mutating string Tool and exact arguments'
        );
      if (result.success) result = context.validateWrapper(message.tool, message.target);
      if (result.success) {
        try {
          return createIfAbsentV1Response(
            message,
            await context.invokeBinding(message.tool, message.target, message.args)
          );
        } catch {
          return null;
        }
      }
    }
  } catch {
    result = failure('E_INVALID_ARGS', 'Expected a bounded creation request');
  }
  return createIfAbsentV1Response(message ?? input, {
    phase: 'not-entered',
    outcome: { status: 'rejected', code: result.error!.code, message: result.error!.message },
  });
}
