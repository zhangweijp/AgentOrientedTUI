import type { ToolParameterContract } from '@aotui/core';
import { RAW_TOOL_ARGUMENT_LIMITS, RESOLVED_TOOL_ENVELOPE_LIMITS, TOOL_REQUEST_LIMITS } from '@aotui/core/internal';
import { reconstructToolParameters } from '@aotui/core/internal';
import { captureInvocationJson, captureToolInvocationTerminal,
  exact, invocationReceiver, invocationObject, invocationToolDescriptor, text } from './worker-message-capture.js';
import type { ViewToolInvokeMessage, ViewToolInvokeResponse } from '../spi/worker-protocol/messages.js';

export function captureToolInvocation(input: unknown): ViewToolInvokeMessage {
  const value = captureInvocationJson(input, TOOL_REQUEST_LIMITS);
  if (!invocationObject(value) || !exact(value, ['type', 'requestId', 'appId', 'instanceId', 'snapshotId', 'tool',
      'observationId', 'receiver', 'rawArgs', 'refSources']) || value.type !== 'VIEW_TOOL_INVOKE' ||
      !['requestId', 'appId', 'instanceId', 'snapshotId', 'observationId'].every(k => text(value[k])) ||
      !invocationToolDescriptor(value.tool) || !invocationReceiver(value.receiver) ||
      !invocationObject(value.rawArgs) || !Array.isArray(value.refSources)) throw new Error('Invalid Tool invocation');
  captureInvocationJson(value.rawArgs, RAW_TOOL_ARGUMENT_LIMITS);
  captureInvocationJson({ source: { appId: value.appId, instanceId: value.instanceId, snapshotId: value.snapshotId,
    toolId: (value.tool as { id: string }).id, receiver: value.receiver }, refSources: value.refSources }, RESOLVED_TOOL_ENVELOPE_LIMITS);
  return value as unknown as ViewToolInvokeMessage;
}

/** Captured request after full binding verification, using that registration's compiled contract. */
export function validateInvocationParameters(message: ViewToolInvokeMessage, contract: ToolParameterContract | undefined | null) {
  if (!contract) return { status: 'rejected' as const, issue: { code: 'REF_CONTRACT_UNSUPPORTED', path: '$',
    message: 'Tool has no registered parameter contract' } };
  return reconstructToolParameters(contract, message.rawArgs, message, message.refSources);
}
export function toolInvocationResponse(input: unknown, terminal: ViewToolInvokeResponse['terminal']): ViewToolInvokeResponse | null {
  try {
    if (!invocationObject(input)) return null;
    const header: Record<string, string> = {};
    for (const key of ['requestId', 'appId', 'instanceId']) {
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (!field || !('value' in field) || !text(field.value)) return null;
      header[key] = field.value;
    }
    const response = captureInvocationJson({ ...header, type: 'VIEW_TOOL_INVOKE_RESPONSE', success: true, terminal });
    return captureToolInvocationTerminal(response, header as { requestId: string; appId: string; instanceId: string }) ? response as unknown as ViewToolInvokeResponse : null;
  } catch { return null; }
}
