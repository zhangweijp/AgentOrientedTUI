import {
  captureToolInvocation,
  toolInvocationResponse,
  validateInvocationParameters,
} from '../adapters/tool-invocation.js';
import type { ToolParameterContract } from '../core/tool/tool-parameters.js';
import type { ToolResultData } from '../core/tool/tool-result.js';
import type { ToolInvocationDescriptor, ViewToolReceiver } from '../core/snapshot/types.js';
import type { ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';
import { checkRefViews } from '../core/tool/snapshot-value-arguments.js';

export async function invokeViewTool(
  input: unknown,
  context?: Readonly<{
    appId: string;
    instanceId: string;
    toolsEnabled: boolean;
    validateBinding?: (tool: ToolInvocationDescriptor, receiver: ViewToolReceiver) => ToolResultData;
    getParameterContract?: (tool: ToolInvocationDescriptor, receiver: ViewToolReceiver) => ToolParameterContract | undefined;
    isRefViewLive?: (viewId: string, viewInstanceId: string) => boolean;
    invokeBinding?: (
      tool: ToolInvocationDescriptor,
      receiver: ViewToolReceiver,
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
    message = captureToolInvocation(input);
    if (!context?.toolsEnabled)
      result = failure(
        'TOOL_EXECUTION_UNAVAILABLE',
        'Tool execution is unavailable for this App'
      );
    else if (message.appId !== context.appId || message.instanceId !== context.instanceId)
      result = failure('APP_INSTANCE_MISMATCH', 'Request is from another App instance');
    else if (!context.validateBinding || !context.getParameterContract || !context.invokeBinding)
      result = failure('TOOL_EXECUTION_UNAVAILABLE', 'The App has no execution binding');
    else {
      result = context.validateBinding(message.tool, message.receiver);
      if (result.success) result = validateInvocationParameters(message, context.getParameterContract(message.tool, message.receiver));
      if (result.success && message.refSources.length) {
        const issue = checkRefViews(message.refSources, message.rawArgs, context.isRefViewLive ?? (() => false));
        if (issue) result = { success: false, error: { code: issue.code, message: issue.message, context: { path: issue.path } } };
      }
      if (result.success) {
        try {
          const terminal = toolInvocationResponse(message,
            await context.invokeBinding(message.tool, message.receiver, message.effectiveArgs));
          if (terminal) return terminal;
        } catch { /* Execution ended with an unreportable outcome. */ }
        return toolInvocationResponse(message, { phase: 'finished-unknown' });
      }
    }
  } catch {
    result = failure('E_INVALID_ARGS', 'Expected a bounded Tool invocation');
  }
  return toolInvocationResponse(message ?? input, { phase: 'not-entered', result });
}
