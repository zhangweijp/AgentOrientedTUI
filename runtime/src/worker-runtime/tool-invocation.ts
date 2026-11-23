import {
  captureToolInvocation,
  toolInvocationResponse,
  validateInvocationParameters,
} from '../adapters/tool-invocation.js';
import type { ToolParameterContract } from '@aotui/core';
import type { ToolResultData } from '@aotui/core';
import type { RefScope, ToolInvocationDescriptor, ViewToolReceiver } from '@aotui/core/internal';
import type { ViewToolInvocationTerminal } from '../spi/worker-protocol/messages.js';
import { checkRefViews } from '@aotui/core/internal';
import { refPath, scopeAllows } from '@aotui/core/internal';

export async function invokeViewTool(
  input: unknown,
  context?: Readonly<{
    appId: string;
    instanceId: string;
    toolsEnabled: boolean;
    validateBinding?: (tool: ToolInvocationDescriptor, receiver: ViewToolReceiver) => ToolResultData;
    getParameterContract?: (tool: ToolInvocationDescriptor, receiver: ViewToolReceiver) => ToolParameterContract | undefined;
    isRefViewLive?: (viewId: string, viewInstanceId: string) => boolean;
    refScope?: (viewId: string, viewInstanceId: string, refId: string) => RefScope | undefined;
    invokeBinding?: (
      tool: ToolInvocationDescriptor,
      receiver: ViewToolReceiver,
      args: Readonly<Record<string, unknown>>
    ) => ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal>;
  }>
) {
  let message: ReturnType<typeof captureToolInvocation> | undefined;
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
      if (result.success) {
        const prepared = validateInvocationParameters(message, context.getParameterContract(message.tool, message.receiver));
        const appId = message.appId;
        const localRefs = prepared.status === 'prepared' ? message.refSources.filter(source => source.appId === appId) : [];
        let issue = prepared.status === 'rejected' ? prepared.issue
          : checkRefViews(localRefs, context.isRefViewLive ?? (() => false));
        if (!issue) {
          const receiver = message.receiver;
          const denied = localRefs.find(source => {
            const scope = context.refScope?.(source.viewId, source.viewInstanceId, source.refId);
            return !scope || !scopeAllows(scope, source.viewInstanceId, receiver.viewInstanceId);
          });
          if (denied) issue = { code: 'REF_NOT_VISIBLE', message: 'The publishing page no longer grants this Ref.',
            path: refPath(denied.param, denied.index) };
        }
        if (issue) result = { success: false, error: { code: issue.code, message: issue.message,
          ...(issue.path ? { context: { path: issue.path } } : {}) } };
        else if (prepared.status === 'prepared') {
          try {
            const terminal = toolInvocationResponse(message,
              await context.invokeBinding(message.tool, message.receiver, prepared.effectiveArgs));
            if (terminal) return terminal;
          } catch { /* Execution ended with an unreportable outcome. */ }
          return toolInvocationResponse(message, { phase: 'finished-unknown' });
        }
      }
    }
  } catch {
    result = failure('E_INVALID_ARGS', 'Expected a bounded Tool invocation');
  }
  return toolInvocationResponse(message ?? input, { phase: 'not-entered', result });
}
